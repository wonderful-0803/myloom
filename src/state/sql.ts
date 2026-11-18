/** Shared SQL repositories. Adapters own connection lifetime, serialization and COMMIT. */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { families, LeaseLost, StateClosed, StateConflict, validateScope } from './ports.ts'
import type { Family, Job, JobClaim, JobPool, RecordIndex, RecordQuery, SessionLease, StateChange, StateRecord, StateScope, StateTransaction } from './ports.ts'
import { kvOwner } from './kv.ts'

export interface SqlResult { rows: Record<string, unknown>[]; count: number }
export interface SqlConnection { query(sql: string, parameters?: readonly unknown[]): Promise<SqlResult> }
export const transactionContext = new AsyncLocalStorage<boolean>()
export const schemaVersion = 5
export function schema(postgres: boolean): string[] {
  const json = postgres ? 'JSONB' : 'TEXT', serial = postgres ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'
  return [
    'CREATE TABLE IF NOT EXISTS loom_state_schema (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL)',
    `CREATE TABLE IF NOT EXISTS loom_state_scopes (tenant TEXT NOT NULL, space TEXT NOT NULL, sequence BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(tenant,space))`,
    `CREATE TABLE IF NOT EXISTS loom_state_records (tenant TEXT NOT NULL, space TEXT NOT NULL, family TEXT NOT NULL, id TEXT NOT NULL,
      revision BIGINT NOT NULL CHECK(revision>0), body ${json} NOT NULL, relation_key TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, sort_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(tenant,space,family,id), FOREIGN KEY(tenant,space) REFERENCES loom_state_scopes(tenant,space))`,
    'CREATE INDEX IF NOT EXISTS loom_state_records_relation ON loom_state_records(tenant,space,family,relation_key,id)',
    'CREATE INDEX IF NOT EXISTS loom_state_records_active ON loom_state_records(tenant,space,family,active,id)',
    'CREATE INDEX IF NOT EXISTS loom_state_records_recent ON loom_state_records(tenant,space,family,sort_at DESC,id DESC)',
    `CREATE TABLE IF NOT EXISTS loom_state_jobs (tenant TEXT NOT NULL, space TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      body ${json} NOT NULL, generation BIGINT NOT NULL, sequence BIGINT NOT NULL, attempts INTEGER NOT NULL, due BIGINT NOT NULL,
      claim_owner TEXT, claim_token TEXT, claim_until BIGINT, held TEXT, PRIMARY KEY(tenant,space,kind,key),
      FOREIGN KEY(tenant,space) REFERENCES loom_state_scopes(tenant,space))`,
    'CREATE INDEX IF NOT EXISTS loom_state_jobs_due ON loom_state_jobs(tenant,space,due,sequence)',
    `CREATE TABLE IF NOT EXISTS loom_state_claims (tenant TEXT NOT NULL, space TEXT NOT NULL, token TEXT NOT NULL,
      kind TEXT NOT NULL, key TEXT NOT NULL, generation BIGINT NOT NULL, owner TEXT NOT NULL, expires BIGINT NOT NULL,
      pool TEXT NOT NULL, PRIMARY KEY(tenant,space,token),
      FOREIGN KEY(tenant,space) REFERENCES loom_state_scopes(tenant,space))`,
    'CREATE INDEX IF NOT EXISTS loom_state_claims_live ON loom_state_claims(tenant,space,expires,pool)',
    `CREATE TABLE IF NOT EXISTS loom_state_pools (tenant TEXT NOT NULL, space TEXT NOT NULL, name TEXT NOT NULL, capacity INTEGER NOT NULL,
      PRIMARY KEY(tenant,space,name), FOREIGN KEY(tenant,space) REFERENCES loom_state_scopes(tenant,space))`,
    `CREATE TABLE IF NOT EXISTS loom_state_leases (tenant TEXT NOT NULL, space TEXT NOT NULL, session_id TEXT NOT NULL,
      owner TEXT NOT NULL, epoch BIGINT NOT NULL CHECK(epoch>0), expires BIGINT NOT NULL,
      PRIMARY KEY(tenant,space,session_id), FOREIGN KEY(tenant,space) REFERENCES loom_state_scopes(tenant,space))`,
    `CREATE TABLE IF NOT EXISTS loom_state_changes (cursor ${serial}, tenant TEXT NOT NULL, space TEXT NOT NULL,
      family TEXT NOT NULL, id TEXT NOT NULL, revision BIGINT NOT NULL, deleted INTEGER NOT NULL,
      FOREIGN KEY(tenant,space) REFERENCES loom_state_scopes(tenant,space))`,
    'CREATE INDEX IF NOT EXISTS loom_state_changes_scope ON loom_state_changes(tenant,space,cursor)',
  ]
}
export async function initialize(connection: SqlConnection, postgres: boolean): Promise<void> {
  // Migration is serialized by the adapter, before any scope can be opened.
  await connection.query(schema(postgres)[0]!)
  const current = (await connection.query('SELECT version FROM loom_state_schema WHERE id=1')).rows[0]
  if (current && ![1, 2, 3, 4, schemaVersion].includes(number(current.version))) throw new Error('Unsupported Loom external-state schema; refusing to open')
  // Do not acquire DDL table locks on every pool startup: they can deadlock with unrelated live transactions.
  if (current && number(current.version) === schemaVersion) return
  if (current && number(current.version) === 1) {
    await connection.query('ALTER TABLE loom_state_records ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
  }
  if (current && number(current.version) < 3) {
    await connection.query('ALTER TABLE loom_state_jobs ADD COLUMN held TEXT')
  }
  if (current && number(current.version) < 4) {
    await connection.query("ALTER TABLE loom_state_records ADD COLUMN sort_at TEXT NOT NULL DEFAULT ''")
    const field = (name: string) => postgres ? `body->>'${name}'` : `json_extract(body,'$.${name}')`
    await connection.query(`UPDATE loom_state_records SET sort_at=COALESCE(${field('updatedAt')},${field('at')},${field('createdAt')},'')`)
  }
  for (const statement of schema(postgres).slice(1)) await connection.query(statement)
  if (current && number(current.version) < 3) {
    // Preserve live claims from v1/v2, including exclusion of overlapping generations.
    await connection.query(`INSERT INTO loom_state_claims(tenant,space,token,kind,key,generation,owner,expires,pool)
      SELECT tenant,space,claim_token,kind,key,generation,claim_owner,claim_until,'' FROM loom_state_jobs WHERE claim_token IS NOT NULL`)
  }
  if (current) await connection.query('UPDATE loom_state_schema SET version=$1 WHERE id=1', [schemaVersion])
  if (!current) await connection.query('INSERT INTO loom_state_schema(id,version) VALUES(1,$1)', [schemaVersion])
}
export function number(value: unknown): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new Error('Invalid durable-state integer')
  return n
}
function key(value: string): void { if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('Invalid state key') }
function family(value: Family, id?: string): void {
  if (!families.includes(value)) throw new Error('Unknown state family')
  if (value === 'kv' && id !== undefined && !kvOwner(id)) throw new Error('Unmapped KV family; register an owner and scope rules first')
}
function limit(value = 100): number { if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error('Page size must be 1..1000'); return value }
function duration(value: number, zero = false): void {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 86_400_000) throw new Error('Invalid state duration')
}
/** Scope-bound repositories sharing one serialized connection until the awaited callback commits or rolls back. */
export class SqlTransaction implements StateTransaction {
  readonly scope: Readonly<StateScope>
  private active = true
  private tail: Promise<unknown> = Promise.resolve()
  private pending = new Set<Promise<unknown>>()
  private failed = false
  private failure: unknown
  constructor(private connection: SqlConnection, scope: StateScope, private postgres: boolean) { this.scope = validateScope(scope) }
  /** Track whole repository operations, not just individual SQL statements across their internal awaits. */
  repositories(): StateTransaction {
    return { scope: this.scope,
      now: () => this.track(this.now()),
      get: <T>(kind: Family, id: string) => this.track(this.get<T>(kind, id)),
      scan: <T>(kind: Family, query?: RecordQuery) => this.track(this.scan<T>(kind, query)),
      put: <T>(kind: Family, id: string, value: T, expected: number, index?: RecordIndex) => this.track(this.put(kind, id, value, expected, index)),
      restore: <T>(kind: Family, id: string, value: T, revision: number, index?: RecordIndex, deleted?: boolean) => this.track(this.restore(kind, id, value, revision, index, deleted)),
      remove: (kind, id, expected) => this.track(this.remove(kind, id, expected)),
      changes: (after, count) => this.track(this.changes(after, count)),
      jobs: {
        enqueue: <T>(kind: string, id: string, value: T, delayMs?: number) => this.track(this.jobs.enqueue(kind, id, value, delayMs)),
        claim: <T>(owner: string, ttlMs: number, kinds: readonly string[], pool?: JobPool) => this.track(this.jobs.claim<T>(owner, ttlMs, kinds, pool)),
        renew: (claim, ttlMs) => this.track(this.jobs.renew(claim, ttlMs)),
        complete: claim => this.track(this.jobs.complete(claim)),
        retry: (claim, delayMs) => this.track(this.jobs.retry(claim, delayMs)),
        hold: (claim, reason) => this.track(this.jobs.hold(claim, reason)),
        resume: (kind, id, generation) => this.track(this.jobs.resume(kind, id, generation)),
        cancel: (kind, id) => this.track(this.jobs.cancel(kind, id)),
        list: <T>(count?: number) => this.track(this.jobs.list<T>(count)),
        hasClaims: () => this.track(this.jobs.hasClaims()),
        restore: job => this.track(this.jobs.restore(job)),
      },
      leases: {
        acquire: (id, owner, ttlMs) => this.track(this.leases.acquire(id, owner, ttlMs)),
        renew: (lease, ttlMs) => this.track(this.leases.renew(lease, ttlMs)),
        release: lease => this.track(this.leases.release(lease)),
        current: id => this.track(this.leases.current(id)),
        assert: lease => this.track(this.leases.assert(lease)),
      },
    }
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.then(value => { this.pending.delete(tracked); return value }, error => {
      this.pending.delete(tracked); this.failed = true; this.failure ??= error; throw error
    })
    this.pending.add(tracked)
    // Still returned as a rejected Promise; the transaction also records errors if a caller loses its await.
    void tracked.catch(() => {})
    return tracked
  }
  async finish(): Promise<void> {
    if (this.pending.size) { await this.discard(); throw new StateClosed('Repository operation escaped its transaction callback; await every operation') }
    this.active = false
    if (this.failed) throw this.failure
    await this.tail
  }
  async discard(): Promise<void> {
    this.active = false
    await Promise.allSettled([...this.pending])
    await this.tail.catch(() => {})
  }
  private async query(sql: string, values: readonly unknown[] = []): Promise<SqlResult> {
    if (!this.active) throw new StateClosed('Transaction has finished')
    const result = this.tail.then(() => {
      if (!this.active) throw new StateClosed('Transaction has finished')
      return this.connection.query(sql, values)
    })
    this.tail = result
    return result
  }
  private get prefix(): [string, string] { return [this.scope.tenantId, this.scope.spaceId] }
  private decode<T>(value: unknown): T { return (this.postgres ? structuredClone(value) : JSON.parse(String(value))) as T }
  async now(): Promise<number> {
    const sql = this.postgres ? 'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now'
      : "SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AS now"
    return number((await this.query(sql)).rows[0]!.now)
  }
  async get<T>(kind: Family, id: string): Promise<StateRecord<T> | undefined> {
    family(kind, id); key(id)
    const row = (await this.query('SELECT id,revision,body FROM loom_state_records WHERE tenant=$1 AND space=$2 AND family=$3 AND id=$4 AND deleted=0', [...this.prefix, kind, id])).rows[0]
    return row ? { id, revision: number(row.revision), value: this.decode<T>(row.body) } : undefined
  }
  async scan<T>(kind: Family, input: RecordQuery = {}): Promise<StateRecord<T>[]> {
    family(kind)
    if (input.recent && input.after !== undefined || input.before && !input.recent) throw new Error('Use an explicit recent cursor, not an ID cursor')
    const parameters: unknown[] = [...this.prefix, kind, input.after ?? '']
    let sql = `SELECT id,revision,body,sort_at,relation_key,active,deleted FROM loom_state_records WHERE tenant=$1 AND space=$2 AND family=$3 AND id>$4${input.includeDeleted ? '' : ' AND deleted=0'}`
    if (input.before) {
      parameters.push(input.before.at, input.before.id)
      sql += ` AND (sort_at<$5 OR (sort_at=$5 AND id<$6))`
    }
    if (input.relation !== undefined) { parameters.push(input.relation); sql += ` AND relation_key=$${parameters.length}` }
    if (input.active !== undefined) { parameters.push(input.active ? 1 : 0); sql += ` AND active=$${parameters.length}` }
    parameters.push(limit(input.limit)); sql += ` ORDER BY ${input.recent ? 'sort_at DESC,id DESC' : 'id'} LIMIT $${parameters.length}`
    return (await this.query(sql, parameters)).rows.map(row => ({ id: String(row.id), revision: number(row.revision), value: this.decode<T>(row.body), ...(input.recent ? { at: String(row.sort_at) } : {}),
      ...(input.includeIndex ? { index: { relation: String(row.relation_key), active: !!row.active, at: String(row.sort_at) } } : {}), ...(input.includeDeleted ? { deleted: !!row.deleted } : {}) }))
  }
  async put<T>(kind: Family, id: string, value: T, expected: number, index: RecordIndex = {}): Promise<number> {
    family(kind, id); key(id)
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Expected revision is required')
    const body = JSON.stringify(value)
    if (body === undefined) throw new Error('State values must be JSON')
    const object = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const timestamp = index.at ?? object.updatedAt ?? object.at ?? object.createdAt
    const at = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : ''
    const args = [...this.prefix, kind, id, expected + 1, body, index.relation ?? '', index.active ? 1 : 0]
    const result = expected === 0
      ? await this.query(`INSERT INTO loom_state_records(tenant,space,family,id,revision,body,relation_key,active,sort_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant,space,family,id) DO NOTHING`, [...args, at])
      : await this.query(`UPDATE loom_state_records SET revision=$5,body=$6,relation_key=$7,active=$8,sort_at=$10,deleted=0
        WHERE tenant=$1 AND space=$2 AND family=$3 AND id=$4 AND revision=$9`, [...args, expected, at])
    if (result.count !== 1) throw new StateConflict(`Revision conflict: ${kind}/${id}`)
    await this.query('INSERT INTO loom_state_changes(tenant,space,family,id,revision,deleted) VALUES($1,$2,$3,$4,$5,0)', [...this.prefix, kind, id, expected + 1])
    return expected + 1
  }
  async remove(kind: Family, id: string, expected: number): Promise<void> {
    family(kind, id); key(id)
    if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('Expected revision is required')
    const result = await this.query('UPDATE loom_state_records SET deleted=1,revision=revision+1 WHERE tenant=$1 AND space=$2 AND family=$3 AND id=$4 AND revision=$5 AND deleted=0', [...this.prefix, kind, id, expected])
    if (result.count !== 1) throw new StateConflict(`Revision conflict: ${kind}/${id}`)
    await this.query('INSERT INTO loom_state_changes(tenant,space,family,id,revision,deleted) VALUES($1,$2,$3,$4,$5,1)', [...this.prefix, kind, id, expected + 1])
  }
  async restore<T>(kind: Family, id: string, value: T, revision: number, index: RecordIndex = {}, deleted = false): Promise<void> {
    family(kind, id); key(id)
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Valid original record revision required')
    const object = value && typeof value === 'object' ? value as Record<string, unknown> : {}, timestamp = index.at ?? object.updatedAt ?? object.at ?? object.createdAt
    const at = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : ''
    const body = JSON.stringify(value); if (body === undefined) throw new Error('State values must be JSON')
    const result = await this.query(`INSERT INTO loom_state_records(tenant,space,family,id,revision,body,relation_key,active,sort_at,deleted)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant,space,family,id) DO NOTHING`, [...this.prefix, kind, id, revision, body, index.relation ?? '', index.active ? 1 : 0, at, deleted ? 1 : 0])
    if (result.count !== 1) throw new StateConflict('Restore destination record already exists')
    await this.query('INSERT INTO loom_state_changes(tenant,space,family,id,revision,deleted) VALUES($1,$2,$3,$4,$5,$6)', [...this.prefix, kind, id, revision, deleted ? 1 : 0])
  }
  async changes(after: number, count?: number): Promise<StateChange[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid change cursor')
    return (await this.query('SELECT cursor,family,id,revision,deleted FROM loom_state_changes WHERE tenant=$1 AND space=$2 AND cursor>$3 ORDER BY cursor LIMIT $4',
      [...this.prefix, after, limit(count)])).rows.map(row => ({ cursor: number(row.cursor), family: row.family as Family, id: String(row.id), revision: number(row.revision), deleted: !!row.deleted }))
  }
  readonly jobs = {
    enqueue: async <T>(kind: string, id: string, value: T, delayMs = 0): Promise<Job<T>> => {
      key(kind); key(id); duration(delayMs, true)
      const now = await this.now()
      const seq = number((await this.query('UPDATE loom_state_scopes SET sequence=sequence+1 WHERE tenant=$1 AND space=$2 RETURNING sequence', this.prefix)).rows[0]!.sequence)
      const row = (await this.query(`INSERT INTO loom_state_jobs(tenant,space,kind,key,body,generation,sequence,attempts,due)
        VALUES($1,$2,$3,$4,$5,1,$6,0,$7) ON CONFLICT(tenant,space,kind,key) DO UPDATE SET body=excluded.body,
        generation=loom_state_jobs.generation+1,sequence=excluded.sequence,attempts=0,due=excluded.due,claim_owner=NULL,claim_token=NULL,claim_until=NULL,held=NULL RETURNING *`,
      [...this.prefix, kind, id, JSON.stringify(value), seq, now + delayMs])).rows[0]!
      return this.job<T>(row)
    },
    claim: async <T>(owner: string, ttlMs: number, kinds: readonly string[], pool?: JobPool): Promise<JobClaim<T> | undefined> => {
      key(owner); duration(ttlMs)
      if (!kinds.length || kinds.length > 50) throw new Error('Explicit job kinds are required')
      kinds.forEach(key)
      if (pool) { key(pool.name); if (!Number.isInteger(pool.limit) || pool.limit < 1 || pool.limit > 1000) throw new Error('Invalid job pool limit') }
      const now = await this.now(), args = [...this.prefix, now, ...kinds]
      await this.query('DELETE FROM loom_state_claims WHERE tenant=$1 AND space=$2 AND expires<=$3', [...this.prefix, now])
      if (pool) {
        await this.query('INSERT INTO loom_state_pools(tenant,space,name,capacity) VALUES($1,$2,$3,$4) ON CONFLICT(tenant,space,name) DO NOTHING', [...this.prefix, pool.name, pool.limit])
        const capacity = number((await this.query('SELECT capacity FROM loom_state_pools WHERE tenant=$1 AND space=$2 AND name=$3', [...this.prefix, pool.name])).rows[0]!.capacity)
        if (capacity !== pool.limit) throw new StateConflict('Consumer pool capacity differs from persisted configuration')
        if (number((await this.query('SELECT count(*) AS n FROM loom_state_claims WHERE tenant=$1 AND space=$2 AND pool=$3', [...this.prefix, pool.name])).rows[0]!.n) >= capacity) return undefined
      }
      args.push(pool?.name ?? '')
      const row = (await this.query(`SELECT j.* FROM loom_state_jobs j WHERE tenant=$1 AND space=$2 AND due<=$3 AND held IS NULL
        AND (claim_until IS NULL OR claim_until<=$3) AND kind IN (${kinds.map((_, i) => `$${i + 4}`).join(',')})
        AND NOT EXISTS (SELECT 1 FROM loom_state_claims c WHERE c.tenant=j.tenant AND c.space=j.space AND c.key=j.key
          AND (c.kind=j.kind OR (c.pool=$${args.length} AND c.pool<>'')))
        ORDER BY sequence LIMIT 1${this.postgres ? ' FOR UPDATE SKIP LOCKED' : ''}`, args)).rows[0]
      if (!row) return undefined
      const token = randomUUID(), until = now + ttlMs
      await this.query('UPDATE loom_state_jobs SET claim_owner=$5,claim_token=$6,claim_until=$7,attempts=attempts+1 WHERE tenant=$1 AND space=$2 AND kind=$3 AND key=$4',
        [...this.prefix, row.kind, row.key, owner, token, until])
      await this.query('INSERT INTO loom_state_claims(tenant,space,token,kind,key,generation,owner,expires,pool) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [...this.prefix, token, row.kind, row.key, row.generation, owner, until, pool?.name ?? ''])
      return { ...this.job<T>(row), attempts: number(row.attempts) + 1, owner, token, until }
    },
    renew: async (claim: JobClaim, ttlMs: number): Promise<JobClaim | undefined> => {
      duration(ttlMs); const now = await this.now(), until = now + ttlMs
      const result = await this.query(`UPDATE loom_state_jobs SET claim_until=$9 WHERE ${this.claimWhere()} AND claim_until>$8`, [...this.claimArgs(claim), now, until])
      if (result.count === 1) await this.query('UPDATE loom_state_claims SET expires=$5 WHERE tenant=$1 AND space=$2 AND token=$3 AND owner=$4', [...this.prefix, claim.token, claim.owner, until])
      return result.count === 1 ? { ...claim, until } : undefined
    },
    complete: async (claim: JobClaim): Promise<boolean> => {
      const now = await this.now()
      const result = await this.query(`DELETE FROM loom_state_jobs WHERE ${this.claimWhere()} AND claim_until>$8`, [...this.claimArgs(claim), now])
      await this.releaseClaim(claim)
      return result.count === 1
    },
    retry: async (claim: JobClaim, delayMs: number): Promise<boolean> => {
      duration(delayMs, true); const now = await this.now()
      const result = await this.query(`UPDATE loom_state_jobs SET due=$9,claim_owner=NULL,claim_token=NULL,claim_until=NULL WHERE ${this.claimWhere()} AND claim_until>$8`,
        [...this.claimArgs(claim), now, now + delayMs])
      await this.releaseClaim(claim)
      return result.count === 1
    },
    hold: async (claim: JobClaim, reason: string): Promise<boolean> => {
      key(reason); const now = await this.now()
      const result = await this.query(`UPDATE loom_state_jobs SET held=$9,claim_owner=NULL,claim_token=NULL,claim_until=NULL WHERE ${this.claimWhere()} AND claim_until>$8`, [...this.claimArgs(claim), now, reason])
      await this.releaseClaim(claim)
      return result.count === 1
    },
    resume: async (kind: string, id: string, generation: number): Promise<boolean> => {
      key(kind); key(id)
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid job generation')
      return (await this.query(`UPDATE loom_state_jobs SET held=NULL,due=$6 WHERE tenant=$1 AND space=$2 AND kind=$3 AND key=$4 AND generation=$5 AND held IS NOT NULL`,
        [...this.prefix, kind, id, generation, await this.now()])).count === 1
    },
    cancel: async (kind: string, id: string): Promise<void> => { key(kind); key(id); await this.query('DELETE FROM loom_state_jobs WHERE tenant=$1 AND space=$2 AND kind=$3 AND key=$4', [...this.prefix, kind, id]) },
    list: async <T>(count?: number): Promise<Job<T>[]> => (await this.query('SELECT * FROM loom_state_jobs WHERE tenant=$1 AND space=$2 ORDER BY sequence LIMIT $3', [...this.prefix, limit(count)])).rows.map(row => this.job<T>(row)),
    hasClaims: async (): Promise<boolean> => number((await this.query('SELECT count(*) AS n FROM loom_state_claims WHERE tenant=$1 AND space=$2 AND expires>$3', [...this.prefix, await this.now()])).rows[0]!.n) > 0,
    restore: async (job: Job): Promise<void> => {
      key(job.kind); key(job.key)
      for (const value of [job.generation, job.sequence]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid restored job identity')
      if (!Number.isSafeInteger(job.attempts) || job.attempts < 0 || !Number.isSafeInteger(job.due) || job.due < 0) throw new Error('Invalid restored job state')
      const result = await this.query(`INSERT INTO loom_state_jobs(tenant,space,kind,key,body,generation,sequence,attempts,due,held)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant,space,kind,key) DO NOTHING`, [...this.prefix, job.kind, job.key, JSON.stringify(job.value), job.generation, job.sequence, job.attempts, job.due, job.held ?? 'Offline restore: reconcile before resuming'])
      if (result.count !== 1) throw new StateConflict('Restored job already exists')
      await this.query('UPDATE loom_state_scopes SET sequence=CASE WHEN sequence<$3 THEN $3 ELSE sequence END WHERE tenant=$1 AND space=$2', [...this.prefix, job.sequence])
    },
  }
  private job<T>(row: Record<string, unknown>): Job<T> {
    return { kind: String(row.kind), key: String(row.key), value: this.decode<T>(row.body), generation: number(row.generation), sequence: number(row.sequence), attempts: number(row.attempts), due: number(row.due), ...(row.held ? { held: String(row.held) } : {}) }
  }
  private async releaseClaim(claim: JobClaim): Promise<void> {
    await this.query('DELETE FROM loom_state_claims WHERE tenant=$1 AND space=$2 AND token=$3 AND owner=$4 AND kind=$5 AND key=$6 AND generation=$7',
      [...this.prefix, claim.token, claim.owner, claim.kind, claim.key, claim.generation])
  }
  private claimWhere(): string { return 'tenant=$1 AND space=$2 AND kind=$3 AND key=$4 AND generation=$5 AND claim_owner=$6 AND claim_token=$7' }
  private claimArgs(claim: JobClaim): unknown[] { return [...this.prefix, claim.kind, claim.key, claim.generation, claim.owner, claim.token] }
  readonly leases = {
    acquire: async (sessionId: string, owner: string, ttlMs: number): Promise<SessionLease | undefined> => {
      key(sessionId); key(owner); duration(ttlMs); const now = await this.now()
      const row = (await this.query(`INSERT INTO loom_state_leases(tenant,space,session_id,owner,epoch,expires) VALUES($1,$2,$3,$4,1,$5)
        ON CONFLICT(tenant,space,session_id) DO UPDATE SET owner=excluded.owner,epoch=loom_state_leases.epoch+1,expires=excluded.expires
        WHERE loom_state_leases.expires<=$6 RETURNING *`, [...this.prefix, sessionId, owner, now + ttlMs, now])).rows[0]
      return row ? this.lease(row) : undefined
    },
    renew: async (lease: SessionLease, ttlMs: number): Promise<SessionLease | undefined> => {
      duration(ttlMs); const now = await this.now(), until = now + ttlMs
      const result = await this.query(`UPDATE loom_state_leases SET expires=$7 WHERE ${this.leaseWhere()} AND expires>$6`, [...this.leaseArgs(lease), now, until])
      return result.count === 1 ? { ...lease, until } : undefined
    },
    release: async (lease: SessionLease): Promise<boolean> => (await this.query(`UPDATE loom_state_leases SET expires=0 WHERE ${this.leaseWhere()}`, this.leaseArgs(lease))).count === 1,
    current: async (id: string): Promise<SessionLease | undefined> => {
      key(id)
      const row = (await this.query('SELECT * FROM loom_state_leases WHERE tenant=$1 AND space=$2 AND session_id=$3', [...this.prefix, id])).rows[0]
      return row ? this.lease(row) : undefined
    },
    assert: async (lease: SessionLease): Promise<void> => {
      const now = await this.now(), current = await this.leases.current(lease.sessionId)
      if (!current || current.owner !== lease.owner || current.epoch !== lease.epoch || current.until <= now) throw new LeaseLost('Session writer lease is stale')
    },
  }
  private leaseWhere(): string { return 'tenant=$1 AND space=$2 AND session_id=$3 AND owner=$4 AND epoch=$5' }
  private leaseArgs(lease: SessionLease): unknown[] { return [...this.prefix, lease.sessionId, lease.owner, lease.epoch] }
  private lease(row: Record<string, unknown>): SessionLease { return { sessionId: String(row.session_id), owner: String(row.owner), epoch: number(row.epoch), until: number(row.expires) } }
}
