/** Killable native provider; synthetic Session only, no model, Feishu or company credentials. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SqlSessionPersistence } from '../../../src/dsh-state/provider.ts'
import { SqliteStateStore } from '../../../src/state/sqlite.ts'
import { PostgresStateStore } from '../../../src/state/postgres.ts'
const input = JSON.parse(process.argv[2]!) as { dialect: 'sqlite' | 'postgres'; path: string; tenantId: string; mode: 'hold' | 'recover' }
const store = input.dialect === 'postgres' ? await PostgresStateStore.open({ connectionString: process.env.LOOM_STATE_TEST_DATABASE_URL }) : await SqliteStateStore.open(input.path)
const ctx = new Context(), provider = new SqlSessionPersistence(ctx, { store, scope: { tenantId: input.tenantId, spaceId: 'crash' }, ttlMs: 900 })
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
try {
  const id = SessionId('worker-stable'), saved = await provider.stat(id)
  const writer = saved ? await provider.open(id, 'write') : await provider.create(Session.create(id).header)
  const persisted = await writer.read()
  const session = saved ? Session.fromRestore(id, persisted.events, writer.header, writer.inheritedEventCount, persisted.eventState) : Session.create(id, undefined, writer.header)
  if (!saved) {
    await writer.append([session.append('model/selection', { provider: 'fixture', model: 'before-1' }), session.append('model/selection', { provider: 'fixture', model: 'before-2' })])
    await writer.flush()
  }
  if (input.mode === 'recover') {
    const before = (await writer.read()).events.length
    session.append('model/selection', { provider: 'fixture', model: 'continued' })
    await writer.append(session.snapshotEvents(SessionLogOffset(before))); await writer.flush()
    emit({ state: 'recovered', id: writer.id, before, after: (await writer.read()).events.length, header: writer.header })
    await provider.dispose(); await ctx.fiber.dispose(); await store.close()
  } else {
    emit({ state: 'ready', id, count: (await writer.read()).events.length, header: writer.header })
    process.stdin.on('data', () => {
      void (async () => {
        try { await writer.append([session.append('model/selection', { provider: 'fixture', model: 'stale-attempt' })]); emit({ state: 'wrote' }) }
        catch (error) { emit({ state: 'fenced', error: error instanceof Error ? error.name : 'Error' }) }
      })()
    })
    setInterval(() => {}, 1000)
  }
} catch (error) {
  emit({ state: error instanceof Error && error.name === 'SessionAlreadyOwnedError' ? 'owned' : 'error', error: error instanceof Error ? error.name : 'Error' })
  await provider.dispose(); await ctx.fiber.dispose(); await store.close()
}
