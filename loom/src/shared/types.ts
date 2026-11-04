/**
 * Shared types for Loom（织机）
 * Maps concepts from Super-agent philosophy to implementation
 */

// ============================================================================
// Domain Model (from superagent-domain.md)
// ============================================================================

/**
 * Mandate（授权）- User intent pinned to the Intent Board
 * Represents continuous goals + policy rules, not a chat session
 */
export interface Mandate {
  id: string;
  title: string; // e.g., "静默复现并修复简单缺陷"
  description: string;
  strength: 'explicit' | 'inferred'; // 明确 | 推断
  scope: string; // Work allowed under this mandate
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Source（来源）- Stream of events
 * Feishu-shaped sources are local simulators (no Feishu login required)
 */
export type SourceKind =
  | 'sim-im'
  | 'sim-ci'
  | 'sim-clock'
  | 'intent-board'
  | 'feishu.message'
  | 'feishu.doc_comment'
  | 'feishu.calendar'
  | 'feishu.approval';

export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  active: boolean;
}

/**
 * Trigger（触发）- One immutable event from a Source
 */
export interface Trigger {
  id: string;
  sourceId: string;
  sourceKind: SourceKind;
  type: string; // e.g., "bug_discussion", "ci_failure", "feishu_im_message"
  payload: Record<string, unknown>;
  threadIds: string[]; // Which Threads this Trigger belongs to
  createdAt: number;
}

/**
 * Thread（线程）- Triggers in time order
 */
export interface Thread {
  id: string;
  sourceKind: SourceKind;
  topic: string; // e.g., "IM#dev-chat", "feishu#ops-群"
  createdAt: number;
  updatedAt: number;
}

/**
 * EvalDecision（评估决定）- Result of gate + assessment
 */
export type DecisionType = 'accept' | 'stop' | 'ignore' | 'unavailable';

export interface EvalDecision {
  id: string;
  triggerId: string;
  threadId: string;
  decision: DecisionType; // accept接单 · stop停止 · ignore忽略 · unavailable未完成
  path: 'fast' | 'slow'; // Fast Path (gate) vs Slow Path (assessment)
  reason: string;
  mandateId: string | null; // If accepted
  createdAt: number;
}

/**
 * Ticket（工单）- A unit of authorized work
 */
export type TicketStatus = 'open' | 'ended' | 'blocked';

export interface Ticket {
  id: string;
  mandateId: string;
  title: string;
  description: string;
  status: TicketStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Assignment（派工）- Binding of Ticket to Worker
 */
export type AssignmentStatus = 'pending' | 'running' | 'ended';
export type ReportType = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';

export interface Assignment {
  id: string;
  ticketId: string;
  workerId: string; // Worker instance ID
  status: AssignmentStatus;
  report: ReportType | null;
  reportMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Subscription（订阅）- Many-to-many: Tickets × Threads
 * Later events passthrough without re-Eval
 */
export interface Subscription {
  id: string;
  ticketId: string;
  threadId: string;
  createdAt: number;
}

/**
 * Artifact（作品）- Finished deliverable in Gallery
 */
export type ArtifactType = 'report' | 'pr_note' | 'brief';

export interface Artifact {
  id: string;
  ticketId: string;
  type: ArtifactType;
  title: string;
  /** One-line human summary for gallery cards */
  summary: string;
  content: string; // Markdown
  createdAt: number;
}

/**
 * WatchdogLog（看门狗日志）- Healing events
 */
export interface WatchdogLog {
  id: string;
  event: 'stuck_assignment' | 'dead_router' | 'healed';
  details: string;
  createdAt: number;
}

/**
 * Feishu ACK bubble (local fake bot replies — no login)
 */
export interface FeishuAck {
  id: string;
  chatName: string;
  /** acked=接单; fixed=缺陷修复; brief=简报; note=变更说明; blocked=受阻 */
  kind: 'acked' | 'fixed' | 'brief' | 'note' | 'blocked';
  text: string;
  ticketId: string | null;
  createdAt: number;
  /** sim=本地气泡; feishu=已推 IM; feishu_failed=尝试失败回落本地 */
  delivery?: 'sim' | 'feishu' | 'feishu_failed';
  messageId?: string | null;
  chatId?: string | null;
}

/** Persisted Feishu app credentials (secrets never sent raw to client) */
export interface FeishuSettingsPublic {
  configured: boolean;
  appId: string;
  /** masked */
  appSecretMasked: string;
  verifyTokenMasked: string;
  encryptKeyMasked: string;
  enforceSign: boolean;
  hasAppSecret: boolean;
  hasVerifyToken: boolean;
  hasEncryptKey: boolean;
  lastEventAt: number | null;
  webhookPath: string;
  connectionStatus: 'unconfigured' | 'configured' | 'receiving';
}

export interface FeishuSettingsWrite {
  appId?: string;
  appSecret?: string;
  verifyToken?: string;
  encryptKey?: string;
  enforceSign?: boolean;
  /** clear a secret field when true */
  clearAppSecret?: boolean;
  clearVerifyToken?: boolean;
  clearEncryptKey?: boolean;
}

/**
 * Demo narrative timeline step
 */
export type DemoStepId = 'inbound' | 'ticket' | 'patch' | 'green' | 'gallery';

export interface DemoTimelineStep {
  id: DemoStepId;
  label: string;
  detail: string;
  pane: 'world' | 'atelier' | 'gallery' | 'intent';
  status: 'pending' | 'active' | 'done';
  at?: number;
  refId?: string; // ticket / artifact id for jump
}

// ============================================================================
// UI State
// ============================================================================

export interface RouterLog {
  id: string;
  type: 'batch_start' | 'batch_end' | 'dispatch' | 'decision';
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface WorkerState {
  id: string;
  ticketId: string;
  status: AssignmentStatus;
  subscribedThreads: string[];
  progress: string;
  lastHeartbeat: number;
}

// ============================================================================
// WebSocket Events
// ============================================================================

export type WSEvent =
  | { type: 'mandate_added'; data: Mandate }
  | { type: 'mandate_updated'; data: Mandate }
  | { type: 'trigger_created'; data: Trigger }
  | { type: 'eval_decision'; data: EvalDecision }
  | { type: 'ticket_created'; data: Ticket }
  | { type: 'ticket_updated'; data: Ticket }
  | { type: 'assignment_updated'; data: Assignment }
  | { type: 'artifact_created'; data: Artifact }
  | { type: 'router_log'; data: RouterLog }
  | { type: 'worker_state'; data: WorkerState }
  | { type: 'watchdog_log'; data: WatchdogLog }
  | { type: 'feishu_ack'; data: FeishuAck }
  | { type: 'demo_timeline'; data: { steps: DemoTimelineStep[]; runId: string; conclusion?: string | null; primaryTicketId?: string | null; primaryArtifactId?: string | null } }
  | { type: 'demo_reset'; data: { ok: true } }
  | { type: 'demo_lock'; data: { locked: boolean; kind: string | null; scene?: 'A' | 'B' } }
  | { type: 'demo_complete'; data: { runId: string; primaryArtifactId: string | null; scene: 'A' | 'B'; conclusion: string | null } };
