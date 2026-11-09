/**
 * The Feishu board: a read-only summary of one workspace's tasks, sent as a card to the person who clicked the bot's menu.
 * The gateway reads the workspace's task database on the host, read-only; the workspace itself is not asked and cannot widen it.
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

/** `application.bot.menu_v6` as `lark-cli event consume` prints it. Unlike message events it carries `union_id` and the tenant. */
export const MenuEventSchema = z.looseObject({
  event_id: z.string().optional(), event_key: z.string().default(''), menu_timestamp: z.string().optional(), timestamp: z.string().optional(),
  operator_open_id: z.string().regex(/^ou_[A-Za-z0-9_-]+$/).optional(), operator_id: z.string().regex(/^ou_[A-Za-z0-9_-]+$/).optional(),
  operator_union_id: z.string().optional(), operator_name: z.string().optional(), tenant_key: z.string().optional(),
}).refine(event => event.operator_open_id ?? event.operator_id, 'menu event without an operator')
export type MenuEvent = z.infer<typeof MenuEventSchema>

/** One task as the board shows it. */
export interface BoardTicket {
  id: string; title: string; createdAt: string; updatedAt: string
  /** `attention`: it asks the person something; `blocked`/`failed`: it cannot go on without them; `running`/`queued`/`idle`: it is open. */
  state: 'attention' | 'blocked' | 'failed' | 'running' | 'queued' | 'idle' | 'ended'
  /** The latest report's summary, or the open question. */
  note: string
  ended?: { at: string; outcome: string }
}
export interface Board { needsYou: BoardTicket[]; running: BoardTicket[]; recent: BoardTicket[]; usage: { messages: number; modelCalls: number } }
/** Which part of the board a menu item asks for; anything else shows all of it. */
export type BoardFocus = 'all' | 'attention' | 'running' | 'recent'
export const boardFocus = (eventKey: string): BoardFocus =>
  /attention|todo|wait|待/.test(eventKey) ? 'attention' : /running|progress|进行/.test(eventKey) ? 'running' : /recent|done|result|完成|产物/.test(eventKey) ? 'recent' : 'all'

interface StoredTicket {
  id?: unknown; title?: unknown; createdAt?: unknown; updatedAt?: unknown; attention?: { question?: unknown }; undelivered?: unknown[]
  assignments?: { state?: unknown; report?: { state?: unknown; summary?: unknown } }[]; ended?: { at?: unknown; outcome?: unknown }
}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

/** Turns a stored ticket into a board row; returns undefined for anything it cannot read. */
export function boardTicket(raw: StoredTicket): BoardTicket | undefined {
  const id = text(raw.id), title = text(raw.title)
  if (!id) return undefined
  const latest = raw.assignments?.at(-1), report = latest?.report, reportState = text(report?.state)
  const base = { id, title: title || '（无标题）', createdAt: text(raw.createdAt), updatedAt: text(raw.updatedAt), note: text(report?.summary) }
  if (raw.ended) return { ...base, state: 'ended', ended: { at: text(raw.ended.at), outcome: text(raw.ended.outcome) } }
  if (raw.attention) return { ...base, state: 'attention', note: text(raw.attention.question) || base.note }
  if (reportState === 'blocked' || reportState === 'failed') return { ...base, state: reportState }
  const assignment = text(latest?.state)
  return { ...base, state: assignment === 'running' ? 'running' : assignment === 'pending' || (raw.undelivered?.length ?? 0) > 0 ? 'queued' : 'idle' }
}

/** Reads a workspace's tasks from its `orchestrator.sqlite`, read-only; a workspace that has not started yet has none. */
export function readTickets(path: string): BoardTicket[] {
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    return (db.prepare('SELECT value FROM ticket').all() as { value: string }[]).flatMap(row => {
      try { const ticket = boardTicket(JSON.parse(row.value) as StoredTicket); return ticket ? [ticket] : [] } catch { return [] }
    })
  } finally { db.close() }
}

/** Groups tasks into what needs the person, what is open, and what ended in the last `days` days (newest first, at most `limit`). */
export function board(tickets: BoardTicket[], usage: Board['usage'], now: Date, days = 7, limit = 5): Board {
  const since = now.getTime() - days * 86_400_000
  const newest = (a: BoardTicket, b: BoardTicket) => (b.ended?.at ?? b.updatedAt).localeCompare(a.ended?.at ?? a.updatedAt)
  return {
    needsYou: tickets.filter(ticket => ['attention', 'blocked', 'failed'].includes(ticket.state)).sort(newest).slice(0, 10),
    running: tickets.filter(ticket => ['running', 'queued', 'idle'].includes(ticket.state)).sort(newest).slice(0, 10),
    recent: tickets.filter(ticket => ticket.ended && Date.parse(ticket.ended.at) >= since).sort(newest).slice(0, limit),
    usage,
  }
}

const STATE: Record<BoardTicket['state'], string> = { attention: '等你回复', blocked: '受阻', failed: '失败', running: '进行中', queued: '排队中', idle: '等待中', ended: '已结束' }
const OUTCOME: Record<string, string> = { completed: '已完成', merged: '已合并', closed: '已关闭', dropped: '无需处理', stopped: '已停止' }
const clip = (value: string, size: number) => { const flat = value.replace(/\s+/g, ' ').trim(); return flat.length > size ? flat.slice(0, size - 1) + '…' : flat }
// Card markdown treats these as markup; task titles come from people's messages, so they are shown literally.
const plain = (value: string) => value.replace(/[\\*_~`[\]<>#|]/g, match => `&#${match.charCodeAt(0)};`)
const when = (iso: string): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  return new Date(at + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
}
const row = (ticket: BoardTicket, detail: string) => `- **${plain(clip(ticket.title, 40))}**　${detail}${ticket.note ? `\n  ${plain(clip(ticket.note, 80))}` : ''}`

/** A Feishu interactive card (schema 2.0) showing the requested part of the board. */
export function boardCard(value: Board, focus: BoardFocus, now: Date): Record<string, unknown> {
  const section = (title: string, rows: string[], empty: string) => ({ tag: 'markdown', content: `**${title}**\n${rows.length ? rows.join('\n') : empty}` })
  const parts: Record<string, unknown>[] = []
  if (focus === 'all' || focus === 'attention')
    parts.push(section(`等你处理（${value.needsYou.length}）`, value.needsYou.map(ticket => row(ticket, `${STATE[ticket.state]} · ${when(ticket.updatedAt)}`)), '没有需要你处理的任务。'))
  if (focus === 'all' || focus === 'running')
    parts.push(section(`进行中（${value.running.length}）`, value.running.map(ticket => row(ticket, `${STATE[ticket.state]} · 开始于 ${when(ticket.createdAt)}`)), '当前没有进行中的任务。'))
  if (focus === 'all' || focus === 'recent')
    parts.push(section('最近完成', value.recent.map(ticket => row(ticket, `${OUTCOME[ticket.ended!.outcome] ?? ticket.ended!.outcome} · ${when(ticket.ended!.at)}`)), '最近 7 天没有结束的任务。'))
  const elements = parts.flatMap((part, index) => index ? [{ tag: 'hr' }, part] : [part])
  elements.push({ tag: 'markdown', text_size: 'notation', content: `今日 ${value.usage.messages} 条消息 · ${value.usage.modelCalls} 次模型调用　|　更新于 ${when(now.toISOString())}，再点菜单可刷新` })
  const title = { all: '我的任务看板', attention: '等你处理', running: '进行中的任务', recent: '最近完成' }[focus]
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template: value.needsYou.length ? 'orange' : 'blue' }, body: { elements } }
}
