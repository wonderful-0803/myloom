/** Durable per-task control with tool leases, cancellation and explicit handover after quiescence. */
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

export type ControlMode = 'agent' | 'pausing' | 'paused' | 'taking_over' | 'human'
export interface ControlOperation { id: string; name: string; startedAt: string; status: 'running' | 'unknown' }
export interface TaskControlState {
  mode: ControlMode; revision: number; drained: boolean; operations: ControlOperation[]; detail?: string
  history: { at: string; action: string; note?: string }[]
}
export type ControlAction = 'pause' | 'resume' | 'takeover' | 'return' | 'resolve'
export interface ControlHost {
  store: Pick<Store, 'get' | 'set' | 'keys' | 'tickets'>
  quiesce(ticketId: string): Promise<void>
  resume(ticketId: string): void
  /** Standing authority is rechecked before an operator can release a held task. */
  canResume?(ticketId: string): boolean
}
/** A stale control form or unsafe state transition; callers must reread before retrying. */
export class ControlConflict extends Error {}
/** Blocks managed task activity until an operator explicitly returns control; persists ambiguous operations on crashes. */
export class TaskControls {
  private closed = false
  private readonly aborters = new Map<string, Map<string, AbortController>>()
  private readonly draining = new Set<string>()
  constructor(private readonly host: ControlHost) {}
  view(id: string): TaskControlState {
    if (!this.host.store.tickets.get(id)) throw new ControlConflict('Unknown task')
    return this.host.store.get(KV.controls.task(id)) ?? { mode: 'agent', revision: 0, drained: true, operations: [], history: [] }
  }
  held(id: string): boolean { return !this.host.store.tickets.get(id) || this.view(id).mode !== 'agent' }
  anyHeld(): boolean { return this.host.store.keys(KV.controls.task).some(key => this.host.store.get(key)?.mode !== 'agent') }
  /** Acquire a lease synchronously before dispatch; release only once the real operation settles. */
  async run<T>(id: string, name: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const state = this.view(id)
    if (state.mode !== 'agent') throw new ControlConflict('Task is under human control or paused')
    const operation = { id: randomUUID(), name, startedAt: new Date().toISOString(), status: 'running' as const }
    const aborter = new AbortController(), active = this.aborters.get(id) ?? new Map<string, AbortController>()
    active.set(operation.id, aborter); this.aborters.set(id, active)
    this.save(id, { ...state, operations: [...state.operations, operation] })
    let uncertain = false
    try { return await work(aborter.signal) }
    catch (error) {
      // Cancelling a client cannot prove that a remote write did not commit. Keep its lease for operator review.
      uncertain = aborter.signal.aborted
      throw error
    }
    finally {
      active.delete(operation.id)
      if (!active.size) this.aborters.delete(id)
      if (!this.closed) {
        const current = this.view(id)
        this.save(id, uncertain ? { ...current, detail: 'Check actual effects of operations whose result was lost during cancellation',
          operations: current.operations.map(item => item.id === operation.id ? { ...item, status: 'unknown' } : item) }
          : { ...current, operations: current.operations.filter(item => item.id !== operation.id) })
        this.settle(id)
      }
    }
  }
  /** Trusted operator APIs only: Feishu adapters must authenticate the sender, task ownership, freshness and revision first. */
  change(id: string, action: ControlAction, revision: number, resolution?: { ids: string[]; note: string }): TaskControlState {
    const current = this.view(id)
    if (current.revision !== revision) throw new ControlConflict('Control state changed; reread it')
    if (action === 'resume' || action === 'return') {
      const required = action === 'resume' ? 'paused' : 'human'
      if (current.mode !== required || current.operations.length || !current.drained) throw new ControlConflict('Task has not finished handing over')
      if (this.host.canResume && !this.host.canResume(id)) throw new ControlConflict('任务委托或来源授权已失效，请先恢复授权并重新查看。')
      const state = this.updated(current, 'agent', action)
      this.save(id, state); this.host.resume(id)
      return this.view(id)
    }
    if (action === 'resolve') {
      if (!resolution?.ids.length || resolution.note.trim().length < 10) throw new ControlConflict('Describe the external-state check and name the unknown operations')
      if (resolution.ids.some(op => !current.operations.some(item => item.id === op && item.status === 'unknown'))) throw new ControlConflict('Only unknown operations can be resolved')
      const state = this.updated(current, current.mode, action, resolution.note)
      state.operations = state.operations.filter(item => !resolution.ids.includes(item.id))
      this.save(id, state); this.drain(id)
      return this.view(id)
    }
    if (current.mode === 'human' || current.mode === 'paused' && action === 'pause') return current
    const state = this.updated(current, action === 'pause' ? 'pausing' : 'taking_over', action)
    state.drained = false; delete state.detail
    this.save(id, state)
    for (const aborter of this.aborters.get(id)?.values() ?? []) aborter.abort()
    this.drain(id)
    return this.view(id)
  }
  /** Running leases from an earlier process are unknown, never silently considered completed. */
  recover(): void {
    for (const key of this.host.store.keys(KV.controls.task)) {
      const id = key.slice(KV.controls.task.prefix.length), current = this.host.store.get(key)!
      if (!this.host.store.tickets.get(id)) continue
      if (current.operations.length) {
        this.save(id, { ...current, mode: current.mode === 'agent' ? 'pausing' : current.mode, drained: false,
          operations: current.operations.map(item => ({ ...item, status: 'unknown' })), detail: 'Check external effects of operations interrupted by restart' })
      }
      if (this.held(id)) this.drain(id)
    }
  }
  dispose(): void {
    this.closed = true
    for (const active of this.aborters.values()) for (const aborter of active.values()) aborter.abort()
  }
  private updated(state: TaskControlState, mode: ControlMode, action: string, note?: string): TaskControlState {
    return { ...state, mode, revision: state.revision + 1,
      history: [...state.history, { at: new Date().toISOString(), action, ...note ? { note } : {} }].slice(-100) }
  }
  private save(id: string, state: TaskControlState): void { this.host.store.set(KV.controls.task(id), state) }
  private settle(id: string): void {
    const state = this.view(id)
    if (!state.drained || state.operations.length) return
    if (state.mode === 'pausing' || state.mode === 'taking_over') {
      this.save(id, { ...state, mode: state.mode === 'pausing' ? 'paused' : 'human' })
    }
  }
  private drain(id: string): void {
    if (this.draining.has(id)) return
    this.draining.add(id)
    void Promise.resolve().then(() => this.host.quiesce(id)).then(() => {
      if (this.closed) return
      const current = this.view(id); this.save(id, { ...current, drained: true }); this.settle(id)
    }).catch(() => {
      if (this.closed) return
      const current = this.view(id); this.save(id, { ...current, detail: 'Managed work has not stopped; control has not transferred' })
    }).finally(() => { this.draining.delete(id) })
  }
}
