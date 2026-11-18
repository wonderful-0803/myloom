import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessDenied, DurableArtifacts, LocalBlobStore, migrateLegacy, migrationDryRun, PostgresStateStore, ProductAccess, SqliteStateStore } from '../../src/state/index.ts'
import type { DurableControl, MigrationMapping, StateStore } from '../../src/state/index.ts'
import { frozenLegacy } from './fixtures/legacy.ts'

const url = process.env.LOOM_STATE_TEST_DATABASE_URL
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Migration tests require disposable _test database')
const folders: string[] = [], stores: StateStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
for (const kind of ['sqlite', 'postgres'] as const) (kind === 'postgres' && !url ? describe.skip : describe)(`offline state migration: ${kind}`, () => {
  async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), 'loom-import-')); folders.push(folder)
    const frozen = await frozenLegacy(folder), scope = { tenantId: `test-${randomUUID()}`, spaceId: 'personal' }
    const mapping: MigrationMapping = { scope, frozenSha256: frozen.sha256, installation: { id: 'installed', appId: 'cli_test', botId: 'ou_bot', operator: 'ou_owner', tenantKey: 'test-tenant', name: 'Fixture', enabled: true, since: '2026-11-11T00:00:00.000Z' } }
    const store = kind === 'postgres' ? await PostgresStateStore.open({ connectionString: url }) : await SqliteStateStore.open(join(folder, 'target.sqlite')); stores.push(store)
    const blobs = await LocalBlobStore.open(join(folder, 'blobs'))
    return { folder, frozen, scope, mapping, store, blobs }
  }
  it('dry-runs without changing frozen bytes, preserves human versions/Word bytes and quarantines pending effects and sends', async () => {
    const f = await fixture(), before = await readFile(f.frozen.path), report = await migrationDryRun(f.frozen.path, f.mapping)
    expect(report.ready).toBe(true); expect(report.heldEffects).toBe(1); expect(report.unknownDeliveries).toBe(1)
    expect(JSON.stringify(report)).not.toContain('R1'); expect(await readFile(f.frozen.path)).toEqual(before)
    await migrateLegacy(f.frozen.path, f.mapping, f.store, f.blobs)
    const access = new ProductAccess('installed'), artifacts = new DurableArtifacts({ ...f, authorize: (tx, actor, subject, op, version) => access.artifact(tx, actor, subject, op, version) })
    expect((await artifacts.read('ou_owner', f.frozen.ticketId, 2)).bytes.toString()).toBe('Human v2 keeps R1')
    expect((await artifacts.read('ou_owner', f.frozen.ticketId, 1, true)).bytes).toEqual(f.frozen.bytes)
    await f.store.transaction(f.scope, async tx => {
      const control = (await tx.get<DurableControl>('control', f.frozen.ticketId))!.value
      expect(control.mode).toBe('human'); expect(control.operations.some(value => value.status === 'unknown')).toBe(true)
      expect((await tx.scan<{ status: string }>('outbox'))[0]!.value.status).toBe('unknown')
      expect(await tx.jobs.list()).toEqual([])
      expect((await tx.get<{ status: string }>('migration', 'status'))?.value.status).toBe('ready')
      expect((await tx.scan('legacy')).some(row => row.id.startsWith('effect/'))).toBe(true)
    })
    expect(await readFile(f.frozen.path)).toEqual(before)
    expect((await migrateLegacy(f.frozen.path, f.mapping, f.store, f.blobs)).datasetHash).toBe(report.datasetHash)
  })
  it('leaves interrupted imports unavailable and resumes the same verified dataset without duplicate versions', async () => {
    const f = await fixture(), access = new ProductAccess('installed')
    await expect(migrateLegacy(f.frozen.path, f.mapping, f.store, { put: async () => { throw new Error('Volume unavailable') }, head: f.blobs.head.bind(f.blobs),
      read: f.blobs.read.bind(f.blobs), delete: f.blobs.delete.bind(f.blobs), list: f.blobs.list.bind(f.blobs) })).rejects.toThrow('Volume unavailable')
    await expect(f.store.transaction(f.scope, tx => access.configuration(tx))).rejects.toBeInstanceOf(AccessDenied)
    await migrateLegacy(f.frozen.path, f.mapping, f.store, f.blobs)
    await f.store.transaction(f.scope, async tx => { expect(await tx.scan('artifact-version')).toHaveLength(2); expect((await access.user(tx, 'ou_owner')).installation.appId).toBe('cli_test') })
  })
  it('blocks unmapped keys, changed backups and populated destinations rather than guessing identity or overwriting state', async () => {
    const f = await fixture()
    await expect(migrationDryRun(f.frozen.path, { ...f.mapping, frozenSha256: '0'.repeat(64) })).rejects.toThrow('digest')
    await f.store.transaction(f.scope, tx => tx.put('ticket', 'existing', { personal: true }, 0))
    await expect(migrateLegacy(f.frozen.path, f.mapping, f.store, f.blobs)).rejects.toThrow('empty destination')
    const db = new DatabaseSync(f.frozen.path); db.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run('private-unknown-key', '"secret"'); db.close()
    const { bytesHash } = await import('../../src/state/blobs.ts')
    const report = await migrationDryRun(f.frozen.path, { ...f.mapping, frozenSha256: bytesHash(await readFile(f.frozen.path)) })
    expect(report.ready).toBe(false); expect(JSON.stringify(report)).not.toContain('secret'); expect(report.blockers).toContain('Unmapped KV family requires explicit ownership registration')
  })
})
