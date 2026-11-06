/** Loom uses the running personal assistant, never a second database, bot consumer or demo executor. */
import { shanghaiDate } from '../codex-delegation.ts'
import type { CodexDaily } from './codex-daily.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, latestReport, type Trigger, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import { feishuSettings } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'
import type { Artifacts, ArtifactVersion } from './artifacts.ts'
import type { QuietDrafts } from './quiet-drafts.ts'
import type { TaskControls } from './task-control.ts'
import type { FeishuMail, MailProposal } from './feishu-mail.ts'
import type { LoomArtifact, LoomMail, LoomSnapshot, LoomTask } from './loom-types.ts'
import type { Deployment } from '../deployment.ts'
import type { Health } from '../sources/host.ts'
import type { Delegations } from './delegations.ts'
import type { Settings } from './settings.ts'
import type { TaskProgress } from './task-progress.ts'
import type { ResultDelivery } from './result-delivery.ts'
import type { CodexHistory } from './codex-history.ts'
import type { DeviceSync } from '../sync/client.ts'
import type { FeishuSync } from '../sync/feishu.ts'
import { SyncError } from '../sync/model.ts'
import { packagePath } from '../infra/paths.ts'

interface Host {
  store: Store; sources: SourceRegistry; artifacts: Artifacts; quietDrafts: QuietDrafts; controls: TaskControls
  mail: FeishuMail; delegations: Delegations; health(): Record<string, Health>; configured(): boolean; deployment(): Deployment
  settings: Pick<Settings, 'save'>
  progress: TaskProgress
  resultDelivery: ResultDelivery
  codexHistory: CodexHistory; codexDaily: CodexDaily
  deviceSync: DeviceSync
  feishuSync: FeishuSync
  syncPort(): number
}
/** A bounded workspace input, authorization or revision failure, serialized by the loopback HTTP adapter. */
export class LoomError extends Error { constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message) } }
const revision = z.number().int().nonnegative()
const version = z.number().int().positive()
const dto = (value: ArtifactVersion): LoomArtifact => ({ subject: value.subject, kind: value.kind, title: value.title,
  version: value.version, body: value.body, hash: value.hash, author: value.author, at: value.at, sources: value.sources,
  ...value.editedVia ? { editedVia: value.editedVia } : {}, ...value.filename ? { filename: value.filename } : {} })
const mailView = (value: MailProposal): LoomMail => ({ token: value.token, ticketId: value.ticketId, to: value.to,
  subject: value.subject, body: value.body, status: value.status, artifactVersion: value.artifactVersion, createdAt: value.createdAt })

/** Projects the authenticated local owner's current Feishu scope and applies existing personal services. */
export class LoomWorkspace {
  constructor(private readonly host: Host) {}
  owner(): string {
    const { sources, store } = this.host, allowed = sources.policyPart('feishu')?.allowed ?? []
    if (!this.host.configured() || store.settings().sources.github?.enabled !== false
      || sources.instance('feishu')?.enabled !== true || !feishuSettings(sources).ownerOnly || allowed.length !== 1) {
      throw new LoomError(503, 'Loom 需要已配置的单人飞书助手；请先核对本机运行配置。')
    }
    return allowed[0]!.id
  }
  private task(id: string, owner: string): Ticket {
    const ticket = this.host.store.tickets.get(id)
    if (!ticket || !this.host.artifacts.canReadContext(ticket, owner)) throw new LoomError(404, '任务不存在或当前来源授权已撤销。')
    return ticket
  }
  private artifact(subject: string, owner: string, atVersion?: number): ArtifactVersion {
    const ticket = this.host.store.tickets.get(subject)
    if (ticket) this.task(subject, owner)
    else if (!this.host.quietDrafts.get(subject, owner)) throw new LoomError(404, '草稿不存在或当前来源授权已撤销。')
    const value = this.host.artifacts.get(subject, owner, atVersion)
    if (!value) throw new LoomError(404, '未找到获授权的产物版本。')
    return value
  }
  private deliverySetting(owner: string, ticketId?: string) {
    const value = this.host.resultDelivery.setting(owner, ticketId), global = this.host.resultDelivery.setting(owner)
    const effective = value.mode === 'default' ? global : value
    return { mode: value.mode, revision: value.revision, effectiveMode: effective.mode as 'feishu' | 'none' | 'mail',
      ...effective.binding ? { address: effective.binding.address } : {} }
  }
  private deliveryReceipts(owner: string, ticketId?: string) {
    return this.host.resultDelivery.list(owner, ticketId).map(({ id, ticketId, version, mode, status, at, updatedAt, destination, detail }) => ({ id, ticketId, version, mode, status, at, updatedAt, destination, detail }))
  }
  snapshot(): LoomSnapshot {
    const owner = this.owner(), { store, artifacts, quietDrafts, sources, controls } = this.host
    const config = feishuSettings(sources), settings = store.settings(), labels = store.get(KV.sources.labels('feishu')) ?? {}
    const tickets = store.tickets.list().filter(ticket => artifacts.canReadContext(ticket, owner))
    const drafts = quietDrafts.list(owner)
    const values = [...tickets.map(ticket => artifacts.snapshot(ticket)), ...drafts.map(draft => artifacts.get(draft.id, owner))]
      .filter((value): value is ArtifactVersion => !!value)
    const events: LoomSnapshot['events'] = store.db.prepare('SELECT value FROM trigger ORDER BY at DESC LIMIT 2000').all()
      .map(row => JSON.parse(String(row.value)) as Trigger).filter(trigger => artifacts.sourceAllowed(trigger, owner)).slice(0, 100).map(trigger => {
        const disposition = store.triggers.disposition(trigger.id), decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId) : undefined
        const request = store.get(KV.feishu.assistant(trigger.id))
        const thread = trigger.threads[0] && store.threads.get(`${trigger.threads[0].source}:${trigger.threads[0].id}`)
        const taskIds = tickets.filter(ticket => ticket.origin.triggerIds.includes(trigger.id) || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id)).map(ticket => ticket.id)
        return { id: trigger.id, text: trigger.source === 'codex-daily' ? `Codex 日报任务 · ${String(trigger.meta.date)}（来源快照限任务内读取）` : trigger.text, at: trigger.at, chat: trigger.source === 'codex-daily' ? '本机 Codex' : labels[String(trigger.meta.chatId)] ?? String(trigger.meta.chatId ?? ''),
          direct: trigger.meta.direct === true, action: request?.action, decision: decision?.kind,
          observed: decision?.audit?.would_accept === true, taskIds,
          ...(thread?.evaluating?.triggerIds.includes(trigger.id) ? { processing: 'evaluating' as const } : thread?.pending.includes(trigger.id) ? { processing: 'queued' as const } : {}) }
      })
    const receipts = this.host.delegations.activity(owner).map(event => ({ id: event.id, text: `${({created:'已保存',updated:'已更新',enabled:'已启用',paused:'已暂停'} as const)[event.action]}持续委托：${event.title}。这是配置生效回执；具体事件匹配后才会创建任务。`,
      at: event.at, chat: '持续委托', direct: false, observed: false, system: true }))
    events.push(...receipts)
    events.sort((a, b) => b.at.localeCompare(a.at))
    const tasks: LoomTask[] = tickets.map(ticket => {
      const control = controls.view(ticket.id), report = latestReport(ticket)
      return { id: ticket.id, title: ticket.title, description: ticket.mandate.scope, status: ticket.ended ? ticket.ended.outcome === 'completed' ? 'ended' : 'blocked'
        : ticket.attention || report?.state === 'blocked' || report?.state === 'failed' ? 'blocked' : 'open',
        outcome: ticket.ended?.outcome, completed: ticket.ended?.outcome === 'completed', createdAt: Date.parse(ticket.createdAt), updatedAt: Date.parse(ticket.updatedAt),
        ruleIds: ticket.mandate.basis.rules ?? [], executionState: report?.state === 'waiting' ? 'waiting' : ticket.assignments.at(-1)?.state === 'running' ? 'running' : 'queued',
        summary: report?.summary ?? '', control: { mode: control.mode, revision: control.revision, pending: control.operations.length } }
    })
    const deliveries = store.keys(KV.feishu.assistant).flatMap(name => {
      const request = store.get(name), trigger = request && store.triggers.get(request.triggerId)
      return request && trigger && artifacts.sourceAllowed(trigger, owner)
        ? [{ id: request.triggerId, action: request.action, status: request.status, at: request.at }] : []
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30)
    const model = settings.executor.model
    return { at: new Date().toISOString(), paused: settings.paused, mode: settings.eval.mode, model: typeof model === 'string' ? model : model ? `${model.provider}/${model.model}` : '', tasks,
      automation: { revision: store.blockRevision('eval'), maxWorkers: settings.executor.maxWorkers, timeoutSeconds: settings.eval.timeoutSeconds },
      delivery: this.deliverySetting(owner), resultDeliveries: this.deliveryReceipts(owner),
      artifacts: values.map(dto), drafts: drafts.map(draft => ({ id: draft.id, title: draft.title, status: draft.status, at: draft.at,
        ...draft.confirmedVersion ? { confirmedVersion: draft.confirmedVersion } : {} })), events,
      rules: settings.policy.rules.filter(rule => !rule.delegation).map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled, text: rule.instruction })), deliveries,
      policyRevision: store.blockRevision('policy'), delegations: this.host.delegations.list(owner, tickets),
      connection: { appId: this.host.deployment().feishu?.appId ?? '', name: this.host.deployment().feishu?.name ?? '飞书助手',
        cardsEnabled: config.cardsEnabled, draftsEnabled: config.draftsEnabled, mailProvider: config.mailProvider,
        chats: config.chats.map(chat => ({ chatId: chat.chatId, name: chat.name || labels[chat.chatId] || chat.chatId, listen: chat.listen })),
        health: Object.entries(this.host.health()).filter(([id]) => ['runtime','feishu','history','draft','assistant','cards','evals','result'].includes(id))
          .map(([id, health]) => ({ id, state: health.state })) } }
  }
  async handle(method: string, path: string[], query: Record<string, string>, body: () => Promise<unknown>): Promise<unknown> {
    const owner = this.owner(), { artifacts, quietDrafts, controls, mail, store } = this.host
    if (method === 'GET' && !path.length) return this.snapshot()
    const [kind, subject, operation] = path
    if (kind === 'sync') {
      const cloud = subject === 'feishu', segments = path.slice(cloud ? 2 : 1)
      if (segments[0] === 'mcp-config' && segments.length === 1 && method === 'GET') return { config: `[mcp_servers.loom_context]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(packagePath('lib', 'sync-mcp.js'))}]\n[mcp_servers.loom_context.env]\nLOOM_SYNC_LOCAL_URL = "http://127.0.0.1:${this.host.syncPort()}/orchestrator/api/loom/sync${cloud ? '/feishu' : ''}"\n` }
      try { return await (cloud ? this.host.feishuSync : this.host.deviceSync).handle(owner, method, segments, method === 'GET' || method === 'DELETE' ? undefined : await body()) }
      catch (error) { if (error instanceof SyncError || error instanceof z.ZodError) throw error; throw new LoomError(409, '同步服务连接或操作未完成，请核对服务地址和设备授权。') }
    }
    if (kind === 'codex') {
      try {
        if (subject === 'access' && path.length === 2 && method === 'GET') return this.host.codexHistory.access(owner)
        if (subject === 'access' && path.length === 2 && method === 'PUT') return this.host.codexHistory.save(owner, await body())
        if (subject === 'sessions' && method === 'GET') {
          const result = path.length === 2 ? await this.host.codexHistory.list(owner, query)
            : path.length === 3 && operation ? await this.host.codexHistory.messages(owner, operation, query) : undefined
          if (this.owner() !== owner) throw new LoomError(404, '当前所有者授权已变化。')
          if (result) return result
        }
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof LoomError) throw error
        throw new LoomError(409, error instanceof Error ? error.message : 'Codex 历史读取未完成。')
      }
      throw new LoomError(404, 'Codex 历史入口只支持日期授权及只读查询。')
    }
    if (kind === 'delivery' && path.length === 1 && method === 'PUT') {
      try { await this.host.resultDelivery.save(owner, await body()); return this.deliverySetting(owner) }
      catch (error) { if (error instanceof z.ZodError) throw error; throw new LoomError(409, error instanceof Error ? error.message : '交付设置未保存。') }
    }
    if (kind === 'delivery' && subject === 'mailbox' && path.length === 2 && method === 'POST') {
      const value = await mail.binding(owner)
      if (this.owner() !== owner) throw new LoomError(409, '所有者授权已变化。')
      return value
    }
    if (kind === 'tasks' && subject && operation === 'delivery' && path.length === 3) {
      const ticket = this.task(subject, owner)
      if (method === 'GET') return { setting: this.deliverySetting(owner, subject), receipts: this.deliveryReceipts(owner, subject) }
      if (method === 'PUT') {
        try { await this.host.resultDelivery.save(owner, await body(), subject); return { setting: this.deliverySetting(owner, subject), receipts: this.deliveryReceipts(owner, subject) } }
        catch (error) { if (error instanceof z.ZodError) throw error; throw new LoomError(409, error instanceof Error ? error.message : '交付设置未保存。') }
      }
      if (method === 'POST') {
        const input = z.object({ version }).strict().parse(await body()), artifact = this.artifact(subject, owner)
        if (input.version !== artifact.version) throw new LoomError(409, '产物已更新，请查看最新版本后再投递。')
        try { this.host.resultDelivery.enqueue(ticket, artifact) }
        catch (error) { throw new LoomError(409, error instanceof Error ? error.message : '暂不能投递。') }
        return { setting: this.deliverySetting(owner, subject), receipts: this.deliveryReceipts(owner, subject) }
      }
    }
    if (kind === 'tasks' && subject && operation === 'report-file' && path.length === 3 && method === 'POST') {
      const input = z.object({ version, filename: z.string().min(1).max(240) }).strict().parse(await body())
      try { return dto(artifacts.importReportFile(this.task(subject, owner), owner, input.version, input.filename)) }
      catch (error) { throw new LoomError(409, error instanceof Error ? error.message : '报告文件未登记。') }
    }
    if (kind === 'tasks' && subject && operation === 'progress' && path.length === 3 && method === 'GET') {
      this.task(subject, owner)
      const result = await this.host.progress.read(subject)
      if (this.owner() !== owner) throw new LoomError(404, '任务所有者授权已变化。')
      this.task(subject, owner)
      return result
    }
    if (kind === 'automation' && path.length === 1 && method === 'PUT') {
      const input = z.object({ mode: z.enum(['off', 'observe', 'auto']), revision }).strict().parse(await body())
      const result = await this.host.settings.save('eval', { ...store.settings().eval, mode: input.mode }, input.revision, 'panel')
      return { mode: store.settings().eval.mode, revision: result.revision,
        message: input.mode === 'auto' ? '已开启自主执行，符合已启用基础规则的新需求可自动创建任务。' : input.mode === 'observe' ? '已切为仅观察，基础规则不再自动接新任务。' : '已关闭基础规则的主动发现。' }
    }
    if (kind === 'rules' && path.length === 2 && subject && method === 'PATCH') {
      const input = z.object({ enabled: z.boolean(), revision }).strict().parse(await body()), policy = store.settings().policy
      const rule = policy.rules.find(rule => rule.id === subject && !rule.delegation && !rule.id.startsWith('loom-delegate-'))
      if (!rule) throw new LoomError(404, '未找到基础规则；持续委托请在对应卡片中操作。')
      const result = await this.host.settings.save('policy', { ...policy, rules: policy.rules.map(item => item.id === subject ? { ...item, enabled: input.enabled } : item) }, input.revision, 'panel')
      return { id: subject, enabled: input.enabled, revision: result.revision, message: input.enabled ? '基础规则已启用。' : '基础规则已停用，不再按它接新任务。' }
    }
    if (kind === 'delegations') {
      if (subject === 'codex-options' && path.length === 2 && method === 'GET') {
        const check = () => { if (this.owner() !== owner) throw new LoomError(409, '本人授权已变化。') }
        try { const result = await this.host.codexHistory.catalog(shanghaiDate(), check); check(); return result }
        catch (error) { if (error instanceof LoomError) throw error; throw new LoomError(409, 'Codex 会话列表暂不可用，请核对本机 Codex CLI。') }
      }
      if (subject && operation === 'run' && path.length === 3 && method === 'POST') {
        const input = z.object({ revision }).strict().parse(await body())
        try { return { run: this.host.codexDaily.run(owner, subject, input.revision), message: '已记录今天的运行请求；同一委托每天最多创建一个任务，可在委托卡片查看状态。' } }
        catch (error) { throw new LoomError(409, error instanceof Error ? error.message : '运行请求未保存。') }
      }
      if (method === 'POST' && path.length === 1) return this.host.delegations.create(owner, await body())
      if ((method === 'PUT' || method === 'PATCH') && subject && path.length === 2) return this.host.delegations.update(owner, subject, await body(), method === 'PATCH')
    }
    if (kind === 'artifacts' && subject && path.length === 2 && method === 'GET') {
      const at = query.version === undefined ? undefined : z.coerce.number().int().positive().parse(query.version)
      const value = this.artifact(subject, owner, at)
      return { artifact: dto(value), versions: artifacts.history(subject, owner).map(({ body: _body, ...entry }) => ({
        version: entry.version, hash: entry.hash, author: entry.author, at: entry.at, editedVia: entry.editedVia })) }
    }
    if (kind === 'artifacts' && subject && operation === 'export' && path.length === 3 && method === 'GET') {
      const at = z.coerce.number().int().positive().parse(query.version), value = this.artifact(subject, owner, at)
      return { filename: 'result.txt', content: `${value.title}\n版本：v${value.version}\nSHA256：${value.hash}\n作者：${value.author}\n时间：${value.at}\n来源：${value.sources.map(s => s.triggerId).join(', ')}\n\n${value.body}\n` }
    }
    if (kind === 'artifacts' && subject && path.length === 2 && method === 'PUT') {
      const input = z.object({ version, body: z.string().trim().min(1).max(40_000) }).strict().parse(await body())
      this.artifact(subject, owner)
      try { return dto(artifacts.edit(subject, owner, input.version, input.body, undefined, 'loom')) }
      catch (error) { throw new LoomError(409, error instanceof Error ? error.message : '版本冲突') }
    }
    if (kind === 'tasks' && subject && operation === 'control' && path.length === 3 && method === 'POST') {
      const input = z.object({ action: z.enum(['pause','resume','takeover','return']), revision }).strict().parse(await body())
      this.task(subject, owner)
      return controls.change(subject, input.action, input.revision)
    }
    if (kind === 'drafts' && subject && path.length === 2 && method === 'POST') {
      const input = z.object({ action: z.enum(['confirm','discard']), version: version.optional() }).strict().parse(await body())
      const draft = quietDrafts.get(subject, owner)
      if (!draft) throw new LoomError(404, '草稿不存在或授权已撤销。')
      if (input.action === 'confirm' && (this.artifact(subject, owner).version !== input.version || !['ready','confirmed'].includes(draft.status)))
        throw new LoomError(409, '草稿版本已变化或尚未就绪，请重新查看。')
      return { message: quietDrafts.change(subject, owner, input.action, input.version) }
    }
    if (kind === 'mail' && subject === 'connection' && method === 'POST' && path.length === 2) return { message: await mail.connection(owner) }
    if (kind === 'tasks' && subject && operation === 'mail' && method === 'POST' && path.length === 3) {
      const ticket = this.task(subject, owner), requestId = randomUUID()
      const message = await mail.preview(ticket, owner, requestId)
      // Resolve the stored permit, never extract authority from report text or a model answer.
      const proposal = mail.proposal(key('mail', requestId).slice(0, 12), owner)
      return { message, proposal: proposal ? mailView(proposal) : undefined }
    }
    if (kind === 'mail' && subject && path.length === 2 && method === 'POST') {
      const input = z.object({ action: z.enum(['confirm','cancel','status']) }).strict().parse(await body())
      const proposal = mail.proposal(subject, owner)
      if (!proposal) throw new LoomError(404, '未找到本人邮件预览。')
      const ticket = this.task(proposal.ticketId, owner)
      const message = input.action === 'confirm' ? await mail.confirm(proposal, ticket)
        : input.action === 'cancel' ? mail.cancel(proposal) : await mail.status(proposal)
      const current = mail.proposal(subject, owner)
      return { message, proposal: current ? mailView(current) : undefined }
    }
    throw new LoomError(404, '未找到该操作。')
  }
}
