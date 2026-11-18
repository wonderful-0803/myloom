import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportExternalState, restoreExternalState, LocalBlobStore, SqliteStateStore, PostgresStateStore, ProductAccess, StateConflict } from '../../src/state/index.ts'
import { productFixture, testURL } from './fixtures/product.ts'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SqlSessionPersistence } from '../../src/dsh-state/provider.ts'
import { SqlKvBackend } from '../../src/dsh-state/metadata.ts'
import { contract, descriptor } from '../dsh-state/fixtures/metadata.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
for (const kind of ['sqlite', 'postgres'] as const) (kind === 'postgres' && !testURL ? describe.skip : describe)(`external rollback: ${kind}`, () => {
  it('retains CAS revisions, tombstones, blobs and request sequences, expires logins, and holds restored jobs', async () => {
    const f = await productFixture(kind); closes.push(f.close)
    const ref = await f.blobs.put(f.scope, Buffer.from('Only synthetic immutable bytes'))
    let job: any
    await f.store.transaction(f.scope, async tx => {
      await tx.put('kv', 'prompt-version:row', { n: 1 }, 0, { relation: 'private', active: true, at: '2026-11-11T00:00:00.000Z' })
      await tx.put('kv', 'prompt-version:row', { n: 2 }, 1, { relation: 'private', active: true, at: '2026-11-11T01:00:00.000Z' })
      await tx.put('kv', 'prompt-version:removed', 1, 0); await tx.remove('kv', 'prompt-version:removed', 1)
      await tx.put('blob', ref.sha256, { ref, refs: 1, status: 'live', updatedAt: await tx.now(), writers: [] }, 0)
      await tx.put('auth-session', 'private-login', { token: 'fixture' }, 0)
      job = await tx.jobs.enqueue('domain.launch', 'fixture', { ticketId: 'not-executed' })
    })
    const directory = join(f.folder, 'backup')
    const report = await exportExternalState(f.store, f.scope, f.blobs, directory, 'installed', 'ou_owner')
    expect(report.blobs).toBe(1)
    // Restore across adapters in both directions when the disposable PostgreSQL server is enabled.
    const clean = kind === 'sqlite' && testURL ? await PostgresStateStore.open({ connectionString: testURL }) : await SqliteStateStore.open(join(f.folder, 'restored.sqlite'))
    closes.push(() => clean.close())
    const targetBlobs = await LocalBlobStore.open(join(f.folder, 'restored-objects'))
    await restoreExternalState(clean, f.scope, targetBlobs, directory)
    await clean.transaction(f.scope, async tx => {
      expect(await tx.get('kv', 'prompt-version:row')).toMatchObject({ revision: 2, value: { n: 2 } })
      expect(await tx.get('kv', 'prompt-version:removed')).toBeUndefined()
      expect((await tx.scan('kv', { includeDeleted: true })).find(row => row.id === 'prompt-version:removed')).toMatchObject({ revision: 2, deleted: true })
      expect(await tx.scan('auth-session')).toEqual([])
      expect((await tx.jobs.list())[0]).toMatchObject({ sequence: job.sequence, generation: job.generation, held: expect.any(String) })
      expect(await tx.jobs.claim('new-compute', 10_000, ['domain.launch'])).toBeUndefined()
      expect((await new ProductAccess('installed').configuration(tx)).settings.paused).toBe(true)
    })
    await expect(clean.transaction(f.scope, tx => tx.put('kv', 'prompt-version:removed', 'resurrect', 0))).rejects.toBeInstanceOf(StateConflict)
    expect(await targetBlobs.read(f.scope, ref)).toEqual(await f.blobs.read(f.scope, ref))
    await expect(restoreExternalState(clean, { ...f.scope, spaceId: randomUUID() }, targetBlobs, directory)).rejects.toThrow('scope mismatch')
    await expect(restoreExternalState(clean, f.scope, targetBlobs, directory)).rejects.toThrow('empty destination')
  })
  it('never produces or restores a native attachment backup without verified bytes', async () => {
    const f = await productFixture(kind); closes.push(f.close)
    const ctx = new Context(), provider = new SqlSessionPersistence(ctx, f), session = Session.create(SessionId('native-backup-file'))
    closes.push(async () => { await provider.dispose(); await ctx.fiber.dispose() })
    const bytes = Buffer.from('Only synthetic native file bytes'), ref = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name: 'sample.txt', bytes: bytes.length }
    session.append('user/message', { id: 'native-file', role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] } as never, { surfaceOp: 'append' })
    const writer = await provider.create(session.header); await writer.append(session.snapshotEvents()); await writer.close()
    await expect(exportExternalState(f.store, f.scope, f.blobs, join(f.folder, 'incomplete'), 'installed', 'ou_owner')).rejects.toThrow('attachment')
    let copied = false
    const native = { read: async () => bytes, validate: async () => {}, put: async (entry: any) => { expect(Buffer.from(entry.data, 'base64')).toEqual(bytes); copied = true }, verify: async () => { expect(copied).toBe(true) } }
    const directory = join(f.folder, 'complete')
    await exportExternalState(f.store, f.scope, f.blobs, directory, 'installed', 'ou_owner', native)
    const clean = await SqliteStateStore.open(join(f.folder, 'restored-native.sqlite')); closes.push(() => clean.close())
    const blobs = await LocalBlobStore.open(join(f.folder, 'restored-native-blobs'))
    await expect(restoreExternalState(clean, f.scope, blobs, directory)).rejects.toThrow('attachment')
    expect(await clean.transaction(f.scope, tx => tx.scan('native-session'))).toEqual([])
    await restoreExternalState(clean, f.scope, blobs, directory, native)
    expect(copied).toBe(true)
    expect(await clean.transaction(f.scope, tx => tx.scan('native-event'))).toHaveLength(1)
    expect((await clean.transaction(f.scope, tx => tx.get<any>('migration', 'status')))?.value.executionEnabled).toBe(false)
  })
  it('refuses a live consumer/source and a different actor rather than taking an inconsistent rollback snapshot', async () => {
    const f = await productFixture(kind); closes.push(f.close)
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('source/installed', 'live', 10_000)))!
    await expect(exportExternalState(f.store, f.scope, f.blobs, join(f.folder, 'live'), 'installed', 'ou_owner')).rejects.toThrow('Stop the source')
    await f.store.transaction(f.scope, tx => tx.leases.release(lease))
    const subscription = (await f.store.transaction(f.scope, tx => tx.leases.acquire('subscription/installed', 'live-group', 10_000)))!
    await expect(exportExternalState(f.store, f.scope, f.blobs, join(f.folder, 'live-group'), 'installed', 'ou_owner')).rejects.toThrow('Stop the source')
    await f.store.transaction(f.scope, tx => tx.leases.release(subscription))
    await expect(exportExternalState(f.store, f.scope, f.blobs, join(f.folder, 'other'), 'installed', 'ou_other')).rejects.toThrow('authorized')
  })
  it('includes native records in the stopped snapshot and refuses an active native writer', async () => {
    const f = await productFixture(kind); closes.push(f.close)
    const ctx = new Context(), provider = new SqlSessionPersistence(ctx, { store: f.store, scope: f.scope })
    closes.push(async () => { await provider.dispose(); await ctx.fiber.dispose() })
    const session = Session.create(SessionId('native-backup')), writer = await provider.create(session.header)
    await writer.append([session.append('model/selection', { provider: 'fixture', model: 'retained' })]); await writer.flush()
    await expect(exportExternalState(f.store, f.scope, f.blobs, join(f.folder, 'live-native'), 'installed', 'ou_owner')).rejects.toThrow('Close all native')
    await writer.close()
    const archive = join(f.folder, 'native-backup'); await exportExternalState(f.store, f.scope, f.blobs, archive, 'installed', 'ou_owner')
    const clean = await SqliteStateStore.open(join(f.folder, 'native-restored.sqlite')); closes.push(() => clean.close())
    const blobs = await LocalBlobStore.open(join(f.folder, 'native-restored-objects'))
    await restoreExternalState(clean, f.scope, blobs, archive)
    const nextCtx = new Context(), restored = new SqlSessionPersistence(nextCtx, { store: clean, scope: f.scope })
    closes.push(async () => { await restored.dispose(); await nextCtx.fiber.dispose() })
    const reader = await restored.open(session.id, 'read')
    expect(reader.header).toEqual(session.header); expect((await reader.read()).events[0]!.data).toMatchObject({ model: 'retained' })
  })
  it('requires the metadata owner to drain and preserves its exact snapshot in rollback', async () => {
    const f = await productFixture(kind); closes.push(f.close)
    const backend = new SqlKvBackend({ ...f, units: ['workspace'], contract }); closes.push(() => backend.close())
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('workspaces', 'ws', { title: 'Synthetic archived workspace' }); await unit.setGlobal({ initialized: true, workspaceIds: ['ws'] })
    await expect(exportExternalState(f.store, f.scope, f.blobs, join(f.folder, 'live-metadata'), 'installed', 'ou_owner')).rejects.toThrow('metadata owners')
    await backend.close()
    const folder = join(f.folder, 'metadata-backup'); await exportExternalState(f.store, f.scope, f.blobs, folder, 'installed', 'ou_owner')
    const restored = await SqliteStateStore.open(join(f.folder, 'metadata-restored.sqlite')); closes.push(() => restored.close())
    await restoreExternalState(restored, f.scope, await LocalBlobStore.open(join(f.folder, 'metadata-restored-objects')), folder)
    const next = new SqlKvBackend({ store: restored, scope: f.scope, units: ['workspace'], contract }); closes.push(() => next.close())
    const view = await (await next.kv.open(descriptor)).loadAll()
    expect(view.tables.workspaces!.ws).toEqual({ title: 'Synthetic archived workspace' }); expect(view.global).toEqual({ initialized: true, workspaceIds: ['ws'] })
  })
})
