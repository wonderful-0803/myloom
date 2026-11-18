/** Scoped borrowing of the application's existing Session lease; no second writer lease or expiry clock. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { hash } from '../state/hash.ts'
import type { SessionLease, StateScope, StateStore, StateTransaction } from '../state/ports.ts'
import type { SqlSessionHandle } from './handle.ts'
export interface NativeWriterClaim { owner: string; epoch: number; token: string; active: boolean }
export const writerClaimKey = (id: string) => `native-writer/${hash(id)}`
export const borrowedWriter = new AsyncLocalStorage<NativeWriterBinding>()

/** Host-only capability: owns the lease renewal and all provider handles opened within one managed Agent lifecycle. */
export class NativeWriterBinding {
  readonly lease: Readonly<SessionLease>
  private readonly lifetime = new AbortController()
  private readonly handles = new Set<SqlSessionHandle>()
  private closing?: Promise<void>
  private renewal?: Promise<void>
  private timer: ReturnType<typeof setInterval>
  get signal(): AbortSignal { return this.lifetime.signal }
  constructor(readonly provider: symbol, readonly store: StateStore, readonly scope: StateScope, lease: SessionLease, ttlMs: number,
    private readonly metadata?: (tx: StateTransaction) => Promise<void>) {
    this.lease = Object.freeze({ ...lease })
    this.timer = setInterval(() => {
      if (!this.closing && !this.renewal && !this.signal.aborted) this.renewal = store.transaction(scope, tx => tx.leases.renew(this.lease, ttlMs)).then(next => {
        if (!next) throw new SessionOwnershipLostError(SessionId(lease.sessionId))
      }).catch(error => this.fail(error)).finally(() => { this.renewal = undefined })
    }, Math.max(20, Math.floor(ttlMs / 3)))
    this.timer.unref()
  }
  add(handle: SqlSessionHandle): void {
    if (this.closing || handle.id !== this.lease.sessionId) throw new Error('Native writer binding no longer admits a handle')
    this.handles.add(handle)
  }
  fail(error: unknown): void { this.lifetime.abort(error) }
  async assertCurrent(tx?: StateTransaction): Promise<void> {
    this.signal.throwIfAborted()
    if (this.closing) throw new Error('Native writer binding is closing')
    if (tx) {
      if (hash(tx.scope) !== hash(this.scope)) throw new Error('Native writer scope mismatch')
      await tx.leases.assert(this.lease)
      await this.metadata?.(tx)
    } else await this.store.transaction(this.scope, async tx => { await tx.leases.assert(this.lease); await this.metadata?.(tx) })
    this.signal.throwIfAborted()
  }
  async flush(): Promise<void> {
    await this.assertCurrent()
    const results = await Promise.allSettled([...this.handles].map(handle => handle.flush()))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) { const error = new AggregateError(errors, 'Native lifecycle flush failed'); this.fail(error); throw error }
    await this.assertCurrent()
  }
  /** Close does not release the application lease: the owner first records actual stop/flush evidence, then releases it. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      clearInterval(this.timer); await this.renewal
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      this.lifetime.abort(new Error('Native writer lifecycle closed'))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Native writer lifecycle did not flush and close')
    })()
  }
}
