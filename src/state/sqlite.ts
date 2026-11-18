/** Personal-mode / contract adapter. Async callbacks hold one transaction until settled. */
import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'
import { StateClosed, validateScope } from './ports.ts'
import type { StateScope, StateStore, StateTransaction } from './ports.ts'
import { initialize, SqlTransaction, transactionContext } from './sql.ts'
import type { SqlConnection } from './sql.ts'

// Two adapters for the same local file must not synchronously block each other's awaited callbacks.
const queues = new Map<string, Promise<void>>()
let memoryId = 0
async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(done => { release = done })
  queues.set(id, next)
  await previous
  try { return await work() } finally { release(); if (queues.get(id) === next) queues.delete(id) }
}
/** SQLite adapter that holds the transaction across awaits and refuses implicit legacy database migration. */
export class SqliteStateStore implements StateStore {
  readonly dialect = 'sqlite' as const
  private readonly db: DatabaseSync
  private readonly connection: SqlConnection
  private readonly queue: string
  private closed = false
  private closing?: Promise<void>
  private constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      const legacy = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ticket'").get()
      if (legacy) throw new Error('Legacy Loom database requires an explicit offline migration; use a separate state database')
      this.queue = path === ':memory:' ? `memory:${++memoryId}` : realpathSync(path)
      if (path !== ':memory:') chmodSync(path, 0o600)
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0')
    } catch (error) { this.db.close(); throw error }
    this.connection = { query: async (sql, parameters = []) => {
      const ordered: (string | number | null)[] = []
      const prepared = sql.replace(/\$(\d+)/g, (_, index: string) => { ordered.push(parameters[Number(index) - 1] as string | number | null); return '?' })
      const statement = this.db.prepare(prepared)
      if (/^\s*(SELECT|PRAGMA)\b/i.test(prepared) || /\bRETURNING\b/i.test(prepared)) {
        const rows = statement.all(...ordered)
        return { rows, count: rows.length }
      }
      const result = statement.run(...ordered)
      return { rows: [], count: Number(result.changes) }
    } }
  }
  static async open(path: string): Promise<SqliteStateStore> {
    const store = new SqliteStateStore(path)
    try {
      await exclusive(store.queue, async () => {
        await store.begin()
        try {
          await initialize(store.connection, false); store.db.exec('COMMIT')
        }
        catch (error) { store.db.exec('ROLLBACK'); throw error }
      })
      return store
    } catch (error) { store.db.close(); throw error }
  }
  private async begin(): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      try { this.db.exec('BEGIN IMMEDIATE'); return }
      catch (error) {
        if (!(error instanceof Error) || !/database is (locked|busy)/.test(error.message) || Date.now() >= deadline) throw error
        await setTimeout(10)
      }
    }
  }
  async transaction<T>(scope: StateScope, work: (tx: StateTransaction) => Promise<T>): Promise<T> {
    if (transactionContext.getStore()) throw new Error('Nested state transactions are forbidden; use the supplied transaction')
    const verified = validateScope(scope)
    if (this.closed) throw new StateClosed('State store is closed')
    return exclusive(this.queue, async () => {
      if (this.closed) throw new StateClosed('State store is closed')
      await this.begin()
      const tx = new SqlTransaction(this.connection, verified, false)
      try {
        await this.connection.query('INSERT INTO loom_state_scopes(tenant,space) VALUES($1,$2) ON CONFLICT(tenant,space) DO NOTHING', [verified.tenantId, verified.spaceId])
        const value = await transactionContext.run(true, () => work(tx.repositories()))
        await tx.finish()
        this.db.exec('COMMIT')
        return value
      } catch (error) { await tx.discard(); this.db.exec('ROLLBACK'); throw error }
    })
  }
  close(): Promise<void> {
    return this.closing ??= exclusive(this.queue, async () => { this.closed = true; this.db.close() })
  }
}
