/** Coordinates periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
import type { ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export interface PassesHost<R extends ReceiveResult | Promise<ReceiveResult> = ReceiveResult> {
  readonly engine: { receive?(trigger: Trigger): R; evaluateDue(): void | Promise<void> }
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  configured(): boolean
  closing(): boolean
}

const now = (): string => new Date().toISOString()

/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * `Runtime` manages its lifecycle, while sources, tools, `Settings`, and HTTP routes trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
export class Passes<R extends ReceiveResult | Promise<ReceiveResult> = ReceiveResult> {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private pumping?: Promise<void>
  private pumpAgain?: Promise<void>
  private receiving = new Set<Promise<ReceiveResult>>()
  constructor(private readonly host: PassesHost<R>) {}
  start(): void { if (!this.stopped && !this.timer) this.timer = setInterval(() => { this.request() }, 2000) }
  stop(): Promise<unknown> {
    this.stopped = true
    clearInterval(this.timer)
    return Promise.allSettled([this.pumping, this.pumpAgain, ...this.receiving])
  }
  receive(trigger: Trigger): R {
    if (this.stopped || this.host.closing()) throw new Error('Orchestrator is stopping')
    if (!this.host.engine.receive) throw new Error('Use the source-aware ingress method to supply command identity')
    const result = this.host.engine.receive(trigger)
    if (typeof result === 'string') {
      if (result === 'stored') this.request()
      return result
    }
    const pending = result.then(value => { if (value === 'stored' && !this.stopped) this.request(); return value })
      .finally(() => { this.receiving.delete(pending) })
    this.receiving.add(pending)
    return pending as R
  }
  request(): void {
    const { health } = this.host
    this.pump().then(() => {
      if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
      health.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    }, (error: unknown) => { health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() }) })
  }
  /** Wait until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain, ...this.receiving])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain && !this.receiving.size) return
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
  async pump(): Promise<void> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    if (this.stopped || !this.host.configured() || this.host.closing()) return
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
    await this.host.engine.evaluateDue()
  }
}
