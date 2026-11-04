/**
 * Loom Server - Express + WebSocket + Vite UI (R9)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createServer as createHttpServer } from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { nanoid } from 'nanoid';
import { LoomDB } from './db.js';
import { Router } from './router.js';
import { Watchdog } from './watchdog.js';
import type { WSEvent, SourceKind, FeishuAck, DemoTimelineStep, FeishuSettingsPublic } from '../shared/types.js';
import { resetSandboxBug, SANDBOX_ROOT, type SandboxScene } from './sandboxWorker.js';
import { decryptFeishuEncrypt } from './feishuCrypto.js';
import { normalizeFeishuBody } from './feishuNormalize.js';
import { replyOrCreateFeishuMessage, clearTokenCache } from './feishuOutbound.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LOOM_PORT || 4567);
const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString('utf8');
    },
  })
);

const db = new LoomDB('./loom.db');
db.initSources();

const wsClients = new Set<WebSocket>();
/** In-memory Feishu ACK bubbles (sim chat) */
let feishuAcks: FeishuAck[] = [];
/** Current demo timeline (merged steps) — primary narrative only */
let demoRunId = '';
let demoSteps: DemoTimelineStep[] = [];
let primaryTicketId: string | null = null;
let primaryArtifactId: string | null = null;
let demoConclusion: string | null = null;
/** R4: serialize demo runs — second POST while locked → 409 */
let demoLock = false;
let demoLockKind: string | null = null;
let demoLockTimer: ReturnType<typeof setTimeout> | null = null;
let demoScene: SandboxScene = 'A';

function clearDemoLockTimer() {
  if (demoLockTimer) {
    clearTimeout(demoLockTimer);
    demoLockTimer = null;
  }
}

function setDemoLock(locked: boolean, kind: string | null = null, holdMs = 0) {
  clearDemoLockTimer();
  demoLock = locked;
  demoLockKind = locked ? kind : null;
  broadcast({
    type: 'demo_lock',
    data: { locked, kind: demoLockKind, scene: demoScene },
  } as any);
  if (locked && holdMs > 0) {
    demoLockTimer = setTimeout(() => {
      demoLock = false;
      demoLockKind = null;
      demoLockTimer = null;
      broadcast({
        type: 'demo_lock',
        data: { locked: false, kind: null, scene: demoScene },
      } as any);
    }, holdMs);
  }
}

function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

function publicFeishuSettings(): FeishuSettingsPublic {
  const raw = db.getFeishuSettingsRaw();
  const configured = Boolean(raw.appId && raw.appSecret);
  let connectionStatus: FeishuSettingsPublic['connectionStatus'] = 'unconfigured';
  if (configured && raw.lastEventAt) connectionStatus = 'receiving';
  else if (configured) connectionStatus = 'configured';
  return {
    configured,
    appId: raw.appId,
    appSecretMasked: maskSecret(raw.appSecret),
    verifyTokenMasked: maskSecret(raw.verifyToken),
    encryptKeyMasked: maskSecret(raw.encryptKey),
    enforceSign: raw.enforceSign,
    hasAppSecret: Boolean(raw.appSecret),
    hasVerifyToken: Boolean(raw.verifyToken),
    hasEncryptKey: Boolean(raw.encryptKey),
    lastEventAt: raw.lastEventAt,
    webhookPath: '/api/feishu/webhook',
    connectionStatus,
  };
}

async function deliverFeishuAck(ack: FeishuAck): Promise<FeishuAck> {
  const raw = db.getFeishuSettingsRaw();
  if (!raw.appId || !raw.appSecret) {
    return { ...ack, delivery: 'sim' };
  }
  const result = await replyOrCreateFeishuMessage({
    creds: { appId: raw.appId, appSecret: raw.appSecret },
    text: ack.text,
    messageId: ack.messageId,
    chatId: ack.chatId,
  });
  if (result.skipped) return { ...ack, delivery: 'sim' };
  return {
    ...ack,
    delivery: result.delivery === 'feishu' ? 'feishu' : 'feishu_failed',
  };
}

function broadcast(event: WSEvent): void {
  if (event.type === 'feishu_ack') {
    // Attempt real outbound when credentials exist; always keep local bubble
    void (async () => {
      const delivered = await deliverFeishuAck(event.data);
      feishuAcks = [delivered, ...feishuAcks.filter((a) => a.id !== delivered.id)].slice(0, 50);
      const message = JSON.stringify({ type: 'feishu_ack', data: delivered });
      for (const client of wsClients) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      }
    })();
    return;
  }
  if (event.type === 'demo_timeline') {
    demoRunId = event.data.runId || demoRunId;
    const byId = new Map(demoSteps.map((s) => [s.id, s]));
    for (const s of event.data.steps) {
      byId.set(s.id, { ...byId.get(s.id), ...s } as DemoTimelineStep);
    }
    demoSteps = [
      'inbound',
      'ticket',
      'patch',
      'green',
      'gallery',
    ].map((id) => {
      const existing = byId.get(id as DemoTimelineStep['id']);
      return (
        existing ||
        ({
          id,
          label: id,
          detail: '',
          pane: 'world',
          status: 'pending',
        } as DemoTimelineStep)
      );
    });
    event = {
      type: 'demo_timeline',
      data: {
        runId: demoRunId,
        steps: demoSteps,
        conclusion: demoConclusion,
        primaryTicketId,
        primaryArtifactId,
      },
    };
  }
  if (event.type === 'demo_reset') {
    feishuAcks = [];
    demoSteps = [];
    demoRunId = '';
    primaryTicketId = null;
    primaryArtifactId = null;
    demoConclusion = null;
    // lock cleared by setDemoLock callers; keep scene
  }

  const message = JSON.stringify(event);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

const llmAvailable = Boolean(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY);
if (llmAvailable) {
  console.log('🧠 LLM available - enhanced assessment enabled');
} else {
  console.log('🔧 No LLM key - using heuristic engine (R7 Worker = 规则补丁，非 LLM)');
}

function emitPrimaryTimeline(
  runId: string,
  steps: Array<Partial<DemoTimelineStep> & { id: DemoTimelineStep['id']; detail: string; pane: DemoTimelineStep['pane']; status: DemoTimelineStep['status'] }>
) {
  if (!runId || runId === 'live') {
    console.warn('R3: refusing timeline emit without real runId');
    return;
  }
  if (demoRunId && runId !== demoRunId) {
    console.warn(`R3: ignoring timeline for non-primary runId=${runId} (primary=${demoRunId})`);
    return;
  }
  demoRunId = runId;
  broadcast({
    type: 'demo_timeline',
    data: {
      runId,
      steps: steps.map((s) => {
        const prev = demoSteps.find((x) => x.id === s.id);
        return {
          id: s.id,
          label: s.label || prev?.label || s.id,
          detail: s.detail,
          pane: s.pane,
          status: s.status,
          at: s.at,
          refId: s.refId,
        };
      }),
      conclusion: demoConclusion,
      primaryTicketId,
      primaryArtifactId,
    },
  });
}

const router = new Router({
  db,
  onEvent: broadcast,
  llmAvailable,
  demo: {
    getPrimaryRunId: () => demoRunId || null,
    ensurePrimaryRunId: () => {
      if (!demoRunId || demoRunId === 'live') {
        demoRunId = nanoid(8);
        demoSteps = baseTimeline(demoRunId);
        demoConclusion = null;
        primaryTicketId = null;
        primaryArtifactId = null;
      }
      return demoRunId;
    },
    getPrimaryTicketId: () => primaryTicketId,
    markPrimaryTicket: (id) => {
      primaryTicketId = id;
    },
    markPrimaryArtifact: (id) => {
      primaryArtifactId = id;
    },
    setConclusion: (c) => {
      demoConclusion = c;
      // R5: signal UI to auto-open primary artifact detail
      broadcast({
        type: 'demo_complete',
        data: {
          runId: demoRunId,
          primaryArtifactId,
          scene: demoScene,
          conclusion: demoConclusion,
        },
      } as any);
    },
    emitPrimaryTimeline,
  },
});

const watchdog = new Watchdog({
  db,
  onEvent: broadcast,
});

watchdog.start();

function baseTimeline(runId: string): DemoTimelineStep[] {
  return [
    { id: 'inbound', label: '群@进线', detail: '飞书形事件注入', pane: 'world', status: 'pending' },
    { id: 'ticket', label: '开 Ticket', detail: 'Router 接单', pane: 'atelier', status: 'pending' },
    {
      id: 'patch',
      label: 'Worker 改 calc.js',
      detail: '规则补丁（非 LLM）',
      pane: 'atelier',
      status: 'pending',
    },
    { id: 'green', label: '测绿', detail: 'node --test', pane: 'atelier', status: 'pending' },
    { id: 'gallery', label: '画廊产物', detail: '主故事：缺陷修复说明', pane: 'gallery', status: 'pending' },
  ];
}

function emitTimeline(runId: string, patch: Partial<DemoTimelineStep> & { id: DemoTimelineStep['id'] }) {
  if (!runId || runId === 'live') {
    console.warn('R3: emitTimeline skipped — runId must be real primary id');
    return;
  }
  emitPrimaryTimeline(runId, [
    {
      id: patch.id,
      label: patch.label,
      detail: patch.detail || '',
      pane: patch.pane || 'world',
      status: patch.status || 'done',
      at: patch.at,
      refId: patch.refId,
    },
  ]);
}

function enqueueFeishuTrigger(
  sourceKind: SourceKind,
  type: string,
  payload: Record<string, unknown>,
  threadTopics: string[]
) {
  const source = db.getSourceByKind(sourceKind);
  if (!source) throw new Error(`Source not initialized: ${sourceKind}`);
  const trigger = db.createTrigger({
    sourceId: source.id,
    sourceKind,
    type,
    payload,
    threadIds: [],
    threadTopics,
  });
  broadcast({ type: 'trigger_created', data: trigger });
  router.enqueueTrigger(trigger);
  watchdog.recordRouterActivity();
  return trigger;
}

// ============================================================================
// REST API
// ============================================================================

app.get('/api/mandates', (req, res) => {
  res.json(db.getAllMandates());
});

app.post('/api/mandates', (req, res) => {
  const mandate = db.createMandate({
    title: req.body.title,
    description: req.body.description || '',
    strength: 'explicit',
    scope: req.body.scope || 'general',
    active: true,
  });

  broadcast({ type: 'mandate_added', data: mandate });

  const source = db.getSourceByKind('intent-board');
  if (source) {
    const trigger = db.createTrigger({
      sourceId: source.id,
      sourceKind: 'intent-board',
      type: 'mandate_created',
      payload: { mandateId: mandate.id, title: mandate.title },
      threadIds: [],
      threadTopics: ['intent-board'],
    });

    broadcast({ type: 'trigger_created', data: trigger });
    router.enqueueTrigger(trigger);
    watchdog.recordRouterActivity();
  }

  res.json(mandate);
});

app.patch('/api/mandates/:id', (req, res) => {
  db.updateMandate(req.params.id, req.body);
  const mandates = db.getAllMandates();
  const updated = mandates.find((m) => m.id === req.params.id);
  if (updated) {
    broadcast({ type: 'mandate_updated', data: updated });
  }
  res.json(updated || { success: true });
});

app.get('/api/triggers', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(db.getRecentTriggers(limit));
});

app.post('/api/triggers', (req, res) => {
  const { sourceKind, type, payload, threadTopics } = req.body;

  const source = db.getSourceByKind(sourceKind);
  if (!source) {
    return res.status(400).json({ error: 'Invalid source kind' });
  }

  const trigger = db.createTrigger({
    sourceId: source.id,
    sourceKind,
    type,
    payload: payload || {},
    threadIds: [],
    threadTopics: threadTopics || [sourceKind],
  });

  broadcast({ type: 'trigger_created', data: trigger });
  router.enqueueTrigger(trigger);
  watchdog.recordRouterActivity();

  res.json(trigger);
});

app.get('/api/router-logs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  res.json(db.getRecentRouterLogs(limit));
});

app.get('/api/tickets', (req, res) => {
  const tickets =
    req.query.status === 'open' ? db.getOpenTickets() : db.getAllTickets();
  res.json(tickets);
});

app.get('/api/workers', (req, res) => {
  res.json(router.getWorkerStates());
});

app.get('/api/artifacts', (req, res) => {
  res.json(db.getAllArtifacts());
});

app.get('/api/watchdog-logs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(db.getRecentWatchdogLogs(limit));
});

app.get('/api/sources', (req, res) => {
  res.json(db.getAllSources());
});

app.get('/api/feishu/acks', (_req, res) => {
  res.json(feishuAcks);
});

app.get('/api/demo/timeline', (_req, res) => {
  const sceneFile = demoScene === 'B' ? 'format.js' : 'calc.js';
  res.json({
    runId: demoRunId,
    steps: demoSteps,
    conclusion: demoConclusion,
    primaryTicketId,
    primaryArtifactId,
    scene: demoScene,
    sceneLabel: `场景 ${demoScene} · ${sceneFile}`,
  });
});

/** R7: build offline-auditable pack (JSON or Markdown download) */
function buildAuditPack() {
  const tickets = db.getAllTickets();
  const artifacts = db.getAllArtifacts();
  const primaryTicket = primaryTicketId
    ? tickets.find((t) => t.id === primaryTicketId) || null
    : null;
  const primaryArtifact = primaryArtifactId
    ? artifacts.find((a) => a.id === primaryArtifactId) || null
    : null;
  const repro =
    primaryArtifact?.summary?.match(/复现:\s*(.+)$/)?.[1] ||
    (demoScene === 'B'
      ? 'cd /workspace/loom-sandbox && node --test src/format.test.js'
      : 'cd /workspace/loom-sandbox && node --test src/calc.test.js');
  const sceneFile = demoScene === 'B' ? 'format.js' : 'calc.js';
  return {
    version: '1.10.0-r10',
    exportedAt: new Date().toISOString(),
    runId: demoRunId || null,
    scene: demoScene,
    sceneLabel: `场景 ${demoScene} · ${sceneFile}`,
    workerMode: 'deterministic-rule-patch',
    sandboxPath: SANDBOX_ROOT,
    reproCommand: repro,
    conclusion: demoConclusion,
    timeline: {
      runId: demoRunId,
      steps: demoSteps,
      conclusion: demoConclusion,
    },
    primaryTicket: primaryTicket
      ? {
          id: primaryTicket.id,
          title: primaryTicket.title,
          status: primaryTicket.status,
          description: primaryTicket.description,
        }
      : null,
    primaryArtifact: primaryArtifact
      ? {
          id: primaryArtifact.id,
          title: primaryArtifact.title,
          type: primaryArtifact.type,
          summary: primaryArtifact.summary,
          content: primaryArtifact.content,
        }
      : null,
    acks: feishuAcks.map((a) => ({
      id: a.id,
      kind: a.kind,
      chatName: a.chatName,
      text: a.text,
      ticketId: a.ticketId,
      createdAt: a.createdAt,
    })),
  };
}

function auditPackToMarkdown(pack: ReturnType<typeof buildAuditPack>): string {
  const lines: string[] = [];
  lines.push(`# Loom 审计包 · ${pack.sceneLabel}`);
  lines.push('');
  lines.push(`- **版本**: ${pack.version}`);
  lines.push(`- **导出时间**: ${pack.exportedAt}`);
  lines.push(`- **runId**: ${pack.runId || '（空）'}`);
  lines.push(`- **workerMode**: ${pack.workerMode}`);
  lines.push(`- **sandbox**: ${pack.sandboxPath}`);
  lines.push('- **复现命令**: `' + pack.reproCommand + '`');
  lines.push(`- **结论**: ${pack.conclusion || '（尚未完成）'}`);
  lines.push('');
  lines.push('## 五步时间线');
  (pack.timeline.steps || []).forEach((s, i) => {
    lines.push(`${i + 1}. **${s.label}** [${s.status}] — ${s.detail || ''}${s.refId ? ` (ref=${s.refId})` : ''}`);
  });
  if (!(pack.timeline.steps || []).length) {
    lines.push('_（无步骤；请先跑一遍飞书场景）_');
  }
  lines.push('');
  lines.push('## 主故事 Ticket');
  if (pack.primaryTicket) {
    lines.push(`- **标题**: ${pack.primaryTicket.title}`);
    lines.push(`- **id**: ${pack.primaryTicket.id}`);
    lines.push(`- **状态**: ${pack.primaryTicket.status}`);
    lines.push(`- **描述**: ${pack.primaryTicket.description}`);
  } else {
    lines.push('_（无）_');
  }
  lines.push('');
  lines.push('## 主故事产物');
  if (pack.primaryArtifact) {
    lines.push(`- **标题**: ${pack.primaryArtifact.title}`);
    lines.push(`- **id**: ${pack.primaryArtifact.id}`);
    lines.push(`- **类型**: ${pack.primaryArtifact.type}`);
    lines.push(`- **摘要**: ${pack.primaryArtifact.summary}`);
    lines.push('');
    lines.push('### 正文');
    lines.push('');
    lines.push(pack.primaryArtifact.content || '');
  } else {
    lines.push('_（无）_');
  }
  lines.push('');
  lines.push('## 飞书 ACK 全文');
  if (pack.acks.length) {
    for (const a of pack.acks) {
      lines.push(`- **[${a.kind}]** ${a.chatName}: ${a.text}`);
    }
  } else {
    lines.push('_（无回执）_');
  }
  lines.push('');
  lines.push('## 离线复述提示');
  lines.push(
    '用本文件即可复述：群@进线 → 开主票 → Worker 规则补丁改 sandbox → node --test 绿 → 画廊缺陷说明 → 假机器人 ACK（含接单/修复/旁路简报语义）。'
  );
  lines.push('');
  lines.push('## 诚实边界');
  lines.push('本包 = **可对外演示的技术验证 demo**，**技术验证 ≠ 生产批准**。');
  lines.push('');
  return lines.join('\n');
}

app.get('/api/demo/audit', (req, res) => {
  const pack = buildAuditPack();
  const format = String(req.query.format || 'json').toLowerCase();
  const base = `loom-audit-${pack.runId || 'empty'}-${pack.scene}`;
  if (format === 'md' || format === 'markdown') {
    const md = auditPackToMarkdown(pack);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.md"`);
    return res.send(md);
  }
  res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
  res.json(pack);
});

app.get('/api/health', (_req, res) => {
  const feishu = publicFeishuSettings();
  res.json({
    status: 'ok',
    version: '1.10.0-r10',
    llmAvailable,
    feishuSim: !feishu.configured,
    feishuConfigured: feishu.configured,
    feishuConnection: feishu.connectionStatus,
    feishuLastEventAt: feishu.lastEventAt,
    workerMode: 'deterministic-rule-patch',
    sandbox: SANDBOX_ROOT,
    demoLock,
    demoLockKind,
    demoScene,
  });
});

function webhookPublicUrl(req: express.Request): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`);
  return `${proto}://${host}/api/feishu/webhook`;
}

app.get('/api/settings/feishu', (req, res) => {
  res.json({
    ...publicFeishuSettings(),
    webhookUrl: webhookPublicUrl(req),
    webhookHint:
      '同事真要用：开放平台事件订阅请求地址须可公网到达。本机 localhost 仅自测；需 ngrok/云主机/反向代理。',
  });
});

app.put('/api/settings/feishu', (req, res) => {
  try {
    const body = req.body || {};
    db.setFeishuSettings({
      appId: body.appId,
      appSecret: body.appSecret,
      verifyToken: body.verifyToken,
      encryptKey: body.encryptKey,
      enforceSign: Boolean(body.enforceSign),
      clearAppSecret: Boolean(body.clearAppSecret),
      clearVerifyToken: Boolean(body.clearVerifyToken),
      clearEncryptKey: Boolean(body.clearEncryptKey),
    });
    clearTokenCache();
    res.json({
      ok: true,
      ...publicFeishuSettings(),
      webhookUrl: webhookPublicUrl(req),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Reset sandbox only */
app.post('/api/sandbox/reset', (_req, res) => {
  try {
    resetSandboxBug();
    res.json({ ok: true, message: 'sandbox calc.js restored to buggy divide()' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** One-click reset: DB demo state + sandbox */
app.post('/api/demo/reset', (_req, res) => {
  try {
    router.shutdown();
    db.clearDemoState();
    resetSandboxBug();
    feishuAcks = [];
    demoSteps = [];
    demoRunId = '';
    primaryTicketId = null;
    primaryArtifactId = null;
    demoConclusion = null;
    setDemoLock(false);
    broadcast({ type: 'demo_reset', data: { ok: true } });
    res.json({ ok: true, message: 'DB demo state + sandbox reset' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Optional Feishu signature check. Uses DB settings (fallback env).
 * Default: skip unless enforceSign.
 */
function verifyFeishuRequest(req: express.Request, body: any): { ok: boolean; error?: string } {
  const cfg = db.getFeishuSettingsRaw();
  const enforce = cfg.enforceSign || process.env.FEISHU_ENFORCE_SIGN === '1';
  if (!enforce) return { ok: true };

  const token = cfg.verifyToken || '';
  if (body.type === 'url_verification') {
    if (token && body.token && body.token !== token) {
      return { ok: false, error: 'token mismatch' };
    }
    return { ok: true };
  }

  const timestamp = String(req.headers['x-lark-request-timestamp'] || '');
  const nonce = String(req.headers['x-lark-request-nonce'] || '');
  const signature = String(req.headers['x-lark-signature'] || '');
  const encryptKey = cfg.encryptKey || '';
  if (!encryptKey) {
    return { ok: false, error: 'ENCRYPT_KEY required when enforceSign' };
  }
  const raw = (req as any).rawBody || JSON.stringify(body);
  const computed = crypto
    .createHash('sha256')
    .update(timestamp + nonce + encryptKey + raw)
    .digest('hex');
  if (signature && computed !== signature) {
    return { ok: false, error: 'signature mismatch' };
  }
  return { ok: true };
}

function unwrapFeishuBody(body: any): { body: any; decrypted: boolean; error?: string } {
  if (!body || typeof body !== 'object') return { body: body || {}, decrypted: false };
  if (!body.encrypt) return { body, decrypted: false };
  const cfg = db.getFeishuSettingsRaw();
  if (!cfg.encryptKey) {
    return { body, decrypted: false, error: 'encrypted payload but ENCRYPT_KEY not configured' };
  }
  try {
    const plain = decryptFeishuEncrypt(String(body.encrypt), cfg.encryptKey);
    return { body: JSON.parse(plain), decrypted: true };
  } catch (e: any) {
    return { body, decrypted: false, error: `decrypt failed: ${e?.message || e}` };
  }
}

/**
 * Feishu webhook: real schema 2.0 + sim scenarios.
 * Unconfigured → sim still works. Configured → normalize + optional outbound ACK.
 */
app.post('/api/feishu/webhook', (req, res) => {
  const rawBody = req.body || {};
  const unwrapped = unwrapFeishuBody(rawBody);
  if (unwrapped.error) {
    return res.status(400).json({ ok: false, error: unwrapped.error });
  }
  const body = unwrapped.body;

  // URL verification challenge (real Feishu style)
  if (body.type === 'url_verification' && body.challenge) {
    const v = verifyFeishuRequest(req, body);
    if (!v.ok) return res.status(401).json({ error: v.error });
    return res.json({ challenge: body.challenge });
  }

  const v = verifyFeishuRequest(req, body);
  if (!v.ok) return res.status(401).json({ error: v.error });

  const cfg = db.getFeishuSettingsRaw();
  let sourceKind: SourceKind = 'feishu.message';
  let type = 'feishu_im_message';
  let payload: Record<string, unknown> = {};
  let threadTopics: string[] = ['feishu#default'];

  const scenario = body.scenario as string | undefined;
  const normalized = normalizeFeishuBody(body, { appId: cfg.appId });

  if (normalized) {
    sourceKind = normalized.sourceKind;
    type = normalized.type;
    payload = normalized.payload;
    threadTopics = normalized.threadTopics;
  } else if (
    scenario === 'group_bug_report' ||
    body.event_type === 'im.message.receive_v1' ||
    (body.schema === 'feishu.sim/v1' && String(body.event_type || '').includes('im.message'))
  ) {
    sourceKind = 'feishu.message';
    type = 'feishu_im_message';
    payload = body.payload || {
      schema: 'feishu.sim/v1',
      event_type: 'im.message.receive_v1',
      chat_id: body.chat_id || 'oc_sim_ops',
      chat_name: body.chat_name || '运维值班群',
      message_id: body.message_id || `om_sim_${Date.now()}`,
      sender: body.sender || { name: '张三', open_id: 'ou_sim_zhang' },
      mentions_bot: body.mentions_bot !== false,
      text:
        body.text ||
        '@Loom 报障：loom-sandbox 的 divide(10,0) 返回 Infinity，请复现并修',
      force_fail: Boolean(body.force_fail),
      raw_feishu_hint: '真实回调里 text 在 message.content JSON 字符串中',
    };
    threadTopics = [`feishu#${(payload as any).chat_name || '运维值班群'}`];
  } else if (scenario === 'doc_comment' || body.event_type === 'drive.file.comment_add_v1') {
    sourceKind = 'feishu.doc_comment';
    type = 'feishu_doc_comment';
    payload = body.payload || {
      schema: 'feishu.sim/v1',
      event_type: 'drive.file.comment_add_v1',
      doc_token: 'doccn_sim',
      doc_title: body.doc_title || '周五技术周报提纲',
      commenter: body.commenter || '李四',
      text: body.text || '请补充本周交付进度与站会材料，周五要用',
    };
    threadTopics = [`feishu-doc#${(payload as any).doc_title}`];
  } else if (scenario === 'calendar_brief' || body.event_type === 'calendar.event.reminder') {
    sourceKind = 'feishu.calendar';
    type = 'feishu_calendar_reminder';
    payload = body.payload || {
      schema: 'feishu.sim/v1',
      event_type: 'calendar.event.reminder',
      summary: body.summary || '周五技术站会',
      start_time: body.start_time || new Date().toISOString(),
    };
    threadTopics = ['feishu-calendar#weekly'];
  } else if (scenario === 'approval_approved' || body.event_type === 'approval.instance') {
    sourceKind = 'feishu.approval';
    type = 'feishu_approval';
    payload = body.payload || {
      schema: 'feishu.sim/v1',
      event_type: 'approval.instance',
      approval_name: body.approval_name || '生产发布审批',
      status: body.status || 'APPROVED',
      applicant: body.applicant || '王五',
    };
    threadTopics = ['feishu-approval#release'];
  } else if (body.sourceKind && body.type) {
    sourceKind = body.sourceKind;
    type = body.type;
    payload = body.payload || body;
    threadTopics = body.threadTopics || [`feishu#${sourceKind}`];
  } else {
    return res.status(400).json({
      error:
        'Unknown Feishu payload. Use schema 2.0 event, or scenario=group_bug_report|doc_comment|calendar_brief|approval_approved',
    });
  }

  try {
    db.touchFeishuLastEvent();
    const trigger = enqueueFeishuTrigger(sourceKind, type, payload, threadTopics);
    if (
      sourceKind === 'feishu.message' &&
      demoRunId &&
      demoRunId !== 'live' &&
      /divide|infinity|loom-sandbox|除零/i.test(String((payload as any).text || ''))
    ) {
      emitTimeline(demoRunId, {
        id: 'inbound',
        label: '群@进线',
        detail: String((payload as any).text || '').slice(0, 60),
        pane: 'world',
        status: 'done',
        at: Date.now(),
        refId: trigger.id,
      });
    }
    res.json({
      ok: true,
      trigger,
      decrypted: unwrapped.decrypted,
      mode: cfg.appId && cfg.appSecret ? 'configured' : 'sim',
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** One-click Feishu demo: reset sandbox, pin mandates, inject ALL 4 sources */
app.post('/api/demo/feishu', async (req, res) => {
  if (demoLock) {
    return res.status(409).json({
      ok: false,
      error: 'demo_locked',
      message: `演示进行中（${demoLockKind || 'running'}），请稍候再试或先 POST /api/demo/reset。`,
      demoLock: true,
      demoLockKind,
    });
  }

  try {
    const clearFirst = req.body?.reset !== false;
    const scene: SandboxScene = req.body?.scene === 'B' ? 'B' : 'A';
    demoScene = scene;
    setDemoLock(true, 'feishu', 14000);

    if (clearFirst) {
      router.shutdown();
      db.clearDemoState();
      feishuAcks = [];
      primaryTicketId = null;
      primaryArtifactId = null;
      demoConclusion = null;
      demoRunId = '';
      demoSteps = [];
      broadcast({ type: 'demo_reset', data: { ok: true } });
    }
    resetSandboxBug();

    const runId = nanoid(8);
    demoRunId = runId;
    primaryTicketId = null;
    primaryArtifactId = null;
    demoConclusion = null;
    const patchFile = scene === 'B' ? 'format.js' : 'calc.js';
    demoSteps = [
      { id: 'inbound', label: '群@进线', detail: '飞书形事件注入', pane: 'world', status: 'pending' },
      { id: 'ticket', label: '开 Ticket', detail: 'Router 接单', pane: 'atelier', status: 'pending' },
      {
        id: 'patch',
        label: `Worker 改 ${patchFile}`,
        detail: `规则补丁（非 LLM）· 场景 ${scene}`,
        pane: 'atelier',
        status: 'pending',
      },
      { id: 'green', label: '测绿', detail: 'node --test', pane: 'atelier', status: 'pending' },
      { id: 'gallery', label: '画廊产物', detail: '主故事：缺陷修复说明', pane: 'gallery', status: 'pending' },
    ];
    broadcast({
      type: 'demo_timeline',
      data: { runId, steps: demoSteps, conclusion: null, primaryTicketId: null, primaryArtifactId: null },
    });

    const ensureMandate = (title: string, description: string, scope: string) => {
      const existing = db.getActiveMandates().find((m) => m.title === title);
      if (existing) return existing;
      const mandate = db.createMandate({
        title,
        description,
        strength: 'explicit',
        scope,
        active: true,
      });
      broadcast({ type: 'mandate_added', data: mandate });
      return mandate;
    };

    ensureMandate(
      '静默复现并修复简单缺陷',
      '飞书群 @机器人 报障后，自动对 loom-sandbox 复现并打规则补丁（非 LLM）· 支持场景 A/B',
      'bugfix'
    );
    ensureMandate(
      '周五技术简报',
      '飞书日历/文档/审批触发时自动生成技术简报（模板）',
      'reporting'
    );

    const primaryText =
      scene === 'B'
        ? '@Loom 报障：loom-sandbox formatPercent(null) 抛 TypeError，请复现并修（场景 B）'
        : '@Loom 报障：loom-sandbox divide(10,0) 返回 Infinity，请复现并修';

    // 1) message — primary bug path
    const t1 = enqueueFeishuTrigger(
      'feishu.message',
      'feishu_im_message',
      {
        schema: 'feishu.sim/v1',
        event_type: 'im.message.receive_v1',
        chat_id: 'oc_sim_ops',
        chat_name: '运维值班群',
        message_id: `om_demo_${Date.now()}`,
        sender: { name: '张三', open_id: 'ou_sim_zhang' },
        mentions_bot: true,
        text: primaryText,
        scene,
      },
      ['feishu#运维值班群']
    );
    emitTimeline(runId, {
      id: 'inbound',
      label: '群@进线',
      detail:
        scene === 'B'
          ? '运维值班群 @Loom 报 formatPercent null'
          : '运维值班群 @Loom 报 divide Infinity',
      pane: 'world',
      status: 'done',
      at: Date.now(),
      refId: t1.id,
    });

    // 2) doc_comment — mid script (bypass brief only)
    setTimeout(() => {
      enqueueFeishuTrigger(
        'feishu.doc_comment',
        'feishu_doc_comment',
        {
          schema: 'feishu.sim/v1',
          event_type: 'drive.file.comment_add_v1',
          doc_token: 'doccn_sim',
          doc_title: '周五技术周报提纲',
          commenter: '李四',
          text: '请补充本周交付进度与站会材料，周五站会前要用',
        },
        ['feishu-doc#周五技术周报提纲']
      );
    }, 1800);

    // 3) calendar
    setTimeout(() => {
      enqueueFeishuTrigger(
        'feishu.calendar',
        'feishu_calendar_reminder',
        {
          schema: 'feishu.sim/v1',
          event_type: 'calendar.event.reminder',
          summary: '周五技术站会',
          start_time: new Date().toISOString(),
        },
        ['feishu-calendar#weekly']
      );
    }, 3200);

    // 4) approval
    setTimeout(() => {
      enqueueFeishuTrigger(
        'feishu.approval',
        'feishu_approval',
        {
          schema: 'feishu.sim/v1',
          event_type: 'approval.instance',
          approval_name: '生产发布审批',
          status: 'APPROVED',
          applicant: '王五',
        },
        ['feishu-approval#release']
      );
    }, 4500);

    res.json({
      ok: true,
      runId,
      scene,
      message:
        `Feishu demo R7 scene=${scene}: 模拟试用全链 · Worker=规则补丁；demoLock=14s`,
      triggerId: t1.id,
      workerMode: 'deterministic-rule-patch',
      demoLock: true,
    });
  } catch (e: any) {
    setDemoLock(false);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Optional blocked-path demo */
app.post('/api/demo/blocked', async (_req, res) => {
  if (demoLock) {
    return res.status(409).json({
      ok: false,
      error: 'demo_locked',
      message: `演示进行中（${demoLockKind || 'running'}），请稍候再试或先 POST /api/demo/reset。`,
      demoLock: true,
      demoLockKind,
    });
  }

  try {
    setDemoLock(true, 'blocked', 8000);
    router.shutdown();
    db.clearDemoState();
    feishuAcks = [];
    demoRunId = '';
    demoSteps = [];
    primaryTicketId = null;
    primaryArtifactId = null;
    demoConclusion = null;
    demoScene = 'A';
    resetSandboxBug();
    broadcast({ type: 'demo_reset', data: { ok: true } });

    const ensureMandate = (title: string, description: string, scope: string) => {
      const existing = db.getActiveMandates().find((m) => m.title === title);
      if (existing) return existing;
      const mandate = db.createMandate({
        title,
        description,
        strength: 'explicit',
        scope,
        active: true,
      });
      broadcast({ type: 'mandate_added', data: mandate });
      return mandate;
    };
    ensureMandate('静默复现并修复简单缺陷', 'blocked-path demo', 'bugfix');

    const t = enqueueFeishuTrigger(
      'feishu.message',
      'feishu_im_message',
      {
        schema: 'feishu.sim/v1',
        event_type: 'im.message.receive_v1',
        chat_id: 'oc_sim_ops',
        chat_name: '运维值班群',
        message_id: `om_block_${Date.now()}`,
        sender: { name: '张三', open_id: 'ou_sim_zhang' },
        mentions_bot: true,
        text: '@Loom 报障：loom-sandbox divide(10,0) Infinity（force_fail）',
        force_fail: true,
      },
      ['feishu#运维值班群']
    );

    res.json({ ok: true, triggerId: t.id, message: 'blocked-path demo started', demoLock: true });
  } catch (e: any) {
    setDemoLock(false);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ============================================================================
// HTTP + Vite UI + WebSocket
// ============================================================================

async function start() {
  const server = createHttpServer(app);
  const projectRoot = path.resolve(__dirname, '../..');
  const isProduction = path.basename(path.dirname(__dirname)) === 'dist';
  if (isProduction) {
    const clientRoot = path.join(projectRoot, 'dist/client');
    app.use(express.static(clientRoot));
    app.get('*', (_req, res) => res.sendFile(path.join(clientRoot, 'index.html')));
  } else {
    const vite = await createViteServer({
      configFile: path.join(projectRoot, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  server.listen(PORT, () => {
    console.log('Loom workspace running on http://localhost:' + PORT);
  });

  const wss = new WebSocketServer({ noServer: true });
  // Only consume application upgrades; Vite owns its HMR connection on this server.
  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== '/ws') return;
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    console.log('🔌 Client connected');

    ws.send(
      JSON.stringify({
        type: 'init',
        data: {
          mandates: db.getAllMandates(),
          triggers: db.getRecentTriggers(20),
          tickets: db.getAllTickets(),
          artifacts: db.getAllArtifacts(),
          routerLogs: db.getRecentRouterLogs(50),
          watchdogLogs: db.getRecentWatchdogLogs(20),
          workerStates: router.getWorkerStates(),
          evalDecisions: db.getRecentEvalDecisions(),
          feishuAcks,
          feishuSettings: publicFeishuSettings(),
          demoTimeline: {
            runId: demoRunId,
            steps: demoSteps,
            conclusion: demoConclusion,
            primaryTicketId,
            primaryArtifactId,
          },
          workerMode: 'deterministic-rule-patch',
          demoLock,
          demoLockKind,
          demoScene,
          version: '1.10.0-r10',
        },
      })
    );

    ws.on('close', () => {
      wsClients.delete(ws);
      console.log('🔌 Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      wsClients.delete(ws);
    });
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    watchdog.stop();
    router.shutdown();
    db.close();
    server.close();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('Failed to start Loom server:', err);
  process.exit(1);
});
