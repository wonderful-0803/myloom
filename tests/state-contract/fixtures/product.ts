/** Isolated external-state instance with a synthetic installation and no credentials or network side effects. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsSchema } from '../../../src/policy.ts'
import { ProductAccess, LocalBlobStore, initializeCompany, PostgresStateStore, SqliteStateStore } from '../../../src/state/index.ts'
export const testURL = process.env.LOOM_STATE_TEST_DATABASE_URL
if (testURL && !new URL(testURL).pathname.endsWith('_test')) throw new Error('External product tests require a disposable _test database')
export async function productFixture(dialect: 'sqlite' | 'postgres', group = false) {
  const folder = await mkdtemp(join(tmpdir(), 'loom-external-')), scope = { tenantId: `test-${randomUUID()}`, spaceId: group ? randomUUID() : 'personal' }
  const open = () => dialect === 'postgres' ? PostgresStateStore.open({ connectionString: testURL }) : SqliteStateStore.open(join(folder, 'state.sqlite'))
  const store = await open(), blobs = await LocalBlobStore.open(join(folder, 'objects')), access = new ProductAccess('installed'), since = new Date(Date.now() - 60_000).toISOString()
  const installation = { id: 'installed', appId: 'cli_test', botId: 'ou_bot', tenantKey: 'test-tenant', operator: 'ou_owner', name: 'Fixture', enabled: true, since }
  const settings = SettingsSchema.parse({ sources: { github: { enabled: false }, feishu: { enabled: true, config: { ownerOnly: true, directMessages: true, chats: [{ chatId: 'oc_test', listen: 'all' }] } } },
    policy: { sources: { feishu: { allowed: [{ id: 'ou_owner' }], ...(group ? { workspace: { mode: 'group', operator: 'ou_owner', chatId: 'oc_test', name: 'Fictional group', masters: [{ id: 'ou_owner', name: 'Owner' }, { id: 'ou_second', name: 'Second' }], spaceId: scope.spaceId, since } } : {}) } } }, eval: { mode: 'auto' } })
  await initializeCompany(store, scope, installation, settings)
  return { folder, scope, store, blobs, access, installation, settings, open,
    raw: (id: string, content: string, extra: Record<string, unknown> = {}) => ({ message_id: `om_${id}`, chat_id: 'oc_test', chat_type: 'group', sender_id: 'ou_owner', sender_type: 'user', content, create_time: String(Date.now()), mentions: [{ id: 'ou_bot' }], ...extra }),
    close: async () => { await store.close(); await rm(folder, { recursive: true, force: true }) } }
}
