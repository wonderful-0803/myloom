import { localComputeIdentity } from './compute.ts'
import { registerCompute, releaseDeadComputeLease } from './recovery.ts'
/** SQL KV facet with one database-time owner per cached DSH domain; no independent metadata lease system. */
import { randomUUID } from 'node:crypto'
import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import type { SessionLease, StateScope, StateStore, StateTransaction } from '../state/ports.ts'
import { StateConflict, validateScope } from '../state/ports.ts'
import { canonical, hash } from '../state/hash.ts'
import { assertNativeReady, pinEnvironment, RecoveryContractSchema } from './catalog.ts'
import type { RecoveryContract } from './catalog.ts'

export interface UnitHeader { format: 'loom-dsh-kv-v1'; descriptor: KvUnitDescriptor }
export interface UnitValue { table: string; key: string; version: number; valueJSON: string; sha256: string }
export const unitLeaseId = (name: string) => `native-domain/${name}`
export const unitRecordId = (unit: string, table: string, key: string) => `${unit}/${hash({ table, key })}`
export function descriptorSnapshot(input: KvUnitDescriptor): KvUnitDescriptor {
  const value = JSON.parse(canonical(input)) as KvUnitDescriptor
  if (!UNIT_NAME_RE.test(value.name) || !Number.isSafeInteger(value.version) || value.version < 0 || typeof value.hasGlobal !== 'boolean'
    || !Array.isArray(value.tables) || value.tables.length > 100 || value.tables.some(table => !UNIT_NAME_RE.test(table)) || new Set(value.tables).size !== value.tables.length
    || value.layout !== undefined && !['single', 'per-record'].includes(value.layout)
    || value.compatibleVersions !== undefined && (!Array.isArray(value.compatibleVersions) || value.compatibleVersions.some(version => !Number.isSafeInteger(version) || version < 0)))
    throw new StorageError('malformed-medium', 'Invalid native KV descriptor')
  return { ...value, layout: value.layout ?? 'single', tables: [...value.tables].sort() }
}
export function checkUnit(header: UnitHeader, descriptor: KvUnitDescriptor): void {
  if (header?.format !== 'loom-dsh-kv-v1') throw new StorageError('malformed-medium', 'Unsupported native KV envelope')
  const saved = descriptorSnapshot(header.descriptor)
  if (saved.layout !== descriptor.layout || hash(saved.tables) !== hash(descriptor.tables) || saved.hasGlobal !== descriptor.hasGlobal || saved.name !== descriptor.name)
    throw new StorageError('malformed-medium', 'Native KV layout or shape differs; explicit migration required')
  if (descriptor.layout === 'single' && saved.version !== descriptor.version) throw new StorageError('version-mismatch', 'Native KV version mismatch')
}
export function storedUnitValue(table: string, key: string, version: number, value: unknown): UnitValue {
  const valueJSON = canonical(value)
  return { table, key, version, valueJSON, sha256: hash(JSON.parse(valueJSON)) }
}
export function decodeUnitValue(row: UnitValue, descriptor: KvUnitDescriptor): unknown {
  if (!row || !Number.isSafeInteger(row.version) || row.version < 0 || typeof row.key !== 'string' || typeof row.table !== 'string') throw new StorageError('malformed-medium', 'Invalid native KV record')
  if (descriptor.layout === 'per-record' && ![descriptor.version, ...descriptor.compatibleVersions ?? []].includes(row.version)) return undefined
  try {
    if (row.version !== descriptor.version && descriptor.layout !== 'per-record') throw new Error('Wrong record version')
    const value = JSON.parse(row.valueJSON)
    if (hash(value) !== row.sha256) throw new Error('Native record digest mismatch')
    return value
  } catch (cause) { throw new StorageError('malformed-medium', 'Invalid native KV document', { cause }) }
}
export interface SqlKvOptions { store: StateStore; scope: StateScope; units: readonly string[]; ttlMs?: number; contract: RecoveryContract; onFailure?(error: unknown): void }
/** KV unit owner: cached DSH domains reopen and reload on owner change, while every durable access checks this exact epoch. */
export class SqlKvBackend implements StorageBackend {
  readonly kv: KvFacet = { open: async descriptor => this.open(descriptor) }
  readonly scope: StateScope
  readonly contract: RecoveryContract
  private readonly lifetime = new AbortController()
  private readonly units = new Map<string, SqlKvUnit>()
  private readonly reserved = new Set<string>()
  private readonly opening = new Set<Promise<unknown>>()
  private readonly owner = randomUUID()
  private readonly computeIdentity = localComputeIdentity()
  private closing?: Promise<void>
  get signal(): AbortSignal { return this.lifetime.signal }
  constructor(readonly options: SqlKvOptions) {
    this.scope = validateScope(options.scope); this.contract = RecoveryContractSchema.parse(options.contract)
    if (!options.units.length || options.units.some(name => !UNIT_NAME_RE.test(name)) || new Set(options.units).size !== options.units.length) throw new Error('Explicit allowed native units required')
    if (!Number.isSafeInteger(options.ttlMs ?? 30_000) || (options.ttlMs ?? 30_000) < 100 || (options.ttlMs ?? 30_000) > 86_400_000) throw new Error('Invalid native domain TTL')
    this.options = { ...options, scope: this.scope, units: Object.freeze([...options.units]), contract: this.contract }
  }
  fail(error: unknown): void { if (!this.signal.aborted) { this.lifetime.abort(error); try { this.options.onFailure?.(error) } catch {} } }
  check(): void { if (this.closing || this.signal.aborted) throw new StorageError('closed', 'Native metadata owner is closed or lost') }
  async assertOwnership(tx: StateTransaction): Promise<void> {
    this.check()
    if (hash(tx.scope) !== hash(this.scope)) throw new StateConflict('Native metadata scope mismatch')
    await assertNativeReady(tx); await pinEnvironment(tx, this.contract)
    for (const name of this.options.units) {
      const unit = this.units.get(name)
      if (!unit) throw new StateConflict('Required native metadata domain is not open')
      await tx.leases.assert(unit.lease)
    }
  }
  private open(input: KvUnitDescriptor): Promise<KvUnit> {
    this.check(); const descriptor = descriptorSnapshot(input)
    if (!this.options.units.includes(descriptor.name)) return Promise.reject(new StorageError('malformed-medium', 'Native domain is not explicitly routed to this backend'))
    if (this.reserved.has(descriptor.name)) return Promise.reject(new StorageError('malformed-medium', 'Native domain already open'))
    this.reserved.add(descriptor.name)
    const operation = (async () => {
      try {
        await releaseDeadComputeLease(this.options.store, this.scope, unitLeaseId(descriptor.name))
        const identity = await this.computeIdentity
        const lease = await this.options.store.transaction(this.scope, async tx => {
          await assertNativeReady(tx); await pinEnvironment(tx, this.contract); await registerCompute(tx, this.owner, identity)
          const row = await tx.get<UnitHeader>('native-unit', descriptor.name)
          if (row) checkUnit(row.value, descriptor)
          const lease = await tx.leases.acquire(unitLeaseId(descriptor.name), this.owner, this.options.ttlMs ?? 30_000)
          if (!lease) throw new StateConflict('Native metadata domain is owned by another compute process')
          await tx.put('native-unit', descriptor.name, { format: 'loom-dsh-kv-v1', descriptor }, row?.revision ?? 0)
          return lease
        })
        const unit = new SqlKvUnit(this, descriptor, lease, () => { this.units.delete(descriptor.name); this.reserved.delete(descriptor.name) })
        this.units.set(descriptor.name, unit); return unit
      } catch (error) { this.reserved.delete(descriptor.name); throw error }
    })()
    this.opening.add(operation); void operation.finally(() => this.opening.delete(operation)).catch(() => {})
    return operation
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.opening])
      const result = await Promise.allSettled([...this.units.values()].map(unit => unit.close()))
      this.lifetime.abort(new Error('Native metadata backend closed'))
      const errors = result.filter(item => item.status === 'rejected').map(item => item.reason)
      if (errors.length) throw new AggregateError(errors, 'Native metadata close failed')
    })()
  }
}
/** Durable KV operations with detached snapshots and a drainable serial chain; domain semantics remain upstream. */
class SqlKvUnit implements KvUnit {
  private tail: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>
  private renewal?: Promise<unknown>
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private backend: SqlKvBackend, private descriptor: KvUnitDescriptor, readonly lease: SessionLease, private release: () => void) {
    this.timer = setInterval(() => {
      if (!this.renewal && !this.closing && !backend.signal.aborted) this.renewal = backend.options.store.transaction(backend.scope, async tx => {
        const next = await tx.leases.renew(lease, backend.options.ttlMs ?? 30_000)
        if (!next) throw new StateConflict('Native metadata owner lost')
      }).catch(error => backend.fail(error)).finally(() => { this.renewal = undefined })
    }, Math.max(20, Math.floor((backend.options.ttlMs ?? 30_000) / 3))); this.timer.unref()
  }
  private async run<T>(work: (tx: StateTransaction) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new StorageError('closed', 'Native KV unit is closed'))
    this.backend.check()
    const result = this.tail.then(() => this.backend.options.store.transaction(this.backend.scope, async tx => {
      this.backend.signal.throwIfAborted(); await assertNativeReady(tx); await tx.leases.assert(this.lease); return work(tx)
    })).catch(error => { this.backend.fail(error); throw error })
    this.tail = result.catch(() => {}); return result
  }
  private key(table: string, key: string): string {
    if (table === '' ? !this.descriptor.hasGlobal || key !== '' : !this.descriptor.tables.includes(table)) throw new StorageError('malformed-medium', 'Undeclared native KV slot')
    if (typeof key !== 'string' || key.length > 100_000 || table !== '' && this.descriptor.layout === 'per-record' && !/^[a-zA-Z0-9_-]+$/.test(key)) throw new StorageError('malformed-medium', 'Invalid native KV key')
    return unitRecordId(this.descriptor.name, table, key)
  }
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return this.run(async tx => {
      const tables = Object.fromEntries(this.descriptor.tables.map(table => [table, Object.create(null)])), result = { tables, global: null as unknown }
      let after: string | undefined
      do {
        const rows = await tx.scan<UnitValue>('native-record', { relation: this.descriptor.name, after, limit: 1000 })
        for (const row of rows) {
          if (row.id !== this.key(row.value.table, row.value.key)) throw new StorageError('malformed-medium', 'Native KV record identity mismatch')
          const value = decodeUnitValue(row.value, this.descriptor)
          if (value === undefined) continue
          if (row.value.table === '') result.global = value; else tables[row.value.table]![row.value.key] = value
        }
        after = rows.length === 1000 ? rows.at(-1)!.id : undefined
      } while (after)
      return result
    })
  }
  async putRecord(table: string, key: string, value: unknown): Promise<void> { return this.put(table, key, value) }
  async setGlobal(value: unknown): Promise<void> { return this.put('', '', value) }
  private put(table: string, key: string, value: unknown): Promise<void> {
    const id = this.key(table, key), saved = storedUnitValue(table, key, this.descriptor.version, value)
    return this.run(async tx => { const old = await tx.get('native-record', id); await tx.put('native-record', id, saved, old?.revision ?? 0, { relation: this.descriptor.name }) })
  }
  async deleteRecord(table: string, key: string): Promise<void> {
    if (!this.descriptor.tables.includes(table)) return Promise.reject(new StorageError('malformed-medium', 'Undeclared native KV table'))
    const id = this.key(table, key)
    return this.run(async tx => { const old = await tx.get('native-record', id); if (old) await tx.remove('native-record', id, old.revision) })
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      clearInterval(this.timer)
      try { await this.tail; await this.renewal; await this.backend.options.store.transaction(this.backend.scope, tx => tx.leases.release(this.lease)) }
      finally { this.release() }
    })()
  }
}
