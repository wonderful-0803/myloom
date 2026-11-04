/**
 * Router - Resident orchestrator
 * R4: primaryRunId timeline binding; ACK by artifact type; defect ticket dedupe
 */

import type { LoomDB } from './db.js';
import { nanoid } from 'nanoid';
import type {
  Trigger,
  EvalDecision,
  Ticket,
  Mandate,
  Thread,
  FeishuAck,
  Artifact,
} from '../shared/types.js';
import { Worker } from './worker.js';
import { humanTicketCopy, feishuChatName } from './ticketTitle.js';

export interface DemoSessionHooks {
  getPrimaryRunId: () => string | null;
  ensurePrimaryRunId: () => string;
  getPrimaryTicketId: () => string | null;
  markPrimaryTicket: (ticketId: string) => void;
  markPrimaryArtifact: (artifactId: string) => void;
  setConclusion: (text: string) => void;
  /** Only primary narrative may emit demo_timeline patches */
  emitPrimaryTimeline: (
    runId: string,
    steps: Array<{
      id: 'inbound' | 'ticket' | 'patch' | 'green' | 'gallery';
      label?: string;
      detail: string;
      pane: 'world' | 'atelier' | 'gallery' | 'intent';
      status: 'pending' | 'active' | 'done';
      at?: number;
      refId?: string;
    }>
  ) => void;
}

export interface RouterOptions {
  db: LoomDB;
  onEvent: (event: any) => void;
  llmAvailable: boolean;
  demo?: DemoSessionHooks;
}

function isBugfixMandate(mandate: Mandate): boolean {
  return mandate.scope === 'bugfix' || mandate.title.includes('缺陷');
}

function looksLikeSandboxDefect(text: string): boolean {
  return /loom-sandbox|divide|infinity|除零|calc\.js|formatPercent|format\.js|场景\s*B/i.test(text);
}

function feishuReplyCtx(trigger: Trigger): { messageId: string | null; chatId: string | null } {
  const p = (trigger.payload || {}) as Record<string, any>;
  return {
    messageId: p.message_id ? String(p.message_id) : null,
    chatId: p.chat_id ? String(p.chat_id) : null,
  };
}


function completionAck(artifact: Artifact | undefined, ticketId: string, status: 'completed' | 'blocked'): {
  kind: FeishuAck['kind'];
  text: string;
} {
  const short = ticketId.slice(0, 8);
  if (status === 'blocked') {
    return {
      kind: 'blocked',
      text: `处理受阻 #${short}：${artifact?.summary || '测试未通过 / 补丁失败'}（详见画廊）`,
    };
  }
  const title = artifact?.title || '';
  const type = artifact?.type;
  if (type === 'pr_note' || /缺陷修复/.test(title)) {
    return {
      kind: 'fixed',
      text: `已修复并出说明 #${short}${title ? `「${title}」` : ''}`,
    };
  }
  if (/审批|变更说明/.test(title)) {
    return {
      kind: 'note',
      text: `已生成变更说明 #${short}${title ? `「${title}」` : ''}`,
    };
  }
  if (type === 'brief' || /简报/.test(title)) {
    return {
      kind: 'brief',
      text: `已生成简报 #${short}${title ? `「${title}」` : ''}`,
    };
  }
  return {
    kind: 'note',
    text: `已完成并出说明 #${short}${title ? `「${title}」` : ''}`,
  };
}

export class Router {
  private db: LoomDB;
  private onEvent: (event: any) => void;
  private llmAvailable: boolean;
  private demo?: DemoSessionHooks;
  private triggerQueue: Trigger[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private processing = false;
  private workers = new Map<string, Worker>();

  constructor(options: RouterOptions) {
    this.db = options.db;
    this.onEvent = options.onEvent;
    this.llmAvailable = options.llmAvailable;
    this.demo = options.demo;
  }

  enqueueTrigger(trigger: Trigger): void {
    this.triggerQueue.push(trigger);
    this.scheduleBatch();
  }

  private scheduleBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, 500);
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.triggerQueue.length === 0) return;

    this.processing = true;
    const batch = [...this.triggerQueue];
    this.triggerQueue = [];

    this.log('batch_start', `Processing batch of ${batch.length} trigger(s)`);

    for (const trigger of batch) {
      await this.processTrigger(trigger);
    }

    this.log('batch_end', `Batch complete`);
    this.processing = false;

    if (this.triggerQueue.length > 0) {
      this.scheduleBatch();
    }
  }

  private async processTrigger(trigger: Trigger): Promise<void> {
    const subscriptions: Array<{ ticketId: string; threadId: string }> = [];

    for (const threadId of trigger.threadIds) {
      const subs = this.db.getSubscriptionsByThread(threadId);
      for (const sub of subs) {
        const ticket = this.db.getTicket(sub.ticketId);
        if (ticket && ticket.status === 'open') {
          subscriptions.push({ ticketId: sub.ticketId, threadId: sub.threadId });
        }
      }
    }

    if (subscriptions.length > 0) {
      this.log('decision', `Trigger ${trigger.type} → passthrough to ${subscriptions.length} ticket(s)`);
      for (const sub of subscriptions) {
        const worker = this.workers.get(sub.ticketId);
        if (worker) {
          worker.receivePassthrough(trigger);
        }
      }
    } else {
      await this.evalTrigger(trigger);
    }
  }

  private async evalTrigger(trigger: Trigger): Promise<void> {
    const mandates = this.db.getActiveMandates();

    for (const threadId of trigger.threadIds) {
      const thread = this.db.getThread(threadId);
      if (!thread) continue;

      const gateResult = this.runGate(trigger, thread, mandates);

      if (gateResult) {
        const decision = this.db.createEvalDecision({
          triggerId: trigger.id,
          threadId: thread.id,
          decision: 'accept',
          path: 'fast',
          reason: gateResult.reason,
          mandateId: gateResult.mandateId,
        });

        this.onEvent({ type: 'eval_decision', data: decision });
        this.log('decision', `Fast Path: ${gateResult.reason}`);

        await this.acceptWork(trigger, thread, gateResult.mandateId);
        continue;
      }

      const assessResult = await this.runAssessment(trigger, thread, mandates);

      const decision = this.db.createEvalDecision({
        triggerId: trigger.id,
        threadId: thread.id,
        decision: assessResult.decision,
        path: 'slow',
        reason: assessResult.reason,
        mandateId: assessResult.mandateId || null,
      });

      this.onEvent({ type: 'eval_decision', data: decision });
      this.log('decision', `Slow Path: ${assessResult.reason}`);

      if (assessResult.decision === 'accept' && assessResult.mandateId) {
        await this.acceptWork(trigger, thread, assessResult.mandateId);
      }
    }
  }

  private runGate(
    trigger: Trigger,
    thread: Thread,
    mandates: Mandate[]
  ): { mandateId: string; reason: string } | null {
    if (trigger.sourceKind === 'intent-board') {
      const mandate = mandates.find((m) => m.active);
      if (mandate) {
        return {
          mandateId: mandate.id,
          reason: 'Intent Board trigger auto-accepted',
        };
      }
    }

    const payloadStr = JSON.stringify(trigger.payload);

    // Strong bug words (exclude bare「缺陷」— appears in「缺陷闭环」weekly language)
    const strongBugKeywords = [
      'bug',
      'crash',
      '崩溃',
      '错误',
      'error',
      'exception',
      '报障',
      'infinity',
      'divide',
      '除以零',
      '除零',
      '复现',
      'loom-sandbox',
    ];
    const hasStrongBug = strongBugKeywords.some((kw) =>
      payloadStr.toLowerCase().includes(kw.toLowerCase())
    );
    // 「缺陷」only counts outside doc_comment weekly phrasing
    const hasDefectWord = /缺陷/.test(payloadStr) && trigger.sourceKind !== 'feishu.doc_comment';
    const hasBugKeyword = hasStrongBug || hasDefectWord;

    const isFeishuMsg =
      trigger.sourceKind === 'feishu.message' ||
      trigger.sourceKind === 'feishu.doc_comment' ||
      trigger.type === 'feishu_im_message' ||
      trigger.type === 'feishu_doc_comment';

    // R3: doc_comment with 周报/站会 language and no strong bug → reporting (handled below)
    const docWeekly =
      trigger.sourceKind === 'feishu.doc_comment' &&
      /简报|周报|周五|提纲|站会|进度|材料/.test(payloadStr) &&
      !hasStrongBug;

    if (docWeekly) {
      const reportMandate = mandates.find(
        (m) => m.active && (m.title.includes('简报') || m.scope === 'reporting')
      );
      if (reportMandate) {
        return {
          mandateId: reportMandate.id,
          reason: '飞书文档评论匹配简报 Mandate（周报/站会语义，仅简报）',
        };
      }
    }

    if (!docWeekly && (hasBugKeyword || (isFeishuMsg && (trigger.payload as any).mentions_bot))) {
      const defectMandate = mandates.find(
        (m) => m.active && (m.title.includes('缺陷') || m.scope === 'bugfix')
      );
      if (defectMandate && (hasBugKeyword || (trigger.payload as any).mentions_bot)) {
        if (hasBugKeyword) {
          return {
            mandateId: defectMandate.id,
            reason: isFeishuMsg
              ? '飞书报障/缺陷关键词匹配缺陷 Mandate'
              : 'Bug keyword matched defect mandate',
          };
        }
      }
    }

    if (trigger.type === 'ci_failure') {
      const defectMandate = mandates.find(
        (m) => m.active && (m.title.includes('缺陷') || m.scope === 'bugfix')
      );
      if (defectMandate) {
        return {
          mandateId: defectMandate.id,
          reason: 'CI failure matched defect mandate',
        };
      }
    }

    if (
      trigger.type === 'weekly_timer' ||
      trigger.sourceKind === 'feishu.calendar' ||
      (trigger.sourceKind === 'feishu.doc_comment' &&
        /简报|周报|周五|提纲|站会|进度|材料/.test(payloadStr))
    ) {
      const reportMandate = mandates.find(
        (m) => m.active && (m.title.includes('简报') || m.scope === 'reporting')
      );
      if (reportMandate) {
        return {
          mandateId: reportMandate.id,
          reason:
            trigger.sourceKind === 'feishu.calendar'
              ? '飞书日历提醒匹配简报 Mandate'
              : trigger.sourceKind === 'feishu.doc_comment'
                ? '飞书文档评论匹配简报 Mandate（无缺陷词 → 仅简报）'
                : 'Weekly/brief trigger matched report mandate',
        };
      }
    }

    if (
      trigger.sourceKind === 'feishu.approval' &&
      String((trigger.payload as any).status || '').toUpperCase() === 'APPROVED'
    ) {
      const reportMandate = mandates.find(
        (m) => m.active && (m.title.includes('简报') || m.scope === 'reporting')
      );
      if (reportMandate) {
        return {
          mandateId: reportMandate.id,
          reason: '飞书审批通过 → 简报/说明 Mandate',
        };
      }
    }

    return null;
  }

  private async runAssessment(
    trigger: Trigger,
    thread: Thread,
    mandates: Mandate[]
  ): Promise<{ decision: EvalDecision['decision']; reason: string; mandateId?: string }> {
    if (!this.llmAvailable) {
      return this.heuristicAssessment(trigger, thread, mandates);
    }
    return this.heuristicAssessment(trigger, thread, mandates);
  }

  private heuristicAssessment(
    trigger: Trigger,
    thread: Thread,
    mandates: Mandate[]
  ): { decision: EvalDecision['decision']; reason: string; mandateId?: string } {
    const payload = JSON.stringify(trigger.payload).toLowerCase();

    const workIndicators = [
      'should fix',
      '应该修',
      'need to',
      '需要',
      'can you',
      'please',
      'investigate',
      '调查',
      'reproduce',
      '复现',
    ];

    const hasWorkIndicator = workIndicators.some((ind) => payload.includes(ind));
    const mentionsBot = Boolean((trigger.payload as any).mentions_bot);

    if ((hasWorkIndicator || mentionsBot) && mandates.length > 0) {
      // Prefer reporting mandate for doc_comment without strong bug keywords
      if (
        trigger.sourceKind === 'feishu.doc_comment' &&
        !/bug|crash|崩溃|infinity|divide|报障/.test(payload)
      ) {
        const report =
          mandates.find((m) => m.title.includes('简报') || m.scope === 'reporting') ||
          mandates[0];
        return {
          decision: 'accept',
          reason: '文档评论催简报（heuristic）',
          mandateId: report.id,
        };
      }

      const preferred =
        mandates.find((m) => m.title.includes('缺陷') || m.scope === 'bugfix') ||
        mandates[0];
      return {
        decision: 'accept',
        reason: mentionsBot
          ? '飞书 @机器人 → 投机接单 (heuristic)'
          : 'Speculative work detected (heuristic)',
        mandateId: preferred.id,
      };
    }

    return {
      decision: 'ignore',
      reason: 'No matching mandate or work indicators',
    };
  }

  /**
   * Accept work: create Ticket and dispatch to Worker
   * R3: defect dedupe; primary narrative timeline only for group@ divide-zero
   */
  private async acceptWork(trigger: Trigger, thread: Thread, mandateId: string): Promise<void> {
    const mandate = this.db.getAllMandates().find((m) => m.id === mandateId);
    if (!mandate) return;

    const { title, description } = humanTicketCopy(trigger, thread);
    const blob = `${title}\n${description}\n${JSON.stringify(trigger.payload)}`;

    // B: same sandbox defect path → merge/skip second ticket
    if (isBugfixMandate(mandate) && looksLikeSandboxDefect(blob)) {
      const existing = this.db.getAllTickets().find(
        (t) =>
          (t.status === 'open' || t.status === 'ended' || t.status === 'blocked') &&
          looksLikeSandboxDefect(`${t.title}\n${t.description}`)
      );
      if (existing) {
        this.log(
          'decision',
          `Skip duplicate defect ticket — keep #${existing.id.slice(0, 8)}「${existing.title}」`
        );
        if (String(trigger.sourceKind).startsWith('feishu')) {
          const ctx = feishuReplyCtx(trigger);
          const ack: FeishuAck = {
            id: nanoid(),
            chatName: feishuChatName(trigger, thread),
            kind: 'acked',
            text: `已并入现有缺陷单 #${existing.id.slice(0, 8)}「${existing.title}」`,
            ticketId: existing.id,
            createdAt: Date.now(),
            messageId: ctx.messageId,
            chatId: ctx.chatId,
            delivery: 'sim',
          };
          this.onEvent({ type: 'feishu_ack', data: ack });
        }
        // Passthrough to open worker if still running
        if (existing.status === 'open') {
          const worker = this.workers.get(existing.id);
          if (worker) worker.receivePassthrough(trigger);
          this.db.createSubscription(existing.id, thread.id);
        }
        return;
      }
    }

    const ticket = this.db.createTicket({
      mandateId,
      title,
      description,
      status: 'open',
    });

    this.onEvent({ type: 'ticket_created', data: ticket });

    // Primary narrative: feishu.message + sandbox divide bug + active demo run
    const isPrimaryCandidate =
      trigger.sourceKind === 'feishu.message' &&
      isBugfixMandate(mandate) &&
      looksLikeSandboxDefect(blob) &&
      Boolean(this.demo?.getPrimaryRunId());

    let isPrimary = false;
    let runId: string | null = null;
    if (isPrimaryCandidate && this.demo && !this.demo.getPrimaryTicketId()) {
      runId = this.demo.getPrimaryRunId();
      if (runId) {
        this.demo.markPrimaryTicket(ticket.id);
        isPrimary = true;
        this.demo.emitPrimaryTimeline(runId, [
          {
            id: 'ticket',
            label: '开 Ticket',
            detail: title,
            pane: 'atelier',
            status: 'done',
            at: Date.now(),
            refId: ticket.id,
          },
        ]);
      }
    }
    // Non-primary tickets: NO demo_timeline emission (prevents hijack)

    if (String(trigger.sourceKind).startsWith('feishu')) {
      const ctx = feishuReplyCtx(trigger);
      const ack: FeishuAck = {
        id: nanoid(),
        chatName: feishuChatName(trigger, thread),
        kind: 'acked',
        text: `已接单 #${ticket.id.slice(0, 8)}「${title}」`,
        ticketId: ticket.id,
        createdAt: Date.now(),
        messageId: ctx.messageId,
        chatId: ctx.chatId,
        delivery: 'sim',
      };
      this.onEvent({ type: 'feishu_ack', data: ack });
    }

    this.db.createSubscription(ticket.id, thread.id);

    await this.dispatch(ticket, trigger, thread, {
      demoRunId: isPrimary ? runId : null,
      isPrimaryNarrative: isPrimary,
    });
  }

  async dispatch(
    ticket: Ticket,
    trigger?: Trigger,
    thread?: Thread,
    narrative?: { demoRunId: string | null; isPrimaryNarrative: boolean }
  ): Promise<void> {
    this.log('dispatch', `Dispatching ticket ${ticket.id}「${ticket.title}」`);

    const workerId = `worker-${ticket.id}`;

    const assignment = this.db.createAssignment({
      ticketId: ticket.id,
      workerId,
      status: 'pending',
      report: null,
      reportMessage: null,
    });

    this.onEvent({ type: 'assignment_updated', data: assignment });

    const chatName = trigger ? feishuChatName(trigger, thread) : null;
    const replyCtx = trigger ? feishuReplyCtx(trigger) : { messageId: null, chatId: null };
    const isFeishu = Boolean(trigger && String(trigger.sourceKind).startsWith('feishu'));

    const worker = new Worker({
      db: this.db,
      ticketId: ticket.id,
      assignmentId: assignment.id,
      llmAvailable: this.llmAvailable,
      onEvent: this.onEvent,
      feishuChatName: isFeishu ? chatName || undefined : undefined,
      forceFail: Boolean((trigger?.payload as any)?.force_fail),
      demoRunId: narrative?.demoRunId || null,
      isPrimaryNarrative: Boolean(narrative?.isPrimaryNarrative),
      onPrimaryTimeline: (steps) => {
        const rid = narrative?.demoRunId || this.demo?.getPrimaryRunId();
        if (rid && narrative?.isPrimaryNarrative && this.demo) {
          this.demo.emitPrimaryTimeline(rid, steps);
        }
      },
      onComplete: (result) =>
        this.handleWorkerComplete(ticket.id, result, chatName || undefined, replyCtx),
    });

    this.workers.set(ticket.id, worker);
    worker.start();
  }

  private async handleWorkerComplete(
    ticketId: string,
    result: { status: 'completed' | 'failed' | 'blocked'; artifact?: Artifact },
    chatName?: string,
    replyCtx?: { messageId: string | null; chatId: string | null }
  ): Promise<void> {
    this.log('decision', `Worker completed: ticket ${ticketId} - ${result.status}`);

    this.workers.delete(ticketId);

    if (result.status === 'completed') {
      this.db.updateTicketStatus(ticketId, 'ended');
    } else if (result.status === 'blocked') {
      this.db.updateTicketStatus(ticketId, 'blocked');
    }

    const updated = this.db.getTicket(ticketId);
    if (updated) {
      this.onEvent({ type: 'ticket_updated', data: updated });
    }

    // ACK by artifact type (all Feishu tickets)
    if (chatName && (result.status === 'completed' || result.status === 'blocked')) {
      const { kind, text } = completionAck(result.artifact, ticketId, result.status);
      const ack: FeishuAck = {
        id: nanoid(),
        chatName,
        kind,
        text,
        ticketId,
        createdAt: Date.now(),
        messageId: replyCtx?.messageId ?? null,
        chatId: replyCtx?.chatId ?? null,
        delivery: 'sim',
      };
      this.onEvent({ type: 'feishu_ack', data: ack });
    }

    // Timeline gallery step ONLY for primary narrative
    const isPrimary = this.demo?.getPrimaryTicketId() === ticketId;
    if (isPrimary && result.artifact && this.demo) {
      const runId = this.demo.getPrimaryRunId();
      if (runId) {
        this.demo.markPrimaryArtifact(result.artifact.id);
        const passHint =
          result.status === 'blocked'
            ? '补丁受阻'
            : /2 绿|测 2|pass 2/i.test(result.artifact.summary || '')
              ? '2 测绿'
              : '测绿';
        const fileHint = /format\.js/.test(result.artifact.summary || '')
          ? 'format.js'
          : 'calc.js';
        const conclusion =
          result.status === 'blocked'
            ? '本轮：值班群报障 → 规则补丁受阻 → 已回执（blocked）'
            : `本轮：值班群报障 → 规则补丁 ${fileHint} → ${passHint} → 已回执`;
        this.demo.setConclusion(conclusion);
        this.demo.emitPrimaryTimeline(runId, [
          {
            id: 'gallery',
            label: '画廊产物',
            detail: result.artifact.title,
            pane: 'gallery',
            status: 'done',
            at: Date.now(),
            refId: result.artifact.id,
          },
        ]);
      }
    }
  }

  private log(type: 'batch_start' | 'batch_end' | 'dispatch' | 'decision', message: string): void {
    const log = this.db.addRouterLog({ type, message });
    this.onEvent({ type: 'router_log', data: log });
  }

  getWorkerStates() {
    const states = [];
    for (const [, worker] of this.workers) {
      states.push(worker.getState());
    }
    return states;
  }

  shutdown(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    for (const worker of this.workers.values()) {
      worker.stop();
    }
    this.workers.clear();
  }
}
