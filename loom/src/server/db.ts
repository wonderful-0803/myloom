/**
 * Database layer - SQLite for state persistence
 * Implements compute-storage separation principle
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type {
  Mandate,
  Source,
  Trigger,
  Thread,
  EvalDecision,
  Ticket,
  Assignment,
  Subscription,
  Artifact,
  WatchdogLog,
  RouterLog,
} from '../shared/types.js';

export class LoomDB {
  private db: Database.Database;

  constructor(dbPath: string = './loom.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.migrateR2();
  }

  /** R2: blocked tickets + artifact.summary + recreate tickets CHECK if needed */
  private migrateR2(): void {
    // summary column
    try {
      this.db.prepare('SELECT summary FROM artifacts LIMIT 1').get();
    } catch {
      try {
        this.db.exec(`ALTER TABLE artifacts ADD COLUMN summary TEXT NOT NULL DEFAULT ''`);
        console.log('🔄 Migrated artifacts.summary');
      } catch (e) {
        console.warn('artifacts.summary migrate:', e);
      }
    }

    // tickets status CHECK may lack blocked — recreate if insert probe fails
    try {
      const id = '__probe_blocked_ticket__';
      this.db
        .prepare(
          `INSERT INTO tickets (id, mandate_id, title, description, status, created_at, updated_at)
           VALUES (?, 'none', 'probe', 'probe', 'blocked', 0, 0)`
        )
        .run(id);
      this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
    } catch {
      console.log('🔄 Migrating tickets table for blocked status...');
      this.db.exec(`
        CREATE TABLE tickets_new (
          id TEXT PRIMARY KEY,
          mandate_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('open', 'ended', 'blocked')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO tickets_new SELECT * FROM tickets;
        DROP TABLE tickets;
        ALTER TABLE tickets_new RENAME TO tickets;
        CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      `);
    }
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        strength TEXT NOT NULL CHECK(strength IN ('explicit', 'inferred')),
        scope TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('sim-im', 'sim-ci', 'sim-clock', 'intent-board', 'feishu.message', 'feishu.doc_comment', 'feishu.calendar', 'feishu.approval')),
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES sources(id)
      );

      CREATE TABLE IF NOT EXISTS trigger_threads (
        trigger_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (trigger_id, thread_id),
        FOREIGN KEY (trigger_id) REFERENCES triggers(id),
        FOREIGN KEY (thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        topic TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS eval_decisions (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('accept', 'stop', 'ignore', 'unavailable')),
        path TEXT NOT NULL CHECK(path IN ('fast', 'slow')),
        reason TEXT NOT NULL,
        mandate_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (trigger_id) REFERENCES triggers(id),
        FOREIGN KEY (thread_id) REFERENCES threads(id),
        FOREIGN KEY (mandate_id) REFERENCES mandates(id)
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        mandate_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'ended', 'blocked')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (mandate_id) REFERENCES mandates(id)
      );

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'ended')),
        report TEXT CHECK(report IN ('progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped')),
        report_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(ticket_id, thread_id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id),
        FOREIGN KEY (thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('report', 'pr_note', 'brief')),
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS watchdog_logs (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL CHECK(event IN ('stuck_assignment', 'dead_router', 'healed')),
        details TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS router_logs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('batch_start', 'batch_end', 'dispatch', 'decision')),
        message TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_triggers_source ON triggers(source_id);
      CREATE INDEX IF NOT EXISTS idx_triggers_created ON triggers(created_at);
      CREATE INDEX IF NOT EXISTS idx_threads_topic ON threads(topic);
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_assignments_ticket ON assignments(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_ticket ON subscriptions(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_thread ON subscriptions(thread_id);
    `);
  }

  // ============================================================================
  // Mandates
  // ============================================================================

  createMandate(data: Omit<Mandate, 'id' | 'createdAt' | 'updatedAt'>): Mandate {
    const now = Date.now();
    const mandate: Mandate = {
      id: nanoid(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO mandates (id, title, description, strength, scope, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mandate.id,
        mandate.title,
        mandate.description,
        mandate.strength,
        mandate.scope,
        mandate.active ? 1 : 0,
        mandate.createdAt,
        mandate.updatedAt
      );

    return mandate;
  }

  getAllMandates(): Mandate[] {
    return this.db
      .prepare('SELECT * FROM mandates ORDER BY created_at DESC')
      .all()
      .map(this.rowToMandate);
  }

  getActiveMandates(): Mandate[] {
    return this.db
      .prepare('SELECT * FROM mandates WHERE active = 1 ORDER BY created_at DESC')
      .all()
      .map(this.rowToMandate);
  }

  updateMandate(id: string, updates: Partial<Omit<Mandate, 'id' | 'createdAt'>>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.active !== undefined) {
      fields.push('active = ?');
      values.push(updates.active ? 1 : 0);
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.db.prepare(`UPDATE mandates SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  // ============================================================================
  // Sources
  // ============================================================================

  initSources(): void {
    // Migrate sources table CHECK constraint if pre-R1 DB
    try {
      this.db.prepare("INSERT OR IGNORE INTO sources (id, kind, name, active) VALUES ('__probe_feishu__', 'feishu.message', 'probe', 0)").run();
      this.db.prepare("DELETE FROM sources WHERE id = '__probe_feishu__'").run();
    } catch {
      console.log('🔄 Migrating sources table for Feishu kinds...');
      this.db.exec(`
        CREATE TABLE sources_new (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('sim-im', 'sim-ci', 'sim-clock', 'intent-board', 'feishu.message', 'feishu.doc_comment', 'feishu.calendar', 'feishu.approval')),
          name TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT OR IGNORE INTO sources_new (id, kind, name, active)
          SELECT id, kind, name, active FROM sources
          WHERE kind IN ('sim-im', 'sim-ci', 'sim-clock', 'intent-board');
        DROP TABLE sources;
        ALTER TABLE sources_new RENAME TO sources;
      `);
    }

    const sources: Array<Source> = [
      { id: 'src-sim-im', kind: 'sim-im', name: 'Simulated IM', active: true },
      { id: 'src-sim-ci', kind: 'sim-ci', name: 'Simulated CI', active: true },
      { id: 'src-sim-clock', kind: 'sim-clock', name: 'Simulated Clock', active: true },
      { id: 'src-intent-board', kind: 'intent-board', name: 'Intent Board', active: true },
      { id: 'src-feishu-message', kind: 'feishu.message', name: '飞书·群消息', active: true },
      { id: 'src-feishu-doc', kind: 'feishu.doc_comment', name: '飞书·文档评论', active: true },
      { id: 'src-feishu-calendar', kind: 'feishu.calendar', name: '飞书·日历', active: true },
      { id: 'src-feishu-approval', kind: 'feishu.approval', name: '飞书·审批', active: true },
    ];

    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO sources (id, kind, name, active) VALUES (?, ?, ?, ?)'
    );

    for (const source of sources) {
      insert.run(source.id, source.kind, source.name, source.active ? 1 : 0);
    }
  }

  getAllSources(): Source[] {
    return this.db
      .prepare('SELECT * FROM sources')
      .all()
      .map((row: any) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        active: Boolean(row.active),
      }));
  }

  getSourceByKind(kind: Source['kind']): Source | null {
    const row: any = this.db.prepare('SELECT * FROM sources WHERE kind = ?').get(kind);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      active: Boolean(row.active),
    };
  }

  // ============================================================================
  // Triggers & Threads
  // ============================================================================

  createTrigger(
    data: Omit<Trigger, 'id' | 'createdAt'> & { threadTopics: string[] }
  ): Trigger {
    const now = Date.now();
    const trigger: Trigger = {
      id: nanoid(),
      sourceId: data.sourceId,
      sourceKind: data.sourceKind,
      type: data.type,
      payload: data.payload,
      threadIds: [],
      createdAt: now,
    };

    // Create or get threads
    const threadIds: string[] = [];
    for (const topic of data.threadTopics) {
      let thread = this.getThreadByTopic(topic);
      if (!thread) {
        thread = this.createThread({
          sourceKind: data.sourceKind,
          topic,
        });
      }
      threadIds.push(thread.id);
    }

    trigger.threadIds = threadIds;

    // Insert trigger
    this.db
      .prepare(
        `INSERT INTO triggers (id, source_id, source_kind, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        trigger.id,
        trigger.sourceId,
        trigger.sourceKind,
        trigger.type,
        JSON.stringify(trigger.payload),
        trigger.createdAt
      );

    // Link to threads
    const linkStmt = this.db.prepare(
      'INSERT INTO trigger_threads (trigger_id, thread_id) VALUES (?, ?)'
    );
    for (const threadId of threadIds) {
      linkStmt.run(trigger.id, threadId);
    }

    return trigger;
  }

  getTrigger(id: string): Trigger | null {
    const row: any = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
    if (!row) return null;

    const threadIds = this.db
      .prepare('SELECT thread_id FROM trigger_threads WHERE trigger_id = ?')
      .all(id)
      .map((r: any) => r.thread_id);

    return {
      id: row.id,
      sourceId: row.source_id,
      sourceKind: row.source_kind,
      type: row.type,
      payload: JSON.parse(row.payload),
      threadIds,
      createdAt: row.created_at,
    };
  }

  getRecentTriggers(limit: number = 50): Trigger[] {
    const rows = this.db
      .prepare('SELECT * FROM triggers ORDER BY created_at DESC LIMIT ?')
      .all(limit);

    return rows.map((row: any) => {
      const threadIds = this.db
        .prepare('SELECT thread_id FROM trigger_threads WHERE trigger_id = ?')
        .all(row.id)
        .map((r: any) => r.thread_id);

      return {
        id: row.id,
        sourceId: row.source_id,
        sourceKind: row.source_kind,
        type: row.type,
        payload: JSON.parse(row.payload),
        threadIds,
        createdAt: row.created_at,
      };
    });
  }

  createThread(data: Omit<Thread, 'id' | 'createdAt' | 'updatedAt'>): Thread {
    const now = Date.now();
    const thread: Thread = {
      id: nanoid(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO threads (id, source_kind, topic, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(thread.id, thread.sourceKind, thread.topic, thread.createdAt, thread.updatedAt);

    return thread;
  }

  getThreadByTopic(topic: string): Thread | null {
    const row: any = this.db.prepare('SELECT * FROM threads WHERE topic = ?').get(topic);
    if (!row) return null;
    return this.rowToThread(row);
  }

  getThread(id: string): Thread | null {
    const row: any = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
    if (!row) return null;
    return this.rowToThread(row);
  }

  // ============================================================================
  // Eval Decisions
  // ============================================================================

  createEvalDecision(data: Omit<EvalDecision, 'id' | 'createdAt'>): EvalDecision {
    const decision: EvalDecision = {
      id: nanoid(),
      ...data,
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO eval_decisions (id, trigger_id, thread_id, decision, path, reason, mandate_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.id,
        decision.triggerId,
        decision.threadId,
        decision.decision,
        decision.path,
        decision.reason,
        decision.mandateId,
        decision.createdAt
      );

    return decision;
  }

  // ============================================================================
  // Tickets
  // ============================================================================

  getRecentEvalDecisions(limit: number = 200): EvalDecision[] {
    const rows: any[] = this.db.prepare(
      'SELECT * FROM eval_decisions ORDER BY created_at DESC, rowid DESC LIMIT ?'
    ).all(limit);
    return rows.map((row) => ({
      id: row.id,
      triggerId: row.trigger_id,
      threadId: row.thread_id,
      decision: row.decision,
      path: row.path,
      reason: row.reason,
      mandateId: row.mandate_id,
      createdAt: row.created_at,
    }));
  }

  createTicket(data: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt'>): Ticket {
    const now = Date.now();
    const ticket: Ticket = {
      id: nanoid(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO tickets (id, mandate_id, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ticket.id,
        ticket.mandateId,
        ticket.title,
        ticket.description,
        ticket.status,
        ticket.createdAt,
        ticket.updatedAt
      );

    return ticket;
  }

  updateTicketStatus(id: string, status: Ticket['status']): void {
    this.db
      .prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  getOpenTickets(): Ticket[] {
    return this.db
      .prepare("SELECT * FROM tickets WHERE status = 'open' ORDER BY created_at DESC")
      .all()
      .map(this.rowToTicket);
  }

  getAllTickets(): Ticket[] {
    return this.db
      .prepare('SELECT * FROM tickets ORDER BY created_at DESC')
      .all()
      .map(this.rowToTicket);
  }

  getTicket(id: string): Ticket | null {
    const row: any = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!row) return null;
    return this.rowToTicket(row);
  }

  // ============================================================================
  // Assignments
  // ============================================================================

  createAssignment(data: Omit<Assignment, 'id' | 'createdAt' | 'updatedAt'>): Assignment {
    const now = Date.now();
    const assignment: Assignment = {
      id: nanoid(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO assignments (id, ticket_id, worker_id, status, report, report_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        assignment.id,
        assignment.ticketId,
        assignment.workerId,
        assignment.status,
        assignment.report,
        assignment.reportMessage,
        assignment.createdAt,
        assignment.updatedAt
      );

    return assignment;
  }

  updateAssignment(
    id: string,
    updates: Partial<Pick<Assignment, 'status' | 'report' | 'reportMessage'>>
  ): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.report !== undefined) {
      fields.push('report = ?');
      values.push(updates.report);
    }
    if (updates.reportMessage !== undefined) {
      fields.push('report_message = ?');
      values.push(updates.reportMessage);
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.db.prepare(`UPDATE assignments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  getAssignmentsByTicket(ticketId: string): Assignment[] {
    return this.db
      .prepare('SELECT * FROM assignments WHERE ticket_id = ? ORDER BY created_at DESC')
      .all(ticketId)
      .map(this.rowToAssignment);
  }

  getActiveAssignments(): Assignment[] {
    return this.db
      .prepare(
        "SELECT * FROM assignments WHERE status IN ('pending', 'running') ORDER BY created_at"
      )
      .all()
      .map(this.rowToAssignment);
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  createSubscription(ticketId: string, threadId: string): Subscription {
    const subscription: Subscription = {
      id: nanoid(),
      ticketId,
      threadId,
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT OR IGNORE INTO subscriptions (id, ticket_id, thread_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(subscription.id, subscription.ticketId, subscription.threadId, subscription.createdAt);

    return subscription;
  }

  getSubscriptionsByTicket(ticketId: string): Subscription[] {
    return this.db
      .prepare('SELECT * FROM subscriptions WHERE ticket_id = ?')
      .all(ticketId)
      .map((row: any) => ({
        id: row.id,
        ticketId: row.ticket_id,
        threadId: row.thread_id,
        createdAt: row.created_at,
      }));
  }

  getSubscriptionsByThread(threadId: string): Subscription[] {
    return this.db
      .prepare('SELECT * FROM subscriptions WHERE thread_id = ?')
      .all(threadId)
      .map((row: any) => ({
        id: row.id,
        ticketId: row.ticket_id,
        threadId: row.thread_id,
        createdAt: row.created_at,
      }));
  }

  // ============================================================================
  // Artifacts
  // ============================================================================

  createArtifact(data: Omit<Artifact, 'id' | 'createdAt'>): Artifact {
    const artifact: Artifact = {
      id: nanoid(),
      ...data,
      summary: data.summary || '',
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO artifacts (id, ticket_id, type, title, summary, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifact.id,
        artifact.ticketId,
        artifact.type,
        artifact.title,
        artifact.summary || '',
        artifact.content,
        artifact.createdAt
      );

    return artifact;
  }

  getAllArtifacts(): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts ORDER BY created_at DESC')
      .all()
      .map((row: any) => ({
        id: row.id,
        ticketId: row.ticket_id,
        type: row.type,
        title: row.title,
        summary: row.summary || '',
        content: row.content,
        createdAt: row.created_at,
      }));
  }

  getArtifactByTicket(ticketId: string): Artifact | null {
    const row: any = this.db
      .prepare('SELECT * FROM artifacts WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(ticketId);
    if (!row) return null;
    return {
      id: row.id,
      ticketId: row.ticket_id,
      type: row.type,
      title: row.title,
      summary: row.summary || '',
      content: row.content,
      createdAt: row.created_at,
    };
  }

  /**
   * Clear demo runtime state (tickets/triggers/artifacts/logs) but keep sources + mandates.
   * Used by one-click reset so repeated demos stay clean.
   */
  clearDemoState(): void {
    this.db.exec(`
      DELETE FROM artifacts;
      DELETE FROM assignments;
      DELETE FROM subscriptions;
      DELETE FROM eval_decisions;
      DELETE FROM trigger_threads;
      DELETE FROM triggers;
      DELETE FROM tickets;
      DELETE FROM router_logs;
      DELETE FROM watchdog_logs;
      DELETE FROM threads;
    `);
  }

  // ============================================================================
  // Logs
  // ============================================================================

  addRouterLog(data: Omit<RouterLog, 'id' | 'createdAt'>): RouterLog {
    const log: RouterLog = {
      id: nanoid(),
      ...data,
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO router_logs (id, type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(log.id, log.type, log.message, log.metadata ? JSON.stringify(log.metadata) : null, log.createdAt);

    return log;
  }

  getRecentRouterLogs(limit: number = 100): RouterLog[] {
    return this.db
      .prepare('SELECT * FROM router_logs ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row: any) => ({
        id: row.id,
        type: row.type,
        message: row.message,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      }));
  }

  addWatchdogLog(data: Omit<WatchdogLog, 'id' | 'createdAt'>): WatchdogLog {
    const log: WatchdogLog = {
      id: nanoid(),
      ...data,
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO watchdog_logs (id, event, details, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(log.id, log.event, log.details, log.createdAt);

    return log;
  }

  getRecentWatchdogLogs(limit: number = 50): WatchdogLog[] {
    return this.db
      .prepare('SELECT * FROM watchdog_logs ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row: any) => ({
        id: row.id,
        event: row.event,
        details: row.details,
        createdAt: row.created_at,
      }));
  }

  // ============================================================================
  // Helper mappers
  // ============================================================================

  private rowToMandate(row: any): Mandate {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      strength: row.strength,
      scope: row.scope,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToThread(row: any): Thread {
    return {
      id: row.id,
      sourceKind: row.source_kind,
      topic: row.topic,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTicket(row: any): Ticket {
    return {
      id: row.id,
      mandateId: row.mandate_id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToAssignment(row: any): Assignment {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      workerId: row.worker_id,
      status: row.status,
      report: row.report,
      reportMessage: row.report_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }


  // ==========================================================================
  // App settings (Feishu credentials etc.)
  // ==========================================================================

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  getFeishuSettingsRaw(): {
    appId: string;
    appSecret: string;
    verifyToken: string;
    encryptKey: string;
    enforceSign: boolean;
    lastEventAt: number | null;
  } {
    const bool = (v: string | null) => v === '1' || v === 'true';
    const last = this.getSetting('feishu.last_event_at');
    return {
      appId: this.getSetting('feishu.app_id') || process.env.FEISHU_APP_ID || '',
      appSecret: this.getSetting('feishu.app_secret') || process.env.FEISHU_APP_SECRET || '',
      verifyToken: this.getSetting('feishu.verify_token') || process.env.FEISHU_VERIFY_TOKEN || '',
      encryptKey: this.getSetting('feishu.encrypt_key') || process.env.FEISHU_ENCRYPT_KEY || '',
      enforceSign:
        bool(this.getSetting('feishu.enforce_sign')) || process.env.FEISHU_ENFORCE_SIGN === '1',
      lastEventAt: last ? Number(last) || null : null,
    };
  }

  setFeishuSettings(patch: {
    appId?: string;
    appSecret?: string;
    verifyToken?: string;
    encryptKey?: string;
    enforceSign?: boolean;
    clearAppSecret?: boolean;
    clearVerifyToken?: boolean;
    clearEncryptKey?: boolean;
  }): void {
    if (patch.appId !== undefined) this.setSetting('feishu.app_id', String(patch.appId).trim());
    if (patch.clearAppSecret) this.deleteSetting('feishu.app_secret');
    else if (patch.appSecret !== undefined && patch.appSecret !== '') {
      this.setSetting('feishu.app_secret', String(patch.appSecret));
    }
    if (patch.clearVerifyToken) this.deleteSetting('feishu.verify_token');
    else if (patch.verifyToken !== undefined && patch.verifyToken !== '') {
      this.setSetting('feishu.verify_token', String(patch.verifyToken));
    }
    if (patch.clearEncryptKey) this.deleteSetting('feishu.encrypt_key');
    else if (patch.encryptKey !== undefined && patch.encryptKey !== '') {
      this.setSetting('feishu.encrypt_key', String(patch.encryptKey));
    }
    if (patch.enforceSign !== undefined) {
      this.setSetting('feishu.enforce_sign', patch.enforceSign ? '1' : '0');
    }
  }

  touchFeishuLastEvent(at: number = Date.now()): void {
    this.setSetting('feishu.last_event_at', String(at));
  }

  close() {
    this.db.close();
  }
}
