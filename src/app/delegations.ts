/** Owner-managed standing instructions backed by versioned policy rules and atomic activation receipts. */
import { z } from 'zod'
import { key, type Ticket } from '../core/index.ts'
import { RuleSchema, type Rule } from '../policy.ts'
import { CodexDailySchema } from '../codex-delegation.ts'
import { codexPersonalOwner, type CodexDaily } from './codex-daily.ts'
import { KV } from '../kv.ts'
import { feishuSettings } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'
import type { Settings } from './settings.ts'
import type { LoomDelegation } from './loom-types.ts'

export interface DelegationActivity { id: string; owner: string; delegationId: string; title: string; action: 'created' | 'updated' | 'enabled' | 'paused'; at: string; revision: number }
interface Host { store: Store; sources: SourceRegistry; settings: Pick<Settings, 'save'>; codexDaily: CodexDaily }
const Input = z.object({
  title: RuleSchema.shape.name, description: RuleSchema.shape.instruction.optional(),
  chatIds: z.array(z.string().regex(/^oc_[a-zA-Z0-9]+$/)).max(3).refine(ids => new Set(ids).size === ids.length, 'Duplicate chat IDs'),
  codex: CodexDailySchema.optional(), codexConsent: z.literal(true).optional(),
  keywords: z.array(z.string().trim().min(1).max(40)).max(12), mode: z.enum(['observe', 'auto']), enabled: z.boolean(),
})
/** A standing delegation failed current owner, receiving-scope or record validation. */
export class DelegationError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message) } }
/** Creates and changes scoped policies without changing global mode or manufacturing Feishu events. */
export class Delegations {
  constructor(private readonly host: Host) {}
  list(owner: string, tickets: Ticket[] = []): LoomDelegation[] {
    const config = feishuSettings(this.host.sources), labels = this.host.store.get(KV.sources.labels('feishu')) ?? {}
    return this.host.store.settings().policy.rules.flatMap(rule => {
      const d = rule.delegation
      if (!d || d.owner !== owner) return []
      const scopes = d.chatIds.map(chatId => ({ chatId, name: config.chats.find(chat => chat.chatId === chatId)?.name || labels[chatId] || chatId }))
      const available = d.codex ? codexPersonalOwner(this.host.store, this.host.sources) === owner : d.chatIds.every(chatId => config.chats.some(chat => chat.chatId === chatId && chat.listen === 'all'))
      return [{ id: rule.id, title: rule.name, description: rule.instruction, enabled: rule.enabled, mode: d.mode, chatIds: d.chatIds,
        keywords: d.keywords, ...(d.codex ? { codex: d.codex, runs: this.host.codexDaily.list(owner, rule.id) } : {}), createdAt: d.createdAt, updatedAt: d.updatedAt, available, scopes,
        taskIds: tickets.filter(ticket => ticket.mandate.basis.rules?.includes(rule.id)).map(ticket => ticket.id) }]
    })
  }
  activity(owner: string): DelegationActivity[] {
    return this.host.store.keys(KV.delegations.activity).flatMap(key => {
      const value = this.host.store.get(key); return value?.owner === owner ? [value] : []
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100)
  }
  async create(owner: string, body: unknown) {
    const input = Input.extend({ revision: z.number().int().nonnegative(), requestId: z.uuid() }).strict().parse(body)
    const id = `loom-delegate-${key('standing', input.requestId).slice(0, 20)}`
    const initialHash = key(JSON.stringify({ title: input.title, description: input.description ?? '', chatIds: input.chatIds, keywords: input.keywords, mode: input.mode, enabled: input.enabled, ...(input.codex ? { codex: input.codex } : {}) }))
    const existing = this.host.store.settings().policy.rules.find(rule => rule.id === id)
    if (existing) {
      if (existing.delegation?.owner !== owner || existing.delegation.initialHash !== initialHash) throw new DelegationError(409, '保存请求已使用，请重新打开表单。')
      return { id, revision: this.host.store.blockRevision('policy'), replay: true }
    }
    if (this.list(owner).length >= 20) throw new DelegationError(400, '当前最多保留 20 条持续委托，请调整已有委托。')
    if (input.codex && !input.codexConsent) throw new DelegationError(400, '请确认持续读取及用于生成日报的授权。')
    this.scopes(input, owner)
    const at = new Date().toISOString()
    const rule = RuleSchema.parse({ id, name: input.title, instruction: input.description ?? input.title, enabled: input.enabled,
      delegation: { owner, chatIds: input.chatIds, keywords: input.keywords, mode: input.mode, ...(input.codex ? { codex: input.codex } : {}), createdAt: at, updatedAt: at, since: at, requestId: input.requestId, initialHash } })
    return this.save(rule, input.revision, 'created')
  }
  async update(owner: string, id: string, body: unknown, toggle: boolean) {
    const old = this.host.store.settings().policy.rules.find(rule => rule.id === id)
    if (!old?.delegation || old.delegation.owner !== owner) throw new DelegationError(404, '未找到属于你的持续委托。')
    const input = toggle ? z.object({ revision: z.number().int().nonnegative(), enabled: z.boolean() }).strict().parse(body)
      : Input.extend({ revision: z.number().int().nonnegative() }).strict().parse(body)
    const at = new Date().toISOString()
    const rule = toggle ? { ...old, enabled: input.enabled, delegation: { ...old.delegation, updatedAt: at, ...(input.enabled ? { since: at } : {}) } }
      : (() => {
        const fields = Input.parse(input)
        if (fields.codex && !fields.codexConsent) throw new DelegationError(400, '请确认持续读取及用于生成日报的授权。')
        this.scopes(fields, owner)
        if (!!old.delegation?.codex !== !!fields.codex) throw new DelegationError(400, '不能改变已有委托的来源类型，请新建另一条委托。')
        return { ...old, name: fields.title, instruction: fields.description ?? fields.title, enabled: fields.enabled,
          delegation: { ...old.delegation, chatIds: fields.chatIds, keywords: fields.keywords, mode: fields.mode, ...(fields.codex ? { codex: fields.codex } : {}), updatedAt: at, since: at } }
      })()
    if (rule.enabled) this.scopes(rule.delegation, owner)
    return this.save(RuleSchema.parse(rule), input.revision, toggle ? rule.enabled ? 'enabled' : 'paused' : 'updated')
  }
  private scopes(input: { chatIds: string[]; keywords: string[]; codex?: z.infer<typeof CodexDailySchema> }, owner: string): void {
    if (input.codex) {
      if (input.chatIds.length || input.keywords.length || codexPersonalOwner(this.host.store, this.host.sources) !== owner) throw new DelegationError(400, 'Codex 日报需要单人所有者授权，并使用独立的项目或会话范围。')
      return
    }
    const ids = input.chatIds
    if (!ids.length) throw new DelegationError(400, '请选择至少一个飞书群。')
    const config = feishuSettings(this.host.sources)
    if (ids.some(id => !config.chats.some(chat => chat.chatId === id && chat.listen === 'all'))) {
      throw new DelegationError(400, '持续委托只能选择当前已获授权、接收全部消息的群；不会自动扩大监听范围。')
    }
  }
  private async save(rule: Rule, revision: number, action: DelegationActivity['action']) {
    const { store, settings } = this.host, current = store.settings()
    const rules = current.policy.rules.some(item => item.id === rule.id) ? current.policy.rules.map(item => item.id === rule.id ? rule : item) : [...current.policy.rules, rule]
    const activity: DelegationActivity = { id: key('delegation-change', rule.id, String(revision)), owner: rule.delegation!.owner,
      delegationId: rule.id, title: rule.name, action, at: new Date().toISOString(), revision: revision + 1 }
    const result = await settings.save('policy', { ...current.policy, rules }, revision, 'panel', () => {
      store.set(KV.delegations.activity(activity.id), { ...activity, revision: store.blockRevision('policy') })
    })
    return { id: rule.id, revision: result.revision, message: rule.enabled ? '持续委托已生效，将按指定范围处理之后的新事件。' : '持续委托已暂停，历史任务和交付物保留。' }
  }
}
