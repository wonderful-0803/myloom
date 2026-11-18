/** Device-local SQLite receipts and grants; deliberately independent of Loom/DSH session storage. */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { checkedReceipt, checkedRequest, intentHash, terminal } from '../protocol.ts'
import type { RemoteRequest, RemoteReceipt } from '../protocol.ts'
import { hash } from '../../state/hash.ts'
import { privateFile } from './config.ts'
import type { RunnerConfig } from './config.ts'
import type { LocalGrant } from './files.ts'
export interface LedgerEntry { request: RemoteRequest; receipt: RemoteReceipt; created: number }
/** Holds a kernel-backed SQLite writer lock for the process lifetime; expiry cannot create a second owner. */
export class RunnerLedger {
  private closed = false
  private constructor(private db: DatabaseSync, private lock: DatabaseSync, readonly config: RunnerConfig) {}
  static async open(home: string, config: RunnerConfig): Promise<RunnerLedger> {
    for (const name of ['owner.sqlite', 'receipts.sqlite']) await privateFile(join(home, name), true)
    const lock = new DatabaseSync(join(home, 'owner.sqlite')); let db: DatabaseSync | undefined
    try {
      lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO owner VALUES(1)')
      db = new DatabaseSync(join(home, 'receipts.sqlite'))
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name)
      if (tables.length && (tables.length !== 4 || !['meta', 'grants', 'receipts', 'fences'].every(name => tables.includes(name)))) throw Error('Not a Runner receipt database')
      db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, binding TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, intent TEXT NOT NULL, request TEXT, receipt TEXT, status TEXT NOT NULL, sequence INTEGER NOT NULL, created INTEGER NOT NULL, completed INTEGER);
        CREATE TABLE IF NOT EXISTS fences(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);`)
      const binding = hash({ deviceId: config.deviceId, binding: config.binding, gateway: config.gatewayPublicKey }), row = db.prepare('SELECT * FROM meta WHERE id=1').get()
      if (row && (row.version !== 1 || row.binding !== binding)) throw Error('Runner ledger identity/version mismatch')
      if (!row) db.prepare('INSERT INTO meta VALUES(1,1,?)').run(binding)
      const ledger = new RunnerLedger(db, lock, config)
      // Accepted/running are not evidence of completion after a process dies. Never automatically replay them.
      for (const entry of ledger.active()) ledger.finish(entry.request, 'unknown', undefined, 'internal')
      return ledger
    } catch (error) { db?.close(); lock.close(); throw error }
  }
  private assert() { if (this.closed) throw Error('Runner ledger is closed') }
  private atomic<T>(fn: () => T): T {
    this.assert(); this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  grant(id: string): LocalGrant | undefined {
    this.assert(); const row = this.db.prepare('SELECT body FROM grants WHERE id=?').get(id)
    return row ? JSON.parse(String(row.body)) : undefined
  }
  grants(): LocalGrant[] { this.assert(); return this.db.prepare('SELECT body FROM grants ORDER BY id').all().map(row => JSON.parse(String(row.body))) }
  putGrant(value: LocalGrant, expected: number) {
    this.atomic(() => {
      const old = this.grant(value.id)
      if ((old?.revision ?? 0) !== expected || value.revision !== expected + 1) throw Error('Local grant revision changed')
      this.db.prepare('INSERT INTO grants VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, JSON.stringify(value))
    })
  }
  private entry(row: Record<string, unknown> | undefined): LedgerEntry | undefined {
    if (!row) return undefined
    if (row.request === null || row.receipt === null) throw Error('Receipt content expired; request tombstone prevents reexecution')
    const request = checkedRequest(JSON.parse(String(row.request))), receipt = checkedReceipt(JSON.parse(String(row.receipt)), request)
    if (request.requestId !== row.id || intentHash(request) !== row.intent || receipt.status !== row.status || receipt.sequence !== row.sequence) throw Error('Runner receipt integrity failure')
    return { request, receipt, created: Number(row.created) }
  }
  get(id: string, intent: string): LedgerEntry | undefined {
    this.assert(); const row = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id)
    if (row && row.intent !== intent) throw Error('Request identity conflict')
    return this.entry(row)
  }
  active(): LedgerEntry[] { this.assert(); return this.db.prepare("SELECT * FROM receipts WHERE status IN ('accepted','running') ORDER BY created,id").all().map(row => this.entry(row)!) }
  current(request: RemoteRequest) {
    this.assert()
    for (const [id, revision] of this.fences(request)) {
      const row = this.db.prepare('SELECT revision FROM fences WHERE id=?').get(id)
      if (row && Number(row.revision) > revision) throw Error('Runner execution fence changed')
    }
  }
  private fences(request: RemoteRequest): [string, number][] {
    return [[`session/${request.sessionId}`, request.sessionEpoch], [`task/${request.ticketId}`, request.controlRevision]]
  }
  accept(request: RemoteRequest): RemoteReceipt {
    return this.atomic(() => {
      const previous = this.get(request.requestId, intentHash(request)); if (previous) return previous.receipt
      this.current(request)
      const size = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(request AS BLOB))+length(CAST(receipt AS BLOB))),0) AS bytes FROM receipts').get()!
      if (Number(size.count) >= 10000 || Number(size.bytes) >= 100_000_000) throw Error('Runner receipt retention budget exhausted')
      for (const [id, revision] of this.fences(request)) this.db.prepare('INSERT INTO fences VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=MAX(revision,excluded.revision)').run(id, revision)
      const receipt: RemoteReceipt = { protocolVersion: 1, requestId: request.requestId, intentHash: intentHash(request), sequence: 1, status: 'accepted' }
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?,NULL)').run(request.requestId, intentHash(request), JSON.stringify(request), JSON.stringify(receipt), receipt.status, 1, Date.now())
      return receipt
    })
  }
  running(request: RemoteRequest) { return this.transition(request, 'running') }
  finish(request: RemoteRequest, status: 'succeeded' | 'failed' | 'cancelled' | 'unknown', result?: RemoteReceipt['result'], error?: RemoteReceipt['error']) { return this.transition(request, status, result, error) }
  private transition(request: RemoteRequest, status: RemoteReceipt['status'], result?: RemoteReceipt['result'], error?: RemoteReceipt['error']): RemoteReceipt {
    return this.atomic(() => {
      const entry = this.get(request.requestId, intentHash(request)); if (!entry) throw Error('Receipt has not been durably accepted')
      if (terminal(entry.receipt)) return entry.receipt
      const receipt = checkedReceipt({ protocolVersion: 1, requestId: request.requestId, intentHash: intentHash(request), sequence: entry.receipt.sequence + 1, status,
        ...(result ? { result, resultHash: hash(result) } : {}), ...(error ? { error } : {}) }, request)
      this.db.prepare('UPDATE receipts SET receipt=?,status=?,sequence=?,completed=? WHERE id=?').run(JSON.stringify(receipt), status, receipt.sequence, terminal(receipt) ? Date.now() : null, request.requestId)
      return receipt
    })
  }
  prune(now = Date.now()) {
    this.assert()
    this.db.prepare("UPDATE receipts SET request=NULL,receipt=NULL WHERE completed IS NOT NULL AND completed<=? AND receipt IS NOT NULL").run(now - 3_600_000)
  }
  close() { if (this.closed) return; this.closed = true; try { this.db.close() } finally { this.lock.close() } }
}
