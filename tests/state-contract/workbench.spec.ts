import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { AccessDenied, WorkbenchBotService, ProductSessions, productHttp } from '../../src/state/index.ts'
import { productFixture } from './fixtures/product.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('verifies and durably registers an existing bot without putting its secret in state', async () => {
  const f = await productFixture('sqlite'), secretRoot = join(f.folder, 'secrets'), request = vi.fn(async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('/tenant_access_token/internal')) return { status: 200, json: async () => ({ code: 0, tenant_access_token: 'tenant-token' }) }
    if (url.endsWith('/bot/v3/info')) return { status: 200, json: async () => ({ code: 0, data: { open_id: 'ou_bound_bot', app_name: '已绑定机器人' } }) }
    throw new Error('unexpected endpoint')
  })
  cleanups.push(f.close)
  const service = new WorkbenchBotService({ store: f.store, scope: f.scope, access: f.access, installationId: 'installed', secretRoot, request: request as any })
  const before = await service.status('ou_guest'); expect(before.authorized).toBe(false); expect(before.bot.status).toBe('unconfigured')
  const verified = await service.verify('ou_guest', { appId: 'cli_bound', appSecret: 'secret-value-123' })
  expect(verified).toMatchObject({ appId: 'cli_bound', botId: 'ou_bound_bot', token: 'ok', bot: 'ok', permissionCheck: 'platform-required' })
  const bound = await service.bind('ou_owner', { appId: 'cli_bound', appSecret: 'secret-value-123', optionalScopes: ['drive:drive:readonly'] })
  expect(bound).toMatchObject({ status: 'pending-permissions', appId: 'cli_bound', requiresRestart: true })
  const secret = await readFile(join(secretRoot, bound.appId ? 'feishu-' + (await import('node:crypto')).createHash('sha256').update(bound.appId).digest('hex').slice(0, 32) + '.secret' : ''), 'utf8')
  expect(secret).toBe('secret-value-123'); expect((await stat(secretRoot)).mode & 0o077).toBe(0)
  const row = await f.store.transaction(f.scope, tx => tx.get<any>('kv', 'workbench-bot-connection'))
  expect(JSON.stringify(row?.value)).not.toContain('secret-value-123'); expect(row?.value.requestedOptional).toEqual(['drive:drive:readonly'])
  expect((await service.status('ou_owner')).bot.status).toBe('pending-permissions')
})

it('uses the token scope list when Feishu returns one and reports only missing scopes', async () => {
  const f = await productFixture('sqlite'), scopes = ['im:chat:read', 'im:message:readonly', 'im:message.group_msg', 'im:message.group_at_msg:readonly', 'im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:message:update', 'im:resource', 'im:chat.members:read']
  cleanups.push(f.close)
  const request = vi.fn(async (input: string | URL) => String(input).endsWith('/tenant_access_token/internal')
    ? { status: 200, json: async () => ({ code: 0, tenant_access_token: 'tenant-token', scope: scopes.join(' ') }) }
    : { status: 200, json: async () => ({ code: 0, data: { open_id: 'ou_bound_bot', app_name: '已绑定机器人' } }) })
  const service = new WorkbenchBotService({ store: f.store, scope: f.scope, access: f.access, installationId: 'installed', secretRoot: join(f.folder, 'secrets'), request: request as any })
  const result = await service.verify('ou_owner', { appId: 'cli_test', appSecret: 'secret-value-123' })
  expect(result.permissionCheck).toBe('scope-list'); expect(result.missingScopes).toEqual([]); expect(result.grantedScopes).toEqual(scopes)
  expect((await service.bind('ou_owner', { appId: 'cli_test', appSecret: 'secret-value-123' })).status).toBe('verified')
})

it('lets an authenticated UID reach onboarding while product resources still require membership', async () => {
  const f = await productFixture('sqlite', true)
  cleanups.push(f.close)
  const service = new WorkbenchBotService({ store: f.store, scope: f.scope, access: f.access, installationId: 'installed', secretRoot: join(f.folder, 'secrets'), request: vi.fn() as any })
  const sessions = new ProductSessions(f.store, f.scope, f.access, { authorizeUrl: state => `https://login.example/?state=${state}`, exchange: async () => ({ openId: 'ou_guest', tenantKey: 'test-tenant', expiresIn: 3600 }) }, undefined, true)
  const begin = await sessions.begin(), state = new URL(begin.location).searchParams.get('state')!, auth = await sessions.callback(state, begin.browser, 'fixture')
  const handler = productHttp({ product: { handle: async () => { throw new AccessDenied('No workspace membership') } } as any, sessions, origin: 'http://127.0.0.1:0', assets: f.folder, development: true, workbench: service })
  const server = createServer((req, res) => { void handler(req, res) }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const status = await fetch(origin + '/orchestrator/api/loom/workbench/status', { headers: { cookie: `loom_session=${auth.token}` } })
  expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ uid: 'ou_guest', authorized: false })
  const product = await fetch(origin + '/orchestrator/api/loom', { headers: { cookie: `loom_session=${auth.token}` } }); expect(product.status).toBe(403)
  await new Promise<void>(resolve => server.close(() => resolve()))
  expect((await sessions.authenticate(auth.token, undefined, false)).actor).toBe('ou_guest')
  expect((await service.status('ou_guest')).authorized).toBe(false)
})
