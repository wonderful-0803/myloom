/** Company-server adapter. Database URL stays in the service process; never return it to clients. */
import { Pool } from 'pg'
import type { PoolConfig, PoolClient } from 'pg'
import { StateClosed, validateScope } from './ports.ts'
import type { StateScope, StateStore, StateTransaction } from './ports.ts'
import { initialize, SqlTransaction, transactionContext } from './sql.ts'
import type { SqlConnection } from './sql.ts'

function connection(client: PoolClient): SqlConnection {
  return { query: async (sql, parameters) => {
    const result = await client.query(sql, parameters ? [...parameters] : undefined)
    return { rows: result.rows as Record<string, unknown>[], count: result.rowCount ?? 0 }
  } }
}
/** PostgreSQL authority for explicitly scoped short transactions, durable claims and monotonic writer leases. */
export class PostgresStateStore implements StateStore {
  readonly dialect = 'postgres' as const
  private closed = false
  private closing?: Promise<void>
  private constructor(private pool: Pool) {}
  static async open(config: PoolConfig): Promise<PostgresStateStore> {
    if (!config.connectionString?.trim() && !(config.host && config.database && config.user))
      throw new Error('Explicit PostgreSQL URL or host/database/user configuration is required')
    const pool = new Pool({ max: 8, connectionTimeoutMillis: 5000, statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000, ...config })
    // Broken idle connections are removed by pg. Active operations still reject and cannot authorize dispatch.
    pool.on('error', () => {})
    try {
      const client = await pool.connect()
      let broken: Error | undefined
      const onError = (error: Error) => { broken = error }
      client.on('error', onError)
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('loom-state-schema-v1',0))")
        await initialize(connection(client), true)
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { broken = new Error('State migration connection lost') }
        throw error
      } finally { client.removeListener('error', onError); client.release(broken) }
      return new PostgresStateStore(pool)
    } catch (error) { await pool.end(); throw error }
  }
  async transaction<T>(scope: StateScope, work: (tx: StateTransaction) => Promise<T>): Promise<T> {
    if (transactionContext.getStore()) throw new Error('Nested state transactions are forbidden; use the supplied transaction')
    const verified = validateScope(scope)
    if (this.closed) throw new StateClosed('State store is closed')
    const client = await this.pool.connect(), sql = connection(client)
    const tx = new SqlTransaction(sql, verified, true)
    let broken: Error | undefined
    const onError = (error: Error) => { broken = error }
    client.on('error', onError)
    try {
      await client.query('BEGIN')
      await sql.query('INSERT INTO loom_state_scopes(tenant,space) VALUES($1,$2) ON CONFLICT(tenant,space) DO NOTHING', [verified.tenantId, verified.spaceId])
      // Initial single-enterprise implementation: short per-space domain transactions, no model/network I/O under this lock.
      await sql.query('SELECT sequence FROM loom_state_scopes WHERE tenant=$1 AND space=$2 FOR UPDATE', [verified.tenantId, verified.spaceId])
      const value = await transactionContext.run(true, () => work(tx.repositories()))
      await tx.finish()
      await client.query('COMMIT')
      return value
    } catch (error) {
      await tx.discard()
      try { await client.query('ROLLBACK') } catch { broken = new Error('State transaction connection lost') }
      throw error
    } finally { client.removeListener('error', onError); client.release(broken) }
  }
  close(): Promise<void> { this.closed = true; return this.closing ??= this.pool.end() }
}
