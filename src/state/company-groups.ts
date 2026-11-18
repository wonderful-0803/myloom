/** One bot, independently authorized group runtimes and a durable, explicit workspace directory. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SettingsSchema } from '../policy.ts'
import { GroupWorkspaceSchema } from '../group-mode.ts'
import { ProductAccess, AccessDenied } from './access.ts'
import type { Installation } from './access.ts'
import type { CompanyServer } from './server.ts'
import { initializeCompany } from './server.ts'
import type { StateStore, StateScope } from './ports.ts'
import { StateConflict } from './ports.ts'
import type { FeishuWire } from './feishu.ts'
import { hash } from './hash.ts'
import type { GatewayHttpControl } from './http.ts'
const Create = z.object({ chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/), masters: z.array(z.string().regex(/^ou_[A-Za-z0-9]+$/)).min(1).max(20), mode: z.enum(['observe', 'auto']), requestId: z.uuid() }).strict()
const GroupRecordSchema = z.object({ spaceId: z.uuid(), chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/), name: z.string().min(1).max(60), since: z.iso.datetime(), requestId: z.uuid(), inputHash: z.string(), registration: Create.optional() }).strict()
export type CompanyGroupRecord = z.infer<typeof GroupRecordSchema>
const Catalog = z.object({ version: z.literal(1), groups: z.array(GroupRecordSchema).min(1).max(20) }).strict().refine(value =>
  ['spaceId', 'chatId', 'requestId'].every(key => new Set(value.groups.map(group => group[key as keyof CompanyGroupRecord])).size === value.groups.length), 'Group directory identities must be unique')
/**
 * Groups reuse the primary company settings but never the company-wide execution entry points: one host
 * owns the TLS Gateway listener and its paired-device registry, and cloning them would bind the same port
 * a second time and hand one workspace's Runner grants to another. Per-group remote execution needs
 * explicit enrollment and is not implied by copying the primary configuration.
 */
export function groupCompanyConfig(primary: Record<string, unknown>, paths: { spaceId: string; attachmentHome: string; scratch: string }): Record<string, unknown> {
  const value: Record<string, unknown> = { ...primary, spaceId: paths.spaceId, attachmentHome: paths.attachmentHome, scratch: paths.scratch, legacyWorkspaceRoots: [] }
  delete value.gateway
  delete value.remoteExecution
  return value
}
export interface CompanyGroupsOptions {
  store: StateStore; primary: CompanyServer; wire: FeishuWire
  /** Boot a fresh isolated native context with this already-initialized scope; never reuse another group's provider. */
  factory(record: CompanyGroupRecord): Promise<CompanyServer>
}
/** Registers groups explicitly and routes product operations only after current per-space authorization. */
export class CompanyGroups {
  private servers = new Map<string, CompanyServer>()
  private opening = new Map<string, Promise<CompanyServer>>()
  private closing = false
  private constructor(private options: CompanyGroupsOptions) { this.servers.set(options.primary.scope.spaceId, options.primary) }
  static async open(options: CompanyGroupsOptions) {
    const groups = new CompanyGroups(options), config = await options.store.transaction(options.primary.scope, tx => options.primary.access.configuration(tx))
    if (!config.group) throw new AccessDenied('Multi-group entry requires a group primary workspace')
    await options.store.transaction(options.primary.scope, async tx => {
      const previous = await tx.get('installation', 'group-directory')
      if (previous) {
        const catalog = Catalog.parse(previous.value)
        if (!catalog.groups.some(group => group.spaceId === config.group!.spaceId && group.chatId === config.group!.chatId)) throw new StateConflict('Primary group differs from persisted directory')
      } else await tx.put('installation', 'group-directory', { version: 1, groups: [{ spaceId: config.group!.spaceId, chatId: config.group!.chatId, name: config.group!.name,
        since: config.group!.since, requestId: randomUUID(), inputHash: 'existing-primary' }] }, 0)
    })
    for (const record of await groups.records()) if (record.spaceId !== options.primary.scope.spaceId
      && await options.store.transaction(groups.scope(record), tx => tx.get('settings', 'current'))) await groups.ensure(record).catch(() => {})
    return groups
  }
  private scope(record: CompanyGroupRecord): StateScope { return { tenantId: this.options.primary.scope.tenantId, spaceId: record.spaceId } }
  private records() { return this.options.store.transaction(this.options.primary.scope, async tx => Catalog.parse((await tx.get('installation', 'group-directory'))?.value).groups) }
  private async recordAccess(record: CompanyGroupRecord, actor?: string) {
    const primary = await this.options.store.transaction(this.options.primary.scope, tx => this.options.primary.access.configuration(tx))
    const access = new ProductAccess(this.options.primary.installationId)
    return this.options.store.transaction(this.scope(record), async tx => {
      const config = await (actor ? access.user(tx, actor) : access.configuration(tx))
      if (config.group?.chatId !== record.chatId || ['appId', 'botId', 'tenantKey', 'operator'].some(key => config.installation[key as keyof Installation] !== primary.installation[key as keyof Installation])) throw new AccessDenied('Group installation differs from the shared bot')
      return config
    })
  }
  private async operator(actor: string) {
    return this.options.store.transaction(this.options.primary.scope, tx => this.options.primary.access.user(tx, actor, true))
  }
  private ensure(record: CompanyGroupRecord): Promise<CompanyServer> {
    if (this.closing) return Promise.reject(new StateConflict('Company host is stopping'))
    const existing = this.servers.get(record.spaceId); if (existing) return Promise.resolve(existing)
    let pending = this.opening.get(record.spaceId)
    if (!pending) {
      pending = this.options.factory(record).then(async server => {
        if (server.scope.tenantId !== this.options.primary.scope.tenantId || server.scope.spaceId !== record.spaceId || server.installationId !== this.options.primary.installationId) { await server.stop(); throw new StateConflict('Workspace factory returned another authority') }
        const config = await this.recordAccess(record).catch(async error => { await server.stop(); throw error })
        if (config.group?.chatId !== record.chatId) { await server.stop(); throw new StateConflict('Workspace group mapping differs') }
        if (this.closing) { await server.stop(); throw new StateConflict('Company host is stopping') }
        this.servers.set(record.spaceId, server); return server
      }).catch(error => {
        console.error(`Loom group workspace boot failed (${record.spaceId}): ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }).finally(() => { this.opening.delete(record.spaceId) })
      this.opening.set(record.spaceId, pending)
    }
    return pending
  }
  async authorize(actor: string) {
    // No cross-space transaction or cached membership: each scope is checked against current settings.
    for (const record of await this.records()) {
      try { await this.recordAccess(record, actor); return }
      catch (error) { if (!(error instanceof AccessDenied) && !(error instanceof StateConflict)) throw error }
    }
    throw new AccessDenied('No current workspace membership')
  }
  async list(actor: string) {
    const items = []
    const primary = await this.options.store.transaction(this.options.primary.scope, tx => this.options.primary.access.configuration(tx))
    for (const record of await this.records()) {
      if (!await this.options.store.transaction(this.scope(record), tx => tx.get('settings', 'current'))) {
        if (actor === primary.installation.operator) items.push({ spaceId: record.spaceId, chatId: record.chatId, name: record.name, enabled: false, mode: 'observe' as const, revision: 0, state: 'error' as const, canManage: true })
        continue
      }
      try {
        const config = await this.recordAccess(record, actor)
        const server = this.servers.get(record.spaceId)
        items.push({ spaceId: record.spaceId, chatId: record.chatId, name: config.group?.name ?? record.name, enabled: config.settings.sources.feishu?.enabled === true,
          mode: config.settings.eval.mode, revision: config.row.value.revision, state: server?.sourceHealth ?? 'error',
          ...(server?.sourceHealthDetail ? { detail: server.sourceHealthDetail } : {}), canManage: actor === config.installation.operator })
      } catch (error) { if (!(error instanceof AccessDenied)) throw error }
    }
    return { groups: items, canManage: actor === primary.installation.operator, maxGroups: 20, operator: primary.installation.operator }
  }
  async resolve(actor: string, id?: string) {
    // Older links select primary only; there is never an implicit fallback from an explicitly selected scope.
    const record = (await this.records()).find(value => value.spaceId === (id ?? this.options.primary.scope.spaceId))
    if (!record) throw new AccessDenied('Unknown or unauthorized workspace')
    await this.recordAccess(record, actor)
    const server = this.servers.get(record.spaceId)
    if (!server) throw new StateConflict('群工作空间尚未就绪，请管理员重试接入。')
    return server.product
  }
  async gateway(actor: string, id?: string): Promise<GatewayHttpControl | undefined> {
    const record = (await this.records()).find(value => value.spaceId === (id ?? this.options.primary.scope.spaceId))
    if (!record) throw new AccessDenied('Unknown or unauthorized workspace')
    await this.recordAccess(record, actor)
    const server = this.servers.get(record.spaceId)
    if (!server) throw new StateConflict('群工作空间尚未就绪，请管理员重试接入。')
    return server.gatewayHttpControl()
  }
  async chats(actor: string) {
    await this.operator(actor)
    const chats: { chatId: string; name: string }[] = [], seen = new Set<string>(); let page: string | undefined
    for (let n = 0; n < 10; n++) {
      const result = z.object({ items: z.array(z.object({ chat_id: z.string().regex(/^oc_[A-Za-z0-9]+$/), name: z.string().max(60) })).max(100), has_more: z.boolean(), page_token: z.string().optional() }).parse(
        await this.options.wire.lark(['api', 'GET', '/open-apis/im/v1/chats', '--params', JSON.stringify({ page_size: 100, ...(page ? { page_token: page } : {}) })], AbortSignal.timeout(60000)))
      chats.push(...result.items.map(chat => ({ chatId: chat.chat_id, name: chat.name })))
      if (!result.has_more) { await this.operator(actor); return { chats } }
      if (!result.page_token || seen.has(result.page_token)) throw new StateConflict('群列表分页未前进。')
      page = result.page_token; seen.add(page)
    }
    throw new StateConflict('群列表超过读取上限，请输入目标群 ID 后核验成员。')
  }

  async members(actor: string, chatId: string) {
    z.string().regex(/^oc_[A-Za-z0-9]+$/).parse(chatId); const config = await this.operator(actor)
    // Chat must be one the bot can actually access; never trust a browser-supplied group title.
    const detail = z.object({ name: z.string().min(1).max(60) }).parse(await this.options.wire.lark(['api', 'GET', `/open-apis/im/v1/chats/${chatId}`], AbortSignal.timeout(60000)))
    const result = z.object({ users: z.array(z.object({ member_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), name: z.string().max(100).optional() })).max(10000), has_more: z.literal(false), truncations: z.array(z.unknown()).max(0).optional() }).parse(
      await this.options.wire.lark(['im', '+chat-members-list', '--chat-id', chatId, '--member-types', 'user', '--page-all', '--page-limit', '0'], AbortSignal.timeout(60000)))
    if (!result.users.some(member => member.member_id === config.installation.operator)) throw new AccessDenied('Administrator must be a verified member of this group')
    await this.operator(actor); return { name: detail.name, members: result.users.map(user => ({ id: user.member_id, name: user.name })) }
  }
  async create(actor: string, raw: unknown) {
    const input = Create.parse(raw), fingerprint = hash(input), verified = await this.members(actor, input.chatId), config = await this.operator(actor)
    const ids = new Set(input.masters)
    if (ids.size !== input.masters.length || !ids.has(config.installation.operator) || input.masters.some(id => !verified.members.some(person => person.id === id))) throw new AccessDenied('Select verified masters and retain the administrator')
    const record = await this.options.store.transaction(this.options.primary.scope, async tx => {
      await this.options.primary.access.user(tx, actor, true)
      const row = (await tx.get('installation', 'group-directory'))!, catalog = Catalog.parse(row.value)
      const old = catalog.groups.find(group => group.requestId === input.requestId || group.chatId === input.chatId)
      if (old) { if (old.requestId !== input.requestId || old.inputHash !== fingerprint) throw new StateConflict('该群已登记，或接入请求内容已变化。'); return old }
      if (catalog.groups.length >= 20) throw new StateConflict('当前最多接入二十个独立群。')
      const record: CompanyGroupRecord = { spaceId: randomUUID(), chatId: input.chatId, name: verified.name, since: new Date(await tx.now()).toISOString(), requestId: input.requestId, inputHash: fingerprint, registration: input }
      // Intent is durable before any separate-space setup or native boot; retry keeps the same spaceId.
      await tx.put('installation', row.id, { ...catalog, groups: [...catalog.groups, record] }, row.revision)
      await tx.put('audit', `group-register/${input.requestId}`, { actor, spaceId: record.spaceId, chatId: record.chatId, at: record.since }, 0)
      return record
    })
    const scope = this.scope(record)
    const exists = await this.options.store.transaction(scope, tx => tx.get('settings', 'current'))
    if (!exists) {
      const installation: Installation = { ...config.installation, since: record.since }
      const settings = SettingsSchema.parse({ paused: false, sources: { github: { enabled: false }, feishu: { enabled: true, config: { ownerOnly: true, directMessages: false, otherChats: 'none', chats: [{ chatId: record.chatId, name: record.name, listen: 'all' }], cardsEnabled: false, draftsEnabled: false } } },
        policy: { sources: { feishu: { allowed: [{ id: config.installation.operator }], workspace: GroupWorkspaceSchema.parse({ mode: 'group', operator: config.installation.operator, chatId: record.chatId, name: record.name, masters: verified.members.filter(person => ids.has(person.id)), spaceId: record.spaceId, since: record.since }) } },
          rules: [{ id: 'office-summary', name: '工作总结与纪要', enabled: true, instruction: '仅根据本群已授权来源整理明确要求的总结或纪要，区分提议与决定，保留引用，定稿只交付原线程。' }, { id: 'office-data', name: '数据汇总', enabled: true, instruction: '仅汇总本群明确提供且口径清楚的数据，工具不足如实说明，不猜测数字，不修改业务源数据。' }, { id: 'office-research', name: '资料查阅', enabled: true, instruction: '只查阅本群已授权且有受控读取能力的资料，引用来源，缺少连接器时如实说明。' }] },
        eval: { mode: input.mode, model: config.settings.eval.model }, executor: { model: config.settings.executor.model, maxWorkers: Math.min(config.settings.executor.maxWorkers, 2) } })
      try { await initializeCompany(this.options.store, scope, installation, settings) } catch (error) {
        if (!await this.options.store.transaction(scope, tx => tx.get('settings', 'current'))) throw error
      }
    }
    await this.ensure(record)
    return { spaceId: record.spaceId, message: '群已接入；主人、规则和历史与其他群独立。' }
  }
  async retry(actor: string, spaceId: string) {
    await this.operator(actor); const record = (await this.records()).find(group => group.spaceId === spaceId)
    if (!record) throw new AccessDenied('Unknown workspace')
    if (!await this.options.store.transaction(this.scope(record), tx => tx.get('settings', 'current'))) {
      if (!record.registration) throw new StateConflict('Missing registration intent')
      return this.create(actor, record.registration)
    }
    await this.ensure(record); return { spaceId, message: '已重新检查群接入。' }
  }
  async close() { this.closing = true; await Promise.allSettled(this.opening.values()); await Promise.allSettled([...this.servers.values()].map(server => server.stop())) }
}
