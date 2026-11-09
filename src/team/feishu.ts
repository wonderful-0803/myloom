/** Feishu as the team gateway sees it: raw v2 message events in, and a narrow port for the sends and reads the gateway allows. */
import { z } from 'zod'

const Mention = z.object({ key: z.string(), name: z.string().default(''), id: z.object({ open_id: z.string().optional(), union_id: z.string().optional() }).default({}) })
/** `im.message.receive_v1` as Feishu delivers it; unlike the compact form a workspace consumes, it carries `union_id` and tenant keys. */
export const RawMessageEventSchema = z.object({
  header: z.object({ event_id: z.string().min(1), event_type: z.literal('im.message.receive_v1'), tenant_key: z.string().min(1), app_id: z.string().optional() }),
  event: z.object({
    sender: z.object({
      sender_id: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), union_id: z.string().regex(/^on_[A-Za-z0-9]+$/).optional(), user_id: z.string().optional() }),
      sender_type: z.string(), tenant_key: z.string().min(1),
    }),
    message: z.object({
      message_id: z.string().regex(/^om_[A-Za-z0-9]+$/), chat_id: z.string().regex(/^oc_[A-Za-z0-9]+$/), chat_type: z.enum(['p2p', 'group']),
      message_type: z.string(), content: z.string(), create_time: z.string().regex(/^\d+$/),
      root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(), mentions: z.array(Mention).default([]),
    }),
  }),
})
export type RawMessageEvent = z.infer<typeof RawMessageEventSchema>

/** Plain text of a message; non-text messages keep their raw content so nothing is silently dropped. */
export function messageText(message: RawMessageEvent['event']['message']): string {
  if (message.message_type !== 'text') return message.content
  try {
    const parsed = JSON.parse(message.content) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : message.content
  } catch { return message.content }
}
/** The compact line `lark-cli event consume` prints and the workspace's Feishu Source parses (`src/sources/feishu-trigger.ts`). */
export function compactEvent(raw: RawMessageEvent): Record<string, unknown> {
  const { message, sender } = raw.event
  return { message_id: message.message_id, chat_id: message.chat_id, chat_type: message.chat_type, sender_id: sender.sender_id.open_id,
    sender_type: sender.sender_type === 'user' ? 'user' : 'bot', content: messageText(message), create_time: message.create_time,
    mentions: message.mentions.filter(mention => mention.id.open_id).map(mention => ({ id: mention.id.open_id!, key: mention.key, name: mention.name })),
    ...message.root_id ? { root_id: message.root_id } : {}, ...message.parent_id ? { parent_id: message.parent_id } : {},
    ...message.thread_id ? { thread_id: message.thread_id } : {} }
}

/** The compact line `lark-cli event consume im.message.receive_v1` prints: it identifies the sender by `open_id` only, with no tenant. */
export const CompactMessageEventSchema = z.looseObject({
  message_id: z.string().regex(/^om_[A-Za-z0-9_-]+$/), chat_id: z.string().regex(/^oc_[A-Za-z0-9_-]+$/), chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(), sender_type: z.string(), content: z.string(), create_time: z.string(), event_id: z.string().optional(),
  mentions: z.array(z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  root_id: z.string().optional(), parent_id: z.string().optional(), reply_to: z.string().optional(), thread_id: z.string().optional(),
})
/** One message event in the gateway's terms, whichever form it arrived in. `unionId` and `tenantKey` are absent for CLI events. */
export interface Incoming {
  eventId: string; messageId: string; chatId: string; chatType: 'p2p' | 'group'; senderOpenId: string; senderUnionId?: string
  senderType: string; tenantKey?: string; text: string; mentions: string[]; line: Record<string, unknown>
}
export function incomingFromRaw(raw: RawMessageEvent): Incoming {
  const { message, sender } = raw.event
  return { eventId: raw.header.event_id, messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type,
    senderOpenId: sender.sender_id.open_id, ...sender.sender_id.union_id ? { senderUnionId: sender.sender_id.union_id } : {}, senderType: sender.sender_type,
    // Both keys must agree; a mismatch is treated as another tenant.
    tenantKey: sender.tenant_key === raw.header.tenant_key ? sender.tenant_key : '\u0000mismatch', text: messageText(message),
    mentions: message.mentions.flatMap(mention => mention.id.open_id ? [mention.id.open_id] : []), line: compactEvent(raw) }
}
export function incomingFromCompact(event: z.infer<typeof CompactMessageEventSchema>): Incoming {
  const line: Record<string, unknown> = { message_id: event.message_id, chat_id: event.chat_id, chat_type: event.chat_type, sender_id: event.sender_id,
    sender_type: event.sender_type === 'user' ? 'user' : 'bot', content: event.content, create_time: event.create_time,
    mentions: event.mentions.map(mention => ({ id: mention.id, ...mention.key ? { key: mention.key } : {}, ...mention.name ? { name: mention.name } : {} })),
    ...event.root_id ? { root_id: event.root_id } : {}, ...event.parent_id ? { parent_id: event.parent_id } : {},
    ...event.reply_to ? { reply_to: event.reply_to } : {}, ...event.thread_id ? { thread_id: event.thread_id } : {} }
  return { eventId: event.event_id ?? 'msg:' + event.message_id, messageId: event.message_id, chatId: event.chat_id, chatType: event.chat_type,
    senderOpenId: event.sender_id, senderType: event.sender_type, text: event.content, mentions: event.mentions.map(mention => mention.id), line }
}

/** A message in the history-API shape (`/open-apis/im/v1/messages`), which the workspace's backfill and reads validate. */
export interface HistoryMessage {
  message_id: string; chat_id: string; create_time: string; msg_type: string; root_id?: string; parent_id?: string; thread_id?: string
  sender: { id: string; sender_type: string }; body: { content: string }; mentions?: { id: string; key: string; name: string }[]
}
export interface Outgoing { text: string; file?: { name: string; bytes: number } }
/** Only what the gateway itself may do in Feishu; workspaces never reach this directly. */
export interface FeishuPort {
  readonly bot: { openId: string; appId: string; name: string; brand: 'feishu' | 'lark' }
  sendToUser(openId: string, message: Outgoing, key: string): Promise<string>
  sendToChat(chatId: string, message: Outgoing, key: string): Promise<string>
  reply(messageId: string, message: Outgoing, key: string, inThread: boolean): Promise<string>
  react(messageId: string, emoji: string): Promise<void>
  chatName(chatId: string): Promise<string>
  members(chatId: string): Promise<{ member_id: string; name: string }[]>
  history(chatId: string, range: { start?: number; end?: number }): Promise<HistoryMessage[]>
  messages(ids: string[]): Promise<HistoryMessage[]>
}

/** In-memory Feishu for the prototype and tests: records what users said and every message the bot sent, with no network. */
export class SimulatedFeishu implements FeishuPort {
  readonly sent: { to: { userId?: string; chatId?: string; replyTo?: string }; text: string; file?: Outgoing['file']; key: string; messageId: string; inThread?: boolean }[] = []
  readonly reactions: { messageId: string; emoji: string }[] = []
  private readonly log: HistoryMessage[] = []
  private readonly chats = new Map<string, { name: string; members: Map<string, string> }>()
  private readonly direct = new Map<string, string>()
  private counter = 0
  constructor(readonly bot: FeishuPort['bot']) {}

  /** Declares a group and its members so membership and names can be checked. */
  defineChat(chatId: string, name: string, members: { openId: string; name: string }[]): void {
    this.chats.set(chatId, { name, members: new Map(members.map(member => [member.openId, member.name])) })
  }
  /** Records an incoming user message so history and message reads return it. */
  observe(raw: RawMessageEvent): void {
    const { message, sender } = raw.event
    if (message.chat_type === 'p2p') this.direct.set(sender.sender_id.open_id, message.chat_id)
    if (this.log.some(item => item.message_id === message.message_id)) return
    this.log.push({ message_id: message.message_id, chat_id: message.chat_id, create_time: message.create_time, msg_type: message.message_type,
      sender: { id: sender.sender_id.open_id, sender_type: sender.sender_type }, body: { content: message.content },
      mentions: message.mentions.filter(mention => mention.id.open_id).map(mention => ({ id: mention.id.open_id!, key: mention.key, name: mention.name })),
      ...message.root_id ? { root_id: message.root_id } : {}, ...message.parent_id ? { parent_id: message.parent_id } : {}, ...message.thread_id ? { thread_id: message.thread_id } : {} })
  }
  private record(to: SimulatedFeishu['sent'][number]['to'], chatId: string, message: Outgoing, key: string, extra: Partial<HistoryMessage> = {}, inThread?: boolean): string {
    const existing = this.sent.find(item => item.key === key)
    if (existing) return existing.messageId
    const messageId = `om_sim${String(++this.counter).padStart(6, '0')}`
    this.sent.push({ to, text: message.text, ...message.file ? { file: message.file } : {}, key, messageId, ...inThread ? { inThread } : {} })
    this.log.push({ message_id: messageId, chat_id: chatId, create_time: String(Date.now()), msg_type: message.file ? 'file' : 'text',
      sender: { id: this.bot.appId, sender_type: 'app' }, body: { content: JSON.stringify({ text: message.text }) }, ...extra })
    return messageId
  }
  async sendToUser(openId: string, message: Outgoing, key: string): Promise<string> {
    return this.record({ userId: openId }, this.direct.get(openId) ?? `oc_simdm${openId.slice(3)}`, message, key)
  }
  async sendToChat(chatId: string, message: Outgoing, key: string): Promise<string> { return this.record({ chatId }, chatId, message, key) }
  async reply(messageId: string, message: Outgoing, key: string, inThread: boolean): Promise<string> {
    const parent = this.log.find(item => item.message_id === messageId)
    if (!parent) throw new Error('Simulated Feishu: reply target not found')
    return this.record({ replyTo: messageId }, parent.chat_id, message, key, { parent_id: messageId, root_id: parent.root_id ?? messageId }, inThread)
  }
  async react(messageId: string, emoji: string): Promise<void> {
    if (!this.reactions.some(item => item.messageId === messageId && item.emoji === emoji)) this.reactions.push({ messageId, emoji })
  }
  async chatName(chatId: string): Promise<string> { return this.chats.get(chatId)?.name ?? chatId }
  async members(chatId: string): Promise<{ member_id: string; name: string }[]> {
    return [...this.chats.get(chatId)?.members ?? []].map(([member_id, name]) => ({ member_id, name }))
  }
  async history(chatId: string, range: { start?: number; end?: number }): Promise<HistoryMessage[]> {
    return this.log.filter(item => item.chat_id === chatId && (range.start === undefined || Number(item.create_time) >= range.start * 1000)
      && (range.end === undefined || Number(item.create_time) <= range.end * 1000))
  }
  async messages(ids: string[]): Promise<HistoryMessage[]> { return this.log.filter(item => ids.includes(item.message_id)) }
}
