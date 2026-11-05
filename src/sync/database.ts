import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
/** Separate sync persistence; it does not create another assistant, task database or bot listener. */
export class SyncDatabase {
  readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS record (key TEXT PRIMARY KEY,value TEXT NOT NULL);')
    if (path !== ':memory:') chmodSync(path, 0o600)
  }
  get<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM record WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : undefined }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO record VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  list<T>(prefix: string): T[] { return this.db.prepare('SELECT value FROM record WHERE substr(key,1,?)=? ORDER BY key').all(prefix.length,prefix).map(row=>JSON.parse(String(row.value)) as T) }
  atomic<T>(run: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value=run(); this.db.exec('COMMIT'); return value } catch(error) { this.db.exec('ROLLBACK'); throw error } }
  close() { this.db.close() }
}
