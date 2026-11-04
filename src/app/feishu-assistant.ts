/** Owner-authenticated Feishu queries and task controls; never evaluated by a model or fanned out as task input. */
import { settingsPolicy } from '../policy.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { key, latestReport, threadKey, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import { ControlConflict, type ControlAction, type TaskControls } from './task-control.ts'
import { FeishuMail } from './feishu-mail.ts'
import type { Artifacts, ArtifactVersion } from './artifacts.ts'
import type { QuietDrafts } from './quiet-drafts.ts'
import { assistantCard, taskListCard, CardEventSchema, type CardAction, type CardGrant } from './feishu-cards.ts'

export interface AssistantRequest {
  triggerId: string; ticketId?: string; action: string; text: string; body?: string; at: string
  status: 'queued' | 'sending' | 'sent' | 'unknown' | 'dropped'; messageId?: string
  subject?: string; editor?: { version: number; body: string }; cardTokens?: string[]
  args?: string[]; controlRevision?: number; mailToken?: string
  artifactVersion?: number
  focusTicketId?: string
}
interface Host {
  store: Store; controls: TaskControls; sources: SourceRegistry; effects: Effects; commands: Commands; stateDir: string
  configured(): boolean
  artifacts: Artifacts
  quietDrafts: QuietDrafts
}
type Command = { action: string; args: string[]; body?: string }
const modes = { agent: '助手可继续', pausing: '正在暂停', paused: '已暂停', taking_over: '正在交接', human: '你已接管' }
const plain = (text: string, max = 80): string => text.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, max)
const storeRequest = (store: Store, message: string): AssistantRequest | undefined => {
  const id = store.get(KV.feishu.assistantMessage(message))
  return id ? store.get(KV.feishu.assistant(id)) : undefined
}
const help = '可用指令：\n/助手 任务\n/助手 状态 [任务ID]\n/助手 产物 [任务ID] [v版本]\n/助手 导出 [任务ID] [v版本]\n/助手 版本 [任务ID]\n/助手 来源 [任务ID]\n/助手 暂停 [任务ID]\n/助手 接管 [任务ID]\n/助手 编辑 [任务ID]\n/助手 草稿箱\n/助手 邮箱\n/助手 邮件 任务ID\n继续、交还或确认邮件请使用最新卡片，或复制最新回复中的完整指令。\n可回复任务消息说“暂停这个任务”“把这版发到我邮箱”（仅预览）。\n任务列表、产物正文、导出和邮件仅在私聊提供；群内操作需 @ 机器人或在原任务线程内发送。'

/** Exact commands avoid interpreting quoted material, ordinary discussion or model output as control authority. */
export function assistantCommand(trigger: Trigger): Command | undefined {
  if (trigger.source !== 'feishu') return
  let text = trigger.text.trim()
  if (trigger.addressed === 'mention') text = text.replace(/^@[^\n]+?\s+(?=\/助手(?:\s|$)|看看|查看|暂停|接管|我来|编辑|导出|把这)/, '')
  const draft = /^\/助手 起草\s*\n([\s\S]+)$/.exec(text)
  if (draft) return { action: '起草', args: [], body: draft[1] }
  const edit = /^\/助手 保存改稿 ([a-f0-9]{32}) v(\d+)\r?\n([\s\S]+)$/.exec(text)
  if (edit) return { action: '保存改稿', args: [edit[1]!, edit[2]!], body: edit[3] }
  if (/^\/助手(?:\s|$)/.test(text) && /[\r\n]/.test(text)) return { action: '格式错误', args: [] }
  const match = /^\/助手(?:\s+([^\r\n]*))?$/.exec(text)
  if (match) { const [action, ...args] = (match[1] ?? '').trim().split(/\s+/); return { action: action || '帮助', args } }
  if (trigger.meta.direct !== true && !trigger.addressed && !trigger.meta.rootId && !trigger.meta.parentId) return
  if (/^(?:我的任务|查看任务|任务列表|查任务)[？?！!。]?$/.test(text)) return { action: '任务', args: [] }
  if (/^(?:我的产物|查看产物|今天有哪些产物|最近产物)[？?！!。]?$/.test(text)) return { action: '产物', args: [] }
  if (/^(?:草稿箱|我的草稿|待确认草稿)[？?！!。]?$/.test(text)) return { action: '草稿箱', args: [] }
  const actions: Record<string, string> = { '看看进展': '状态', '查看进展': '状态', '看看刚才的进展': '状态', '看看刚才的总结': '产物', '查看这份产物': '产物',
    '暂停这件事': '暂停', '暂停这个任务': '暂停', '接管这个任务': '接管', '我来修改': '接管', '编辑这份产物': '编辑', '导出这份产物': '导出',
    '把这版发到我邮箱': '邮件', '把这份总结发到我的邮箱': '邮件', '查看版本': '版本', '查看来源': '来源' }
  Object.assign(actions, { '看看这份草稿': '草稿', '确认这份草稿': '确认草稿', '忽略这份草稿': '忽略草稿', '编辑这份草稿': '编辑草稿',
    '导出这份草稿': '导出草稿', '确认发送这版': '确认邮件', '确认发送': '确认邮件', '取消发送': '取消邮件', '继续这个任务': '继续', '交还助手': '交还' })
  const phrase = text.replace(/[？?！!。]$/, '')
  if (actions[phrase]) return { action: actions[phrase]!, args: [] }
  if (/^(?:编辑|导出|看看|状态|暂停|接管|继续|交还)$/.test(phrase)) return { action: ({ 编辑: '编辑', 导出: '导出', 看看: '产物', 状态: '状态', 暂停: '暂停', 接管: '接管', 继续: '继续', 交还: '交还' } as Record<string, string>)[phrase]!, args: [] }
  const rewrite = /^改稿为[：:]\s*\n?([\s\S]+)$/.exec(text)
  if (rewrite) return { action: '保存改稿', args: [], body: rewrite[1] }
  if (trigger.meta.direct !== true) return
  const named = /^(?:查看|看看|看)(.{2,60}?)(?:的)?(产物|草稿|结果|进展|状态)[？?！!。]?$/.exec(text)
  if (named) return { action: ['进展', '状态'].includes(named[2]!) ? '状态' : named[2] === '草稿' ? '草稿' : '产物', args: [named[1]!] }
}

/** Consumes authenticated owner commands before Engine intake and persists query/export responses in a separate effect queue. */
export class FeishuAssistant {
  readonly mail: FeishuMail
  constructor(private readonly host: Host) {
    this.mail = new FeishuMail({ ...host, cli: () => String(host.sources.instance('feishu')?.config.mailCli ?? ''),
      provider: () => host.sources.instance('feishu')?.config.mailProvider === '163' ? '163' : 'feishu',
      smtpCli: () => String(host.sources.instance('feishu')?.config.smtpCli ?? ''),
      allowed: (owner, id) => { const ticket = host.store.tickets.get(id); return !!ticket && this.ownerTask(ticket, owner) && (ticket.mandate.actor.source !== 'codex-daily' || settingsPolicy(host.store.settings(), host.sources).revalidate(ticket.mandate)) } })
    host.effects.handle('assistant', (_payload, id) => this.deliver(id), { limit: () => host.configured() ? 1 : 0 })
  }
  /** Only the native bot event consumer calls this adapter; payload arguments never confer task authority. */
  receiveCard(input: unknown): ReceiveResult {
    if (this.host.sources.instance('feishu')?.config.cardsEnabled !== true) return 'filtered'
    const parsed = CardEventSchema.safeParse(input)
    if (!parsed.success) return 'filtered'
    const event = parsed.data, { store } = this.host
    let token: string | undefined, body: string | undefined
    try {
      token = event.action_name?.startsWith('save_') ? event.action_name.slice(5) : JSON.parse(event.action_value ?? '{}').grant
      if (event.action_name?.startsWith('save_')) body = JSON.parse(event.form_value ?? '{}').body
    } catch { return 'filtered' }
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return 'filtered'
    const grant = store.get(KV.cards.grant(token)), now = Date.now(), time = Number(event.timestamp)
    if (!grant || grant.owner !== event.operator_id || grant.chatId !== event.chat_id || grant.messageId !== event.message_id
      || !Number.isFinite(time) || now - time > 120_000 || time - now > 30_000) return 'filtered'
    const basis = store.triggers.get(grant.triggerId)
    if (!basis || !this.authorized(basis)) return 'filtered'
    const id = key('feishu-card', event.event_id)
    if (store.triggers.get(id)) return 'duplicate'
    if (grant.usedBy) return 'filtered'
    const current = grant.ticketId && store.tickets.get(grant.ticketId)
    const artifact = grant.subject ? this.host.artifacts.get(grant.subject, grant.owner) : undefined
    const stale = now > grant.expiresAt || grant.ticketId && (!current || !this.ownerTask(current, grant.owner)
      || grant.controlRevision !== this.host.controls.view(grant.ticketId).revision)
      || grant.artifactVersion !== undefined && grant.artifactVersion !== (artifact?.version ?? 0)
    if (grant.action === '保存改稿' && (typeof body !== 'string' || body.length > 1000)) return 'filtered'
    const text = stale ? '/助手 失效' : grant.action === '保存改稿'
      ? `/助手 保存改稿 ${grant.subject} v${grant.artifactVersion}\n${body}` : `/助手 ${grant.action} ${grant.args.join(' ')}`.trim()
    const trigger: Trigger = { ...basis, id, actor: { source: 'feishu', id: event.operator_id }, at: new Date(time).toISOString(), text,
      channel: { ...basis.channel!, address: { ...basis.channel!.address, messageId: event.message_id } },
      meta: { ...basis.meta, messageId: event.message_id, parentId: event.message_id, cardEventId: event.event_id } }
    return store.atomic(() => {
      store.set(KV.cards.grant(token!), { ...grant, usedBy: event.event_id })
      return this.receive(trigger) ?? 'filtered'
    })
  }
  /** Returning undefined leaves ordinary requests to the Engine; recognized commands are consumed even if refused. */
  receive(trigger: Trigger): ReceiveResult | undefined {
    const parsed = assistantCommand(trigger)
    if (!parsed) {
      // A new private work request must not leave an older selected task as the target of later controls.
      if (trigger.meta.direct === true && this.authorized(trigger) && !this.host.store.triggers.get(trigger.id)
        && !/^(?:谢谢|好的|收到|好|嗯|明白了)[!！。]?$/.test(trigger.text.trim())) {
        const focus = KV.feishu.assistantFocus(trigger.actor.id, String(trigger.meta.chatId))
        const current = this.host.store.get(focus)
        if (current && Date.parse(trigger.at) >= Date.parse(current.at) - 2000) this.host.store.delete(focus)
      }
      return
    }
    const command = this.resolveReference(trigger, parsed)
    const { store } = this.host
    if (store.triggers.get(trigger.id)) return 'duplicate'
    return store.atomic(() => {
      store.triggers.save(trigger)
      store.triggers.saveDisposition(trigger.id, { fanout: [], at: new Date().toISOString() })
      if (!this.authorized(trigger)) return 'filtered'
      const response = this.answer(trigger, command)
      const record: AssistantRequest = { triggerId: trigger.id, action: command!.action, args: command!.args,
        at: new Date().toISOString(), status: 'queued', ...response,
        ...response.ticketId || response.focusTicketId ? { controlRevision: this.host.controls.view((response.ticketId ?? response.focusTicketId)!).revision } : {} }
      store.set(KV.feishu.assistant(trigger.id), record)
      store.set(KV.feishu.assistantMessage(String(trigger.meta.messageId)), trigger.id)
      if (trigger.meta.direct === true && (record.ticketId || record.subject || ['任务', '草稿箱', '产物', '起草', '忽略草稿'].includes(record.action))) {
        // Wait for a confirmed response before activating its context, including when switching away from another task.
        store.delete(KV.feishu.assistantFocus(trigger.actor.id, String(trigger.meta.chatId)))
      }
      if (record.ticketId) store.set(KV.feishu.assistantThread(String(trigger.meta.messageId)), record.ticketId)
      this.host.effects.enqueue('assistant', trigger.id, {})
      return 'stored'
    })
  }
  private reference(trigger: Trigger): AssistantRequest | undefined {
    const refs = [trigger.meta.parentId, trigger.meta.rootId].filter(value => typeof value === 'string' && value !== trigger.meta.messageId) as string[]
    // An explicit quote is authoritative even when stale; never upgrade it to the private focus.
    if (refs.length) return refs.map(value => storeRequest(this.host.store, value)).find(Boolean)
    if (trigger.meta.direct !== true) return
    const focus = this.host.store.get(KV.feishu.assistantFocus(trigger.actor.id, String(trigger.meta.chatId)))
    if (!focus || Date.now() - Date.parse(focus.at) > 30 * 60_000 || Date.parse(trigger.at) < Date.parse(focus.at) - 2000) return
    const record = this.host.store.get(KV.feishu.assistant(focus.requestId))
    return record?.status === 'sent' ? { ...record, ticketId: record.ticketId ?? record.focusTicketId } : undefined
  }
  private resolveReference(trigger: Trigger, command: Command): Command {
    if (command.args.length) return command
    const reference = this.reference(trigger)
    const draft = reference?.subject && this.host.quietDrafts.get(reference.subject, trigger.actor.id)
    if (draft && ['编辑', '导出', '产物'].includes(command.action)) return { ...command, action: { 编辑: '编辑草稿', 导出: '导出草稿', 产物: '草稿' }[command.action]! }
    if (!draft && reference?.ticketId && ['草稿', '编辑草稿', '导出草稿'].includes(command.action)) return {
      ...command, action: { 草稿: '产物', 编辑草稿: '编辑', 导出草稿: '导出' }[command.action]!,
    }
    if (['确认邮件', '取消邮件', '邮件状态'].includes(command.action) && reference?.action === '邮件') {
      const token = reference.mailToken
      if (token) return { ...command, args: [token] }
    }
    if (['继续', '交还'].includes(command.action) && reference?.ticketId && reference.controlRevision !== undefined) {
      return { ...command, args: [reference.ticketId, `r${reference.controlRevision}`] }
    }
    return command
  }
  private authorized(trigger: Trigger): boolean {
    const { sources } = this.host
    return trigger.human && trigger.actor.source === 'feishu' && !!trigger.channel
      && trigger.channel.source === 'feishu' && trigger.channel.address.chatId === trigger.meta.chatId
      && trigger.channel.address.messageId === trigger.meta.messageId
      && sources.scope(trigger).listened
      && (sources.policyPart('feishu')?.allowed.some(person => person.id === trigger.actor.id) ?? false)
  }
  private owned(ticket: Ticket, trigger: Trigger): boolean {
    return this.ownerTask(ticket, trigger.actor.id)
  }
  private ownerTask(ticket: Ticket, owner: string): boolean {
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    if (ticket.mandate.actor.source === 'codex-daily') return this.host.artifacts.canReadContext(ticket, owner)
    return ticket.mandate.actor.source === 'feishu' && ticket.mandate.actor.id === owner
      && (this.host.sources.policyPart('feishu')?.allowed.some(person => person.id === owner) ?? false)
      && !!origin && origin.human && origin.actor.id === owner && origin.source === 'feishu'
      && this.host.sources.scope(origin).listened
  }
  private inOriginThread(ticket: Ticket, trigger: Trigger): boolean {
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    return !!origin && origin.threads.some(ref => trigger.threads.some(current => threadKey(current) === threadKey(ref)))
  }
  private tasks(trigger: Trigger): Ticket[] {
    return this.host.store.tickets.list().filter(ticket => this.owned(ticket, trigger)
      && (trigger.meta.direct === true || this.inOriginThread(ticket, trigger)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  private select(trigger: Trigger, id?: string): Ticket | undefined {
    const tasks = this.tasks(trigger)
    if (id) {
      const matches = /^[a-f0-9]{6,32}$/.test(id) ? tasks.filter(task => task.id.startsWith(id))
        : id.length >= 2 && id.length <= 60 ? tasks.filter(task => task.title.includes(id)) : []
      return matches.length === 1 ? matches[0] : undefined
    }
    const focused = this.reference(trigger)?.ticketId
    if (focused) return tasks.find(task => task.id === focused)
    const bound = [trigger.meta.parentId, trigger.meta.rootId].flatMap(value => typeof value === 'string'
      ? [this.host.store.get(KV.feishu.assistantThread(value))] : []).find(Boolean)
    if (bound) return tasks.find(task => task.id === bound)
    const sameThread = tasks.filter(task => this.inOriginThread(task, trigger))
    return sameThread.length === 1 ? sameThread[0] : undefined
  }
  private controlText(ticket: Ticket, direct: boolean): string {
    const state = this.host.controls.view(ticket.id)
    const lines = [`任务：${plain(ticket.title)}`, `ID：${ticket.id}`, `控制：${modes[state.mode]}`, `任务：${ticket.ended ? '已结束' : '未结束'}`]
    if (state.operations.length) lines.push(`在途：${state.operations.length} 项；待核查：${state.operations.filter(op => op.status === 'unknown').length} 项`)
    if (state.detail) lines.push('交接尚未完成，请核对实际操作结果；不自动重放。')
    if (state.mode === 'paused') lines.push(`/助手 继续 ${ticket.id} r${state.revision}`)
    if (state.mode === 'human') lines.push(`/助手 交还 ${ticket.id} r${state.revision}`)
    if (direct && this.host.artifacts.canReadContext(ticket, ticket.mandate.actor.id)) {
      const artifact = this.host.artifacts.snapshot(ticket)
      if (artifact) lines.push(`最近产物 v${artifact.version}：${plain(artifact.body, 300)}`)
      if (ticket.attention) lines.push(`待处理：${plain(ticket.attention.question, 200)}`)
    }
    return lines.join('\n')
  }
  private artifactBody(artifact: ArtifactVersion): string {
    return `${artifact.title}\n产物：${artifact.id} · v${artifact.version}\nSHA256：${artifact.hash}\n作者：${artifact.author}\n时间：${artifact.at}\n来源消息：${artifact.sources.map(source => source.triggerId).join(', ')}\n\n${artifact.body}\n`
  }
  private card(request: AssistantRequest, trigger: Trigger): { card: Record<string, unknown>; tokens: string[] } {
    const tokens: string[] = [], direct = trigger.meta.direct === true
    const grant = (label: string, action: string, args: string[], ticketId?: string, subject?: string, primary = false): CardAction => {
      const token = randomBytes(16).toString('hex')
      const value: CardGrant = { token, owner: trigger.actor.id, chatId: String(trigger.meta.chatId), triggerId: trigger.id,
        action, args, expiresAt: Date.now() + 600_000, ...ticketId ? { ticketId, controlRevision: this.host.controls.view(ticketId).revision } : {},
        ...subject ? { subject, artifactVersion: this.host.artifacts.get(subject, trigger.actor.id)?.version ?? 0 } : {} }
      this.host.store.set(KV.cards.grant(token), value); tokens.push(token)
      return { label, token, primary }
    }
    if (direct && !request.ticketId && request.action === '任务') {
      const page = Number(assistantCommand(trigger)?.args[0] ?? 1), tasks = this.tasks(trigger)
      const rows = tasks.slice((page - 1) * 5, page * 5).map(task => ({ title: task.title,
        detail: `${modes[this.host.controls.view(task.id).mode]} · ${task.ended ? '已结束' : '处理中'}`,
        action: grant('查看', '状态', [task.id], task.id, undefined, true) }))
      if (rows.length) return { card: taskListCard(rows, tasks.length > page * 5 ? grant('下一页', '任务', [String(page + 1)]) : undefined), tokens }
    }
    const actions: CardAction[] = [], ticket = request.ticketId && this.host.store.tickets.get(request.ticketId)
    const subject = request.subject ?? (ticket ? ticket.id : undefined)
    if (ticket) {
      const state = this.host.controls.view(ticket.id)
      actions.push(grant('刷新状态', '状态', [ticket.id], ticket.id, undefined, true))
      if (direct) actions.push(grant('查看产物', '产物', [ticket.id], ticket.id))
      if (state.mode === 'agent') actions.push(grant('暂停', '暂停', [ticket.id], ticket.id), grant('接管', '接管', [ticket.id], ticket.id))
      if (state.mode === 'paused') actions.push(grant('继续', '继续', [ticket.id, `r${state.revision}`], ticket.id))
      if (state.mode === 'human') {
        if (direct) actions.push(grant('编辑产物', '编辑', [ticket.id], ticket.id, ticket.id))
        actions.push(grant('交还助手', '交还', [ticket.id, `r${state.revision}`], ticket.id))
      }
      if (direct && subject && !request.editor) actions.push(grant('导出', '导出', [ticket.id], ticket.id, subject))
      if (direct && ticket.ended?.outcome === 'completed' && state.mode === 'agent') actions.push(grant('邮件预览', '邮件', [ticket.id], ticket.id, ticket.id))
    }
    if (direct && request.action === '草稿箱') {
      const drafts = this.host.quietDrafts.list(trigger.actor.id).slice(0, 5)
      for (const draft of drafts) actions.push(grant(draft.title.slice(0, 16), '草稿', [draft.id], undefined, draft.id, actions.length === 0))
    }
    if (direct && subject && this.host.quietDrafts.get(subject, trigger.actor.id)) {
      actions.push(grant('确认草稿', '确认草稿', [subject], undefined, subject, true), grant('编辑草稿', '编辑草稿', [subject], undefined, subject), grant('忽略', '忽略草稿', [subject], undefined, subject),
        grant('导出', '导出草稿', [subject], undefined, subject))
    }
    if (direct && request.action === '邮件') {
      const token = request.mailToken
      if (token) {
        actions.length = 0
        actions.push(grant('确认发送这版', '确认邮件', [token], ticket ? ticket.id : undefined, subject, true),
          grant('取消发送', '取消邮件', [token], ticket ? ticket.id : undefined, subject))
      }
    }
    let editor: { token: string; body: string } | undefined
    if (request.editor && subject && request.editor.body.length <= 1000) {
      const action = grant('保存新版本', '保存改稿', [], ticket ? ticket.id : undefined, subject, true)
      editor = { token: action.token, body: request.editor.body }
    }
    return { card: assistantCard(request.editor ? '编辑产物' : '个人助手', request.text, actions, editor), tokens }
  }
  private answer(trigger: Trigger, command: Command): Pick<AssistantRequest, 'text' | 'ticketId' | 'body' | 'subject' | 'editor' | 'artifactVersion' | 'focusTicketId'> {
    const { action, args } = command, direct = trigger.meta.direct === true
    const tasks = this.tasks(trigger)
    const bound = this.select(trigger)
    if (!direct && trigger.addressed !== 'mention' && !bound) return { text: '请在原任务线程使用指令，或 @ 机器人。' }
    if (action === '格式错误') return { text: '每条消息请只发一条指令；多行指令不会执行。改稿请回复“改稿为：”并附上完整正文。' }
    if (action === '失效') return { text: '这张卡片的版本或操作许可已失效，请重新发送“我的任务”或在原线程查询最新状态。' }
    const maxArgs = ['继续', '交还', '保存改稿', '产物', '导出'].includes(action) ? 2 : 1
    if (args.length > maxArgs || ['邮箱', '帮助', '草稿箱'].includes(action) && args.length) return { text: '指令参数过多，本次未执行。每条消息只使用一条指令。' }
    if (['产物', '导出'].includes(action) && args.length === 2 && !/^v[1-9]\d*$/.test(args[1]!)) return { text: '版本格式为 v1、v2 等；本次未执行。' }
    if (action === '帮助') return { text: help }
    if (['保存改稿', '确认草稿', '忽略草稿', '起草', '取消邮件'].includes(action)) {
      const age = Date.now() - Date.parse(trigger.at)
      if (!Number.isFinite(age) || age > 120_000 || age < -30_000) return { text: '操作消息已过期，请重新发送；历史消息不会改稿、起草或改变投递许可。' }
    }
    if (action === '起草') return { text: direct ? this.host.quietDrafts.request(trigger.id) : '请私聊机器人发送起草记录；群内自动起草仅按授权观察规则处理。' }
    if (['草稿箱', '草稿', '确认草稿', '忽略草稿', '导出草稿', '编辑草稿'].includes(action)) {
      if (!direct) return { text: '静默草稿仅通过机器人私聊查看。' }
      const drafts = this.host.quietDrafts.list(trigger.actor.id)
      if (action === '草稿箱') {
        const only = drafts.length === 1 ? this.host.artifacts.get(drafts[0]!.id, trigger.actor.id) : undefined
        return { ...only ? { subject: only.subject, artifactVersion: only.version } : {}, text: drafts.length ? drafts.slice(0, 5).map(draft => {
          const value = this.host.artifacts.get(draft.id, trigger.actor.id)
          return `${draft.title}\n${draft.id} · ${draft.status}${value ? ` · v${value.version}\n${value.body.slice(0, only ? 3000 : 500)}` : ''}\n/助手 草稿 ${draft.id}`
        }).join('\n\n') + (only ? '\n\n可直接发送“编辑这份草稿”“确认这份草稿”或“导出”，无需点击回复。' : '') : '暂无可查看的静默草稿。' }
      }
      const subject = args[0] ?? this.reference(trigger)?.subject
      const matched = subject ? drafts.filter(draft => draft.id === subject || /^[a-f0-9]{6,32}$/.test(subject) && draft.id.startsWith(subject)
        || subject.length >= 2 && draft.title.includes(subject)) : drafts.length === 1 ? drafts : []
      const draft = matched.length === 1 ? matched[0] : undefined
      if (!draft) return { text: '未找到获授权的草稿，请重新打开草稿箱。' }
      const artifact = this.host.artifacts.get(draft.id, trigger.actor.id)
      if (action === '编辑草稿' && artifact) return { subject: draft.id, artifactVersion: artifact.version,
        text: `编辑“${artifact.title}” v${artifact.version}。直接发送“改稿为：”和完整正文即可，保存后保留旧版本。`, editor: { version: artifact.version, body: artifact.body } }
      if (action === '确认草稿' || action === '忽略草稿') {
        const view = this.reference(trigger)
        if (action === '确认草稿' && (!artifact || view?.subject !== draft.id || view.artifactVersion !== artifact.version)) {
          return { text: '草稿版本已变化或尚未查看，请重新打开草稿箱后再确认。' }
        }
        return { ...action === '确认草稿' && artifact ? { subject: draft.id, artifactVersion: artifact.version } : {},
          text: this.host.quietDrafts.change(draft.id, trigger.actor.id, action === '确认草稿' ? 'confirm' : 'discard',
            view?.subject === draft.id ? view.artifactVersion : undefined) }
      }
      return { ...artifact ? { subject: draft.id, artifactVersion: artifact.version } : {}, text: artifact ? `静默草稿 · v${artifact.version}\n${artifact.body}\n\n仅保存在本机，尚未向群或邮箱发送。` : `草稿状态：${draft.status}\n/助手 忽略草稿 ${draft.id}`,
        ...action === '导出草稿' && artifact ? { body: this.artifactBody(artifact) } : {} }
    }
    if (action === '保存改稿') {
      if (!direct) return { text: '请在机器人私聊中编辑产物。' }
      const subject = args[0] ?? bound?.id ?? this.reference(trigger)?.subject
      const head = subject && this.host.artifacts.get(subject, trigger.actor.id)
      if (!head || !command.body) return { text: '请先查看具体产物，再直接发送“改稿为：”和完整正文；也可回复具体产物消息。' }
      // Text replies bind to the exact version displayed in that message, never to whichever version is newest now.
      const referenced = this.reference(trigger)
      const expected = args[1] ? Number(args[1]) : referenced?.editor?.version ?? referenced?.artifactVersion
      if (!expected) return { text: '请先打开具体产物或编辑消息，再发送“改稿为：”和完整正文，确保版本明确。' }
      try {
        const next = this.host.artifacts.edit(head.subject, trigger.actor.id, expected, command.body, trigger.id)
        return { ...head.kind === 'task' ? { ticketId: head.subject } : {}, subject: head.subject, artifactVersion: next.version,
          text: `已保存 v${next.version}，旧版本保留，旧邮件许可失效。\n${next.body}` }
      } catch (error) { return { text: error instanceof Error ? error.message : '改稿未保存。' } }
    }
    if (['邮箱', '邮件', '确认邮件', '取消邮件', '邮件状态'].includes(action) && !direct) return { text: '邮箱信息和邮件操作仅在机器人私聊中提供。' }
    if (action === '邮箱') return { text: '正在查询邮箱连接。' }
    if (['确认邮件', '取消邮件', '邮件状态'].includes(action)) {
      const proposal = this.mail.proposal(args[0] ?? '', trigger.actor.id)
      const ticket = proposal && tasks.find(task => task.id === proposal.ticketId)
      if (ticket && proposal && action === '取消邮件') return { ticketId: ticket.id, text: this.mail.cancel(proposal) }
      return ticket ? { ticketId: ticket.id, text: '正在处理你的邮件请求。' } : { text: '未找到属于你的邮件预览或任务授权已撤销。' }
    }
    if (action === '任务' || action === '产物' && !args.length && !bound) {
      if (!direct) return { text: '任务总览和产物列表请私聊机器人查看。' }
      const page = action === '任务' && args[0] ? Number(args[0]) : 1
      if (!Number.isSafeInteger(page) || page < 1) return { text: '页码应为正整数，例如 /助手 任务 2' }
      const selected = tasks.slice((page - 1) * 5, page * 5)
      return { ...tasks.length === 1 && selected[0] ? { focusTicketId: selected[0].id } : {}, text: selected.length ? selected.map(task => `${plain(task.title, 40)}\n${task.id}\n${modes[this.host.controls.view(task.id).mode]} · ${task.ended ? '已结束' : '未结束'}`).join('\n\n')
        + `\n\n/助手 状态 任务ID\n/助手 产物 任务ID\n/助手 任务 ${page + 1}` : '没有可显示的任务。' }
    }
    const revision = args.find(arg => /^r\d+$/.test(arg)), viewVersion = args.find(arg => /^v[1-9]\d*$/.test(arg)), id = args.find(arg => !/^[rv]\d+$/.test(arg))
    const ticket = this.select(trigger, id)
    if (!ticket) return { text: '未找到唯一且获授权的任务。请私聊发送“我的任务”，再复制任务 ID；原线程内可省略 ID。' }
    if (action === '状态') return { ticketId: ticket.id, text: this.controlText(ticket, direct) }
    if (action === '邮件') return { ticketId: ticket.id, text: '正在准备定稿邮件预览，尚未发送。' }
    if (['产物', '导出', '版本', '来源', '编辑'].includes(action)) {
      if (!direct) return { text: '产物正文与文件仅通过机器人私聊取回，避免把个人内容带入群。' }
      const report = latestReport(ticket), latest = this.host.artifacts.snapshot(ticket)
      const artifact = viewVersion ? this.host.artifacts.get(ticket.id, trigger.actor.id, Number(viewVersion.slice(1))) : latest
      if (!report) return { ticketId: ticket.id, text: '此任务尚未保存报告或结果；查询不会启动 Worker。' }
      if (!artifact) return { text: '未找到该版本，或产物来源已不在当前授权范围内。' }
      const meta = `v${artifact.version} · ${artifact.author === 'human' ? '本人编辑' : '助手生成'} · ${artifact.hash.slice(0, 12)}`
      if (action === '版本') return { ticketId: ticket.id, subject: ticket.id, text: this.host.artifacts.history(ticket.id, trigger.actor.id).map(value => `v${value.version} · ${value.author} · ${value.at} · ${value.hash.slice(0, 12)}`).join('\n') + `\n\n查看旧版：/助手 产物 ${ticket.id} v1\n导出旧版：/助手 导出 ${ticket.id} v1` }
      if (action === '来源') return { ticketId: ticket.id, subject: ticket.id, text: `${meta}\n来源消息：\n${artifact.sources.map(source => `${source.triggerId} · SHA256 ${source.hash}`).join('\n')}\n来源记录用于追溯消息；报告中引用的外部资料仍以正文引用和计算文件为准。` }
      if (action === '编辑') {
        const control = this.host.controls.view(ticket.id)
        if (control.mode !== 'human' || control.operations.length) return { ticketId: ticket.id, text: '请先点“接管”，等待交接完成，再打开编辑。' }
        return { ticketId: ticket.id, subject: ticket.id, artifactVersion: artifact.version, editor: { version: artifact.version, body: artifact.body },
          text: `正在编辑 ${meta}。保存将创建新版本。直接发送“改稿为：”和完整正文即可，无需点击回复。` }
      }
      const body = this.artifactBody(artifact)
      return { ticketId: ticket.id, text: action === '导出' ? '已保存结果导出。' : `已保存报告（${report.state}）：\n${plain(report.summary, 900)}\n\n全文导出：/助手 导出 ${ticket.id}`,
        subject: ticket.id, artifactVersion: artifact.version, ...action === '产物' ? { text: `已保存产物 · ${meta}\n${artifact.body.slice(0, 3000)}\n\n${artifact.requirement !== this.host.artifacts.requirement(ticket) ? '此版本尚未覆盖后续要求，请先更新。' : ''}` } : {},
        ...action === '导出' ? { body } : {} }
    }
    const actions: Record<string, ControlAction> = { 暂停: 'pause', 接管: 'takeover', 继续: 'resume', 交还: 'return' }
    const change = actions[action]
    if (!change) return { text: help }
    const age = Date.now() - Date.parse(trigger.at)
    if (!Number.isFinite(age) || age > 120_000 || age < -30_000) return { ticketId: ticket.id, text: '控制消息已过期，请查询最新状态后重新发送；历史消息不会改变控制权。' }
    if ((change === 'resume' || change === 'return') && !revision) return { ticketId: ticket.id, text: '为避免旧消息解除新的暂停，请复制最新状态中的完整继续／交还指令。\n' + this.controlText(ticket, direct) }
    const current = this.host.controls.view(ticket.id)
    try {
      this.host.controls.change(ticket.id, change, revision ? Number(revision.slice(1)) : current.revision)
      return { ticketId: ticket.id, text: `已记录“${action}”请求。\n${this.controlText(ticket, direct)}\n可随时发送 /助手 状态 查询实际状态。` }
    } catch (error) {
      if (!(error instanceof ControlConflict)) throw error
      return { ticketId: ticket.id, text: '当前状态不允许该操作，或指令已失效；请重新查询状态。\n' + this.controlText(ticket, direct) }
    }
  }
  private async deliver(id: string): Promise<void> {
    const { store, commands } = this.host
    let request = store.get(KV.feishu.assistant(id))
    const trigger = request && store.triggers.get(request.triggerId)
    if (!request || ['sent', 'unknown', 'dropped'].includes(request.status)) return
    // Lost responses cannot prove that Feishu did not accept the send. Do not replay after a crash.
    if (request.status === 'sending') { store.set(KV.feishu.assistant(id), { ...request, status: 'unknown' }); return }
    const ticket = request.ticketId && store.tickets.get(request.ticketId)
    if (!trigger || !this.authorized(trigger) || request.ticketId && (!ticket || !this.owned(ticket, trigger))) {
      store.set(KV.feishu.assistant(id), { ...request, status: 'dropped' }); return
    }
    if (request.subject && !this.host.artifacts.get(request.subject, trigger.actor.id)) {
      store.set(KV.feishu.assistant(id), { ...request, status: 'dropped' }); return
    }
    if (request.editor && request.subject && request.editor.version !== this.host.artifacts.get(request.subject, trigger.actor.id)?.version) {
      request = { ...request, editor: undefined, text: '产物已被更新，请重新打开编辑，避免覆盖新版。' }
    }
    // A list can span multiple source chats. Recompute it so revoked origins do not survive in a queued snapshot.
    if (!request.ticketId && ['任务', '产物'].includes(request.action)) {
      request = { ...request, focusTicketId: undefined, ...this.answer(trigger, assistantCommand(trigger)!) }
    }
    if (trigger.meta.direct === true && ['邮箱', '邮件', '确认邮件', '邮件状态'].includes(request.action)) {
      const command = { ...assistantCommand(trigger)!, args: request.args ?? assistantCommand(trigger)!.args }
      try {
        if (request.action === '邮箱') request.text = await this.mail.connection(trigger.actor.id)
        else if (request.action === '邮件' && ticket) {
          request.text = await this.mail.preview(ticket, trigger.actor.id, id)
          const proposal = this.mail.proposal(key('mail', id).slice(0, 12), trigger.actor.id)
          if (proposal?.ticketId === ticket.id) request.mailToken = proposal.token
        }
        else if (ticket) {
          const proposal = this.mail.proposal(command.args[0] ?? '', trigger.actor.id)
          if (proposal) {
            if (request.action === '邮件状态') request.text = await this.mail.status(proposal)
            else if (!Number.isFinite(Date.parse(trigger.at)) || Date.now() - Date.parse(trigger.at) > 120_000
              || Date.parse(trigger.at) - Date.now() > 30_000) request.text = '确认消息已过期，请重新预览；未执行发送。'
            else request.text = await this.mail.confirm(proposal, ticket)
          }
        }
      } catch (error) { request.text = error instanceof Error ? error.message : '邮箱操作未完成，请核对授权和实际结果。' }
      if (!this.authorized(trigger) || ticket && !this.owned(ticket, trigger)) {
        store.set(KV.feishu.assistant(id), { ...request, status: 'dropped' }); return
      }
    }
    const args = ['im', '+messages-reply', '--message-id', String(trigger.meta.messageId), '--idempotency-key', key('assistant', id)]
    if (trigger.meta.direct !== true) args.push('--reply-in-thread')
    let directory: string | undefined
    if (request.body) {
      directory = join(this.host.stateDir, 'assistant-exports', key('export', id))
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, 'result.txt'), request.body, { mode: 0o600 })
      args.push('--file', './result.txt')
    } else if (this.host.sources.instance('feishu')?.config.cardsEnabled === true) {
      const rendered = this.card(request, trigger)
      request = { ...request, cardTokens: rendered.tokens }
      args.push('--msg-type', 'interactive', '--content', JSON.stringify(rendered.card))
    } else args.push('--text', request.text)
    store.set(KV.feishu.assistant(id), { ...request, status: 'sending' })
    try {
      const sent = await commands.lark<{ message_id?: string }>(args, directory)
      store.set(KV.feishu.assistant(id), { ...request, status: 'sent', ...sent.message_id ? { messageId: sent.message_id } : {} })
      if (sent.message_id && request.ticketId) store.set(KV.feishu.assistantThread(sent.message_id), request.ticketId)
      if (sent.message_id) {
        store.set(KV.feishu.assistantMessage(sent.message_id), id)
        for (const token of request.cardTokens ?? []) {
          const value = store.get(KV.cards.grant(token))
          if (value) store.set(KV.cards.grant(token), { ...value, messageId: sent.message_id })
        }
        if (trigger.meta.direct === true) {
          const focus = KV.feishu.assistantFocus(trigger.actor.id, String(trigger.meta.chatId))
          if (request.ticketId || request.subject || request.focusTicketId) store.set(focus, { requestId: id, at: new Date().toISOString() })
          else if (['任务', '草稿箱', '产物', '起草', '忽略草稿'].includes(request.action)) store.delete(focus)
        }
      }
    } catch {
      store.set(KV.feishu.assistant(id), { ...request, status: 'unknown' })
      throw new Error('Feishu assistant response was not confirmed; inspect the destination before retrying')
    }
  }
}
