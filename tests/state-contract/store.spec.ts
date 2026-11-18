import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { LeaseLost, PostgresStateStore, SqliteStateStore, StateClosed, StateConflict } from '../../src/state/index.ts'
import type { StateStore, StateTransaction } from '../../src/state/index.ts'

const databaseUrl = process.env.LOOM_STATE_TEST_DATABASE_URL
// Explicit opt-in: never fall back to DATABASE_URL or a running Loom instance's credentials.
if (databaseUrl && !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('State integration tests require a database name ending in _test')
const stores: StateStore[] = [], directories: string[] = []
it('requires explicit PostgreSQL configuration instead of creating tables in an ambient default database', async () => {
  await expect(PostgresStateStore.open({})).rejects.toThrow('Explicit PostgreSQL')
})
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const scope = () => ({ tenantId: `test-${randomUUID()}`, spaceId: 'personal' })
async function adapter(kind: 'sqlite' | 'postgres', path?: string): Promise<StateStore> {
  const store = kind === 'postgres' ? await PostgresStateStore.open({ connectionString: databaseUrl, application_name: 'loom-state-contract' })
    : await SqliteStateStore.open(path ?? ':memory:')
  stores.push(store); return store
}
for (const kind of ['sqlite', 'postgres'] as const) (kind === 'postgres' && !databaseUrl ? describe.skip : describe)(`async state contract: ${kind}`, () => {
  it('awaits the complete callback, rolls back all repositories and rejects escaped transactions', async () => {
    const store = await adapter(kind), id = scope()
    let escaped!: StateTransaction
    await expect(store.transaction(id, async tx => {
      escaped = tx
      await tx.put('ticket', 't', { title: 'partial' }, 0)
      await setTimeout(10)
      await tx.jobs.enqueue('launch', 't', {})
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    await expect(escaped.get('ticket', 't')).rejects.toBeInstanceOf(StateClosed)
    await store.transaction(id, async tx => {
      expect(await tx.get('ticket', 't')).toBeUndefined()
      expect(await tx.jobs.list()).toEqual([])
      expect(await tx.changes(0)).toEqual([])
    })
  })
  it('isolates scopes, enforces CAS, and bounds scans and change cursors', async () => {
    const store = await adapter(kind), a = scope(), b = { ...a, spaceId: 'other' }
    await store.transaction(a, async tx => { await tx.put('ticket', 'same', { title: 'private' }, 0, { active: true, relation: 'owner' }) })
    await store.transaction(b, async tx => {
      expect(await tx.get('ticket', 'same')).toBeUndefined()
      expect(await tx.changes(0)).toEqual([])
      await tx.put('ticket', 'same', { title: 'different' }, 0)
    })
    await expect(store.transaction(a, async tx => tx.put('ticket', 'same', {}, 0))).rejects.toBeInstanceOf(StateConflict)
    await store.transaction(a, async tx => {
      expect(await tx.scan('ticket', { active: false })).toEqual([])
      expect((await tx.scan('ticket', { active: true, relation: 'owner' }))[0]?.value).toEqual({ title: 'private' })
      const first = (await tx.changes(0))[0]!
      await tx.put('ticket', 'same', { title: 'new' }, 1)
      expect((await tx.changes(first.cursor))[0]?.revision).toBe(2)
    })
    await expect(store.transaction({ tenantId: '', spaceId: 'x' }, async () => {})).rejects.toThrow('Explicit')
    await expect(store.transaction(a, async tx => tx.scan('ticket', { limit: 1001 }))).rejects.toThrow('Page size')
    await expect(store.transaction(a, async tx => tx.put('kv', 'unregistered-private-key', 'value', 0))).rejects.toThrow('Unmapped KV')
  })
  it('rolls back lost awaits and prevents queued repository writes from escaping after rollback', async () => {
    const store = await adapter(kind), id = scope()
    let write!: Promise<number>
    await expect(store.transaction(id, async tx => {
      write = tx.put('ticket', 'lost-await', {}, 0)
      return 'callback returned before write'
    })).rejects.toThrow('await every operation')
    await expect(write).rejects.toBeInstanceOf(StateClosed)
    let queued: Promise<unknown>[] = []
    await expect(store.transaction(id, async tx => {
      queued = [tx.put('ticket', 'first', {}, 0), tx.put('ticket', 'second', {}, 0)]
      throw new Error('cancel whole transaction')
    })).rejects.toThrow('cancel whole transaction')
    await Promise.allSettled(queued)
    await store.transaction(id, async tx => { expect(await tx.scan('ticket')).toEqual([]); expect(await tx.changes(0)).toEqual([]) })
  })
  it('round-trips JSON scalars and retains a tombstone revision across deletion to prevent ABA writes', async () => {
    const store = await adapter(kind), id = scope()
    await store.transaction(id, async tx => {
      for (const [i, value] of ['plain text', 0, false, null, [1, 'a']].entries()) {
        await tx.put('kv', `prompt-built-in:value-${i}`, value, 0)
        expect((await tx.get('kv', `prompt-built-in:value-${i}`))?.value).toEqual(value)
      }
      await tx.remove('kv', 'prompt-built-in:value-0', 1)
      expect(await tx.get('kv', 'prompt-built-in:value-0')).toBeUndefined()
      expect(await tx.scan('kv')).toHaveLength(4)
    })
    await expect(store.transaction(id, tx => tx.put('kv', 'prompt-built-in:value-0', 'recreate', 0))).rejects.toBeInstanceOf(StateConflict)
    await expect(store.transaction(id, tx => tx.put('kv', 'prompt-built-in:value-0', 'stale', 1))).rejects.toBeInstanceOf(StateConflict)
    await store.transaction(id, async tx => {
      expect(await tx.put('kv', 'prompt-built-in:value-0', 'explicit revive', 2)).toBe(3)
      expect((await tx.get('kv', 'prompt-built-in:value-0'))?.revision).toBe(3)
    })
  })
  it('rejects nested transactions instead of deadlocking or committing an independent write', async () => {
    const store = await adapter(kind), id = scope()
    await expect(store.transaction(id, async tx => {
      await tx.put('kv', 'prompt-version:outer', 1, 0)
      await store.transaction(id, async inner => { await inner.put('kv', 'prompt-version:inner', 1, 0) })
    })).rejects.toThrow('Nested state transactions')
    await store.transaction(id, async tx => { expect(await tx.scan('kv')).toEqual([]) })
  })
  it('serializes overlapping async transactions without committing the first callback early', async () => {
    const store = await adapter(kind), id = scope(), events: string[] = []
    await Promise.all([
      store.transaction(id, async tx => { events.push('first'); await tx.put('kv', 'prompt-revision', 1, 0); await setTimeout(20); events.push('commit') }),
      store.transaction(id, async tx => { events.push('second'); expect((await tx.get('kv', 'prompt-revision'))?.value).toBe(1) }),
    ])
    expect(events).toEqual(['first', 'commit', 'second'])
  })
  it('claims once and fences late completion, renewal and retry after a newer generation', async () => {
    const store = await adapter(kind), id = scope()
    await store.transaction(id, async tx => { await tx.jobs.enqueue('launch', 't', { generation: 1 }) })
    const claims = await Promise.all(['a', 'b'].map(owner => store.transaction(id, async tx => tx.jobs.claim(owner, 10_000, ['launch']))))
    expect(claims.filter(Boolean)).toHaveLength(1)
    const old = claims.find(Boolean)!
    await store.transaction(id, async tx => {
      const updated = await tx.jobs.enqueue('launch', 't', { generation: 2 })
      expect(updated.generation).toBe(2)
      expect(await tx.jobs.complete(old)).toBe(false)
      expect(await tx.jobs.renew(old, 1000)).toBeUndefined()
      expect(await tx.jobs.retry(old, 0)).toBe(false)
      const claim = await tx.jobs.claim('new', 10_000, ['launch'])
      expect(claim?.value).toEqual({ generation: 2 })
      expect(await tx.jobs.complete(claim!)).toBe(true)
    })
  })
  it('reclaims expired jobs using a new token and preserves queue ordering and attempts', async () => {
    const store = await adapter(kind), id = scope()
    const old = await store.transaction(id, async tx => {
      await tx.jobs.enqueue('input', 'first', 1); await tx.jobs.enqueue('input', 'second', 2)
      return (await tx.jobs.claim('dead', 10, ['input']))!
    })
    await setTimeout(30)
    await store.transaction(id, async tx => {
      const retry = (await tx.jobs.claim('alive', 10_000, ['input']))!
      expect(retry.key).toBe('first'); expect(retry.attempts).toBe(2); expect(retry.token).not.toBe(old.token)
      expect(await tx.jobs.complete(old)).toBe(false)
      expect(await tx.jobs.complete(retry)).toBe(true)
      expect((await tx.jobs.claim('alive', 10_000, ['input']))?.key).toBe('second')
    })
  })
  it('grants one live Session writer and fences every stale epoch after expiry and release', async () => {
    const store = await adapter(kind), id = scope()
    const lease = await store.transaction(id, async tx => (await tx.leases.acquire('session', 'a', 10_000))!)
    expect(lease.epoch).toBe(1)
    expect(await store.transaction(id, async tx => tx.leases.acquire('session', 'b', 1000))).toBeUndefined()
    await store.transaction(id, async tx => { expect(await tx.leases.release(lease)).toBe(true) })
    const next = await store.transaction(id, async tx => (await tx.leases.acquire('session', 'b', 10_000))!)
    expect(next.epoch).toBe(2)
    await expect(store.transaction(id, async tx => tx.leases.assert(lease))).rejects.toBeInstanceOf(LeaseLost)
    await store.transaction(id, async tx => {
      expect(await tx.leases.release(lease)).toBe(false)
      expect(await tx.leases.renew(lease, 1000)).toBeUndefined()
      expect(await tx.leases.renew(next, 10_000)).toBeDefined()
      expect(await tx.leases.release(next)).toBe(true)
      expect((await tx.leases.acquire('session', 'c', 10_000))?.epoch).toBe(3)
    })
    const expiring = await store.transaction(id, async tx => (await tx.leases.acquire('expiring-session', 'old', 1))!)
    await setTimeout(30)
    const replacement = await store.transaction(id, async tx => (await tx.leases.acquire('expiring-session', 'new', 10_000))!)
    expect(replacement.epoch).toBe(expiring.epoch + 1)
    await expect(store.transaction(id, async tx => tx.leases.assert(expiring))).rejects.toBeInstanceOf(LeaseLost)
  })
  it('recovers committed jobs in a new adapter without an in-process wakeup', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'loom-state-')); directories.push(folder)
    const path = join(folder, 'state.sqlite'), first = await adapter(kind, path), id = scope()
    await first.transaction(id, async tx => { await tx.put('ticket', 't', { title: 'durable' }, 0); await tx.jobs.enqueue('launch', 't', {}) })
    await first.close()
    const next = await adapter(kind, path)
    await next.transaction(id, async tx => {
      expect((await tx.get('ticket', 't'))?.value).toEqual({ title: 'durable' })
      expect((await tx.jobs.claim('new-process', 1000, ['launch']))?.key).toBe('t')
    })
  })
})

const describePostgres = databaseUrl ? describe : describe.skip
describePostgres('PostgreSQL fault and independent-client checks', () => {
  it('opens a new pool during a live write transaction without repeating DDL or waiting on business tables', async () => {
    const a = await adapter('postgres'), id = scope()
    let ready!: () => void, release!: () => void
    const checkpoint = new Promise<void>(done => { ready = done }), held = new Promise<void>(done => { release = done })
    const write = a.transaction(id, async tx => { await tx.put('ticket', 't', {}, 0); ready(); await held; await tx.put('outbox', 'message', {}, 0) })
    let opening: Promise<StateStore> | undefined
    try {
      await checkpoint
      opening = adapter('postgres')
      await Promise.race([opening, setTimeout(1000).then(() => { throw new Error('Pool startup waited for unrelated business DDL locks') })])
    } finally { release(); await write; await opening }
  })
  it('rolls back an interrupted backend before any external callback runs', async () => {
    const app = `loom-state-fault-${randomUUID()}`, admin = new Pool({ connectionString: databaseUrl })
    const store = await PostgresStateStore.open({ connectionString: databaseUrl, application_name: app }); stores.push(store)
    const id = scope(); let terminate!: () => void, resume!: () => void, dispatched = false
    const ready = new Promise<void>(done => { terminate = done }), suspended = new Promise<void>(done => { resume = done })
    const result = store.transaction(id, async tx => {
      await tx.put('ticket', 't', { incomplete: true }, 0); terminate(); await suspended
      await tx.jobs.enqueue('launch', 't', {})
    }).then(() => { dispatched = true })
    const rejected = expect(result).rejects.toBeDefined()
    try {
      await ready
      const killed = await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1', [app])
      expect(killed.rowCount).toBe(1); resume(); await rejected
      expect(dispatched).toBe(false)
      await store.transaction(id, async tx => { expect(await tx.get('ticket', 't')).toBeUndefined(); expect(await tx.jobs.list()).toEqual([]) })
    } finally { resume(); await admin.end() }
  })
  it('enforces writer and job fencing across independent connection pools', async () => {
    const a = await adapter('postgres'), b = await adapter('postgres'), id = scope()
    const leases = await Promise.all([a, b].map((store, i) => store.transaction(id, async tx => tx.leases.acquire('s', String(i), 10_000))))
    expect(leases.filter(Boolean)).toHaveLength(1)
    await a.transaction(id, async tx => { await tx.jobs.enqueue('launch', 't', {}) })
    const claims = await Promise.all([a, b].map((store, i) => store.transaction(id, async tx => tx.jobs.claim(String(i), 10_000, ['launch']))))
    expect(claims.filter(Boolean)).toHaveLength(1)
  })
})

it('refuses a legacy SQLite file before journal changes, and rejects unknown future state schemas', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'loom-state-schema-')); directories.push(folder)
  const legacy = join(folder, 'legacy.sqlite'), source = new DatabaseSync(legacy)
  source.exec('CREATE TABLE ticket(id TEXT PRIMARY KEY, value TEXT NOT NULL)'); source.close()
  const before = await readFile(legacy)
  await expect(SqliteStateStore.open(legacy)).rejects.toThrow('offline migration')
  expect(await readFile(legacy)).toEqual(before)
  const path = join(folder, 'new.sqlite'), store = await adapter('sqlite', path)
  await store.close()
  const future = new DatabaseSync(path)
  future.exec('UPDATE loom_state_schema SET version=999'); future.close()
  await expect(SqliteStateStore.open(path)).rejects.toThrow('Unsupported')
})

it.each([1, 2, 3, 4])('upgrades external schema %i to 5 without resetting existing records or live job claims', async version => {
  const folder = await mkdtemp(join(tmpdir(), 'loom-state-migration-')); directories.push(folder)
  const path = join(folder, 'v1.sqlite'), db = new DatabaseSync(path)
  const { schema } = await import('../../src/state/sql.ts')
  for (const sql of schema(false).filter(sql => (version >= 3 || !sql.includes('loom_state_claims') && !sql.includes('loom_state_pools')) && !sql.includes('records_recent'))) {
    db.exec(sql.replace(version < 3 ? ', held TEXT' : '/*none*/', '').replace(version < 4 ? ", sort_at TEXT NOT NULL DEFAULT ''" : '/*none*/', '').replace(version === 1 ? ', deleted INTEGER NOT NULL DEFAULT 0' : '/*none*/', ''))
  }
  db.exec(`INSERT INTO loom_state_schema VALUES(1,${version}); INSERT INTO loom_state_scopes(tenant,space) VALUES('test-migration','personal'); INSERT INTO loom_state_records(tenant,space,family,id,revision,body) VALUES('test-migration','personal','ticket','t',7,'{}')`)
  db.prepare(`INSERT INTO loom_state_jobs(tenant,space,kind,key,body,generation,sequence,attempts,due,claim_owner,claim_token,claim_until)
    VALUES('test-migration','personal','work','active','{}',1,1,1,0,'old','old-token',?)`).run(Date.now() + 60_000)
  if (version >= 3) db.prepare("INSERT INTO loom_state_claims VALUES('test-migration','personal','old-token','work','active',1,'old',?,'')").run(Date.now() + 60_000)
  db.close()
  const store = await adapter('sqlite', path)
  await store.transaction({ tenantId: 'test-migration', spaceId: 'personal' }, async tx => {
    expect((await tx.get('ticket', 't'))?.revision).toBe(7)
    await tx.remove('ticket', 't', 7)
    expect(await tx.put('ticket', 't', { retained: true }, 8)).toBe(9)
    await tx.jobs.enqueue('work', 'active', { newer: true })
    expect(await tx.jobs.claim('new', 10_000, ['work'])).toBeUndefined()
  })
})
