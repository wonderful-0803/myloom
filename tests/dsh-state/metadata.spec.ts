import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SqlSessionPersistence } from '../../src/dsh-state/provider.ts'
import { SqlKvBackend, unitLeaseId, unitRecordId } from '../../src/dsh-state/metadata.ts'
import { hash } from '../../src/state/hash.ts'
import { metadataFixture, testURL, descriptor, contract } from './fixtures/metadata.ts'
import { apply as mountMetadata } from '../../src/dsh-metadata.ts'
import type { StateStore } from '../../src/state/ports.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !testURL ? describe.skip : describe)(`native KV: ${dialect}`, () => {
  it('mounts the real storage facet and rejects changed runtime preset composition or model before inference', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const root = new Context(), provider = new SqlSessionPersistence(root, f)
    closes.push(async () => { await provider.dispose(); await root.fiber.dispose() })
    await root.plugin(Storage)
    let content = 'synthetic-composition', ctx!: Context
    root.reflect.provide('agentPresets', { readDocument: async () => ({ content }) })
    await root.inject(['storage', 'sessionPersistence'], child => { ctx = child })
    const path = join(f.folder, 'contract.json'); await writeFile(path, JSON.stringify(contract), { mode: 0o600 })
    await mountMetadata(ctx, { contractFile: path, units: ['workspace'] })
    const backend = ctx.storage.backend.get('loom-sql') as SqlKvBackend
    await backend.kv.open(descriptor)
    await provider.verifyEnvironment('fixture', { provider: 'fixture', model: 'synthetic' } as never)
    content = 'changed-preset'
    await expect(provider.verifyEnvironment('fixture', { provider: 'fixture', model: 'synthetic' } as never)).rejects.toThrow('composition differs')
    content = 'synthetic-composition'
    await expect(provider.verifyEnvironment('fixture', { provider: 'fixture', model: 'unreviewed' } as never)).rejects.toThrow('model')
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('metadata-plugin-guard', 'application', 5000)))!
    await provider.useLease(lease, binding => binding.assertCurrent())
  })
  it('round trips opaque JSON, singleton, prototype-like keys and durable deletion across owners and scopes', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const unit = await f.backend.kv.open(descriptor), original = { title: '零\0孤\ud800', sessions: ['s'], nested: { n: 2 } }
    const pending = unit.putRecord('workspaces', '__proto__', original); original.nested.n = 99; await pending
    await unit.setGlobal({ initialized: true, order: ['x'] }); const view = await unit.loadAll()
    expect(view.tables.workspaces!.__proto__).toEqual({ title: '零\0孤\ud800', sessions: ['s'], nested: { n: 2 } })
    ;(view.tables.workspaces!.__proto__ as any).nested.n = -1
    expect((await unit.loadAll()).tables.workspaces!.__proto__).toMatchObject({ nested: { n: 2 } })
    await unit.close(); const next = await (await f.open()).backend.kv.open(descriptor)
    expect((await next.loadAll()).global).toEqual({ initialized: true, order: ['x'] })
    await next.deleteRecord('workspaces', '__proto__'); await next.deleteRecord('workspaces', '__proto__')
    expect(Object.keys((await next.loadAll()).tables.workspaces!)).toEqual([])
    const isolated = await (await f.open({ ...f.scope, spaceId: 'other' })).backend.kv.open(descriptor)
    expect((await isolated.loadAll()).global).toBeNull()
  })
  it('rejects competing domain caches, then loads committed metadata in a new owner', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const unit = await f.backend.kv.open(descriptor), other = await f.open()
    await expect(f.backend.kv.open(descriptor)).rejects.toThrow('already open')
    await expect(other.backend.kv.open(descriptor)).rejects.toThrow('another compute')
    await unit.putRecord('workspaces', 'one', { title: 'committed' }); await unit.close()
    const next = await other.backend.kv.open(descriptor)
    expect((await next.loadAll()).tables.workspaces!.one).toEqual({ title: 'committed' })
    await expect(unit.putRecord('workspaces', 'two', {})).rejects.toMatchObject({ code: 'closed' })
  })
  it('fences stale metadata and its managed native host without releasing a replacement owner', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const unit = await f.backend.kv.open(descriptor), ctx = new Context(), provider = new SqlSessionPersistence(ctx, { store: f.store, scope: f.scope })
    closes.push(async () => { await provider.dispose(); await ctx.fiber.dispose() })
    provider.attachMetadata({ assertCurrent: tx => f.backend.assertOwnership(tx), verify: async () => {} })
    const id = SessionId('metadata-bound-worker'), lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire(id, 'agent-owner', 5000)))!
    await provider.useLease(lease, async binding => {
      await binding.assertCurrent()
      const replacement = await f.store.transaction(f.scope, async tx => {
        const old = (await tx.leases.current(unitLeaseId('workspace')))!
        await tx.leases.release(old); return (await tx.leases.acquire(unitLeaseId('workspace'), 'replacement', 5000))!
      })
      await expect(binding.assertCurrent()).rejects.toThrow()
      await expect(unit.putRecord('workspaces', 'bad', {})).rejects.toThrow()
      await unit.close()
      expect(await f.store.transaction(f.scope, tx => tx.leases.current(replacement.sessionId))).toMatchObject({ owner: replacement.owner, epoch: replacement.epoch, until: replacement.until })
    })
  })
  it('refuses shape, layout, version and environment drift rather than erasing cached data', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const unit = await f.backend.kv.open(descriptor); await unit.putRecord('workspaces', 'retained', { v: 1 }); await unit.close()
    await expect(f.backend.kv.open({ ...descriptor, version: 3 })).rejects.toMatchObject({ code: 'version-mismatch' })
    await expect(f.backend.kv.open({ ...descriptor, layout: 'per-record' })).rejects.toMatchObject({ code: 'malformed-medium' })
    await expect(f.backend.kv.open({ ...descriptor, tables: ['unknown'] })).rejects.toMatchObject({ code: 'malformed-medium' })
    const wrong = new SqlKvBackend({ ...f, units: ['workspace'], contract: { ...contract, profileRevision: hash('changed') } }); closes.push(() => wrong.close())
    await expect(wrong.kv.open(descriptor)).rejects.toThrow('deployment contract differs')
    expect((await (await f.backend.kv.open(descriptor)).loadAll()).tables.workspaces!.retained).toEqual({ v: 1 })
  })
  it('honors per-record compatible versions, skips foreign stamps and preserves other records', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const shape = { ...descriptor, name: 'cache', version: 1, layout: 'per-record' as const }, backend = new SqlKvBackend({ ...f, units: ['cache'], contract }); closes.push(() => backend.close())
    const first = await backend.kv.open(shape); await first.putRecord('workspaces', 'retained', { value: 1 }); await first.close()
    const second = await backend.kv.open({ ...shape, version: 2, compatibleVersions: [1] }); expect((await second.loadAll()).tables.workspaces!.retained).toEqual({ value: 1 })
    await second.putRecord('workspaces', 'new', { value: 2 }); await expect(second.putRecord('workspaces', '../unsafe', {})).rejects.toThrow('Invalid')
    await second.close()
    const third = await backend.kv.open({ ...shape, version: 2 }); expect((await third.loadAll()).tables.workspaces).toEqual({ new: { value: 2 } })
    expect(await f.store.transaction(f.scope, tx => tx.get('native-record', unitRecordId('cache', 'workspaces', 'retained')))).toBeDefined()
  })
  it('drains accepted writes on backend close and rejects corrupted committed JSON loudly', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const unit = await f.backend.kv.open(descriptor), pending = unit.setGlobal({ flushed: true })
    await f.backend.close(); await pending
    const other = await f.open(), restored = await other.backend.kv.open(descriptor)
    expect((await restored.loadAll()).global).toEqual({ flushed: true })
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get<any>('native-record', unitRecordId('workspace', '', '')))!; await tx.put('native-record', row.id, { ...row.value, valueJSON: '{bad' }, row.revision, { relation: 'workspace' }) })
    await expect(restored.loadAll()).rejects.toMatchObject({ code: 'malformed-medium' })
    await expect(restored.putRecord('workspaces', 'after-corruption', {})).rejects.toMatchObject({ code: 'closed' })
  })
  it('fails the old cached owner on a lost COMMIT acknowledgement and reloads the actual committed value', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    let fail = false, failures = 0
    const wrapped: StateStore = { dialect: f.store.dialect, close: async () => {}, transaction: async (scope, work) => {
      const result = await f.store.transaction(scope, work)
      if (fail) { fail = false; throw new Error('Synthetic metadata COMMIT response lost') }
      return result
    } }
    const backend = new SqlKvBackend({ store: wrapped, scope: f.scope, units: ['workspace'], contract, onFailure: () => { failures++ } }); closes.push(() => backend.close())
    const unit = await backend.kv.open(descriptor); fail = true
    await expect(unit.putRecord('workspaces', 'once', { title: 'Actually committed' })).rejects.toThrow('response lost')
    expect(backend.signal.aborted).toBe(true); expect(failures).toBe(1)
    await expect(unit.putRecord('workspaces', 'after-failure', {})).rejects.toThrow('owner is closed')
    await backend.close()
    const restored = await (await f.open()).backend.kv.open(descriptor)
    expect((await restored.loadAll()).tables.workspaces).toEqual({ once: { title: 'Actually committed' } })
  })
})
