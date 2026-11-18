/** Browser-bound Feishu login and revocable server sessions. Provider tokens never reach Loom clients or the state log. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { AccessDenied, ProductAccess } from './access.ts'
import { hash } from './hash.ts'
import type { StateScope, StateStore } from './ports.ts'

export interface LoginUser { openId: string; tenantKey: string; expiresIn: number; unionId?: string; name?: string }
export interface LoginProvider {
  authorizeUrl(state: string): string
  exchange(code: string): Promise<LoginUser>
}
export interface LoginOptions { appId: string; appSecret(): Promise<string>; redirectUri: string; request?: typeof fetch }
/** Official Feishu web OAuth endpoints; login identity only, no Drive/mail grant or refresh-token persistence. */
export class FeishuLogin implements LoginProvider {
  constructor(private options: LoginOptions) {
    const callback = new URL(options.redirectUri)
    if (callback.protocol !== 'https:' || callback.username || callback.password || !/^cli_[a-zA-Z0-9]+$/.test(options.appId)) throw new Error('Feishu login requires HTTPS callback and App ID')
  }
  authorizeUrl(state: string) {
    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize')
    url.search = new URLSearchParams({ app_id: this.options.appId, redirect_uri: this.options.redirectUri, state, response_type: 'code' }).toString()
    return url.href
  }
  async exchange(code: string): Promise<LoginUser> {
    if (!code || code.length > 4096) throw new AccessDenied('Invalid login code')
    const request = this.options.request ?? fetch
    const tokenResponse = await request('https://open.feishu.cn/open-apis/authen/v2/oauth/token', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code',
        client_id: this.options.appId, client_secret: await this.options.appSecret(), code, redirect_uri: this.options.redirectUri }) })
    if (!tokenResponse.ok) throw new AccessDenied('Feishu login exchange failed')
    const token = z.object({ access_token: z.string().min(1), token_type: z.string().optional(), expires_in: z.number().positive() }).safeParse(await tokenResponse.json())
    if (!token.success) throw new AccessDenied('Feishu login token was not granted')
    const response = await request('https://open.feishu.cn/open-apis/authen/v1/user_info', { redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token.data.access_token}` } })
    if (!response.ok) throw new AccessDenied('Feishu login identity lookup failed')
    const user = z.object({ code: z.literal(0), data: z.object({ open_id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), tenant_key: z.string().min(1), union_id: z.string().nullish(), name: z.string().nullish() }) }).safeParse(await response.json())
    if (!user.success) throw new AccessDenied('Feishu login identity was not verified')
    return { openId: user.data.data.open_id, tenantKey: user.data.data.tenant_key, expiresIn: token.data.expires_in,
      ...(user.data.data.union_id ? { unionId: user.data.data.union_id } : {}), ...(user.data.data.name ? { name: user.data.data.name } : {}) }
  }
}
interface LoginState { kind: 'login'; browser: string; until: number; used: boolean; appId: string }
interface BrowserSession { kind: 'session'; actor: string; tenantKey: string; appId: string; until: number; csrf: string; revoked: boolean }
/** Missing/expired browser authentication, distinct from a logged-in user losing resource permissions. */
export class LoginRequired extends AccessDenied {}
const nonce = () => randomBytes(32).toString('base64url')
const validToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)
/** Uses one persisted authority for login callbacks and every subsequent product request, including revocation. */
export class ProductSessions {
  constructor(private store: StateStore, private scope: StateScope, private access: ProductAccess, private provider: LoginProvider,
    private membership?: (actor: string) => Promise<void>, private allowIdentity = false) {}
  /** Trusted multi-group host only. Business routes must still check the selected workspace's current access. */
  withMembership(authorize: (actor: string) => Promise<void>, options: { allowIdentity?: boolean } = {}) {
    return new ProductSessions(this.store, this.scope, this.access, this.provider, authorize, options.allowIdentity ?? this.allowIdentity)
  }
  /** Explicit loopback-only personal console. Identity comes from server configuration, never from browser data. */
  async localOperator(csrf?: string) {
    const result = await this.store.transaction(this.scope, async tx => {
      const config = await this.access.configuration(tx), actor = config.installation.operator
      await this.access.user(tx, actor, true)
      const id = 'local-console', previous = await tx.get<{ kind: string; actor: string; appId: string; tenantKey: string; csrf: string }>('auth-session', id)
      let value = previous?.value
      if (!value || value.kind !== 'local-console' || value.actor !== actor || value.appId !== config.installation.appId || value.tenantKey !== config.installation.tenantKey) {
        value = { kind: 'local-console', actor, appId: config.installation.appId, tenantKey: config.installation.tenantKey, csrf: nonce() }
        await tx.put('auth-session', id, value, previous?.revision ?? 0)
      }
      if (csrf !== undefined && (!validToken(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(value.csrf)))) throw new AccessDenied('Request verification failed')
      return { actor, tenantKey: config.installation.tenantKey, csrf: value.csrf, until: null, mode: 'local-operator' as const }
    })
    await this.membership?.(result.actor)
    return result
  }
  async begin(existingBrowser?: string) {
    const state = nonce(); let browser = nonce()
    await this.store.transaction(this.scope, async tx => {
      const config = await this.access.configuration(tx), now = await tx.now()
      const pending = await tx.scan<LoginState>('auth-session', { relation: 'pending-login', limit: 500 })
      // Opening a second login tab must not invalidate the first tab's browser binding.
      // Reuse only a server-issued nonce with a current, unused state for this installation.
      if (existingBrowser && validToken(existingBrowser) && pending.some(row => !row.value.used && row.value.until > now
        && row.value.appId === config.installation.appId && row.value.browser === hash(existingBrowser))) browser = existingBrowser
      for (const row of pending) if (row.value.used || row.value.until <= now) await tx.remove('auth-session', row.id, row.revision)
      if (pending.filter(row => !row.value.used && row.value.until > now).length >= 120) throw new AccessDenied('Too many pending login attempts; retry after expiry')
      await tx.put<LoginState>('auth-session', `login/${hash(state)}`, { kind: 'login', browser: hash(browser), used: false, until: await tx.now() + 300_000, appId: config.installation.appId }, 0, { relation: 'pending-login' })
    })
    return { location: this.provider.authorizeUrl(state), browser }
  }
  async callback(state: string, browser: string, code: string) {
    if (!validToken(state) || !validToken(browser)) throw new AccessDenied('Login state or browser binding missing')
    const appId = await this.store.transaction(this.scope, async tx => {
      const row = await tx.get<LoginState>('auth-session', `login/${hash(state)}`)
      if (!row || row.value.used || row.value.until <= await tx.now()) throw new AccessDenied('Login state expired or already used')
      if (row.value.browser !== hash(browser)) throw new AccessDenied('Login browser binding changed')
      const config = await this.access.configuration(tx)
      if (row.value.appId !== config.installation.appId) throw new AccessDenied('Application changed during login')
      await tx.put('auth-session', row.id, { ...row.value, used: true }, row.revision, { relation: 'pending-login' })
      return row.value.appId
    })
    const user = await this.provider.exchange(code), token = nonce(), csrf = nonce()
    if (!this.allowIdentity) await this.membership?.(user.openId)
    await this.store.transaction(this.scope, async tx => {
      const config = await (this.membership || this.allowIdentity ? this.access.configuration(tx) : this.access.user(tx, user.openId))
      if (config.installation.tenantKey !== user.tenantKey || config.installation.appId !== appId || !Number.isFinite(user.expiresIn) || user.expiresIn < 1) throw new AccessDenied('Login installation or tenant mismatch')
      await tx.put<BrowserSession>('auth-session', `session/${hash(token)}`, { kind: 'session', actor: user.openId, tenantKey: user.tenantKey, appId,
        until: await tx.now() + Math.min(3600, user.expiresIn) * 1000, csrf, revoked: false }, 0, { relation: user.openId, active: true })
    })
    return { token, csrf }
  }
  async authenticate(token: string | undefined, csrf?: string, enforceMembership = true) {
    if (!token || !validToken(token)) throw new LoginRequired('Login required')
    const result = await this.store.transaction(this.scope, async tx => {
      const row = await tx.get<BrowserSession>('auth-session', `session/${hash(token)}`)
      if (!row || row.value.kind !== 'session' || row.value.revoked || row.value.until <= await tx.now()) throw new LoginRequired('Login expired')
      const config = await (this.membership || this.allowIdentity ? this.access.configuration(tx) : this.access.user(tx, row.value.actor))
      if (config.installation.tenantKey !== row.value.tenantKey || config.installation.appId !== row.value.appId) throw new AccessDenied('Application identity changed')
      if (csrf !== undefined && (!validToken(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(row.value.csrf)))) throw new AccessDenied('Request verification failed')
      return { actor: row.value.actor, tenantKey: row.value.tenantKey, csrf: row.value.csrf, until: row.value.until }
    })
    if (enforceMembership) await this.membership?.(result.actor)
    return result
  }
  async revoke(token: string) {
    await this.store.transaction(this.scope, async tx => {
      const row = await tx.get<BrowserSession>('auth-session', `session/${hash(token)}`)
      if (row) await tx.put('auth-session', row.id, { ...row.value, revoked: true }, row.revision, { relation: row.value.actor, active: false })
    })
  }
}
