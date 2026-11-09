/** The team gateway's own local database: workspaces, routed events, scoped sends and an audit trail. It holds no task data. */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface Workspace {
  id: string; unionId: string; openId: string; tenantKey: string; name: string
  status: 'active' | 'disabled'; createdAt: string; lastActiveAt: string
}
/** A message routed to one workspace, kept so sends and reads can be checked against what that person actually sent. */
export interface InboxItem { seq: number; eventId: string; messageId: string; workspaceId: string; chatId: string; chatType: 'p2p' | 'group'; text: string; line: string; receivedAt: string }
export interface OutboxItem { workspaceId: string; key: string; decision: 'sent' | 'redirected' | 'rejected'; reason: string; target: string; messageId: string | null; at: string }

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Private SQLite store of the gateway; transactions are immediate so routing and acknowledgement never interleave. */
export class TeamStore {
  readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, union_id TEXT NOT NULL UNIQUE, open_id TEXT NOT NULL, tenant_key TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (event_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspace(id), chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, text TEXT NOT NULL, line TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_workspace ON inbox (workspace_id, seq);
      CREATE TABLE IF NOT EXISTS delivered (workspace_id TEXT PRIMARY KEY REFERENCES workspace(id), seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (workspace_id TEXT NOT NULL REFERENCES workspace(id), key TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
        target TEXT NOT NULL, message_id TEXT, at TEXT NOT NULL, PRIMARY KEY (workspace_id, key));
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, workspace_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL);`)
    if (path !== ':memory:') chmodSync(path, 0o600)
  }
  atomic<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = run(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.db.close() }

  /** Records an event ID once; returns false when it was already seen, whatever its outcome then. */
  markSeen(eventId: string, outcome: string, at: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?,?)').run(eventId, outcome, at).changes === 1
  }
  forgetSeen(eventId: string): void { this.db.prepare('DELETE FROM seen WHERE event_id=?').run(eventId) }
  setSeen(eventId: string, outcome: string): void { this.db.prepare('UPDATE seen SET outcome=? WHERE event_id=?').run(outcome, eventId) }

  /** Creates a workspace with a fresh access token and returns the token; only its hash is stored. */
  createWorkspace(fields: Pick<Workspace, 'unionId' | 'openId' | 'tenantKey' | 'name'>, at: string): { workspace: Workspace; token: string } {
    const id = 'ws_' + createHash('sha256').update(fields.unionId).digest('hex').slice(0, 16), token = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT INTO workspace (id,union_id,open_id,tenant_key,name,status,token_hash,created_at,last_active_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, fields.unionId, fields.openId, fields.tenantKey, fields.name, 'active', tokenHash(token), at, at)
    return { workspace: this.workspace(id)!, token }
  }
  /** Replaces a workspace's access token, invalidating the old one. */
  rotateToken(id: string): string {
    const token = randomBytes(32).toString('base64url')
    this.db.prepare('UPDATE workspace SET token_hash=? WHERE id=?').run(tokenHash(token), id)
    return token
  }
  workspace(id: string): Workspace | undefined { return row(this.db.prepare('SELECT * FROM workspace WHERE id=?').get(id)) }
  byUnion(unionId: string): Workspace | undefined { return row(this.db.prepare('SELECT * FROM workspace WHERE union_id=?').get(unionId)) }
  byToken(token: string): Workspace | undefined { return row(this.db.prepare('SELECT * FROM workspace WHERE token_hash=?').get(tokenHash(token))) }
  workspaces(): Workspace[] { return this.db.prepare('SELECT * FROM workspace ORDER BY created_at').all().map(value => row(value)!) }
  touch(id: string, at: string, openId?: string): void {
    this.db.prepare('UPDATE workspace SET last_active_at=?, open_id=coalesce(?, open_id) WHERE id=?').run(at, openId ?? null, id)
  }
  setStatus(id: string, status: Workspace['status']): void { this.db.prepare('UPDATE workspace SET status=? WHERE id=?').run(status, id) }

  enqueue(item: Omit<InboxItem, 'seq'>): number {
    return Number(this.db.prepare('INSERT INTO inbox (event_id,message_id,workspace_id,chat_id,chat_type,text,line,received_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(item.eventId, item.messageId, item.workspaceId, item.chatId, item.chatType, item.text, item.line, item.receivedAt).lastInsertRowid)
  }
  /** Events after `after` (or after the last acknowledged one); asking for `after` acknowledges everything up to it. */
  pending(workspaceId: string, after?: number): InboxItem[] {
    if (after !== undefined) this.db.prepare('INSERT INTO delivered VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET seq=max(seq, excluded.seq)').run(workspaceId, after)
    const acknowledged = Number(this.db.prepare('SELECT seq FROM delivered WHERE workspace_id=?').get(workspaceId)?.seq ?? 0)
    return this.db.prepare('SELECT * FROM inbox WHERE workspace_id=? AND seq>? ORDER BY seq LIMIT 50').all(workspaceId, after ?? acknowledged).map(inbox)
  }
  routedSince(workspaceId: string, since: string): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM inbox WHERE workspace_id=? AND received_at>=?').get(workspaceId, since)?.n ?? 0)
  }
  message(messageId: string): InboxItem | undefined {
    const value = this.db.prepare('SELECT * FROM inbox WHERE message_id=?').get(messageId)
    return value ? inbox(value) : undefined
  }
  /** The newest message this workspace's owner sent in a chat, i.e. the request a send to that chat answers. */
  latestIn(workspaceId: string, chatId: string): InboxItem | undefined {
    const value = this.db.prepare('SELECT * FROM inbox WHERE workspace_id=? AND chat_id=? ORDER BY seq DESC LIMIT 1').get(workspaceId, chatId)
    return value ? inbox(value) : undefined
  }
  /** Chats the owner has used with this workspace: the only chats it may read or send to. */
  chats(workspaceId: string): { chatId: string; chatType: 'p2p' | 'group' }[] {
    return this.db.prepare('SELECT DISTINCT chat_id, chat_type FROM inbox WHERE workspace_id=?').all(workspaceId)
      .map(value => ({ chatId: String(value.chat_id), chatType: value.chat_type === 'p2p' ? 'p2p' as const : 'group' as const }))
  }

  sent(workspaceId: string, key: string): OutboxItem | undefined {
    const value = this.db.prepare('SELECT * FROM outbox WHERE workspace_id=? AND key=?').get(workspaceId, key)
    return value ? { workspaceId: String(value.workspace_id), key: String(value.key), decision: value.decision as OutboxItem['decision'], reason: String(value.reason),
      target: String(value.target), messageId: value.message_id === null ? null : String(value.message_id), at: String(value.at) } : undefined
  }
  recordSend(item: OutboxItem): void {
    this.db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?,?)').run(item.workspaceId, item.key, item.decision, item.reason, item.target, item.messageId, item.at)
  }
  outbox(workspaceId: string): OutboxItem[] {
    return this.db.prepare('SELECT key FROM outbox WHERE workspace_id=? ORDER BY at').all(workspaceId).map(value => this.sent(workspaceId, String(value.key))!)
  }
  /** Audit details name IDs, decisions and reasons only, never message text or tokens. */
  /** How many audit entries of `action` a workspace has since `since`. */
  auditCount(workspaceId: string, action: string, since: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM audit WHERE workspace_id=? AND action=? AND at>=?').get(workspaceId, action, since) as { n: number }).n
  }
  audit(action: string, detail: Record<string, string | number | boolean>, workspaceId: string | null, at: string): void {
    this.db.prepare('INSERT INTO audit (at,workspace_id,action,detail) VALUES (?,?,?,?)').run(at, workspaceId, action, JSON.stringify(detail))
  }
  auditTrail(): { at: string; workspaceId: string | null; action: string; detail: Record<string, unknown> }[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY seq').all().map(value => ({ at: String(value.at), workspaceId: value.workspace_id === null ? null : String(value.workspace_id),
      action: String(value.action), detail: JSON.parse(String(value.detail)) as Record<string, unknown> }))
  }
}

function row(value: Record<string, unknown> | undefined): Workspace | undefined {
  return value ? { id: String(value.id), unionId: String(value.union_id), openId: String(value.open_id), tenantKey: String(value.tenant_key), name: String(value.name),
    status: value.status === 'disabled' ? 'disabled' : 'active', createdAt: String(value.created_at), lastActiveAt: String(value.last_active_at) } : undefined
}
function inbox(value: Record<string, unknown>): InboxItem {
  return { seq: Number(value.seq), eventId: String(value.event_id), messageId: String(value.message_id), workspaceId: String(value.workspace_id),
    chatId: String(value.chat_id), chatType: value.chat_type === 'p2p' ? 'p2p' : 'group', text: String(value.text), line: String(value.line), receivedAt: String(value.received_at) }
}
