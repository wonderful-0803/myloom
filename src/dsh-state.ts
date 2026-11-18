/** Explicit native SQL provider entry; company adoption uses the same authority and managed lease scopes. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { PostgresStateStore } from './state/postgres.ts'
export { SqlSessionPersistence } from './dsh-state/provider.ts'
export type { SqlSessionPersistenceOptions } from './dsh-state/provider.ts'
export type { NativeWriterBinding } from './dsh-state/ownership.ts'
import { SqlSessionPersistence } from './dsh-state/provider.ts'

export const name = 'loom-dsh-state'
export const Config = s.object({ tenantId: s.string().required(), spaceId: s.string().required(),
  databaseUrlEnv: s.string().required().description('Name of a LOOM_* environment variable; never the database credential itself.') })
export async function apply(ctx: Context, config: ReturnType<typeof Config>): Promise<void> {
  if (!/^LOOM_[A-Z0-9_]+$/.test(config.databaseUrlEnv)) throw new Error('Explicit LOOM_* database environment reference required')
  if (ctx.get('sessionPersistence')) throw new Error('Disable the existing SessionPersistence provider before mounting native SQL persistence')
  const url = process.env[config.databaseUrlEnv]
  if (!url) throw new Error('Native Session database environment is missing')
  const store = await PostgresStateStore.open({ connectionString: url, application_name: 'loom-dsh-state' })
  let provider: SqlSessionPersistence
  try { provider = new SqlSessionPersistence(ctx, { store, scope: { tenantId: config.tenantId, spaceId: config.spaceId } }) }
  catch (error) { await store.close(); throw error }
  ctx.effect(() => async () => { try { await provider.dispose() } finally { await store.close() } })
}
