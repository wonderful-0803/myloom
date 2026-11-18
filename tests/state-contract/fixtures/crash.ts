/** Subprocess fixture: intentionally killable on either side of COMMIT, with no model/Feishu credentials. */
import { SqliteStateStore } from '../../../src/state/sqlite.ts'
import { PostgresStateStore } from '../../../src/state/postgres.ts'
import { DurableConsumer } from '../../../src/state/consumer.ts'
const input = JSON.parse(process.argv[2]!) as { kind: 'sqlite' | 'postgres'; path: string; tenantId: string; phase: 'before' | 'after' | 'claimed' }
const store = input.kind === 'postgres' ? await PostgresStateStore.open({ connectionString: process.env.LOOM_STATE_TEST_DATABASE_URL }) : await SqliteStateStore.open(input.path)
const hold = () => new Promise<never>(() => { setInterval(() => {}, 1000); process.stdout.write('READY\n') })
await store.transaction({ tenantId: input.tenantId, spaceId: 'crash' }, async tx => {
  await tx.put('ticket', 'task', { title: 'committed state' }, 0)
  await tx.jobs.enqueue('launch', 'task', { assignment: 'one' })
  if (input.phase === 'before') await hold()
})
if (input.phase === 'claimed') {
  const consumer = new DurableConsumer({ store, scope: { tenantId: input.tenantId, spaceId: 'crash' }, ttlMs: 300,
    lanes: [{ kinds: ['launch'], concurrency: 1, pool: { name: 'workers', limit: 1 }, handle: async () => hold() }] })
  consumer.start()
} else await hold()
