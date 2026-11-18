/** Opt-in async task kernel. It does not switch the desktop/HTTP Runtime or start a real source listener. */
import { randomUUID } from 'node:crypto'
import { Passes } from '../app/passes.ts'
import type { Candidate, Outcome, PolicyEffect, Ticket, Trigger } from '../core/index.ts'
import { HealthBoard } from '../infra/health.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AsyncOrchestrator } from './application.ts'
import type { AsyncOrchestratorOptions, CommandIdentity, DueCursor } from './application.ts'
import { control } from './controls.ts'
import { DurableConsumer } from './consumer.ts'
import type { JobContext, JobResult } from './consumer.ts'
import { DeliveryPending, DurableOutbox } from './outbox.ts'
import type { DeliveryTransport } from './outbox.ts'
import { StateConflict, validateScope } from './ports.ts'
import type { SessionLease } from './ports.ts'
import type { JobLane } from './consumer.ts'

export interface WorkRequest {
  /** Stable across process crashes; a new queued generation gets a different sequence. */
  requestId: string; kind: 'domain.launch' | 'domain.input'
  ticket: Ticket; assignmentId: string; controlRevision: number
}
export interface StopRequest { ticket: Ticket; assignmentId?: string; revision?: number; reason?: string }
export interface AsyncRuntimeOptions extends Omit<AsyncOrchestratorOptions, 'wake'> {
  /** Trusted service principal, checked against persisted authority on every job and command. */
  actorId: string
  assess(candidate: Candidate, context: JobContext): Promise<Outcome>
  /** Must await the actual turn, use request receipts, and fence every native Session/tool call. */
  work(request: WorkRequest, context: JobContext): Promise<JobResult>
  /** Must obtain the backend's stop receipt; AbortSignal alone never confirms handover. */
  stop(request: StopRequest, context: JobContext): Promise<JobResult>
  delivery: DeliveryTransport
  concurrency?: number; ttlMs?: number; pollMs?: number
  health?: HealthEntry
  lanes?: readonly JobLane[]
}
/** Drives durable admission → assessment → worker callbacks → ordered delivery from one external state authority. */
export class AsyncTaskRuntime {
  readonly app: AsyncOrchestrator
  readonly consumer: DurableConsumer
  readonly outbox: DurableOutbox
  readonly health: HealthEntry
  readonly jobsHealth: HealthEntry
  private readonly passes: Passes
  private readonly lifetime = new AbortController()
  private readonly receiving = new Set<Promise<unknown>>()
  private cursor: DueCursor = {}
  private closing = false
  constructor(private options: AsyncRuntimeOptions) {
    this.options = { ...options, scope: validateScope(options.scope) }
    if (!options.actorId.trim()) throw new Error('Async task runtime requires a trusted actor')
    const concurrency = options.concurrency ?? 2
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) throw new Error('Invalid worker concurrency')
    this.health = options.health ?? new HealthBoard().claim('async-runtime', { state: 'starting', detail: '' })
    this.jobsHealth = new HealthBoard().claim('async-jobs', { state: 'ready', detail: 'Durable queue is ready' })
    this.app = new AsyncOrchestrator({ ...options, wake: () => { this.passes.request(); this.consumer.kick() } })
    this.outbox = new DurableOutbox(options.store, options.scope, options.delivery)
    this.consumer = new DurableConsumer({ store: options.store, scope: options.scope, ttlMs: options.ttlMs, pollMs: options.pollMs,
      problem: problem => this.jobsHealth.set({ state: 'error', detail: `Background ${problem.phase} requires inspection`, at: new Date().toISOString() }),
      lanes: [
        { kinds: ['policy.changed'], concurrency: 1, pool: { name: 'policy-changes', limit: 1 }, handle: async ctx => { await ctx.assertCurrent(); await this.app.policyChanged(this.jobIdentity(ctx, 'refresh'), ctx.claim.value as { from: string; to: string; effects: [string, PolicyEffect][] }); return { state: 'done' } } },
        { kinds: ['domain.assess'], concurrency: 1, pool: { name: 'assessors', limit: 1 }, handle: ctx => this.assess(ctx) },
        { kinds: ['domain.launch', 'domain.input'], concurrency, pool: { name: 'workers', limit: concurrency }, handle: ctx => this.work(ctx) },
        { kinds: ['domain.stop', 'control.stop'], concurrency: 2, pool: { name: 'stops', limit: 2 }, handle: ctx => this.stopWork(ctx) },
        { kinds: ['outbox.send'], concurrency: 1, pool: { name: 'deliveries', limit: 1 }, handle: async ctx => {
          await ctx.assertCurrent()
          try {
            const status = await this.outbox.deliver(ctx.claim.key)
            return status === 'unknown' ? { state: 'hold', reason: 'Delivery receipt unknown; reconcile with provider' } : { state: 'done' }
          } catch (error) { if (error instanceof DeliveryPending) return { state: 'retry', delayMs: 1000 }; throw error }
        } },
        ...options.lanes ?? [],
      ] })
    this.passes = new Passes({ engine: { evaluateDue: async () => { this.cursor = await this.app.evaluateDue(this.identity(), this.cursor) } },
      effects: this.consumer, health: this.health, lifetime: this.lifetime.signal, configured: () => true, closing: () => this.closing })
  }
  start(): void { if (!this.closing) { this.consumer.start(); this.passes.start(); this.passes.request(); this.health.set({ state: 'ready', detail: 'Async task runtime started', at: new Date().toISOString() }) } }
  receive(identity: CommandIdentity, installationId: string, sourceEventId: string, trigger: Trigger, sourceLease?: SessionLease) {
    if (this.closing) throw new Error('Async task runtime is stopping')
    const result = this.app.receive(identity, installationId, sourceEventId, trigger, sourceLease).finally(() => { this.receiving.delete(result) })
    this.receiving.add(result); return result
  }
  async idle(): Promise<void> { await Promise.all([...this.receiving]); this.passes.request(); await this.passes.idle() }
  async stop(): Promise<void> {
    this.closing = true; this.lifetime.abort()
    await Promise.all([this.passes.stop(), this.consumer.stop(), ...this.receiving])
  }
  private identity(id: string = randomUUID()): CommandIdentity { return { id, userId: this.options.actorId } }
  private jobIdentity(ctx: JobContext, suffix: string) { return this.identity(`${ctx.claim.kind}/${ctx.claim.key}/${ctx.claim.sequence}/${suffix}`) }
  private async assess(ctx: JobContext): Promise<JobResult> {
    const saved = (ctx.claim.value as { candidate: Candidate }).candidate
    const primary = saved.thread.evaluating?.primary ?? saved.triggers[0]?.id
    if (!primary) return { state: 'hold', reason: 'Assessment candidate has no source event' }
    const candidate = await this.app.candidate(this.jobIdentity(ctx, 'read'), primary)
    if (!candidate || candidate.evalId !== ctx.claim.key) return { state: 'done' }
    await ctx.assertCurrent()
    await this.app.candidateDelivered(this.jobIdentity(ctx, 'delivered'), candidate.thread.key, candidate.evalId)
    const outcome = await this.options.assess(candidate, ctx)
    await ctx.assertCurrent()
    await this.app.decide(this.jobIdentity(ctx, 'decide'), candidate.thread.evaluating?.primary ?? candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
    return { state: 'done' }
  }
  private async work(ctx: JobContext): Promise<JobResult> {
    const { ticketId, assignmentId } = ctx.claim.value as { ticketId: string; assignmentId: string }
    const read = async () => this.options.store.transaction(this.options.scope, async tx => {
      const authority = await this.options.authorize(tx, { ...this.jobIdentity(ctx, 'dispatch'), name: 'work', ticketId })
      const ticket = (await tx.get<Ticket>('ticket', ticketId))?.value
      if (!ticket) throw new StateConflict('Unknown worker task')
      const fence = await control(tx, ticketId), assignment = ticket.assignments.at(-1)
      if (assignment?.id !== assignmentId || assignment.state === 'ended') return { state: 'obsolete' as const }
      if (!authority.policy().revalidate(ticket.mandate)) throw new StateConflict('Worker mandate revoked')
      if (fence.value.mode !== 'agent' || authority.policy().paused || ctx.claim.kind === 'domain.input' && assignment.state === 'pending') return { state: 'wait' as const }
      return { state: 'ready' as const, ticket, controlRevision: fence.value.revision }
    })
    await ctx.assertCurrent()
    const ready = await read()
    if (ready.state === 'obsolete') return { state: 'done' }
    if (ready.state === 'wait') return { state: 'retry', delayMs: 1000 }
    const guarded: JobContext = { ...ctx, assertCurrent: async () => {
      await ctx.assertCurrent()
      const current = await read()
      if (current.state !== 'ready' || current.controlRevision !== ready.controlRevision) throw new StateConflict('Worker authorization changed')
    } }
    return this.options.work({ requestId: `${ctx.claim.kind}/${ctx.claim.key}/${ctx.claim.sequence}`, kind: ctx.claim.kind as WorkRequest['kind'],
      ticket: ready.ticket, assignmentId, controlRevision: ready.controlRevision }, guarded)
  }
  private async stopWork(ctx: JobContext): Promise<JobResult> {
    const { ticketId, assignmentId, revision, reason } = ctx.claim.value as { ticketId: string; assignmentId?: string; revision?: number; reason?: string }
    await ctx.assertCurrent()
    const ticket = await this.options.store.transaction(this.options.scope, async tx => {
      await this.options.authorize(tx, { ...this.jobIdentity(ctx, 'stop'), name: 'stopWork', ticketId })
      if (revision !== undefined && (await control(tx, ticketId)).value.revision !== revision) return undefined
      const value = (await tx.get<Ticket>('ticket', ticketId))?.value
      if (assignmentId && value?.assignments.at(-1)?.id !== assignmentId) return undefined
      return value
    })
    if (!ticket) return { state: 'done' }
    return this.options.stop({ ticket, assignmentId, revision, reason }, ctx)
  }
}
