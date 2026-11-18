/** First async command slice: existing intake/decision/report/reply rules, external state and durable effects.
 * Not a second live Runtime: callers must explicitly opt in and supply trusted authorization on EVERY command.
 */
import { Engine, pendingEvaluationDue, threadKey } from '../core/index.ts'
import type { Decision, DomainEvent, EngineOptions, Outcome, OutboundMessage, PolicyEffect, ReplyRequest, Thread, Ticket, Trigger, WorkerReport } from '../core/index.ts'
import { changeControl, control, ensureControl, requireAgent } from './controls.ts'
import { DomainUnit } from './domain-unit.ts'
import { hash } from './hash.ts'
import { enqueueDelivery } from './outbox.ts'
import type { DeliveryIntent } from './outbox.ts'
import { StateConflict, validateScope } from './ports.ts'
import type { SessionLease, StateScope, StateStore, StateTransaction } from './ports.ts'
import { FEISHU_INTAKE_WINDOW_MS, recordFeishuSignal } from './signals.ts'

export interface CommandIdentity { id: string; userId: string }
export interface CommandContext extends CommandIdentity { name: string; ticketId?: string; triggerId?: string; installationId?: string }
export interface DueCursor { threads?: string; tickets?: string }
export type WorkerFact = { kind: 'inputsDelivered'; inputIds: string[] } | { kind: 'inputsRead'; inputIds: string[] }
  | { kind: 'turnEnded' } | { kind: 'deliveryFailed'; error: string }
/** Values must be reconstructed from current, server-side settings/grants, never from event text. */
export type CommandAuthority = Pick<EngineOptions, 'policy' | 'scope' | 'prepareTicket'>
export interface AsyncOrchestratorOptions {
  store: StateStore; scope: StateScope
  authorize(tx: StateTransaction, command: CommandContext): Promise<CommandAuthority>
  /** Advisory only. Losing this wakeup must not lose a job; an exception cannot undo COMMIT. */
  wake?(): void
  requireWorkerBindings?: boolean
  /** Persist follow-on intents in the SAME report transaction. Must not perform external I/O. */
  reported?(tx: StateTransaction, ticket: Ticket, report: WorkerReport): Promise<void>
  deciding?(tx: StateTransaction, triggerId: string, outcome: Outcome): Promise<void>
  decided?(tx: StateTransaction, decision: Decision): Promise<void>
}
type Root = Parameters<DomainUnit['load']>[1][number]
interface CommandResult<T> { parameterHash: string; result: T }
/** Opt-in async admission/control/reply commands; reuses Engine rules and persists effects before waking consumers. */
export class AsyncOrchestrator {
  constructor(private options: AsyncOrchestratorOptions) { this.options = { ...options, scope: validateScope(options.scope) } }
  private async writer(tx: StateTransaction, ticketId: string, assignmentId: string, lease: SessionLease): Promise<void> {
    await tx.leases.assert(lease)
    if (!this.options.requireWorkerBindings) return
    const binding = (await tx.get<{ sessionId: string; owner: string; epoch: number }>('grant', `worker-binding/${ticketId}/${assignmentId}`))?.value
    if (!binding || binding.sessionId !== lease.sessionId || binding.owner !== lease.owner || binding.epoch !== lease.epoch) throw new StateConflict('Worker Session binding changed')
  }
  /** Fresh authorized read; no whole-database cache and no command-result cache. */
  async candidate(identity: CommandIdentity, triggerId: string) {
    return this.options.store.transaction(this.options.scope, async tx => {
      const authority = await this.options.authorize(tx, { ...identity, name: 'candidate', triggerId }), unit = new DomainUnit()
      await unit.load(tx, [{ family: 'trigger', id: triggerId }])
      const engine = new Engine({ ...authority, repo: unit.repo, assessor: { request: () => { throw new Error('Read-only candidate') } },
        executor: { start: () => {}, stop: () => {}, deliver: () => {} }, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, emit: () => {} })
      return engine.candidate(triggerId)
    })
  }
  private async command<T>(context: CommandContext, parameters: unknown, roots: readonly Root[],
    execute: (engine: Engine, tx: StateTransaction, authority: CommandAuthority) => T | Promise<T>): Promise<T> {
    if (!context.id.trim() || !context.userId.trim()) throw new Error('Explicit command ID and actor are required')
    const result = await this.options.store.transaction(this.options.scope, async tx => {
      const authority = await this.options.authorize(tx, context)
      const commandId = hash({ actor: context.userId, name: context.name, id: context.id }), digest = hash(parameters)
      const previous = await tx.get<CommandResult<T>>('command', commandId)
      if (previous) {
        if (previous.value.parameterHash !== digest) throw new StateConflict('Command ID reused with different parameters')
        return previous.value.result
      }
      const unit = new DomainUnit()
      await unit.load(tx, roots)
      for (const ticket of unit.tickets()) await control(tx, ticket.id)
      const outbound = new Map<string, DeliveryIntent>(), queued = new Map<string, OutboundMessage>(), withdrawn = new Set<string>()
      for (const ticket of unit.tickets()) {
        const rows = await tx.scan<DeliveryIntent>('outbox', { relation: ticket.id, limit: 1000 })
        if (rows.length >= 1000) throw new StateConflict('Delivery history needs pagination')
        for (const row of rows) outbound.set(row.id, row.value)
      }
      const effects: { kind: string; key: string; value: unknown }[] = [], cancelled: { kind: string; key: string }[] = [], events: DomainEvent[] = []
      const at = new Date(await tx.now()).toISOString()
      const engine = new Engine({ ...authority, repo: unit.repo, now: () => at,
        assessor: {
          request: candidate => { effects.push({ kind: 'domain.assess', key: candidate.evalId, value: { candidate } }) },
          release: id => { cancelled.push({ kind: 'domain.assess', key: id }) },
        },
        executor: {
          start: (ticket, assignment) => { effects.push({ kind: 'domain.launch', key: assignment.id, value: { ticketId: ticket.id, assignmentId: assignment.id } }) },
          deliver: (ticket, assignment) => { effects.push({ kind: 'domain.input', key: assignment.id, value: { ticketId: ticket.id, assignmentId: assignment.id } }) },
          stop: (ticket, assignment, reason) => { effects.push({ kind: 'domain.stop', key: assignment.id, value: { ticketId: ticket.id, assignmentId: assignment.id, reason } }) },
        },
        outbox: {
          send: message => { if (!queued.has(message.id) && !outbound.has(message.id)) queued.set(message.id, message) },
          status: id => withdrawn.has(id) ? 'dropped' : queued.has(id) ? 'pending'
            : outbound.has(id) ? outbound.get(id)!.status === 'sent' ? 'sent' : outbound.get(id)!.status === 'dropped' ? 'dropped' : 'pending' : undefined,
          withdraw: id => { queued.delete(id); withdrawn.add(id) },
        },
        emit: event => { events.push(event) },
      })
      const value = await execute(engine, tx, authority)
      await unit.flush(tx)
      for (const ticket of unit.tickets()) {
        // A migrated existing ticket without control data must be repaired by the migration, not silently reset to agent.
        if (unit.isNewTicket(ticket.id)) await ensureControl(tx, ticket.id)
      }
      for (const effect of effects) await tx.jobs.enqueue(effect.kind, effect.key, effect.value)
      for (const item of cancelled) await tx.jobs.cancel(item.kind, item.key)
      for (const id of withdrawn) {
        const row = await tx.get<DeliveryIntent>('outbox', id)
        if (row?.value.status === 'pending') {
          await tx.put('outbox', id, { ...row.value, status: 'dropped' }, row.revision, { relation: row.value.message.ticketId })
          await tx.jobs.cancel('outbox.send', id)
        }
      }
      for (const message of queued.values()) await enqueueDelivery(tx, message)
      for (const [index, event] of events.entries()) await tx.put('audit', `${commandId}/${index}`, event, 0)
      await tx.put('command', commandId, { parameterHash: digest, result: value }, 0)
      return value
    })
    try { this.options.wake?.() } catch { /* Durable jobs are authoritative. */ }
    return result
  }
  receive(identity: CommandIdentity, installationId: string, sourceEventId: string, trigger: Trigger, sourceLease?: SessionLease) {
    trigger = structuredClone(trigger)
    if (!installationId.trim() || !sourceEventId.trim()) throw new Error('Source installation and event ID are required')
    if (!Number.isFinite(Date.parse(trigger.at))) throw new Error('Source event timestamp is invalid')
    return this.command({ ...identity, name: 'receive', triggerId: trigger.id, installationId }, { installationId, sourceEventId, trigger, sourceLease: sourceLease && leaseIdentity(sourceLease) },
      [{ family: 'trigger', id: trigger.id }, ...trigger.threads.map(ref => ({ family: 'thread' as const, id: threadKey(ref) }))], async (engine, tx) => {
        if (sourceLease) await tx.leases.assert(sourceLease)
        const eventId = hash({ installationId, sourceEventId }), digest = hash(trigger)
        const existing = await tx.get<{ parameterHash: string }>('source-event', eventId)
        if (existing) {
          if (existing.value.parameterHash !== digest) throw new StateConflict(`Source event ID reused with changed content (${sourceEventId}; trigger ${trigger.id})`)
          return 'duplicate' as const
        }
        const feishu = !!sourceLease && trigger.source === 'feishu'
        const batchMs = feishu && trigger.human && !trigger.addressed ? FEISHU_INTAKE_WINDOW_MS : 0
        const result = engine.receive(trigger, batchMs)
        if (result === 'duplicate') {
          const previous = await tx.get<Trigger>('trigger', trigger.id)
          if (!previous || hash(previous.value) !== hash({ ...trigger, at: new Date(trigger.at).toISOString() }))
            throw new StateConflict('Trigger ID reused with different content')
        }
        await tx.put('source-event', eventId, { installationId, sourceEventId, triggerId: trigger.id, parameterHash: digest }, 0)
        if (feishu && result === 'stored') await recordFeishuSignal(tx, trigger)
        return result
      })
  }
  decide(identity: CommandIdentity, triggerId: string, outcome: Outcome) {
    outcome = structuredClone(outcome)
    return this.command({ ...identity, name: 'decide', triggerId }, { triggerId, outcome }, [{ family: 'trigger', id: triggerId },
      ...outcome.kind === 'stop' ? [{ family: 'ticket' as const, id: outcome.ticketId }] : []], async (engine, tx) => {
        await this.options.deciding?.(tx, triggerId, outcome)
        const result = engine.decide(triggerId, outcome)
        await this.options.decided?.(tx, result)
        return result
      })
  }
  /** Durable policy-change job. Pages and individual commands re-read current authority; no global in-memory state cache. */
  async policyChanged(identity: CommandIdentity, change: { from: string; to: string; effects: [string, PolicyEffect][] }) {
    for (const family of ['thread', 'ticket'] as const) {
      let after: string | undefined
      do {
        const rows = await this.options.store.transaction(this.options.scope, async tx => { await this.options.authorize(tx, { ...identity, name: 'policyChanged' }); return tx.scan(family, { after, active: true, limit: 100 }) })
        for (const row of rows) await this.command({ ...identity, id: `${identity.id}/${family}/${row.id}`, name: 'policyChanged' }, { family, id: row.id, change }, [{ family, id: row.id }], engine => engine.policyChanged(change.from, change.to, new Map(family === 'ticket' ? change.effects.filter(([id]) => id === row.id) : [])))
        after = rows.length === 100 ? rows.at(-1)!.id : undefined
      } while (after)
    }
  }
  /** Each pass uses a fresh identity ID; pages are bounded and every mutation reauthorizes in its own transaction. */
  async evaluateDue(identity: CommandIdentity, cursor: DueCursor = {}): Promise<DueCursor> {
    const page = await this.options.store.transaction(this.options.scope, async tx => {
      const authority = await this.options.authorize(tx, { ...identity, name: 'evaluateDue' }), policy = authority.policy(), now = await tx.now()
      const at = new Date(now).toISOString()
      const threads = await tx.scan<Thread>('thread', { active: true, after: cursor.threads, limit: 100 })
      const tickets = await tx.scan<Ticket>('ticket', { active: true, after: cursor.tickets, limit: 100 })
      return {
        threads: threads.filter(({ value: t }) => {
          const e = t.evaluating
          return e ? policy.paused ? !e.pausedAt : !!e.pausedAt || !!e.delivered && Date.parse(e.deadline) <= now : !policy.paused && pendingEvaluationDue(t, at)
        }).map(row => row.id),
        tickets: tickets.filter(row => row.value.ended && row.value.undelivered.length).map(row => row.id),
        cursor: { threads: threads.length === 100 ? threads.at(-1)!.id : undefined, tickets: tickets.length === 100 ? tickets.at(-1)!.id : undefined },
      }
    })
    for (const id of page.threads) await this.command({ ...identity, id: `${identity.id}/thread/${id}`, name: 'evaluateThread' }, { id },
      [{ family: 'thread', id }], engine => engine.evaluateThread(id))
    for (const id of page.tickets) await this.command({ ...identity, id: `${identity.id}/ticket/${id}`, name: 'wakeTicket', ticketId: id }, { id },
      [{ family: 'ticket', id }], async (engine, tx) => { if ((await control(tx, id)).value.mode === 'agent') engine.wakeTicket(id) })
    return page.cursor
  }
  candidateDelivered(identity: CommandIdentity, threadId: string, evalId: string) {
    return this.command({ ...identity, name: 'candidateDelivered' }, { threadId, evalId }, [{ family: 'thread', id: threadId }], engine => engine.candidateDelivered(evalId))
  }
  workerFact(identity: CommandIdentity, ticketId: string, assignmentId: string, lease: SessionLease, controlRevision: number, fact: WorkerFact) {
    fact = structuredClone(fact); lease = structuredClone(lease)
    return this.command({ ...identity, name: 'workerFact', ticketId }, { ticketId, assignmentId, lease: leaseIdentity(lease), controlRevision, fact },
      [{ family: 'ticket', id: ticketId }], async (engine, tx) => {
        await this.writer(tx, ticketId, assignmentId, lease); await requireAgent(tx, ticketId, controlRevision)
        if ((await tx.get<Ticket>('ticket', ticketId))?.value.assignments.at(-1)?.id !== assignmentId) throw new StateConflict('Stale assignment callback')
        switch (fact.kind) {
          case 'inputsDelivered': return engine.inputsDelivered(ticketId, assignmentId, fact.inputIds)
          case 'inputsRead': return engine.inputsRead(ticketId, fact.inputIds)
          case 'turnEnded': return engine.turnEnded(ticketId, assignmentId)
          case 'deliveryFailed': return engine.deliveryFailed(ticketId, assignmentId, fact.error)
        }
      })
  }
  assignmentStarted(identity: CommandIdentity, ticketId: string, assignmentId: string, lease: SessionLease) {
    lease = structuredClone(lease)
    return this.command({ ...identity, name: 'assignmentStarted', ticketId }, { ticketId, assignmentId, lease: leaseIdentity(lease) }, [{ family: 'ticket', id: ticketId }], async (engine, tx) => {
      await this.writer(tx, ticketId, assignmentId, lease)
      const ticket = await tx.get<Ticket>('ticket', ticketId), fence = await control(tx, ticketId)
      if (ticket?.value.ended || ticket?.value.assignments.at(-1)?.id !== assignmentId) throw new StateConflict('Assignment changed')
      await requireAgent(tx, ticketId, fence.value.revision)
      engine.assignmentStarted(ticketId, assignmentId)
    })
  }
  report(identity: CommandIdentity, ticketId: string, assignmentId: string, lease: SessionLease, controlRevision: number, report: WorkerReport) {
    lease = structuredClone(lease); report = structuredClone(report)
    return this.command({ ...identity, name: 'report', ticketId }, { ticketId, assignmentId, lease: leaseIdentity(lease), controlRevision, report }, [{ family: 'ticket', id: ticketId }], async (engine, tx) => {
      await this.writer(tx, ticketId, assignmentId, lease); await requireAgent(tx, ticketId, controlRevision)
      if ((await tx.get<Ticket>('ticket', ticketId))?.value.assignments.at(-1)?.id !== assignmentId) throw new StateConflict('Stale assignment report')
      const result = engine.report(ticketId, report)
      await this.options.reported?.(tx, result, report)
      return result
    })
  }
  reply(identity: CommandIdentity, request: ReplyRequest & { ticketId: string }) {
    request = structuredClone(request)
    return this.command({ ...identity, name: 'reply', ticketId: request.ticketId }, request,
      [{ family: 'ticket', id: request.ticketId }, ...request.triggerId ? [{ family: 'trigger' as const, id: request.triggerId }] : []], engine => engine.reply(request))
  }
  note(identity: CommandIdentity, ticketId: string, text: string) {
    if (!text.trim() || text.length > 20_000) throw new Error('Invalid task requirement')
    return this.command({ ...identity, name: 'note', ticketId }, { ticketId, text }, [{ family: 'ticket', id: ticketId }],
      async (engine, tx) => { const fence = await control(tx, ticketId); await requireAgent(tx, ticketId, fence.value.revision); return engine.note(ticketId, text) })
  }
  stopTicket(identity: CommandIdentity, ticketId: string, reason?: string) {
    return this.command({ ...identity, name: 'stopTicket', ticketId }, { ticketId, reason }, [{ family: 'ticket', id: ticketId }], engine => engine.stopTicket(ticketId, reason))
  }
  retryTicket(identity: CommandIdentity, ticketId: string) {
    return this.command({ ...identity, name: 'retryTicket', ticketId }, { ticketId }, [{ family: 'ticket', id: ticketId }], async (engine, tx) => {
      await requireAgent(tx, ticketId, (await control(tx, ticketId)).value.revision); return engine.retryTicket(ticketId)
    })
  }
  rerunTicket(identity: CommandIdentity, ticketId: string, note: string) {
    if (!note.trim() || note.length > 20_000) throw new Error('Invalid rerun requirement')
    return this.command({ ...identity, name: 'rerunTicket', ticketId }, { ticketId, note }, [{ family: 'ticket', id: ticketId }], async (engine, tx) => {
      await requireAgent(tx, ticketId, (await control(tx, ticketId)).value.revision); return engine.rerunTicket(ticketId, note)
    })
  }
  reevaluate(identity: CommandIdentity, triggerId: string) {
    return this.command({ ...identity, name: 'reevaluate', triggerId }, { triggerId }, [{ family: 'trigger', id: triggerId }], engine => engine.reevaluate(triggerId))
  }
  attach(identity: CommandIdentity, ticketId: string, triggerId: string, note?: string) {
    return this.command({ ...identity, name: 'attach', ticketId, triggerId }, { ticketId, triggerId, note },
      [{ family: 'ticket', id: ticketId }, { family: 'trigger', id: triggerId }], async (engine, tx) => {
        await requireAgent(tx, ticketId, (await control(tx, ticketId)).value.revision); return engine.attach(ticketId, triggerId, note)
      })
  }
  changeControl(identity: CommandIdentity, ticketId: string, expectedRevision: number, action: 'pause' | 'takeover' | 'resume' | 'return') {
    return this.command({ ...identity, name: 'changeControl', ticketId }, { ticketId, expectedRevision, action }, [{ family: 'ticket', id: ticketId }], async (_engine, tx, authority) => {
      const ticket = (await tx.get<Ticket>('ticket', ticketId))?.value
      if (!ticket) throw new StateConflict('Unknown task')
      if ((action === 'resume' || action === 'return') && !authority.policy().revalidate(ticket.mandate))
        throw new StateConflict('Task mandate no longer permits resuming')
      const changed = await changeControl(tx, ticketId, expectedRevision, action, identity.userId)
      if ((action === 'resume' || action === 'return') && !ticket.ended && ticket.assignments.at(-1))
        _engine.assignmentInterrupted(ticketId, ticket.assignments.at(-1)!.id, 'controlReturned')
      return changed
    })
  }
}
/** Renewal changes the deadline, not the immutable callback identity. */
function leaseIdentity(lease: SessionLease) { return { sessionId: lease.sessionId, owner: lease.owner, epoch: lease.epoch } }
