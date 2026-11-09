/**
 * The team gateway: the only holder of the Feishu bot. It admits each event, routes it to the sender's workspace by `union_id`
 * (creating one on first contact), and answers the workspace's `lark-cli` calls itself so every send and read is checked here,
 * never only in the workspace's prompts.
 */
import { createHash } from 'node:crypto'
import { CompactMessageEventSchema, incomingFromCompact, incomingFromRaw, messageText, RawMessageEventSchema, type FeishuPort, type HistoryMessage, type Incoming, type Outgoing } from './feishu.ts'
import { board, boardCard, boardFocus, MenuEventSchema, type BoardTicket } from './board.ts'
import type { TeamStore, Workspace } from './store.ts'

/** Starts (or wakes) a workspace's assistant; `issueToken` is called only when the workspace needs a new access token. */
export interface WorkspaceRuntime { ensure(workspace: Workspace, issueToken: () => string): Promise<void> }
export interface GatewayOptions {
  store: TeamStore; feishu: FeishuPort; runtime: WorkspaceRuntime
  /** Only senders of this tenant get a workspace; external contacts in shared groups are ignored. */
  tenantKey: string
  /** Names that address the bot in a group without an @, such as its persona name. */
  aliases?: string[]
  /** Optional allowlist; when it rejects a person, no workspace is created. Required for CLI events, which carry no tenant. */
  admit?: (person: { openId: string; unionId?: string }) => boolean
  /** A workspace's tasks for the menu board, read-only; without it the board shows none. */
  tickets?: (workspace: Workspace) => BoardTicket[]
  /** Messages routed per workspace per day (Asia/Shanghai) before new ones are declined. */
  dailyLimit?: number
  now?: () => Date
}
export type IngestOutcome = { outcome: 'routed'; workspaceId: string; created: boolean } | { outcome: 'duplicate' | 'ignored' | 'rejected'; reason: string; workspaceId?: string }
export type MenuOutcome = { outcome: 'board'; workspaceId: string; focus: string } | { outcome: 'duplicate' | 'ignored' | 'rejected' | 'failed'; reason: string; workspaceId?: string }
export interface CliResult { code: number; stdout: string; stderr: string }

/**
 * A group result goes to the group only when the request explicitly asks for it; everything else is sent privately to the requester.
 * Matching is deliberately literal, so a model's judgement can never widen it.
 */
const PUBLIC_REQUEST = /发到群里|发群里|发在群里|发到这个群|同步到群|群里同步|在群里(说|回|发|公布)|给大家|告诉大家|大家看|公开回复|@所有人|post (it )?(in|to) (the )?(group|chat)|share (it )?with (the )?(group|everyone)|tell everyone/i
export const isPublicRequest = (text: string): boolean => PUBLIC_REQUEST.test(text)

const BOOLEAN_FLAGS = new Set(['--reply-in-thread', '--no-reactions', '--page-all', '--verify', '--paginate', '--slurp', '--yes', '--json', '--dry-run'])
function flags(argv: string[]): { words: string[]; options: Map<string, string> } {
  const words: string[] = [], options = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!
    if (!item.startsWith('--')) { words.push(item); continue }
    if (BOOLEAN_FLAGS.has(item) || index + 1 >= argv.length) options.set(item, 'true')
    else options.set(item, argv[++index]!)
  }
  return { words, options }
}
const shanghaiDay = (at: Date): string => new Date(Date.parse(at.toISOString()) + 8 * 3600_000).toISOString().slice(0, 10)
const dayStart = (at: Date): string => new Date(Date.parse(shanghaiDay(at) + 'T00:00:00Z') - 8 * 3600_000).toISOString()
const json = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' })
const refuse = (message: string, code = 403): CliResult =>
  ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }), stderr: `team gateway: ${message}\n` })
/** The `+messages-mget` shape the workspace's readers validate (`src/sources/feishu-read.ts`). */
const cliMessage = (message: HistoryMessage) => ({ message_id: message.message_id, chat_id: message.chat_id, msg_type: message.msg_type,
  content: message.msg_type === 'text' ? messageText({ message_type: 'text', content: message.body.content } as never) : message.body.content,
  sender: message.sender, create_time: message.create_time, ...message.mentions ? { mentions: message.mentions } : {},
  ...message.root_id ? { root_id: message.root_id } : {}, ...message.parent_id ? { parent_id: message.parent_id } : {}, ...message.thread_id ? { thread_id: message.thread_id } : {} })

/** Routes each admitted event to its sender's workspace and answers that workspace's Feishu calls under the rules above. */
export class Gateway {
  private readonly waiters = new Map<string, Set<() => void>>()
  constructor(private readonly options: GatewayOptions) {}
  private get store(): TeamStore { return this.options.store }
  private now(): Date { return this.options.now?.() ?? new Date() }

  /** Admits and routes one raw Feishu event (simulation and webhook form); safe to call again with the same event. */
  async ingest(input: unknown): Promise<IngestOutcome> {
    const parsed = RawMessageEventSchema.safeParse(input)
    return parsed.success ? this.route(incomingFromRaw(parsed.data)) : { outcome: 'rejected', reason: 'invalid_event' }
  }
  /** Admits and routes one line from `lark-cli event consume`, which carries no `union_id` or tenant. */
  async ingestCompact(input: unknown): Promise<IngestOutcome> {
    const parsed = CompactMessageEventSchema.safeParse(input)
    return parsed.success ? this.route(incomingFromCompact(parsed.data)) : { outcome: 'rejected', reason: 'invalid_event' }
  }

  private async route(incoming: Incoming): Promise<IngestOutcome> {
    const at = this.now().toISOString()
    if (!this.store.markSeen(incoming.eventId, 'received', at) || this.store.message(incoming.messageId)) return { outcome: 'duplicate', reason: 'already_seen' }
    const ignore = (reason: string, workspaceId?: string): IngestOutcome => {
      this.store.setSeen(incoming.eventId, reason)
      this.store.audit('ignored', { reason, chat: incoming.chatType }, workspaceId ?? null, at)
      return { outcome: 'ignored', reason, ...workspaceId ? { workspaceId } : {} }
    }
    if (incoming.senderType !== 'user') return ignore('not_a_user')
    if (incoming.tenantKey === undefined) {
      // Without a tenant on the event, only an explicit allowlist keeps external contacts out.
      if (!this.options.admit) return ignore('tenant_unknown')
    } else if (incoming.tenantKey !== this.options.tenantKey) return ignore('external_tenant')
    // The workspace key: union_id when Feishu provides it, else the open_id, which is stable within this one app.
    const identity = incoming.senderUnionId ?? (incoming.tenantKey === undefined ? 'open:' + incoming.senderOpenId : undefined)
    if (!identity) return ignore('no_union_id')
    const bot = this.options.feishu.bot, text = incoming.text
    const mentioned = incoming.mentions.includes(bot.openId)
    const addressed = incoming.chatType === 'p2p' || mentioned || [bot.name, ...this.options.aliases ?? []].some(name => name && text.includes(name))
    if (!addressed) return ignore('not_addressed')

    const existing = this.store.byUnion(identity)
    if (existing?.status === 'disabled') return ignore('workspace_disabled', existing.id)
    if (!existing && this.options.admit && !this.options.admit({ openId: incoming.senderOpenId, ...incoming.senderUnionId ? { unionId: incoming.senderUnionId } : {} }))
      return ignore('not_admitted')
    let token: string | undefined
    const workspace = existing ?? (() => {
      const made = this.store.createWorkspace({ unionId: identity, openId: incoming.senderOpenId, tenantKey: incoming.tenantKey ?? '', name: '' }, at)
      token = made.token
      this.store.audit('workspace_created', { chat: incoming.chatType }, made.workspace.id, at)
      return made.workspace
    })()
    const created = !existing
    const limit = this.options.dailyLimit
    if (limit !== undefined && this.store.routedSince(workspace.id, dayStart(this.now())) >= limit) {
      await this.notify(workspace, `quota:${shanghaiDay(this.now())}`, '今天的使用次数已达上限，明天再来找我吧。')
      return ignore('quota', workspace.id)
    }
    // A group event is delivered as if the bot were mentioned, since the gateway already decided it was addressed.
    const line = { ...incoming.line }
    if (incoming.chatType === 'group' && !mentioned) line.mentions = [...line.mentions as unknown[], { id: bot.openId, key: '@_gateway', name: bot.name }]
    const seq = this.store.atomic(() => {
      const value = this.store.enqueue({ eventId: incoming.eventId, messageId: incoming.messageId, workspaceId: workspace.id, chatId: incoming.chatId,
        chatType: incoming.chatType, text, line: JSON.stringify(line), receivedAt: at })
      this.store.touch(workspace.id, at, incoming.senderOpenId)
      this.store.setSeen(incoming.eventId, 'routed')
      return value
    })
    this.store.audit('routed', { seq, chat: incoming.chatType }, workspace.id, at)
    if (created) await this.notify(workspace, 'welcome', '你好，我是团队工作助手。我已为你单独开了一个工作区：你的会话、任务和产物只保存在里面，其他同事看不到。'
      + '\n在群里 @ 我时，我默认私聊回复你；需要发到群里时请直接说「发到群里」。')
    if (incoming.chatType === 'group') await this.options.feishu.react(incoming.messageId, 'OK').catch(() => {})
    this.wake(workspace.id)
    const issued = token
    await this.options.runtime.ensure(workspace, () => issued ?? this.store.rotateToken(workspace.id)).catch(error => {
      this.store.audit('runtime_failed', { error: String(error).slice(0, 300) }, workspace.id, this.now().toISOString())
    })
    return { outcome: 'routed', workspaceId: workspace.id, created }
  }

  /**
   * Answers a click on the bot's menu (`application.bot.menu_v6`) with a private card of the clicker's own workspace. The
   * clicker is the only possible reader: the card goes to their open_id and shows only the workspace keyed by it.
   */
  async menu(input: unknown): Promise<MenuOutcome> {
    const parsed = MenuEventSchema.safeParse(input)
    if (!parsed.success) return { outcome: 'rejected', reason: 'invalid_event' }
    const event = parsed.data, openId = (event.operator_open_id ?? event.operator_id)!, at = this.now().toISOString()
    const eventId = 'menu:' + (event.event_id ?? `${openId}:${event.event_key}:${event.menu_timestamp ?? event.timestamp ?? at}`)
    if (!this.store.markSeen(eventId, 'received', at)) return { outcome: 'duplicate', reason: 'already_seen' }
    const ignore = (reason: string, workspaceId?: string): MenuOutcome => {
      this.store.setSeen(eventId, reason)
      this.store.audit('menu_ignored', { reason }, workspaceId ?? null, at)
      return { outcome: 'ignored', reason, ...workspaceId ? { workspaceId } : {} }
    }
    if (this.options.tenantKey && event.tenant_key !== this.options.tenantKey) return ignore('external_tenant')
    if (this.options.admit && !this.options.admit({ openId, ...event.operator_union_id ? { unionId: event.operator_union_id } : {} })) return ignore('not_admitted')
    const workspace = (event.operator_union_id ? this.store.byUnion(event.operator_union_id) : undefined) ?? this.store.byUnion('open:' + openId)
    // Never trust the key alone: the workspace must also belong to this open_id.
    if (workspace && workspace.openId !== openId) return ignore('owner_mismatch', workspace.id)
    if (workspace?.status === 'disabled') return ignore('workspace_disabled', workspace.id)
    const feishu = this.options.feishu
    if (!workspace) {
      await feishu.sendToUser(openId, { text: '你还没有工作区。先私聊我说一句话，我会为你开一个，之后再点菜单就能看到任务看板。' }, eventId).catch(() => {})
      return ignore('no_workspace')
    }
    const focus = boardFocus(event.event_key), since = dayStart(this.now())
    try {
      const tickets = this.options.tickets?.(workspace) ?? []
      const usage = { messages: this.store.routedSince(workspace.id, since), modelCalls: this.store.auditCount(workspace.id, 'model', since) }
      const id = await feishu.sendCard(openId, boardCard(board(tickets, usage, this.now()), focus, this.now()), eventId)
      this.store.recordSend({ workspaceId: workspace.id, key: eventId, decision: 'sent', reason: 'menu_board', target: 'user', messageId: id, at })
      this.store.setSeen(eventId, 'board')
      this.store.audit('menu_board', { focus, key: event.event_key.slice(0, 60) }, workspace.id, at)
      return { outcome: 'board', workspaceId: workspace.id, focus }
    } catch (error) {
      // Let a later redelivery of the same click try again.
      this.store.forgetSeen(eventId)
      this.store.audit('menu_failed', { error: String(error).slice(0, 300) }, workspace.id, at)
      return { outcome: 'failed', reason: String(error instanceof Error ? error.message : error).slice(0, 300), workspaceId: workspace.id }
    }
  }

  /** Workspace event stream: events after `after` (acknowledging up to it), waiting up to `waitMs` for the next one. */
  async pull(workspace: Workspace, after: number | undefined, waitMs: number): Promise<{ seq: number; line: string }[]> {
    let items = this.store.pending(workspace.id, after)
    if (!items.length && waitMs > 0) {
      await new Promise<void>(resolve => {
        const set = this.waiters.get(workspace.id) ?? new Set()
        const done = () => { clearTimeout(timer); set.delete(done); resolve() }
        const timer = setTimeout(done, waitMs)
        set.add(done); this.waiters.set(workspace.id, set)
      })
      items = this.store.pending(workspace.id)
    }
    return items.map(item => ({ seq: item.seq, line: item.line }))
  }
  private wake(workspaceId: string): void { for (const done of [...this.waiters.get(workspaceId) ?? []]) done() }

  /** Answers one `lark-cli` invocation from a workspace; anything not listed here is refused. */
  async cli(workspace: Workspace, argv: string[], files: Record<string, number> = {}): Promise<CliResult> {
    if (workspace.status !== 'active') return refuse('workspace disabled')
    const trimmed = [...argv]
    for (const [flag, value] of [['--as', 'bot'], ['--format', 'json']] as const) {
      const index = trimmed.findIndex((item, position) => item === flag && trimmed[position + 1] === value)
      if (index >= 0) trimmed.splice(index, 2)
    }
    const { words, options } = flags(trimmed), command = words.slice(0, 2).join(' ')
    const bot = this.options.feishu.bot
    try {
      if (command === 'auth status') return { code: 0, stdout: JSON.stringify({ appId: bot.appId, brand: bot.brand, identities: { bot: { status: 'ready', verified: true } } }), stderr: '' }
      if (command === 'config strict-mode') return { code: 0, stdout: 'strict-mode: bot\n', stderr: '' }
      if (command === 'api GET' && words[2] === '/open-apis/bot/v3/info') return { code: 0, stdout: JSON.stringify({ bot: { open_id: bot.openId, app_name: bot.name } }) + '\n', stderr: '' }
      if (command === 'im +messages-reply' || command === 'im +messages-send') return await this.send(workspace, command, options, files)
      if (command === 'im +chat-list') {
        const groups = this.store.chats(workspace.id).filter(chat => chat.chatType === 'group')
        return json({ chats: await Promise.all(groups.map(async chat => ({ chat_id: chat.chatId, name: await this.options.feishu.chatName(chat.chatId) }))) })
      }
      if (command === 'im +chat-members-list') {
        const chat = options.get('--chat-id') ?? ''
        if (!this.allowed(workspace, chat)) return refuse('chat outside this workspace')
        return json({ users: await this.options.feishu.members(chat), has_more: false })
      }
      if (command === 'im +messages-mget') return json({ messages: (await this.readable(workspace, (options.get('--message-ids') ?? '').split(','))).map(cliMessage) })
      if (command === 'im +threads-messages-list') {
        const thread = options.get('--thread') ?? ''
        const messages = (await this.inChats(workspace)).filter(message => message.thread_id === thread)
        return json({ messages: messages.map(cliMessage), has_more: false, thread_id: thread })
      }
      if (command === 'api GET' && words[2] === '/open-apis/im/v1/messages/mget') {
        const params = JSON.parse(options.get('--params') ?? '{}') as { message_ids?: string[] }
        return json({ items: await this.readable(workspace, params.message_ids ?? []) })
      }
      if (command === 'api GET' && words[2] === '/open-apis/im/v1/messages') {
        const params = JSON.parse(options.get('--params') ?? '{}') as { container_id_type?: string; container_id?: string; start_time?: string; end_time?: string }
        const range = { ...params.start_time ? { start: Number(params.start_time) } : {}, ...params.end_time ? { end: Number(params.end_time) } : {} }
        if (params.container_id_type === 'thread') {
          const items = (await this.inChats(workspace, range)).filter(message => message.thread_id === params.container_id)
          return json({ items, has_more: false })
        }
        const chat = params.container_id ?? ''
        if (!this.allowed(workspace, chat)) return refuse('chat outside this workspace')
        return json({ items: await this.options.feishu.history(chat, range), has_more: false })
      }
    } catch (error) { return refuse(String(error instanceof Error ? error.message : error), 500) }
    this.store.audit('cli_refused', { command: words.slice(0, 3).join(' ').slice(0, 80) }, workspace.id, this.now().toISOString())
    return refuse(`command not allowed: ${words.slice(0, 2).join(' ')}`)
  }

  private allowed(workspace: Workspace, chatId: string): boolean { return this.store.chats(workspace.id).some(chat => chat.chatId === chatId) }
  private async inChats(workspace: Workspace, range: { start?: number; end?: number } = {}): Promise<HistoryMessage[]> {
    return (await Promise.all(this.store.chats(workspace.id).map(chat => this.options.feishu.history(chat.chatId, range)))).flat()
  }
  /** Messages the workspace may read: only those in chats its owner used with it. */
  private async readable(workspace: Workspace, ids: string[]): Promise<HistoryMessage[]> {
    const chats = new Set(this.store.chats(workspace.id).map(chat => chat.chatId))
    return (await this.options.feishu.messages(ids.filter(Boolean))).filter(message => chats.has(message.chat_id))
  }

  private async send(workspace: Workspace, command: string, options: Map<string, string>, files: Record<string, number>): Promise<CliResult> {
    const text = options.get('--markdown') ?? options.get('--text') ?? options.get('--content') ?? ''
    const file = options.get('--file'), out: Outgoing = { text, ...file ? { file: { name: file.replace(/^.*[\\/]/, ''), bytes: files[file] ?? 0 } } : {} }
    const key = options.get('--idempotency-key') ?? 'argv:' + createHash('sha256').update(JSON.stringify([command, ...options])).digest('hex').slice(0, 24)
    const previous = this.store.sent(workspace.id, key)
    if (previous) return previous.decision === 'rejected' ? refuse(previous.reason) : json({ message_id: previous.messageId })
    const at = this.now().toISOString(), feishu = this.options.feishu
    const record = (decision: 'sent' | 'redirected' | 'rejected', reason: string, target: string, messageId: string | null) => {
      this.store.recordSend({ workspaceId: workspace.id, key, decision, reason, target, messageId, at })
      this.store.audit('send', { decision, reason, target }, workspace.id, at)
    }
    if (command === 'im +messages-send' && options.has('--user-id')) {
      if (options.get('--user-id') !== workspace.openId) { record('rejected', 'not_owner', 'user', null); return refuse('not_owner') }
      const id = await feishu.sendToUser(workspace.openId, out, key); record('sent', 'owner', 'user', id); return json({ message_id: id })
    }
    let chatId = options.get('--chat-id'), request = undefined as ReturnType<TeamStore['message']>
    const replyTo = command === 'im +messages-reply' ? options.get('--message-id') ?? '' : undefined
    if (replyTo !== undefined) {
      request = this.store.message(replyTo)
      if (request && request.workspaceId !== workspace.id) { record('rejected', 'foreign_message', 'reply', null); return refuse('message outside this workspace') }
      chatId = request?.chatId ?? (await feishu.messages([replyTo]))[0]?.chat_id
    }
    const chat = this.store.chats(workspace.id).find(item => item.chatId === chatId)
    if (!chat) { record('rejected', 'chat_outside_workspace', 'chat', null); return refuse('chat outside this workspace') }
    if (chat.chatType === 'group') {
      request ??= this.store.latestIn(workspace.id, chat.chatId)
      if (!request || !isPublicRequest(request.text)) {
        const name = await feishu.chatName(chat.chatId).catch(() => '')
        const id = await feishu.sendToUser(workspace.openId, { ...out, text: `（群「${name || '群聊'}」中的请求，私下回复你）\n${text}` }, key)
        record('redirected', 'private_by_default', 'user', id)
        return json({ message_id: id })
      }
    }
    // In a direct chat a reply is sent as a plain new message, never quoted or opened as a topic under the person's message.
    const id = replyTo !== undefined && chat.chatType === 'group' ? await feishu.reply(replyTo, out, key, options.has('--reply-in-thread')) : await feishu.sendToChat(chat.chatId, out, key)
    record('sent', chat.chatType === 'group' ? 'public_request' : 'direct', chat.chatType === 'group' ? 'group' : 'direct', id)
    return json({ message_id: id })
  }
  private async notify(workspace: Workspace, key: string, text: string): Promise<void> {
    if (this.store.sent(workspace.id, 'gateway:' + key)) return
    const id = await this.options.feishu.sendToUser(workspace.openId, { text }, 'gateway:' + workspace.id + ':' + key).catch(() => null)
    this.store.recordSend({ workspaceId: workspace.id, key: 'gateway:' + key, decision: id ? 'sent' : 'rejected', reason: 'gateway_notice', target: 'user', messageId: id, at: this.now().toISOString() })
  }

  /** Stops routing to a workspace; its assistant refuses further sends and reads through the gateway. */
  disable(workspaceId: string): void {
    this.store.setStatus(workspaceId, 'disabled')
    this.store.audit('workspace_disabled', {}, workspaceId, this.now().toISOString())
    this.wake(workspaceId)
  }
}
