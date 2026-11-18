/** Real killable Linux compute owner over disposable state. No model or external tool. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SqlSessionPersistence } from '../../../src/dsh-state/provider.ts'
import { PostgresStateStore } from '../../../src/state/postgres.ts'
import { SqliteStateStore } from '../../../src/state/sqlite.ts'
const input = JSON.parse(process.argv[2]!)
const store = input.dialect === 'postgres' ? await PostgresStateStore.open({ connectionString: process.env.LOOM_STATE_TEST_DATABASE_URL }) : await SqliteStateStore.open(input.path)
const ctx = new Context(), scope = input.scope, provider = new SqlSessionPersistence(ctx, { store, scope }), session = Session.create(SessionId('worker-crash'))
const lease = await store.transaction(scope, tx => tx.leases.acquire(session.id, input.owner, 60_000))
await provider.useLease(lease!, async binding => {
  const writer = await provider.create(session.header)
  await writer.append([session.append('model/selection', { provider: 'fixture', model: 'synthetic' })]); await binding.flush()
  process.stdout.write(JSON.stringify({ sessionId: session.id, owner: lease!.owner, epoch: lease!.epoch }) + '\n')
  setInterval(() => {}, 1000)
  await new Promise(() => {})
})
