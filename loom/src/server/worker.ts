/**
 * Worker - Executes one Ticket
 * R4: demoRunId passthrough + scene A/B + distinct titles (never 'live'); timeline only for primary narrative
 */

import type { LoomDB } from './db.js';
import type { Trigger, Assignment, WorkerState, Artifact, DemoTimelineStep } from '../shared/types.js';
import { reproduceAndPatchSandbox } from './sandboxWorker.js';

export interface WorkerOptions {
  db: LoomDB;
  ticketId: string;
  assignmentId: string;
  llmAvailable: boolean;
  onEvent: (event: any) => void;
  onComplete: (result: {
    status: 'completed' | 'failed' | 'blocked';
    artifact?: Artifact;
  }) => void;
  feishuChatName?: string;
  forceFail?: boolean;
  /** R3: primary demo run id — never hardcode 'live' */
  demoRunId?: string | null;
  isPrimaryNarrative?: boolean;
  onPrimaryTimeline?: (
    steps: Array<
      Partial<DemoTimelineStep> & {
        id: DemoTimelineStep['id'];
        detail: string;
        pane: DemoTimelineStep['pane'];
        status: DemoTimelineStep['status'];
      }
    >
  ) => void;
}

const WORKER_DISCLAIMER =
  '⚠️ **规则补丁 Worker = 规则补丁，非 LLM** — 确定性字符串替换 / 模板生成，不是大模型写的代码。';

export class Worker {
  private db: LoomDB;
  private ticketId: string;
  private assignmentId: string;
  private llmAvailable: boolean;
  private onEvent: (event: any) => void;
  private onComplete: WorkerOptions['onComplete'];
  private status: Assignment['status'] = 'pending';
  private progress = 'Initializing...';
  private lastHeartbeat = Date.now();
  private passthroughQueue: Trigger[] = [];
  private stopped = false;
  private sandboxResult: Awaited<ReturnType<typeof reproduceAndPatchSandbox>> | null = null;
  private forceFail: boolean;
  private demoRunId: string | null;
  private isPrimaryNarrative: boolean;
  private onPrimaryTimeline?: WorkerOptions['onPrimaryTimeline'];

  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.ticketId = options.ticketId;
    this.assignmentId = options.assignmentId;
    this.llmAvailable = options.llmAvailable;
    this.onEvent = options.onEvent;
    this.onComplete = options.onComplete;
    this.forceFail = Boolean(options.forceFail);
    this.demoRunId = options.demoRunId || null;
    this.isPrimaryNarrative = Boolean(options.isPrimaryNarrative);
    this.onPrimaryTimeline = options.onPrimaryTimeline;
  }

  private emitPrimarySteps(
    steps: Array<
      Partial<DemoTimelineStep> & {
        id: DemoTimelineStep['id'];
        detail: string;
        pane: DemoTimelineStep['pane'];
        status: DemoTimelineStep['status'];
      }
    >
  ): void {
    if (!this.isPrimaryNarrative || !this.demoRunId) return;
    this.onPrimaryTimeline?.(steps);
  }

  async start(): Promise<void> {
    this.updateStatus('running', 'progress', 'Starting work…（规则 Worker，非 LLM）');
    setImmediate(() => this.execute());
  }

  private async execute(): Promise<void> {
    try {
      const ticket = this.db.getTicket(this.ticketId);
      if (!ticket) {
        this.updateStatus('ended', 'failed', 'Ticket not found');
        this.onComplete({ status: 'failed' });
        return;
      }

      const mandate = this.db.getAllMandates().find((m) => m.id === ticket.mandateId);
      const isBugFix =
        (mandate?.title.includes('缺陷') || mandate?.scope === 'bugfix') ?? false;
      const isReporting =
        (mandate?.title.includes('简报') || mandate?.scope === 'reporting') ?? false;
      // R3: reporting tickets never touch sandbox (even if title mentions 缺陷闭环)
      const wantsSandbox =
        !isReporting &&
        (isBugFix ||
          /loom-sandbox|divide|Infinity|报障|bug|崩溃|复现|除零|formatPercent|format\.js|null/i.test(
            `${ticket.title}\n${ticket.description}`
          ));
      const sandboxScene: 'A' | 'B' =
        /formatPercent|format\.js|场景\s*B|Scene B/i.test(
          `${ticket.title}\n${ticket.description}`
        )
          ? 'B'
          : 'A';
      const patchLabel =
        sandboxScene === 'B' ? 'Worker 改 format.js' : 'Worker 改 calc.js';

      await this.simulateWork('分析触发上下文…（规则引擎）', 350);
      if (this.stopped) return;

      if (wantsSandbox) {
        this.emitPrimarySteps([
          {
            id: 'patch',
            label: patchLabel,
            detail: `规则补丁写入 loom-sandbox（场景 ${sandboxScene}）`,
            pane: 'atelier',
            status: 'active',
            at: Date.now(),
            refId: ticket.id,
          },
        ]);

        await this.simulateWork(
          `在 loom-sandbox 复现缺陷（场景 ${sandboxScene}）…`,
          250
        );
        if (this.stopped) return;
        try {
          this.sandboxResult = await reproduceAndPatchSandbox({
            forceFail: this.forceFail,
            scene: sandboxScene,
          });
          this.progress = this.sandboxResult.patched
            ? '已写入 sandbox 规则补丁，正在跑测试…'
            : 'sandbox 已是修复态，复核测试…';
          this.emitState();

          const greenDetail = this.sandboxResult.testAfter.ok
            ? `node --test pass · exit ${this.sandboxResult.testAfter.exitCode}`
            : `测试仍红 → blocked · exit ${this.sandboxResult.testAfter.exitCode}`;
          this.emitPrimarySteps([
            {
              id: 'patch',
              label: patchLabel,
              detail: this.sandboxResult.patched
                ? sandboxScene === 'B'
                  ? '已写入 null 保护'
                  : '已写入除零保护'
                : '已是修复态',
              pane: 'atelier',
              status: 'done',
              at: Date.now(),
              refId: ticket.id,
            },
            {
              id: 'green',
              label: '测绿',
              detail: greenDetail,
              pane: 'atelier',
              status: this.sandboxResult.testAfter.ok ? 'done' : 'active',
              at: Date.now(),
              refId: ticket.id,
            },
          ]);
        } catch (e) {
          const artifact = this.createBlockedArtifact(
            ticket,
            `Sandbox 补丁失败：${e}`,
            mandate?.title || ''
          );
          this.updateStatus('ended', 'blocked', `Sandbox work failed: ${e}`);
          this.onComplete({ status: 'blocked', artifact });
          return;
        }

        if (this.sandboxResult && !this.sandboxResult.testAfter.ok) {
          const artifact = this.createBlockedArtifact(
            ticket,
            `补丁后测试仍失败。\n\n\`\`\`\n${this.sandboxResult.testAfter.output.slice(0, 600)}\n\`\`\``,
            mandate?.title || ''
          );
          this.updateStatus('ended', 'blocked', '测试仍红 — Ticket blocked');
          this.onComplete({ status: 'blocked', artifact });
          return;
        }
      } else {
        await this.simulateWork('调查中…', 600);
        if (this.stopped) return;
        if (this.passthroughQueue.length > 0) {
          await this.handlePassthroughs(this.passthroughQueue.splice(0));
          if (this.stopped) return;
        }
        await this.simulateWork('整理方案…（模板）', 450);
        if (this.stopped) return;
      }

      const artifact = await this.createArtifact(ticket, mandate?.title || '');
      this.updateStatus('ended', 'ready', 'Work complete - artifact created（规则 Worker）');
      this.onComplete({ status: 'completed', artifact });
    } catch (error) {
      this.updateStatus('ended', 'failed', `Error: ${error}`);
      this.onComplete({ status: 'failed' });
    }
  }

  private async handlePassthroughs(triggers: Trigger[]): Promise<void> {
    this.progress = `Processing ${triggers.length} related event(s)...`;
    this.emitState();
    for (const trigger of triggers) {
      if (trigger.type === 'ci_failure') {
        await this.simulateWork('Incorporating CI failure data...', 300);
      } else if (trigger.sourceKind.startsWith('feishu')) {
        await this.simulateWork('合并飞书后续消息...', 250);
      } else if (trigger.type === 'im_message') {
        await this.simulateWork('Reviewing team discussion...', 250);
      }
    }
  }

  receivePassthrough(trigger: Trigger): void {
    if (this.status === 'running') {
      this.passthroughQueue.push(trigger);
    }
  }

  private createBlockedArtifact(ticket: any, reason: string, mandateTitle: string): Artifact {
    const summary = `阻塞：${reason.slice(0, 60).replace(/\n/g, ' ')}`;
    const content = `# 处理受阻：${ticket.title}

${WORKER_DISCLAIMER}

## 原因
${reason}

## Mandate
${mandateTitle || '(无)'}

---
*Loom 规则补丁 Worker · blocked*
`;
    const artifact = this.db.createArtifact({
      ticketId: this.ticketId,
      type: 'report',
      title: `受阻说明：${ticket.title}`.slice(0, 80),
      summary,
      content,
    });
    this.onEvent({ type: 'artifact_created', data: artifact });
    return artifact;
  }

  private async createArtifact(ticket: any, mandateTitle: string): Promise<Artifact> {
    let type: Artifact['type'] = 'report';
    let title = '';
    let summary = '';
    let content = '';

    if (mandateTitle.includes('缺陷') || this.sandboxResult) {
      type = 'pr_note';
      const scene = this.sandboxResult?.scene || 'A';
      const rel = this.sandboxResult?.relativeFile || 'src/calc.js';
      title = this.sandboxResult
        ? scene === 'B'
          ? '缺陷修复说明（场景B · format.js 规则补丁）'
          : '缺陷修复说明（真实 sandbox 规则补丁）'
        : '缺陷修复说明';
      if (this.sandboxResult) {
        const passLine = this.extractPassLine(this.sandboxResult.testAfter.output);
        const exitCode = this.sandboxResult.testAfter.exitCode;
        summary = `改了 ${rel} · 测 ${passLine} · exit ${exitCode} · 复现: ${this.sandboxResult.reproCommand}`;
      } else {
        summary = '未绑定 sandbox · 仅模板说明';
      }
      content = this.generateBugFixNote(ticket);
    } else if (mandateTitle.includes('简报') || /日历|审批|周报|简报|文档评论/.test(ticket.title)) {
      type = 'brief';
      // R4: distinguishable bypass titles (no twin「技术简报」)
      if (/审批/.test(ticket.title)) {
        title = '审批通过：生产发布变更说明';
        summary = '旁路 · 审批触发 · 模板 · 非 LLM';
      } else if (/文档评论|文档催更|云文档|周报提纲/.test(ticket.title)) {
        title = '文档催更：站会材料清单';
        summary = '旁路 · 文档评论触发 · 模板 · 非 LLM';
      } else if (/日历/.test(ticket.title)) {
        title = '日历触发：周五站会简报';
        summary = '旁路 · 日历提醒触发 · 模板 · 非 LLM';
      } else {
        title = '旁路简报：' + String(ticket.title).slice(0, 28);
        summary = '旁路 · 简报 Mandate · 模板 · 非 LLM';
      }
      content = this.generateTechBrief(ticket);
    } else {
      type = 'report';
      title = '工作报告';
      summary = '模板报告 · 规则 Worker 非 LLM';
      content = this.generateWorkReport(ticket);
    }

    const artifact = this.db.createArtifact({
      ticketId: this.ticketId,
      type,
      title,
      summary,
      content,
    });

    this.onEvent({ type: 'artifact_created', data: artifact });
    return artifact;
  }

  private extractPassLine(output: string): string {
    const m = output.match(/# pass\s+(\d+)[\s\S]*?# fail\s+(\d+)/);
    if (m) return `${m[1]} 绿 / fail ${m[2]}`;
    if (/pass/i.test(output) && !/fail\s+[1-9]/i.test(output)) return '全绿';
    return '见产物日志';
  }

  private generateBugFixNote(ticket: any): string {
    if (this.sandboxResult) {
      const r = this.sandboxResult;
      const passLine = this.extractPassLine(r.testAfter.output);
      return `# ${ticket.title}

${WORKER_DISCLAIMER}

## 真实项目验证（loom-sandbox · 场景 ${r.scene}）

**路径：** \`${r.filePath}\`
**相对文件：** \`${r.relativeFile}\`
**本轮是否写入文件：** ${r.patched ? '是（规则补丁）' : '否（已是修复态，仅复核）'}
**一句话：** 改了 \`${r.relativeFile}\`，测 ${passLine}，exit ${r.testAfter.exitCode}

### 人人可复制复现
\`\`\`bash
${r.reproCommand}
\`\`\`
**期望退出码（补丁后）：** \`${r.testAfter.exitCode}\`

### 测试（补丁前）
- 结果：${r.testBefore.ok ? '通过' : '失败（预期）'} · exit ${r.testBefore.exitCode}
\`\`\`
${r.testBefore.output.slice(0, 800)}
\`\`\`

### Diff
\`\`\`diff
${r.diffSummary}
\`\`\`

### 测试（补丁后）
- 结果：${r.testAfter.ok ? '✅ 通过' : '❌ 仍失败'} · exit ${r.testAfter.exitCode}
\`\`\`
${r.testAfter.output.slice(0, 800)}
\`\`\`

## 伪 PR
**Branch:** \`fix/sandbox-scene-${r.scene.toLowerCase()}\`
**Files:** \`${r.relativeFile}\`
**Status:** Ready for review

---
*Loom 规则补丁 Worker ${this.assignmentId} · 规则补丁真实改写了 sandbox*
`;
    }

    return `# ${ticket.title}

${WORKER_DISCLAIMER}

## 问题复现
根据飞书/IM 讨论描述完成调查（本 Ticket 未绑定 sandbox 真改路径）。

## 建议
将报障指向 \`loom-sandbox\` 的 divide 场景，以便 Worker 执行真实补丁。

---
*Auto-generated by Loom 规则补丁 Worker ${this.assignmentId}*
`;
  }

  private generateTechBrief(ticket: any): string {
    const now = new Date();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return `# ${/审批/.test(ticket.title) ? '审批通过：生产发布变更说明' : /文档评论|文档催更|云文档|周报提纲/.test(ticket.title) ? '文档催更：站会材料清单' : /日历/.test(ticket.title) ? '日历触发：周五站会简报' : '旁路简报'}

${WORKER_DISCLAIMER}

**周期：** ${weekStart.toLocaleDateString('zh-CN')} - ${now.toLocaleDateString('zh-CN')}
**触发 Ticket：** ${ticket.title}
**说明：** ${ticket.description}

## 本周进展
### 🐛 缺陷修复
- loom-sandbox divide-by-zero 闭环（飞书报障主叙事）
- 值班群假机器人 ACK：已接单 → 按产物类型回执（修复/简报/变更说明）

### 🔧 流程
- Mandate 钉板持续生效
- 飞书四源：\`im.message.receive_v1\` / \`drive.file.comment_add_v1\` / \`calendar.event.reminder\` / \`approval.instance\`
- 文档评论剧本去掉缺陷词，只催简报；同路径缺陷单防抖合并

## 下周计划
- 接真飞书时用 \`im.message.reply\` / 卡片更新对齐 ACK（本 demo 不调 Open API）

---
*Loom 规则补丁 Worker · 模板生成，非 LLM*
`;
  }

  private generateWorkReport(ticket: any): string {
    return `# 工作报告

${WORKER_DISCLAIMER}

## 任务
${ticket.title}

## 描述
${ticket.description}

## 完成内容
已完成初步调查和分析（模板）。

---
*Generated at ${new Date().toLocaleString('zh-CN')}*
`;
  }

  private async simulateWork(message: string, ms: number): Promise<void> {
    this.progress = message;
    this.lastHeartbeat = Date.now();
    this.emitState();
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private updateStatus(
    status: Assignment['status'],
    report: Assignment['report'],
    message: string
  ): void {
    this.status = status;
    this.progress = message;
    this.lastHeartbeat = Date.now();
    this.db.updateAssignment(this.assignmentId, {
      status,
      report,
      reportMessage: message,
    });
    const assignment = this.db.getAssignmentsByTicket(this.ticketId)[0];
    if (assignment) {
      this.onEvent({ type: 'assignment_updated', data: assignment });
    }
    this.emitState();
  }

  private emitState(): void {
    const subscriptions = this.db.getSubscriptionsByTicket(this.ticketId);
    const state: WorkerState = {
      id: `worker-${this.ticketId}`,
      ticketId: this.ticketId,
      status: this.status,
      subscribedThreads: subscriptions.map((s) => s.threadId),
      progress: this.progress,
      lastHeartbeat: this.lastHeartbeat,
    };
    this.onEvent({ type: 'worker_state', data: state });
  }

  getState(): WorkerState {
    const subscriptions = this.db.getSubscriptionsByTicket(this.ticketId);
    return {
      id: `worker-${this.ticketId}`,
      ticketId: this.ticketId,
      status: this.status,
      subscribedThreads: subscriptions.map((s) => s.threadId),
      progress: this.progress,
      lastHeartbeat: this.lastHeartbeat,
    };
  }

  stop(): void {
    this.stopped = true;
  }
}
