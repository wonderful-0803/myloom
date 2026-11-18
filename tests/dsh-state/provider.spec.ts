import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionFormatUnsupportedError, SessionHandleClosedError, SessionOwnershipLostError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError, SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqlSessionPersistence } from '../../src/dsh-state/provider.ts'
import { eventKey } from '../../src/dsh-state/storage.ts'
import { SqliteStateStore } from '../../src/state/sqlite.ts'
import { PostgresStateStore } from '../../src/state/postgres.ts'
import { hash } from '../../src/state/hash.ts'
import type { StateScope, StateStore } from '../../src/state/ports.ts'

const url = process.env.LOOM_STATE_TEST_DATABASE_URL
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Native provider tests require a disposable _test database')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const header = (id = 'worker-test'): SessionHeader => Session.create(SessionId(id)).header
function events(count: number, start = 0): SessionEvent[] {
  const session = Session.create(SessionId('fixture'))
  return Array.from({ length: count + start }, (_, i) => session.append('model/selection', { provider: 'fixture', model: `model-${i}` })).slice(start)
}
async function fixture(dialect: 'sqlite' | 'postgres', options: { ttlMs?: number; maxBufferedBytes?: number; onFailure?: (id: SessionId, error: unknown) => void } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'loom-native-')); cleanups.push(() => rm(folder, { recursive: true, force: true }))
  const scope = { tenantId: `test-${randomUUID()}`, spaceId: 'native-b1' }
  const open = async (otherScope: StateScope = scope, storeOverride?: StateStore) => {
    const store = storeOverride ?? (dialect === 'postgres' ? await PostgresStateStore.open({ connectionString: url }) : await SqliteStateStore.open(join(folder, 'state.sqlite')))
    if (!storeOverride) cleanups.push(() => store.close())
    const ctx = new Context(), provider = new SqlSessionPersistence(ctx, { store, scope: otherScope, ...options })
    cleanups.push(async () => { await provider.dispose().catch(() => {}); await ctx.fiber.dispose() })
    return { store, ctx, provider }
  }
  return { ...await open(), open, scope }
}
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !url ? describe.skip : describe)(`native SessionPersistence: ${dialect}`, () => {
  it('borrows the application lease without another epoch and refuses a second handle even with the same lease capability', async () => {
    const f = await fixture(dialect), h = header(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire(h.id, 'application-owner', 3000)))!
    const running = f.provider.useLease(lease, async binding => {
      const writer = await f.provider.create(h); await writer.append(events(1)); await binding.flush()
      expect(await f.store.transaction(f.scope, tx => tx.leases.current(h.id))).toMatchObject({ owner: lease.owner, epoch: lease.epoch })
      entered.resolve(); await release.promise
    })
    void running.catch(() => {}); await entered.promise
    try {
      const other = await f.open()
      await expect(other.provider.open(h.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      await expect(other.provider.useLease(lease, async () => { await other.provider.open(h.id, 'write') })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    } finally { release.resolve(); await running }
    const current = await f.store.transaction(f.scope, tx => tx.leases.current(h.id))
    expect(current).toMatchObject({ owner: lease.owner, epoch: lease.epoch }); expect(current!.until).toBeGreaterThan(0)
    await f.store.transaction(f.scope, tx => tx.leases.release(lease))
    const next = await (await f.open()).provider.open(h.id, 'write'); expect((await next.read()).events).toHaveLength(1)
  })
  it('limits a borrowed scope to one Session and aborts its host before provider teardown waits for it', async () => {
    const f = await fixture(dialect), h = header(), lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire(h.id, 'application-owner', 3000)))!
    await f.provider.useLease(lease, async () => {
      await expect(f.provider.create(header('wrong-session'))).rejects.toThrow('differs')
    })
    const entered = Promise.withResolvers<void>()
    const active = f.provider.useLease(lease, async binding => {
      await f.provider.create(h); entered.resolve()
      await new Promise<void>(resolve => binding.signal.addEventListener('abort', () => resolve(), { once: true }))
      // Host cancellation may still append final Session events while draining.
      f.ctx.emit('session/event', Session.create(h.id), events(1)[0]!)
    })
    await entered.promise; await f.provider.dispose(); await active
    expect(await f.store.transaction(f.scope, tx => tx.get('native-session', 'wrong-session'))).toBeUndefined()
    const other = await f.open(), reader = await other.provider.open(h.id, 'read')
    expect((await reader.read()).events).toHaveLength(1)
  })
  it('materializes empty headers, preserves revision through ownership churn and isolates scope', async () => {
    const f = await fixture(dialect), h = header()
    const writer = await f.provider.create(h); await writer.flush()
    const before = await f.provider.stat(h.id)
    expect(before).toMatchObject({ header: h, eventCount: 0, formatStatus: 'current' })
    expect(await f.provider.list()).toEqual([before])
    await expect(f.provider.create(h)).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    const other = await f.open(); await expect(other.provider.open(h.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    const reader = await other.provider.open(h.id, 'read'); expect((await reader.read()).events).toEqual([])
    await expect(reader.append([])).rejects.toBeInstanceOf(SessionReadOnlyError)
    await expect(reader.flush()).rejects.toBeInstanceOf(SessionReadOnlyError)
    await writer.close(); const next = await other.provider.open(h.id, 'write'); await next.flush()
    expect((await f.provider.stat(h.id))!.revision).toBe(before!.revision)
    const isolated = await f.open({ ...f.scope, spaceId: 'other' })
    expect(await isolated.provider.stat(h.id)).toBeUndefined()
    await expect(isolated.provider.open(h.id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  })
  it('serializes borrowed append snapshots, paginates beyond 1000 and restores exact fork metadata', async () => {
    const f = await fixture(dialect), h = header(), writer = await f.provider.create(h), reader = await f.provider.open(h.id, 'read')
    const batch = structuredClone(events(1003)), pending = writer.append(batch)
    ;(batch[0]!.data as any).model = 'caller-mutated'
    await pending; await writer.flush()
    const slice = await reader.read(1000, 10)
    expect(slice.events).toHaveLength(3); expect(slice.eventState).toBe('detached')
    expect((await reader.read(0, 1)).events[0]!.data).toMatchObject({ model: 'model-0' })
    ;(slice.events[0]!.data as any).model = 'reader-mutated'
    expect((await reader.read(1000, 1)).events[0]!.data).toMatchObject({ model: 'model-1000' })
    expect((await reader.read(2000)).events).toEqual([])
    const inherited = (await reader.read(0, 2)).events, child = { ...header('fork'), isSeeded: true, parentSession: h.id }
    await expect(f.provider.create(child)).rejects.toThrow('inheritedEventCount')
    const fork = await f.provider.create(child, { inheritedEventCount: SessionLogOffset(2) }); await fork.append(inherited); await fork.close()
    const cold = await (await f.open()).provider.open(child.id, 'read')
    expect(cold.inheritedEventCount).toBe(2); expect(cold.header).toEqual(child); expect((await cold.read()).events).toEqual(inherited)
  }, 20_000)
  it('rejects invalid headers, non-JSON batches, seq gaps and duplicate rewrites without damaging the prefix', async () => {
    const f = await fixture(dialect), h = header()
    await expect(f.provider.create({ ...h, version: 99 } as never)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    await expect(f.provider.create({ ...h, cwd: 'relative' })).rejects.toThrow()
    await expect(f.provider.create({ ...h, isSeeded: false }, { inheritedEventCount: SessionLogOffset(1) })).rejects.toThrow('zero')
    const writer = await f.provider.create(h)
    await expect(writer.append([{ ...events(1)[0]!, data: { bad: BigInt(1) } }] as never)).rejects.toThrow('JSON')
    await expect(writer.append([{ ...events(1)[0]!, time: 1.5 }] as never)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await expect(writer.append(events(1, 1))).rejects.toThrow('seq mismatch')
    await writer.append(events(1))
    await expect(writer.append(events(1))).rejects.toThrow('seq mismatch')
    await expect(writer.append([{ ...events(1, 1)[0]!, type: 'future/required' }] as never)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    expect((await writer.read()).events).toHaveLength(1)
    await writer.append(events(1, 1)); expect((await writer.read()).events).toHaveLength(2)
  })
  it('routes actual SessionStore events, barriers and disposal exactly once; constructor seeds are not re-enqueued', async () => {
    const f = await fixture(dialect); await f.ctx.plugin(SessionStore)
    const session = f.ctx.sessions.prepare(SessionId('live')), writer = await f.provider.create(session.header)
    const detach = f.ctx.sessions.enter(session); f.ctx.sessions.announce(session)
    session.append('model/selection', { provider: 'fixture', model: 'live' })
    expect(await f.ctx.sessions.flush(session)).toBe(true)
    expect((await writer.read()).events).toHaveLength(1)
    session.append('model/selection', { provider: 'fixture', model: 'last' })
    detach(); await writer.close()
    const other = await f.open(), cold = await other.provider.open(session.id, 'read')
    expect((await cold.read()).events).toHaveLength(2)
    const fork = Session.create(SessionId('seed'), (await cold.read()).events, { ...header('seed'), isSeeded: true, parentSession: session.id }, SessionLogOffset(2))
    const forkWriter = await f.provider.create(fork.header, { inheritedEventCount: fork.inheritedEventCount })
    await forkWriter.append(fork.snapshotEvents())
    const detachFork = f.ctx.sessions.enter(fork); f.ctx.sessions.announce(fork)
    await f.ctx.sessions.flush(fork)
    expect((await forkWriter.read()).events.length).toBe(fork.seq)
    detachFork()
  })
  it('retries a failed live batch ahead of newer events, including ambiguous committed acknowledgements', async () => {
    const f = await fixture(dialect), writer = await f.provider.create(header())
    const original = f.store.transaction.bind(f.store)
    let fail: 'before' | 'after' | undefined = 'after'
    const spy = vi.spyOn(f.store, 'transaction').mockImplementation(async (scope, work) => {
      if (fail === 'before') { fail = undefined; throw new Error('database unavailable') }
      const value = await original(scope, work)
      if (fail === 'after') { fail = undefined; throw new Error('COMMIT acknowledgement lost') }
      return value
    })
    const session = Session.create(writer.id)
    f.ctx.emit('session/event', session, events(1)[0]!)
    await expect(writer.flush()).rejects.toThrow('acknowledgement lost')
    f.ctx.emit('session/event', session, events(1, 1)[0]!)
    await writer.flush(); expect((await writer.read()).events).toHaveLength(2)
    fail = 'before'; f.ctx.emit('session/event', session, events(1, 2)[0]!)
    await expect(writer.flush()).rejects.toThrow('unavailable')
    await writer.flush(); spy.mockRestore()
    expect((await writer.read()).events).toHaveLength(3)
  })
  it('permanently fences an old handle using A leases, without affecting its readonly access or the replacement owner', async () => {
    const f = await fixture(dialect, { ttlMs: 10_000 }), h = header(), writer = await f.provider.create(h)
    await writer.append(events(1))
    const old = await f.store.transaction(f.scope, async tx => {
      const old = (await tx.leases.current(h.id))!; await tx.leases.release(old); return old
    })
    const other = await f.open(), next = await other.provider.open(h.id, 'write')
    await expect(writer.append(events(1, 1))).rejects.toBeInstanceOf(SessionOwnershipLostError)
    await expect(writer.flush()).rejects.toBeInstanceOf(SessionOwnershipLostError)
    await next.append(events(1, 1)); await writer.close()
    expect((await writer.close())).toBeUndefined()
    const current = await f.store.transaction(f.scope, tx => tx.leases.current(h.id))
    expect(current!.epoch).toBeGreaterThan(old.epoch); expect(current!.until).toBeGreaterThan(0)
    await expect(writer.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
    expect((await next.read()).events).toHaveLength(2)
  })
  it('renews a healthy idle writer and never silently reacquires an expired lease', async () => {
    const f = await fixture(dialect, { ttlMs: 300 }), writer = await f.provider.create(header())
    await delay(450)
    const other = await f.open(); await expect(other.provider.open(writer.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.flush()
  })
  it('detects missing, altered and future-format committed events rather than treating them as absent sessions', async () => {
    const f = await fixture(dialect), h = header(), writer = await f.provider.create(h)
    await writer.append(events(2)); await writer.close()
    await f.store.transaction(f.scope, async tx => {
      const row = (await tx.get<any>('native-event', eventKey(h.id, 1)))!
      await tx.put('native-event', row.id, { ...row.value, sha256: 'invalid' }, row.revision, { relation: hash(h.id) })
    })
    await expect(f.provider.open(h.id, 'read')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await f.store.transaction(f.scope, async tx => {
      const row = (await tx.get<any>('native-event', eventKey(h.id, 1)))!, event = { ...JSON.parse(row.value.eventJSON), type: 'future/required' }
      await tx.put('native-event', row.id, { ...row.value, eventJSON: JSON.stringify(event), sha256: hash(event) }, row.revision, { relation: hash(h.id) })
    })
    await expect(f.provider.open(h.id, 'write')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    await f.store.transaction(f.scope, async tx => {
      const row = (await tx.get<any>('native-event', eventKey(h.id, 1)))!; await tx.remove('native-event', row.id, row.revision)
    })
    await expect(f.provider.open(h.id, 'write')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  })
  it('refuses an orphan committed tail rather than silently truncating database corruption', async () => {
    const f = await fixture(dialect), h = header(), writer = await f.provider.create(h)
    await writer.append(events(1)); await writer.close()
    await f.store.transaction(f.scope, async tx => {
      const event = events(1, 1)[0]!
      await tx.put('native-event', eventKey(h.id, 1), { sessionId: h.id, eventJSON: JSON.stringify(event), sha256: hash(event) }, 0, { relation: hash(h.id) })
    })
    await expect(f.provider.open(h.id, 'read')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  })
  it('round-trips lossless JSON text that cannot be represented as raw PostgreSQL JSONB strings', async () => {
    const f = await fixture(dialect), text = 'nul\0and-unpaired\ud800', h = { ...header(), agentPreset: text }
    const writer = await f.provider.create(h), event = { ...events(1)[0]!, data: { provider: 'fixture', model: text } } as SessionEvent
    await writer.append([event]); await writer.flush(); await writer.close()
    const reader = await (await f.open()).provider.open(h.id, 'read')
    expect(reader.header.agentPreset).toBe(text); expect((await reader.read()).events).toEqual([event])
    await expect(f.provider.create({ ...header('invalid\0id') })).rejects.toThrow()
  })
  it('aggregates failures while flushing other writers and rejects overflow instead of acknowledging dropped events', async () => {
    const f = await fixture(dialect, { maxBufferedBytes: 1024 }), bad = await f.provider.create(header('bad')), good = await f.provider.create(header('good'))
    const event = { ...events(1)[0]!, data: { provider: 'fixture', model: 'x'.repeat(2000) } } as SessionEvent
    f.ctx.emit('session/event', Session.create(bad.id), event)
    f.ctx.emit('session/event', Session.create(good.id), events(1)[0]!)
    await expect(f.provider.flush()).rejects.toBeInstanceOf(AggregateError)
    expect((await good.read()).events).toHaveLength(1)
    await expect(bad.close()).rejects.toBeInstanceOf(AggregateError)
  })
  it('observes cancellation before work, refuses competing providers and drains live data on provider teardown', async () => {
    const f = await fixture(dialect), writer = await f.provider.create(header())
    await expect(f.provider.open(writer.id, 'read', { signal: AbortSignal.abort() })).rejects.toThrow()
    await expect(writer.append(events(1), { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(() => new SqlSessionPersistence(f.ctx, { store: f.store, scope: f.scope })).toThrow('Disable')
    f.ctx.emit('session/event', Session.create(writer.id), events(1)[0]!)
    await f.provider.dispose()
    expect((await (await (await f.open()).provider.open(writer.id, 'read')).read()).events).toHaveLength(1)
    await expect(f.provider.open(writer.id, 'read')).rejects.toThrow('closing')
  })
})
