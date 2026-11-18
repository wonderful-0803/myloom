/** Opt-in native provider. No models, tools, workspace migration or company Runtime are started here. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError, SessionPersistence, SessionPersistenceNotFoundError, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionPersistenceCreateOptions, SessionPersistenceListOptions, SessionPersistenceOpenOptions, SessionPersistenceSnapshot, SessionPersistenceStatOptions } from '@deepseek-ai/dsh-session-persistence'
import { validateScope } from '../state/ports.ts'
import type { SessionLease, StateScope, StateStore } from '../state/ports.ts'
import { hash } from '../state/hash.ts'
import { SqlSessionHandle } from './handle.ts'
import { cut, headerSnapshot, logEvents, logRecord, storedLog } from './storage.ts'
import type { NativeLog } from './storage.ts'
import { borrowedWriter, NativeWriterBinding, writerClaimKey } from './ownership.ts'
import type { NativeWriterClaim } from './ownership.ts'
import type { StateTransaction } from '../state/ports.ts'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { localComputeIdentity } from './compute.ts'
import { registerCompute } from './recovery.ts'
import { assertNativeReady } from './catalog.ts'

export interface NativeMetadataAuthority {
  assertCurrent(tx: StateTransaction): Promise<void>
  verify(preset: string, model: ModelSelection): Promise<void>
  close?(): Promise<void>
}

export interface SqlSessionPersistenceOptions {
  store: StateStore; scope: StateScope; ttlMs?: number; maxBufferedBytes?: number
  /** Host integration must fail closed on this signal before enabling business tools (B3). No event bodies are logged. */
  onFailure?(id: SessionId, error: unknown): void
}
/** Native DSH provider over A's durable records and database-time leases, with one event route per Session. */
export class SqlSessionPersistence extends SessionPersistence {
  private readonly options: SqlSessionPersistenceOptions & { ttlMs: number; maxBufferedBytes: number }
  private readonly instance = randomUUID()
  private readonly computeIdentity = localComputeIdentity()
  private writers = new Map<SessionId, SqlSessionHandle | null>()
  private handles = new Set<SqlSessionHandle>()
  private operations = new Set<Promise<unknown>>()
  private disposing?: Promise<void>
  private listeners: (() => unknown)[] = []
  private bindings = new Set<NativeWriterBinding>()
  private metadata?: NativeMetadataAuthority
  private closeMetadata?: () => Promise<void>
  /** Installed by the explicit metadata plugin. Unmounting revokes the guard instead of silently falling back. */
  attachMetadata(authority: NativeMetadataAuthority): () => void {
    if (this.metadata || this.bindings.size) throw new Error('Mount native metadata before company compute starts')
    this.metadata = authority
    this.closeMetadata = authority.close?.bind(authority)
    return () => { const error = new Error('Native metadata authority was removed'); this.failManaged(error); this.metadata = { assertCurrent: async () => { throw error }, verify: async () => { throw error } } }
  }
  failManaged(error: unknown): void { for (const binding of this.bindings) binding.fail(error) }
  async verifyEnvironment(preset: string, model: ModelSelection): Promise<void> { await this.metadata?.verify(preset, model) }
  /** The company entry reuses this exact authority instead of opening an unrelated storage/lease instance. */
  get authority(): { store: StateStore; scope: Readonly<StateScope> } { return { store: this.options.store, scope: this.options.scope } }
  useLease<T>(lease: SessionLease, work: (binding: NativeWriterBinding) => Promise<T>): Promise<T> {
    return this.invoke(async () => {
      if (borrowedWriter.getStore()) throw new Error('Native lease scope cannot be nested')
      const identity = await this.computeIdentity
      await this.options.store.transaction(this.options.scope, async tx => { await tx.leases.assert(lease); await registerCompute(tx, lease.owner, identity) })
      const binding = new NativeWriterBinding(this.identity, this.options.store, this.options.scope, lease, this.options.ttlMs, tx => this.metadata?.assertCurrent(tx) ?? Promise.resolve())
      this.bindings.add(binding)
      try { return await borrowedWriter.run(binding, () => work(binding)) }
      finally { try { await binding.close() } finally { this.bindings.delete(binding) } }
    })
  }
  private async claim(tx: StateTransaction, id: SessionId): Promise<{ lease: SessionLease; claimToken: string; binding?: NativeWriterBinding }> {
    const binding = borrowedWriter.getStore()
    if (binding && (binding.provider !== this.identity || binding.lease.sessionId !== id)) throw new Error('Native provider or Session differs from the borrowed lease')
    if (!binding && id.startsWith('worker-') && await tx.get('ticket', id.slice('worker-'.length)))
      throw new SessionAlreadyOwnedError(id) // The raw Harness API must not bypass company guards/control by adopting a task Session.
    if (binding) await binding.assertCurrent(tx)
    const lease = binding?.lease ?? await tx.leases.acquire(id, `${this.instance}/${randomUUID()}`, this.options.ttlMs)
    if (!lease) throw new SessionAlreadyOwnedError(id)
    const key = writerClaimKey(id), old = await tx.get<NativeWriterClaim>('grant', key)
    if (old?.value.active && old.value.owner === lease.owner && old.value.epoch === lease.epoch) throw new SessionAlreadyOwnedError(id)
    const claimToken = randomUUID()
    await tx.put('grant', key, { owner: lease.owner, epoch: lease.epoch, token: claimToken, active: true }, old?.revision ?? 0)
    return { lease: { ...lease }, claimToken, binding }
  }
  constructor(ctx: Context, options: SqlSessionPersistenceOptions) {
    const ttlMs = options.ttlMs ?? 30_000, maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 86_400_000) throw new TypeError('Native lease ttlMs must be 100..86400000')
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1024 || maxBufferedBytes > 256 * 1024 * 1024) throw new TypeError('Invalid native live buffer budget')
    const scope = validateScope(options.scope)
    if (ctx.get('sessionPersistence')) throw new Error('Disable the existing SessionPersistence provider before mounting native SQL persistence')
    super(ctx)
    this.options = { ...options, scope, ttlMs, maxBufferedBytes }
    this.listeners.push(ctx.on('session/event', (session, event) => {
      const writer = this.writers.get(session.id)
      if (!writer) return
      try { writer.live(event) } catch (error) { this.failure(session.id, error) }
    }), ctx.on('session/flush', session => this.writers.get(session.id)?.flush()), ctx.on('session/disposed', session => {
      const writer = this.writers.get(session.id)
      if (writer) void writer.close().catch(error => this.failure(session.id, error))
    }))
    ctx.effect(() => () => this.dispose())
  }
  private failure = (id: SessionId, error: unknown): void => {
    this.ctx.logger.warn(`Native Session persistence failed (${error instanceof Error ? error.name : 'Error'}); unconfirmed data must not be acknowledged`)
    try { this.options.onFailure?.(id, error) } catch { this.ctx.logger.warn('Native persistence failure observer threw') }
  }
  private invoke<T>(work: () => Promise<T>): Promise<T> {
    if (this.disposing) return Promise.reject(new Error('Native Session provider is closing'))
    const operation = work(); this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }
  private adopt(log: NativeLog, access: SessionAccess, writer?: { lease: SessionLease; claimToken: string; binding?: NativeWriterBinding }): SqlSessionHandle {
    const handle = new SqlSessionHandle({ ...this.options, claimToken: writer?.claimToken ?? '', binding: writer?.binding, release: handle => {
      this.handles.delete(handle)
      if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
    }, failure: (id, error) => { writer?.binding?.fail(error); this.failure(id, error) } }, log.header.id, headerSnapshot(log.header), access, log.inheritedEventCount, writer?.lease)
    writer?.binding?.add(handle)
    this.handles.add(handle)
    if (access === 'write') this.writers.set(handle.id, handle)
    return handle
  }
  create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return this.invoke(async () => {
      options?.signal?.throwIfAborted()
      const snapshot = headerSnapshot(header), inheritedEventCount = cut(snapshot, options?.inheritedEventCount)
      if (this.writers.has(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
      this.writers.set(snapshot.id, null)
      try {
        const { log, writer } = await this.options.store.transaction(this.options.scope, async tx => {
          options?.signal?.throwIfAborted()
          await assertNativeReady(tx)
          if (await tx.get('native-session', snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
          const writer = await this.claim(tx, snapshot.id)
          const log: NativeLog = { format: 'loom-dsh-session-v1', header: snapshot, inheritedEventCount, eventCount: 0, headerHash: hash(snapshot) }
          await tx.put('native-session', snapshot.id, storedLog(log), 0)
          return { log, writer }
        })
        return this.adopt(log, 'write', writer)
      } catch (error) { this.writers.delete(snapshot.id); throw error }
    })
  }
  open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.invoke(async () => {
      options?.signal?.throwIfAborted()
      if (typeof id !== 'string' || !id.trim() || id.length > 2000 || !['read', 'write'].includes(access)) throw new TypeError('Explicit Session id and read/write access required')
      if (access === 'write') {
        if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
        this.writers.set(id, null)
      }
      try {
        const { log, writer } = await this.options.store.transaction(this.options.scope, async tx => {
          options?.signal?.throwIfAborted()
          const record = await logRecord(tx, id)
          if (!record) throw new SessionPersistenceNotFoundError(id)
          // Validate the complete committed prefix before publishing any resumed writer.
          await logEvents(tx, record.value)
          const writer = access === 'write' ? await this.claim(tx, id) : undefined
          return { log: record.value, writer }
        })
        return this.adopt(log, access, writer)
      } catch (error) { if (access === 'write') this.writers.delete(id); throw error }
    })
  }
  private snapshot(log: NativeLog, revision: number): SessionPersistenceSnapshot {
    return { header: headerSnapshot(log.header), formatStatus: 'current', eventCount: log.eventCount,
      revision: SessionPersistenceRevision(`${this.instance}/${hash(log.header.id)}/${revision}`) }
  }
  stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    return this.invoke(() => this.options.store.transaction(this.options.scope, async tx => {
      options?.signal?.throwIfAborted()
      const log = await logRecord(tx, id)
      return log ? this.snapshot(log.value, log.revision) : undefined
    }))
  }
  list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    return this.invoke(() => this.options.store.transaction(this.options.scope, async tx => {
      await assertNativeReady(tx)
      const snapshots: SessionPersistenceSnapshot[] = []
      let after: string | undefined
      do {
        options?.signal?.throwIfAborted()
        const page = await tx.scan<NativeLog>('native-session', { after, limit: 100 })
        for (const record of page) {
          const log = await logRecord(tx, record.id as SessionId)
          snapshots.push(this.snapshot(log!.value, log!.revision))
        }
        after = page.length === 100 ? page.at(-1)!.id : undefined
      } while (after)
      return snapshots
    }))
  }
  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.handles].filter(handle => handle.access === 'write').map(async handle => {
      try { await handle.flush() } catch (error) { if (error instanceof SessionHandleClosedError) await handle.close(); else throw error }
    }))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Native Session provider flush failed')
  }
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      for (const binding of this.bindings) binding.fail(new Error('Native provider is shutting down'))
      await Promise.allSettled([...this.operations])
      const metadataErrors: unknown[] = []
      try { await this.closeMetadata?.() } catch (error) { metadataErrors.push(error) }
      // Managed Agents may append cancellation/final events while their host drains.
      // Keep live routing installed until those lifecycles have actually closed.
      for (const remove of this.listeners.splice(0)) remove()
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const errors = [...metadataErrors, ...results.filter(result => result.status === 'rejected').map(result => result.reason)]
      if (errors.length) throw new AggregateError(errors, 'Native Session provider shutdown failed')
    })()
  }
}
