/** Feishu Workbench identity and first-use bot onboarding.
 *
 * The browser receives a Feishu OAuth session bound to an open_id.  This module
 * deliberately keeps bot credentials outside the StateStore.  The durable record
 * contains only a private-file reference and the verification/audit result.
 */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { AccessDenied, ProductAccess } from './access.ts'
import type { StateScope, StateStore } from './ports.ts'
import { KV } from '../kv.ts'

export interface WorkbenchBotCapability {
  id: string
  name: string
  required: boolean
  scopes: string[]
  events: string[]
  /** Platform-side status cannot be inferred from a tenant token alone. */
  status: 'required' | 'optional' | 'platform-check'
}

export const WORKBENCH_BOT_CAPABILITIES: readonly WorkbenchBotCapability[] = [
  { id: 'messages', name: '收发私聊、群消息与原线程回复', required: true,
    scopes: ['im:chat:read', 'im:message:readonly', 'im:message.group_msg', 'im:message.group_at_msg:readonly', 'im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:message:update'], events: ['im.message.receive_v1'], status: 'required' },
  { id: 'attachments', name: '读取消息附件并发送报告文件', required: true,
    scopes: ['im:resource'], events: [], status: 'required' },
  { id: 'group-members', name: '核验群成员与主人名单', required: true,
    scopes: ['im:chat.members:read'], events: [], status: 'required' },
  { id: 'documents', name: '资料查阅连接器', required: false,
    scopes: ['drive:drive:readonly', 'drive:drive.metadata:readonly'], events: [], status: 'optional' },
  { id: 'tables', name: '电子表格和多维表格读取', required: false,
    scopes: ['sheets:spreadsheet:readonly', 'bitable:app:readonly'], events: [], status: 'optional' },
]

export interface WorkbenchBotConnectionRecord {
  version: 1
  appId: string
  botId: string
  name: string
  tenantKey: string
  boundBy: string
  boundAt: string
  secretRef: string
  requestedOptional: string[]
  requiredScopes: string[]
  requiredEvents: string[]
  status: 'pending-permissions' | 'verified'
  grantedScopes: string[]
  missingScopes: string[]
  /** A process restart is required before this record can become the source bot. */
  requiresRestart: boolean
  verification: { token: 'ok'; bot: 'ok'; at: string }
}

export interface WorkbenchBotView {
  status: 'unconfigured' | 'pending-permissions' | 'verified'
  appId?: string
  botId?: string
  name?: string
  tenantKey?: string
  boundBy?: string
  boundAt?: string
  requiresRestart: boolean
  requiredScopes: string[]
  requiredEvents: string[]
  requestedOptional: string[]
  missingScopes: string[]
}

export interface WorkbenchIdentityView {
  uid: string
  tenantKey: string
  authorized: boolean
  canManage: boolean
  bot: WorkbenchBotView
}

export interface WorkbenchBotVerification {
  appId: string
  botId: string
  name: string
  tenantKey: string
  token: 'ok'
  bot: 'ok'
  requiredScopes: string[]
  requiredEvents: string[]
  missingScopes: string[]
  permissionCheck: 'scope-list' | 'platform-required'
  grantedScopes: string[]
  checkedAt: string
}

export interface WorkbenchHttpControl {
  status(actor: string): Promise<WorkbenchIdentityView>
  capabilities(actor: string): Promise<{ capabilities: readonly WorkbenchBotCapability[]; manifest: Record<string, unknown> }>
  verify(actor: string, input: unknown): Promise<WorkbenchBotVerification>
  bind(actor: string, input: unknown): Promise<WorkbenchBotView & { message: string }>
  quickCreate(actor: string): Promise<{ consoleUrl: string; manifest: Record<string, unknown>; message: string }>
}

const Credentials = z.object({
  appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/),
  appSecret: z.string().min(8).max(512),
  optionalScopes: z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{2,127}$/)).max(100).default([]),
}).strict()

interface FeishuResponse { status: number; json(): Promise<unknown> }
interface WorkbenchOptions {
  store: StateStore
  scope: StateScope
  access: ProductAccess
  installationId: string
  secretRoot: string
  request?: (input: string | URL, init?: RequestInit) => Promise<FeishuResponse>
}

const required = () => WORKBENCH_BOT_CAPABILITIES.filter(value => value.required)
const requiredScopes = () => [...new Set(required().flatMap(value => value.scopes))]
const requiredEvents = () => [...new Set(required().flatMap(value => value.events))]
const manifest = (includeOptional = false) => ({
  version: 1,
  product: 'loom',
  scopes: [...new Set(WORKBENCH_BOT_CAPABILITIES.filter(value => includeOptional || value.required).flatMap(value => value.scopes))],
  events: [...new Set(WORKBENCH_BOT_CAPABILITIES.filter(value => includeOptional || value.required).flatMap(value => value.events))],
  note: 'Loom 首次绑定默认清单；平台审批和发布状态以飞书开放平台为准。',
})

function safeSecretName(appId: string) { return `feishu-${createHash('sha256').update(appId).digest('hex').slice(0, 32)}.secret` }

/** One installation-scoped onboarding service. It never exposes app secrets. */
export class WorkbenchBotService implements WorkbenchHttpControl {
  private readonly request: (input: string | URL, init?: RequestInit) => Promise<FeishuResponse>
  constructor(private readonly options: WorkbenchOptions) {
    if (!isAbsolute(options.secretRoot)) throw new Error('Workbench secret root must be absolute')
    this.request = options.request ?? (fetch as unknown as WorkbenchOptions['request'])!
  }

  async status(actor: string): Promise<WorkbenchIdentityView> {
    return this.options.store.transaction(this.options.scope, async tx => {
      const config = await this.options.access.configuration(tx)
      const row = await tx.get<WorkbenchBotConnectionRecord>('kv', KV.workbench.bot)
      let authorized = false
      try { await this.options.access.user(tx, actor); authorized = true } catch (error) { if (!(error instanceof AccessDenied)) throw error }
      return { uid: actor, tenantKey: config.installation.tenantKey, authorized, canManage: actor === config.installation.operator,
        bot: row ? this.view(row.value) : this.legacyView(config.installation) }
    })
  }

  async capabilities(actor: string) {
    await this.options.store.transaction(this.options.scope, tx => this.options.access.configuration(tx).then(() => undefined))
    return { capabilities: WORKBENCH_BOT_CAPABILITIES, manifest: manifest() }
  }

  async verify(actor: string, raw: unknown): Promise<WorkbenchBotVerification> {
    const input = Credentials.parse(raw)
    const config = await this.options.store.transaction(this.options.scope, tx => this.options.access.configuration(tx))
    // Read the authenticated identity first, even though verification is a side-effect-free probe.
    if (!/^ou_[a-zA-Z0-9]+$/.test(actor)) throw new AccessDenied('Invalid Feishu Workbench identity')
    const tokenResponse = await this.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
    })
    const token = z.object({ code: z.literal(0), tenant_access_token: z.string().min(1), scope: z.union([z.string(), z.array(z.string())]).optional() }).safeParse(await tokenResponse.json())
    if (!tokenResponse.status.toString().startsWith('2') || !token.success) throw new AccessDenied('飞书机器人凭据无效，或应用身份令牌未获授予。')
    const botResponse = await this.request('https://open.feishu.cn/open-apis/bot/v3/info', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token.data.tenant_access_token}` },
    })
    const bot = z.object({ code: z.literal(0), data: z.object({ open_id: z.string().min(1), app_name: z.string().min(1).max(100).optional() }).passthrough() }).safeParse(await botResponse.json())
    if (!botResponse.status.toString().startsWith('2') || !bot.success) throw new AccessDenied('飞书机器人身份读取失败，请检查应用已启用机器人能力。')
    const scopes = requiredScopes(), events = requiredEvents(), grantedScopes = token.data.scope === undefined ? [] : Array.isArray(token.data.scope) ? token.data.scope : token.data.scope.split(/\s+/).filter(Boolean)
    const missingScopes = [...new Set([...scopes, ...input.optionalScopes])].filter(scope => !grantedScopes.includes(scope))
    return { appId: input.appId, botId: bot.data.data.open_id, name: bot.data.data.app_name ?? '飞书机器人', tenantKey: config.installation.tenantKey,
      token: 'ok', bot: 'ok', requiredScopes: scopes, requiredEvents: events,
      missingScopes, permissionCheck: token.data.scope === undefined ? 'platform-required' : 'scope-list', grantedScopes, checkedAt: new Date().toISOString() }
  }

  async bind(actor: string, raw: unknown) {
    const input = Credentials.parse(raw), config = await this.options.store.transaction(this.options.scope, tx => this.options.access.user(tx, actor, true))
    const verification = await this.verify(actor, input)
    if (verification.tenantKey !== config.installation.tenantKey) throw new AccessDenied('机器人必须属于当前飞书租户。')
    await this.saveSecret(verification.appId, input.appSecret)
    const value: WorkbenchBotConnectionRecord = { version: 1, appId: verification.appId, botId: verification.botId, name: verification.name,
      tenantKey: verification.tenantKey, boundBy: actor, boundAt: verification.checkedAt, secretRef: safeSecretName(verification.appId),
      requestedOptional: [...new Set(input.optionalScopes)], requiredScopes: verification.requiredScopes, requiredEvents: verification.requiredEvents, grantedScopes: verification.grantedScopes, missingScopes: verification.missingScopes,
      status: verification.missingScopes.length ? 'pending-permissions' : 'verified', requiresRestart: verification.appId !== config.installation.appId, verification: { token: 'ok', bot: 'ok', at: verification.checkedAt } }
    await this.options.store.transaction(this.options.scope, async tx => {
      const previous = await tx.get<WorkbenchBotConnectionRecord>('kv', KV.workbench.bot)
      await tx.put('kv', KV.workbench.bot, value, previous?.revision ?? 0, { relation: 'workbench.bot', active: true })
      await tx.put('audit', `workbench-bot/${verification.appId}/${verification.checkedAt}`, { kind: 'workbench.bot.bound', actor, appId: verification.appId,
        botId: verification.botId, requiredScopes: verification.requiredScopes, optionalScopes: value.requestedOptional, at: verification.checkedAt }, 0, { relation: 'workbench.bot' })
    })
    return { ...this.view(value), message: value.requiresRestart ? '机器人已验证并登记；管理员重启公司服务后才会切换运行来源。' : '机器人已验证并登记；请先在飞书开放平台确认权限并发布版本。' }
  }

  async quickCreate(actor: string) {
    await this.options.store.transaction(this.options.scope, tx => this.options.access.configuration(tx).then(() => undefined))
    return { consoleUrl: 'https://open.feishu.cn/app', manifest: manifest(), message: '在飞书开放平台创建智能体应用，导入这份默认清单，发布后回到这里粘贴 App ID 和 App Secret。' }
  }

  private legacyView(installation: { appId: string; botId: string; name: string; tenantKey: string }): WorkbenchBotView {
    return { status: 'unconfigured', appId: installation.appId, botId: installation.botId, name: installation.name, tenantKey: installation.tenantKey,
      requiresRestart: false, requiredScopes: requiredScopes(), requiredEvents: requiredEvents(), requestedOptional: [], missingScopes: requiredScopes() }
  }
  private view(value: WorkbenchBotConnectionRecord): WorkbenchBotView {
    return { status: value.status, appId: value.appId, botId: value.botId, name: value.name, tenantKey: value.tenantKey, boundBy: value.boundBy, boundAt: value.boundAt,
      requiresRestart: value.requiresRestart, requiredScopes: value.requiredScopes, requiredEvents: value.requiredEvents, requestedOptional: value.requestedOptional,
      missingScopes: value.missingScopes ?? value.requiredScopes }
  }
  private async saveSecret(appId: string, value: string) {
    await mkdir(this.options.secretRoot, { recursive: true, mode: 0o700 })
    const info = await lstat(this.options.secretRoot)
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid?.() !== undefined && info.uid !== process.getuid()) throw new Error('Workbench secret root must be private')
    const root = resolve(this.options.secretRoot), target = join(root, safeSecretName(appId)), temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
  }
}
