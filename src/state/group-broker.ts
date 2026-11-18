/** One real Feishu stream with bounded, recoverable subscriptions; chat identity selects a single registered workspace. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { feishuTrigger } from '../sources/feishu-trigger.ts'
import type { FeishuWire } from './feishu.ts'
import type { ProductAccess } from './access.ts'
import type { StateScope, StateStore, SessionLease } from './ports.ts'
import { StateConflict } from './ports.ts'
interface Subscription { queue: unknown[]; wake?: () => void; generation: number; consuming: boolean; live: boolean }
/** Multiplexes only registered group events; overflow interrupts that subscription so durable history recovery runs again. */
export class GroupEventBroker {
  private subscriptions = new Map<string, Subscription>()
  private generation = 0
  private connected = false
  get ready() { return this.connected }
  private owner = randomUUID()
  constructor(readonly wire: FeishuWire, private options: { store: StateStore; scope: StateScope; access: ProductAccess; appId: string; botId: string; maxPending?: number }) {}
  subscribe(chatId: string): FeishuWire {
    if (this.subscriptions.has(chatId)) throw new StateConflict('A group already has a source subscription')
    const state: Subscription = { queue: [], generation: this.generation, consuming: false, live: false }; this.subscriptions.set(chatId, state)
    const broker = this
    return {
      verify: async signal => {
        const abort = () => state.wake?.(); signal.addEventListener('abort', abort, { once: true })
        try { while (!this.connected && !signal.aborted) await new Promise<void>(done => { state.wake = done; if (signal.aborted) done() }); signal.throwIfAborted() }
        finally { signal.removeEventListener('abort', abort); state.wake = undefined }
      },
      lark: (args, signal) => this.wire.lark(args, signal),
      ...(this.wire.file ? { file: (...args: Parameters<NonNullable<FeishuWire['file']>>) => this.wire.file!(...args) } : {}),
      ...(this.wire.download ? { download: (...args: Parameters<NonNullable<FeishuWire['download']>>) => this.wire.download!(...args) } : {}),
      async *events(signal, ready) {
        if (state.consuming) throw new StateConflict('A group subscription already has a consumer')
        state.consuming = true; const generation = state.generation
        const abort = () => state.wake?.(); signal.addEventListener('abort', abort, { once: true })
        try {
          while (!signal.aborted && !broker.connected && generation === state.generation) await new Promise<void>(done => { state.wake = done; if (signal.aborted) done() })
          signal.throwIfAborted(); if (generation !== state.generation) return
          ready?.(); state.live = true
          while (!signal.aborted && generation === state.generation) {
            if (state.queue.length) yield state.queue.shift()
            else await new Promise<void>(done => { state.wake = done; if (signal.aborted) done() })
          }
          signal.throwIfAborted()
        } finally { signal.removeEventListener('abort', abort); state.wake = undefined; state.consuming = false }
      },
    }
  }
  private interrupt(state: Subscription) { state.queue = []; state.generation++; state.live = false; state.wake?.() }
  forget(chatId: string) { const state = this.subscriptions.get(chatId); if (state) { this.interrupt(state); this.subscriptions.delete(chatId) } }
  private disconnected() {
    this.connected = false; this.generation++
    for (const state of this.subscriptions.values()) this.interrupt(state)
  }
  async run(signal: AbortSignal) {
    const { store, scope, access, appId, botId } = this.options
    while (!signal.aborted) {
      let lease: SessionLease | undefined
      try { lease = await store.transaction(scope, async tx => { const config = await access.configuration(tx); if (config.installation.appId !== appId || config.installation.botId !== botId) throw new StateConflict('Bot installation changed'); return tx.leases.acquire(`source/${access.installationId}`, this.owner, 30000) }) }
      catch { /* No source without current installation authority. */ }
      if (!lease) { await delay(1000, undefined, { signal }).catch(() => {}); continue }
      const connection = new AbortController(), abort = () => connection.abort(); signal.addEventListener('abort', abort, { once: true })
      let tail = Promise.resolve()
      const timer = setInterval(() => { tail = tail.then(async () => {
        const next = await store.transaction(scope, async tx => { await access.configuration(tx); return tx.leases.renew(lease!, 30000) })
        if (!next) throw Error('Source ownership lost'); lease = next
      }).catch(abort) }, 5000)
      try {
        await this.wire.verify?.(connection.signal)
        for await (const raw of this.wire.events(connection.signal, () => { this.connected = true; for (const state of this.subscriptions.values()) state.wake?.() })) {
          connection.signal.throwIfAborted()
          const trigger = feishuTrigger(raw, botId, appId)
          if (!trigger?.human || trigger.meta.direct === true) continue
          const state = this.subscriptions.get(String(trigger.meta.chatId)); if (!state) continue
          if (state.queue.length >= (this.options.maxPending ?? 128)) { this.interrupt(state); continue }
          // A subscription is still reconciling durable history until its
          // events() iterator signals readiness. Preserve the overlap in its
          // queue, but mark it as recovery input so the source can keep the
          // first committed representation when live/history payloads differ.
          const queued = structuredClone(raw) as Record<string, unknown>
          if (!state.live) queued.history = true
          state.queue.push(queued); state.wake?.()
        }
      } catch { /* History watermark is not advanced by stream delivery; every subscription reconciles again. */ }
      finally {
        this.disconnected(); connection.abort(); clearInterval(timer); signal.removeEventListener('abort', abort); await tail
        await store.transaction(scope, tx => tx.leases.release(lease!)).catch(() => {})
      }
      if (!signal.aborted) await delay(1000, undefined, { signal }).catch(() => {})
    }
  }
}
