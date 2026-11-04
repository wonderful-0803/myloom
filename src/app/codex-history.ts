/** Local Codex history: separate day-view grants and explicitly scoped daily-report reads. */
import { z } from 'zod'
import { matchesCodexScope, type CodexDailyConfig } from '../codex-delegation.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import { withCodexReader, type CodexReader } from './codex-rpc.ts'
import type { LoomCodexAccess, LoomCodexMessage, LoomCodexSession, LoomCodexMessages, LoomCodexSessions } from './loom-types.ts'

export interface CodexHistoryAccess { owner: string; date: string; enabled: boolean; revision: number; at: string }
interface Host { store: Store; lifetime: AbortSignal; read?<T>(signal: AbortSignal, run: (reader: CodexReader) => Promise<T>): Promise<T> }
const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const stamp = Date.parse(value + 'T00:00:00+08:00')
  return Number.isFinite(stamp) && new Date(stamp + 8 * 3600_000).toISOString().slice(0, 10) === value
}, '日期无效')
const cursor = z.string().max(4096).nullable().optional()
const thread = z.object({ id: uuid, name: z.string().nullable().optional(), cwd: z.string(), createdAt: z.number(), updatedAt: z.number(),
  source: z.unknown(), parentThreadId: z.string().nullable().optional(), ephemeral: z.boolean().optional() })
const threadsPage = z.object({ data: z.array(thread).max(200), nextCursor: cursor })
const itemsPage = z.object({ data: z.array(z.object({ item: z.record(z.string(), z.unknown()), turnId: z.string(),
  startedAtMs: z.number().nullable().optional(), completedAtMs: z.number().nullable().optional() })).max(200), nextCursor: cursor })
const sourceKinds = ['cli', 'vscode', 'appServer', 'unknown']
const day = (value: string) => { const from = Date.parse(value + 'T00:00:00+08:00'); return { from, to: from + 86400_000 } }
const source = (value: unknown): string => typeof value === 'string' && sourceKinds.includes(value) ? value : 'unsupported'
const dto = (value: z.infer<typeof thread>, archived: boolean): LoomCodexSession => ({ id: value.id, title: value.name || `Codex 会话 ${value.id.slice(0, 8)}`,
  cwd: value.cwd, createdAt: value.createdAt * 1000, updatedAt: value.updatedAt * 1000, source: source(value.source), archived })
/** Binds an explicit day grant to the one Loom owner and rechecks it across every asynchronous RPC boundary. */
export class CodexHistory {
  private busy = 0
  constructor(private readonly host: Host) {}
  access(owner: string): LoomCodexAccess {
    const value = this.host.store.get(KV.codexHistory.access(owner))
    return { enabled: value?.enabled ?? false, date: value?.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
      revision: value?.revision ?? 0, timezone: 'Asia/Shanghai', source: '本机 Codex App Server' }
  }
  save(owner: string, body: unknown): LoomCodexAccess {
    const input = z.object({ enabled: z.boolean(), date, revision: z.number().int().nonnegative() }).strict().parse(body)
    this.host.store.atomic(() => {
      const previous = this.access(owner)
      if (previous.revision !== input.revision) throw new Error('Codex 读取授权已变化，请刷新。')
      if (previous.enabled === input.enabled && previous.date === input.date) return
      this.host.store.set(KV.codexHistory.access(owner), { owner, date: input.date, enabled: input.enabled, revision: input.revision + 1, at: new Date().toISOString() })
    })
    return this.access(owner)
  }
  private grant(owner: string, value: string): () => void {
    const access = this.access(owner)
    const check = () => {
      const current = this.access(owner)
      if (!access.enabled || !current.enabled || current.date !== value || access.date !== value || current.revision !== access.revision)
        throw new Error('Codex 对话读取未授权或已撤销，请在页面确认要读取的日期。')
    }
    check(); return check
  }
  private async use<T>(check: () => void, run: (reader: CodexReader) => Promise<T>, signal = this.host.lifetime): Promise<T> {
    if (this.busy >= 2) throw new Error('正在读取 Codex 历史，请稍后重试。')
    check(); this.busy++
    try {
      const result = await (this.host.read ?? withCodexReader)(AbortSignal.any([this.host.lifetime, signal]), async reader => {
        const guarded: CodexReader = { call: async (method, params) => { check(); const result = await reader.call(method, params); check(); return result } }
        return run(guarded)
      })
      check(); return result
    } finally { this.busy-- }
  }
  async list(owner: string, input: unknown): Promise<LoomCodexSessions> {
    const { date: value } = z.object({ date }).strict().parse(input)
    return this.catalog(value, this.grant(owner, value))
  }
  /** A caller-authenticated, metadata-only picker; never grants transcript access by itself. */
  async catalog(value: string, check: () => void, signal?: AbortSignal): Promise<LoomCodexSessions> {
    date.parse(value); const range = day(value)
    return this.use(check, async reader => {
      const sessions: LoomCodexSession[] = [], seen = new Set<string>(); let truncated = false
      for (const archived of [false, true]) {
        let next: string | null | undefined
        const cursors = new Set<string>()
        for (let page = 0; page < 20; page++) {
          const result = threadsPage.parse(await reader.call('thread/list', { archived, cursor: next, limit: 100, sortKey: 'updated_at', sortDirection: 'desc',
            modelProviders: [], sourceKinds, useStateDbOnly: true }))
          for (const entry of result.data) {
            if (entry.updatedAt * 1000 >= range.from && entry.createdAt * 1000 < range.to && !entry.parentThreadId && !entry.ephemeral
              && source(entry.source) !== 'unsupported' && !seen.has(entry.id)) { seen.add(entry.id); sessions.push(dto(entry, archived)) }
          }
          next = result.nextCursor
          if (!next || result.data.length && result.data.every(entry => entry.updatedAt * 1000 < range.from)) break
          if (cursors.has(next) || page === 19 || sessions.length >= 500) { truncated = true; break }
          cursors.add(next)
        }
      }
      return { date: value, timezone: 'Asia/Shanghai', sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500), truncated }
    }, signal)
  }
  async messages(owner: string, id: string, input: unknown): Promise<LoomCodexMessages> {
    const { date: value, cursor: start } = z.object({ date, cursor }).strict().parse(input)
    return this.page(id, value, start, this.grant(owner, value))
  }
  private async page(id: string, value: string, start: string | null | undefined, check: () => void, scope?: CodexDailyConfig, signal?: AbortSignal): Promise<LoomCodexMessages> {
    uuid.parse(id); date.parse(value); const range = day(value)
    return this.use(check, async reader => {
      const meta = thread.parse(z.object({ thread }).parse(await reader.call('thread/read', { threadId: id, includeTurns: false })).thread)
      if (scope && !matchesCodexScope(scope, meta)) throw new Error('Codex 会话已移出委托授权的项目或会话范围。')
      if (meta.id !== id || meta.updatedAt * 1000 < range.from || meta.createdAt * 1000 >= range.to || meta.parentThreadId || meta.ephemeral || source(meta.source) === 'unsupported')
        throw new Error('未找到该日期获授权的本人交互会话。')
      const messages: LoomCodexMessage[] = [], seen = new Set<string>(), cursors = new Set<string>()
      let next = start, skippedUndated = 0, limited = false
      for (let page = 0; page < 40; page++) {
        const result = itemsPage.parse(await reader.call('thread/items/list', { threadId: id, cursor: next, limit: 50, sortDirection: 'desc' }))
        for (const entry of result.data) {
          const item = entry.item
          if (!['userMessage', 'agentMessage'].includes(String(item.type)) || typeof item.id !== 'string' || seen.has(item.id)) continue
          if (item.type === 'agentMessage' && item.phase != null && !['commentary', 'final_answer'].includes(String(item.phase))) continue
          seen.add(item.id)
          const at = entry.startedAtMs ?? entry.completedAtMs
          if (at === undefined || at === null) { skippedUndated++; continue }
          if (at < range.from || at >= range.to) continue
          const role = item.type === 'userMessage' ? 'user' : 'assistant'
          const parts = role === 'user' && Array.isArray(item.content) ? item.content : []
          let text = role === 'user' ? parts.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
            : typeof item.text === 'string' ? item.text : ''
          // Automatically supplied UI/environment context is not a user-authored conversation message.
          if (/^\s*<(?:environment_context|external_codex_apps_open_page|in-app-browser-context)[\s>]/.test(text) && !text.includes('## My request:')) continue
          text = text.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, '').replace(/^\s*## My request:\s*/,'').trim()
          const omittedAttachments = parts.some(part => part && part.type !== 'text')
          if (!text && !omittedAttachments) continue
          messages.push({ id: item.id, turnId: entry.turnId, role, at, text: text.slice(0, 40_000), truncated: text.length > 40_000,
            ...role === 'assistant' && typeof item.phase === 'string' ? { phase: item.phase } : {}, omittedAttachments })
        }
        next = result.nextCursor
        const stamps = result.data.flatMap(entry => entry.startedAtMs ?? entry.completedAtMs ?? [])
        if (!next || stamps.length === result.data.length && stamps.length > 0 && stamps.every(at => at < range.from)) { next = null; break }
        if (messages.length >= 15) break
        if (cursors.has(next) || page === 39) { limited = true; break }
        cursors.add(next)
      }
      return { date: value, timezone: 'Asia/Shanghai', session: dto(meta, false), messages: messages.sort((a, b) => a.at - b.at),
        nextCursor: next ?? null, skippedUndated, limited }
    }, signal)
  }
  /** Collect a bounded same-day snapshot only after the recurring delegation's own authority check. */
  async daily(value: string, scope: CodexDailyConfig, authority: () => void): Promise<{ text: string; messages: number; sessions: number; warnings: string[] }> {
    const signal = AbortSignal.timeout(90_000), check = () => { signal.throwIfAborted(); authority() }
    const list = await this.catalog(value, check, signal), selected = list.sessions.filter(session => matchesCodexScope(scope, session))
    const warnings: string[] = [], entries: { ref: string; session: string; project: string; title: string; messages: unknown[] }[] = []
    if (list.truncated) warnings.push('会话列表达到读取上限，资料可能不完整。')
    if (selected.length > 20) warnings.push('匹配超过 20 个会话，本次只读取最近更新的 20 个。')
    let chars = 0, count = 0, pages = 0
    for (const session of selected.slice(0, 20)) {
      let next: string | null | undefined
      const messages: LoomCodexMessage[] = [], seen = new Set<string>(), cursors = new Set<string>()
      do {
        if (pages >= 30 || chars >= 60_000) { warnings.push('达到 30 页或 60000 字符预算，部分当天记录未读取。'); break }
        const page = await this.page(session.id, value, next, check, scope, signal); pages++
        if (page.skippedUndated) warnings.push(`会话 ${session.id} 有 ${page.skippedUndated} 条无原生时间的记录被排除。`)
        if (page.limited) warnings.push(`会话 ${session.id} 的分页读取达到上限。`)
        for (const message of page.messages) {
          if (seen.has(message.id) || !message.text) continue
          seen.add(message.id)
          const room = 60_000 - chars
          if (room <= 0) break
          const text = message.text.slice(0, room); chars += text.length
          if (message.truncated || text.length < message.text.length) warnings.push(`会话 ${session.id} 的长消息被截断。`)
          if (message.omittedAttachments) warnings.push(`会话 ${session.id} 含未读取的附件，不能据此验证文件内容。`)
          messages.push({ ...message, text })
        }
        next = page.nextCursor
        if (next && cursors.has(next)) { warnings.push('遇到重复分页游标，已停止读取。'); break }
        if (next) cursors.add(next)
      } while (next)
      if (messages.length) {
        const ref = `S${entries.length + 1}`
        entries.push({ ref, session: session.id, project: session.cwd, title: session.title, messages: messages.sort((a,b) => a.at - b.at)
          .map((message, index) => ({ ref: `${ref}-M${index + 1}`, id: message.id, role: message.role, at: new Date(message.at).toISOString(), text: message.text })) })
        count += messages.length
      }
      if (pages >= 30 || chars >= 60_000) { warnings.push('达到读取预算；未覆盖的会话或较早消息不会被假设为已完成。'); break }
    }
    check()
    const limits = [...new Set(warnings)]
    return { text: JSON.stringify({ date: value, timezone: 'Asia/Shanghai', scope, warnings: limits, sessions: entries }), messages: count, sessions: entries.length, warnings: limits }
  }

}
