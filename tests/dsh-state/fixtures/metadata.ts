/** Isolated native metadata/archive fixtures; no real user profile or network connector. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StateScope, StateStore } from '../../../src/state/ports.ts'
import { SqliteStateStore } from '../../../src/state/sqlite.ts'
import { PostgresStateStore } from '../../../src/state/postgres.ts'
import { hash } from '../../../src/state/hash.ts'
import { SqlKvBackend } from '../../../src/dsh-state/metadata.ts'
export const testURL = process.env.LOOM_STATE_TEST_DATABASE_URL
if (testURL && !new URL(testURL).pathname.endsWith('_test')) throw new Error('Explicit disposable native metadata test database required')
export const contract = { harnessVersion: '0.2.1-rc.3' as const, profileRevision: hash('synthetic-deployment'), presets: { fixture: hash('synthetic-composition') }, models: [{ provider: 'fixture', model: 'synthetic' }] }
export const descriptor = { name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true, layout: 'single' as const }
export async function metadataFixture(dialect: 'sqlite' | 'postgres') {
  const folder = await mkdtemp(join(tmpdir(), 'loom-native-meta-')), scope = { tenantId: `test-${randomUUID()}`, spaceId: 'native-b4' }
  const stores: StateStore[] = [], backends: SqlKvBackend[] = []
  const open = async (target: StateScope = scope) => {
    const store = dialect === 'sqlite' ? await SqliteStateStore.open(join(folder, 'state.sqlite')) : await PostgresStateStore.open({ connectionString: testURL }); stores.push(store)
    const backend = new SqlKvBackend({ store, scope: target, units: ['workspace'], contract }); backends.push(backend)
    return { store, backend }
  }
  const initial = await open()
  return { ...initial, scope, folder, open, close: async () => {
    for (const backend of backends.reverse()) await backend.close().catch(() => {})
    for (const store of stores.reverse()) await store.close()
    await rm(folder, { force: true, recursive: true })
  } }
}
