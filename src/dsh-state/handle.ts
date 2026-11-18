import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { assertContiguous, materializeAppendBatch, SessionHandleClosedError, SessionOwnershipLostError, SessionPersistenceNotFoundError, SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionHandleAppendOptions, SessionHandleFlushOptions, SessionHandleReadOptions } from '@deepseek-ai/dsh-session-persistence'
import { hash } from '../state/hash.ts'
import { LeaseLost } from '../state/ports.ts'
import type { SessionLease, StateScope, StateStore, StateTransaction } from '../state/ports.ts'
import { checkedEvents, corruption, eventKey, logEvents, logRecord, storedLog } from './storage.ts'
import type { NativeEvent } from './storage.ts'
import { writerClaimKey } from './ownership.ts'
import type { NativeWriterBinding, NativeWriterClaim } from './ownership.ts'

export interface HandleOptions {
  store: StateStore; scope: StateScope; ttlMs: number; maxBufferedBytes: number
  claimToken: string; binding?: NativeWriterBinding
  release(handle: SqlSessionHandle): void
  failure(id: SessionId, error: unknown): void
}
/** One serialized writer. A failed/ambiguous commit is reconciled only against this handle's exact attempted bytes. */
export class SqlSessionHandle implements SessionHandle {
  readonly inheritedEventCount
  private tail: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>
  private lost = false
  private observed = 0
  private pending: SessionEvent[] = []
  private pendingBytes = 0
  private fault?: unknown
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private renewing?: Promise<void>
  private uncertain?: string
  private retryBatch?: readonly SessionEvent[]
  private drainPaused = false
  constructor(private options: HandleOptions, readonly id: SessionId, readonly header: SessionHeader, readonly access: SessionAccess,
    inheritedEventCount: number, private lease?: SessionLease) {
    this.inheritedEventCount = SessionLogOffset(inheritedEventCount)
    if (lease && !options.binding) {
      this.heartbeat = setInterval(() => {
        if (!this.renewing && !this.closing && !this.lost) this.renewing = this.renew().catch(error => {
          this.lost = true; this.options.failure(this.id, error)
        }).finally(() => { this.renewing = undefined })
      }, Math.max(20, Math.floor(options.ttlMs / 3)))
      this.heartbeat.unref()
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(operation)
    this.tail = work.catch(() => {})
    return work
  }
  private check(operation: string, write = false): void {
    if (this.closing) throw new SessionHandleClosedError(this.id, operation)
    if (write && this.access !== 'write') throw new SessionReadOnlyError(this.id, operation)
    if (write && this.lost) throw new SessionOwnershipLostError(this.id)
  }
  private async writer(tx: StateTransaction): Promise<void> {
    if (this.lost || !this.lease) throw new SessionOwnershipLostError(this.id)
    try { await tx.leases.assert(this.lease) }
    catch (error) {
      if (error instanceof LeaseLost) { this.lost = true; throw new SessionOwnershipLostError(this.id) }
      throw error
    }
    const claim = (await tx.get<NativeWriterClaim>('grant', writerClaimKey(this.id)))?.value
    if (!claim?.active || claim.owner !== this.lease.owner || claim.epoch !== this.lease.epoch || claim.token !== this.options.claimToken) {
      this.lost = true; throw new SessionOwnershipLostError(this.id)
    }
  }
  private async renew(): Promise<void> {
    const next = await this.options.store.transaction(this.options.scope, tx => tx.leases.renew(this.lease!, this.options.ttlMs))
    if (!next) throw new SessionOwnershipLostError(this.id)
    this.lease = next
  }
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions) {
    this.check('read')
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new TypeError('Read offset and length must be non-negative safe integers')
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      const events = await this.options.store.transaction(this.options.scope, async tx => {
        options?.signal?.throwIfAborted()
        const log = await logRecord(tx, this.id)
        if (!log) throw new SessionPersistenceNotFoundError(this.id)
        if (log.value.headerHash !== hash(this.header) || log.value.eventCount < this.observed) throw corruption(this.id, new Error('Log identity changed or prefix shrank'))
        const events = await logEvents(tx, log.value, offset, length)
        this.observed = Math.max(this.observed, log.value.eventCount)
        return events
      })
      return { eventState: 'detached' as const, events }
    })
  }
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.check('append', true)
    // Snapshot before the first await; callers may mutate borrowed values immediately after append().
    const batch = materializeAppendBatch(events)
    checkedEvents(this.header, batch as SessionEvent[])
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      await this.drain()
      await this.persist(batch, options?.signal)
    })
  }
  private async persist(batch: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    let attempted = false
    const fingerprint = hash(batch)
    try {
      await this.options.store.transaction(this.options.scope, async tx => {
        signal?.throwIfAborted()
        await this.writer(tx)
        const log = await logRecord(tx, this.id)
        if (!log) throw new SessionPersistenceNotFoundError(this.id)
        if (log.value.headerHash !== hash(this.header)) throw corruption(this.id, new Error('Immutable header changed'))
        if (this.uncertain === fingerprint && batch.length && batch[0]!.seq < log.value.eventCount) {
          if (log.value.eventCount !== batch[0]!.seq + batch.length || hash(await logEvents(tx, log.value, batch[0]!.seq, batch.length)) !== fingerprint)
            throw corruption(this.id, new Error('Ambiguous commit differs from attempted batch'))
          return
        }
        assertContiguous(this.id, batch, log.value.eventCount)
        if (!Number.isSafeInteger(log.value.eventCount + batch.length)) throw new Error('Native event sequence overflow')
        attempted = batch.length > 0
        for (const event of batch) {
          const value: NativeEvent = { sessionId: this.id, eventJSON: JSON.stringify(event), sha256: hash(event) }
          await tx.put('native-event', eventKey(this.id, event.seq), value, 0, { relation: hash(this.id) })
        }
        if (batch.length) await tx.put('native-session', this.id, storedLog({ ...log.value, eventCount: log.value.eventCount + batch.length }), log.revision)
      })
      this.uncertain = undefined
    } catch (error) {
      if (attempted) this.uncertain = fingerprint
      this.options.binding?.fail(error)
      throw error
    }
  }
  /** Synchronous publication hook: retained copies are drained by flush/close or one bounded batching window. */
  live(event: SessionEvent): void {
    this.check('event', true)
    if (this.fault) throw this.fault
    try {
      const batch = materializeAppendBatch([event]); checkedEvents(this.header, batch as SessionEvent[])
      const bytes = Buffer.byteLength(JSON.stringify(batch))
      if (this.pendingBytes + bytes > this.options.maxBufferedBytes) throw new Error('Native live-event buffer budget exceeded; flush refused')
      this.pending.push(batch[0]!); this.pendingBytes += bytes
      if (!this.timer && !this.drainPaused) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          if (!this.closing && !this.drainPaused) void this.enqueue(() => this.drain()).catch(error => this.options.failure(this.id, error))
        }, 10)
        this.timer.unref()
      }
    } catch (error) { this.fault = error; this.options.binding?.fail(error); throw error }
  }
  private async drain(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.fault) throw this.fault
    while (this.pending.length) {
      const batch = this.retryBatch ?? this.pending.slice()
      try { await this.persist(batch) }
      catch (error) { this.retryBatch = batch; this.drainPaused = true; throw error }
      this.retryBatch = undefined; this.drainPaused = false
      this.pending.splice(0, batch.length)
      this.pendingBytes = this.pending.reduce((size, event) => size + Buffer.byteLength(JSON.stringify([event])), 0)
    }
  }
  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.check('flush', true)
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      await this.drain()
      // append commits immediately; this transaction is the write-chain and ownership barrier, including empty logs.
      try { await this.options.store.transaction(this.options.scope, tx => this.writer(tx)) }
      catch (error) { this.options.binding?.fail(error); throw error }
    })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    return this.closing = this.enqueue(async () => {
      const failures: unknown[] = []
      try { await this.renewing; if (this.access === 'write') await this.drain() } catch (error) { failures.push(error) }
      try {
        if (this.lease) await this.options.store.transaction(this.options.scope, async tx => {
          const row = await tx.get<NativeWriterClaim>('grant', writerClaimKey(this.id))
          if (row?.value.token === this.options.claimToken) await tx.put('grant', row.id, { ...row.value, active: false }, row.revision)
          if (!this.options.binding) await tx.leases.release(this.lease!)
        })
      } catch (error) { failures.push(error) }
      finally { this.options.release(this) }
      if (failures.length) throw new AggregateError(failures, `Native Session ${this.id}: close failed`)
    })
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }
}
