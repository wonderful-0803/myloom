/** Browser-safe personal workspace contract. Contains no credentials, CLI paths or model keys. */
export interface LoomArtifact {
  subject: string; kind: 'task' | 'draft'; title: string; version: number; body: string; hash: string
  author: 'agent' | 'human'; at: string; editedVia?: 'loom'
  editedBy?: string
  sources: { triggerId: string; hash: string }[]
  filename?: string
  file?: import('../document-format.ts').ArtifactFile
}
export interface LoomTask {
  id: string; title: string; description: string; status: 'open' | 'ended' | 'blocked'; outcome?: string
  createdAt: number; updatedAt: number; summary: string; completed: boolean
  executionState?: 'queued' | 'running' | 'waiting'
  ruleIds: string[]
  control: { mode: 'agent' | 'pausing' | 'paused' | 'taking_over' | 'human'; revision: number; pending: number }
}
export interface LoomMail {
  token: string; ticketId: string; to: string; subject: string; body: string; status: string
  artifactVersion?: number; createdAt: string
}
export interface LoomDelegation {
  id: string; title: string; description: string; enabled: boolean; mode: 'observe' | 'auto'; chatIds: string[]; keywords: string[]
  codex?: { projects: string[]; sessions: string[]; time: string; timezone: 'Asia/Shanghai'; delivery: 'none' | 'feishu' | 'default' }
  meeting?: { audio: 'confirm'; provider?: 'bailian' | 'local' }
  runs?: { id: string; date: string; status: string; at: string; updatedAt: string; ticketId?: string; detail?: string; sessions?: number; messages?: number; warnings?: string[] }[]
  createdAt: string; updatedAt: string; available: boolean; scopes: { chatId: string; name: string }[]; taskIds: string[]
}
export interface LoomProgressEvent {
  id: string; at: string; kind: 'model' | 'tool' | 'retry' | 'report' | 'control' | 'assignment'; title: string
  status: 'running' | 'done' | 'failed' | 'interrupted'; durationMs?: number; detail?: string
}
export interface LoomProgress {
  taskId: string; at: string; phase: string; label: string; lastActivityAt?: string; currentSince?: string
  elapsedMs: number; modelMs: number; toolMs: number; modelSteps: number; toolCalls: number; failedTools: number; outputTokens: number
  events: LoomProgressEvent[]; unavailable?: string; truncated: boolean
  control: { mode: LoomTask['control']['mode']; drained: boolean; detail?: string; pending: { id: string; label: string; startedAt: string; unknown: boolean }[] }
}
export interface LoomSnapshot {
  /** Authenticated Feishu identity, safe to render in the browser. */
  identity?: { uid: string; tenantKey: string }
  workspace?: { mode: 'personal' | 'group'; operator: string; revision: number;
    scopeFixed?: boolean; canManage?: boolean
    group?: { chatId: string; name: string; masters: { id: string; name?: string }[] } }
  at: string; paused: boolean; mode: 'off' | 'observe' | 'auto'; model: string
  automation: { revision: number; maxWorkers: number; timeoutSeconds: number }
  delivery: LoomDeliverySetting
  resultDeliveries: LoomResultReceipt[]
  connection: { appId: string; name: string; cardsEnabled: boolean; draftsEnabled: boolean; mailProvider: string
    chats: { chatId: string; name: string; listen: string }[]; health: { id: string; state: string }[] }
  tasks: LoomTask[]; artifacts: LoomArtifact[]
  drafts: { id: string; title: string; status: string; at: string; confirmedVersion?: number }[]
  events: { id: string; text: string; at: string; chat: string; direct: boolean; actor?: string; contextOnly?: boolean; action?: string; decision?: string; observed: boolean; system?: boolean; taskIds?: string[]; processing?: 'queued' | 'evaluating'; inputKind?: 'attachment' | 'thread-reply'; batched?: boolean }[]
  policyRevision: number; delegations: LoomDelegation[]
  recordings?: { available: boolean; provider: 'bailian' | 'local'; model: string; items: { id: string; title: string; status: string; at: string; updatedAt: string; ticketId?: string; duration?: number; processedSeconds?: number; detail?: string; transcriptReady: boolean }[] }
  rules: { id: string; name: string; enabled: boolean; text: string }[]
  deliveries: { id: string; action: string; status: string; at: string }[]
}
export interface LoomDeliverySetting {
  mode: 'feishu' | 'none' | 'mail' | 'default'; revision: number; effectiveMode: 'feishu' | 'none' | 'mail'; address?: string
}
export interface LoomResultReceipt {
  id: string; ticketId: string; version: number; mode: 'feishu' | 'none' | 'mail'; status: string; at: string
  updatedAt: string; destination: string; detail?: string
}
export interface LoomCodexAccess {
  enabled: boolean; date: string; revision: number; timezone: 'Asia/Shanghai'; source: string
}
export interface LoomCodexSession {
  id: string; title: string; cwd: string; createdAt: number; updatedAt: number; source: string; archived: boolean
}
export interface LoomCodexMessage {
  id: string; turnId: string; role: 'user' | 'assistant'; at: number; text: string; phase?: string
  truncated: boolean; omittedAttachments: boolean
}
export interface LoomCodexSessions {
  date: string; timezone: 'Asia/Shanghai'; sessions: LoomCodexSession[]; truncated: boolean
}
export interface LoomCodexMessages {
  date: string; timezone: 'Asia/Shanghai'; session: LoomCodexSession; messages: LoomCodexMessage[]
  nextCursor: string | null; skippedUndated: number; limited: boolean
}
