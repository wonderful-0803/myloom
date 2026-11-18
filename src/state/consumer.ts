/** Database-backed consumers. Handlers perform external I/O outside state transactions. */
import { randomUUID } from 'node:crypto'
import type { JobClaim, JobPool, StateScope, StateStore } from './ports.ts'
import { validateScope } from './ports.ts'

export type JobResult = { state: 'done' } | { state: 'retry'; delayMs: number } | { state: 'hold'; reason: string }
/** A deliberate consumer shutdown, distinct from lost claims or an uncertain handler failure. */
export class ConsumerStopping extends Error {}
export interface JobContext {
  readonly claim: JobClaim
  readonly signal: AbortSignal
  /** Recheck immediately before dispatch. External side effects still need an idempotent receipt/fence. */
  assertCurrent(): Promise<void>
}
export interface JobLane {
  kinds: readonly string[]
  concurrency: number
  /** Every process consuming these kinds must use the same pool name and limit. */
  pool: JobPool
  handle(context: JobContext): Promise<JobResult>
}
export interface ConsumerOptions {
  store: StateStore; scope: StateScope; lanes: readonly JobLane[]
  owner?: string; ttlMs?: number; pollMs?: number
  /** Contains no job payload, provider exception text or credential. */
  problem?(problem: { phase: 'claim' | 'heartbeat' | 'handler' | 'settle'; kind?: string; key?: string }): void
}
/** Claims bounded work across processes, renews ownership, and holds ambiguous failures for reconciliation. */
export class DurableConsumer {
  private readonly options: ConsumerOptions
  private readonly owner: string
  private readonly ttl: number
  private readonly running = new Map<JobLane, Set<Promise<void>>>()
  private readonly controllers = new Set<AbortController>()
  private pumping?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private again = false
  constructor(options: ConsumerOptions) {
    this.options = { ...options, scope: validateScope(options.scope), lanes: options.lanes.map(lane => ({ ...lane, kinds: [...lane.kinds], ...(lane.pool ? { pool: { ...lane.pool } } : {}) })) }
    this.owner = options.owner ?? randomUUID(); this.ttl = options.ttlMs ?? 30_000
    if (!Number.isInteger(this.ttl) || this.ttl < 30 || this.ttl > 86_400_000) throw new Error('Invalid consumer TTL')
    if (!Number.isInteger(options.pollMs ?? 1000) || (options.pollMs ?? 1000) < 10) throw new Error('Invalid consumer polling interval')
    const kinds = new Set<string>()
    for (const lane of this.options.lanes) {
      if (!Number.isInteger(lane.concurrency) || lane.concurrency < 1 || lane.concurrency > 1000 || !lane.kinds.length) throw new Error('Invalid consumer lane')
      for (const kind of lane.kinds) { if (kinds.has(kind)) throw new Error('Duplicate job kind'); kinds.add(kind) }
      this.running.set(lane, new Set())
    }
  }
  start(): void {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => this.kick(), this.options.pollMs ?? 1000)
    this.timer.unref(); this.kick()
  }
  kick(): void {
    if (this.stopped) return
    if (this.pumping) { this.again = true; return }
    this.pumping = this.pump().catch(() => this.problem('claim')).finally(() => {
      this.pumping = undefined
      if (this.again) { this.again = false; this.kick() }
    })
  }
  /** Wait for currently runnable work. Held and future-due jobs remain durable. */
  async idle(): Promise<void> {
    this.kick()
    for (;;) {
      await this.pumping
      const active = [...this.running.values()].flatMap(values => [...values])
      if (!active.length && !this.pumping) return
      await Promise.allSettled(active)
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer)
    for (const controller of this.controllers) controller.abort(new ConsumerStopping('Consumer stopping'))
    await this.pumping
    await Promise.allSettled([...this.running.values()].flatMap(values => [...values]))
  }
  private problem(phase: 'claim' | 'heartbeat' | 'handler' | 'settle', claim?: JobClaim): void {
    try { this.options.problem?.({ phase, ...(claim ? { kind: claim.kind, key: claim.key } : {}) }) } catch { /* Observability cannot change a receipt. */ }
  }
  private async pump(): Promise<void> {
    const { store, scope } = this.options
    for (const lane of this.options.lanes) {
      const active = this.running.get(lane)!
      while (!this.stopped && active.size < lane.concurrency) {
        const claim = await store.transaction(scope, tx => tx.jobs.claim(this.owner, this.ttl, lane.kinds, lane.pool))
        if (!claim) break
        // stop() may race the database await: retain ownership until the handler has actually settled.
        const task = this.run(lane, claim).finally(() => { active.delete(task); this.kick() })
        active.add(task)
      }
    }
  }
  private async run(lane: JobLane, initial: JobClaim): Promise<void> {
    const { store, scope } = this.options, controller = new AbortController()
    this.controllers.add(controller)
    if (this.stopped) controller.abort(new ConsumerStopping('Consumer stopping'))
    let current = initial, finished = false, lost = false, renewal: Promise<void> = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    const renew = (): Promise<void> => {
      renewal = renewal.then(async () => {
        if (lost) throw new Error('Job ownership lost')
        const next = await store.transaction(scope, tx => tx.jobs.renew(current, this.ttl))
        if (!next) throw new Error('Job ownership lost')
        current = next
      }).catch(error => { lost = true; controller.abort(new Error('Job ownership unavailable')); throw error })
      return renewal
    }
    const schedule = () => {
      timer = setTimeout(() => {
        void renew().catch(() => this.problem('heartbeat', initial)).finally(() => { if (!finished && !lost) schedule() })
      }, Math.max(10, Math.floor(this.ttl / 3)))
      timer.unref()
    }
    schedule()
    let result: JobResult
    try {
      controller.signal.throwIfAborted()
      result = await lane.handle({ claim: structuredClone(initial), signal: controller.signal, assertCurrent: async () => { controller.signal.throwIfAborted(); await renew() } })
      if (!result || !['done', 'retry', 'hold'].includes(result.state)
        || result.state === 'retry' && (!Number.isSafeInteger(result.delayMs) || result.delayMs < 0 || result.delayMs > 86_400_000)
        || result.state === 'hold' && (typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 2048)) throw new Error('Invalid handler result')
    } catch {
      this.problem('handler', initial)
      result = { state: 'hold', reason: 'Handler failed; reconcile external receipts before retrying' }
    } finally {
      finished = true; clearTimeout(timer)
      await renewal.catch(() => {})
      this.controllers.delete(controller)
    }
    try {
      await store.transaction(scope, async tx => {
        if (result.state === 'done') await tx.jobs.complete(current)
        else if (result.state === 'retry') await tx.jobs.retry(current, result.delayMs)
        else await tx.jobs.hold(current, result.reason)
      })
    } catch { this.problem('settle', initial) }
  }
}
