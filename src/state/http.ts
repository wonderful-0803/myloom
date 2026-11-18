/** Company product HTTP boundary. Separate from Harness and its loopback-only administration. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AccessDenied } from './access.ts'
import { LoginRequired, ProductSessions } from './auth.ts'
import type { StateProduct } from './product.ts'
import { StateConflict } from './ports.ts'
import { requireConsoleOrigin } from './operator-login.ts'
import type { WorkbenchHttpControl } from './workbench.ts'

export interface WorkspaceDirectory {
  list(actor: string): Promise<unknown>; resolve(actor: string, id?: string): Promise<StateProduct>
  chats(actor: string): Promise<unknown>; members(actor: string, chatId: string): Promise<unknown>
  create(actor: string, input: unknown): Promise<unknown>; retry(actor: string, id: string): Promise<unknown>
  gateway?(actor: string, id?: string): Promise<GatewayHttpControl | undefined>
}
export interface GatewayHttpControl {
  info(actor: string): Promise<unknown>
  pair(actor: string, input: unknown): Promise<unknown>
  register(actor: string, input: unknown): Promise<unknown>
  devices(actor: string): Promise<unknown>
  revoke(actor: string, deviceId: string): Promise<unknown>
}
export interface ProductHttpOptions { product: StateProduct; sessions: ProductSessions; origin: string; assets: string; development?: boolean; operatorLogin?: boolean; localOperator?: boolean; workspaces?: WorkspaceDirectory; gateway?: GatewayHttpControl; workbench?: WorkbenchHttpControl }
/** Invalid JSON/size, distinct from an unavailable database. */
class InvalidBody extends Error {}
function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? ''
  if (raw.length > 8192) throw new AccessDenied('Invalid cookie')
  const matches = raw.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`))
  if (matches.length > 1) throw new AccessDenied('Ambiguous cookie')
  return matches[0]?.slice(name.length + 1)
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0
  for await (const chunk of req) { length += chunk.length; if (length > 160_000) throw new InvalidBody('Request too large'); chunks.push(Buffer.from(chunk)) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new InvalidBody('Invalid JSON body') }
}
export function productHttp(options: ProductHttpOptions) {
  const origin = new URL(options.origin)
  if (options.operatorLogin && options.localOperator) throw new Error('Choose one console mode')
  if (options.operatorLogin || options.localOperator) requireConsoleOrigin(options.origin)
  if (origin.origin !== options.origin || origin.username || origin.password || origin.protocol !== 'https:' && !((options.development || options.operatorLogin || options.localOperator) && origin.hostname === '127.0.0.1' && origin.protocol === 'http:')) throw new Error('Product origin must be explicit HTTPS')
  const secure = origin.protocol === 'https:', sessionName = secure ? '__Host-loom_session' : 'loom_session', browserName = secure ? '__Host-loom_login' : 'loom_login'
  const setCookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`
  const authenticate = (token?: string, csrf?: string, enforceMembership = true) => options.localOperator ? options.sessions.localOperator(csrf) : options.sessions.authenticate(token, csrf, enforceMembership)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    try {
      if ((options.operatorLogin || options.localOperator) && (req.headers.host !== origin.host || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')))
        throw new AccessDenied('SSH console requires the configured loopback Host and connection')
      if (options.localOperator) {
        res.setHeader('cross-origin-resource-policy', 'same-origin')
        if (req.headers.origin !== undefined && req.headers.origin !== options.origin
          || req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') throw new AccessDenied('Local console requires same-origin requests')
      }
      const url = new URL(req.url ?? '/', options.origin), method = req.method ?? 'GET'
      if (url.pathname === '/healthz') { json(res, 200, { status: 'up' }); return }
      if (options.localOperator && ['/auth/login', '/auth/operator', '/auth/callback', '/auth/logout'].includes(url.pathname)) {
        if (['GET', 'HEAD'].includes(method)) { res.writeHead(302, { location: '/orchestrator/loom/', 'cache-control': 'no-store' }); res.end() }
        else json(res, 404, { error: '此工作台已取消登录，请直接打开工作台。' })
        return
      }
      if (url.pathname === '/auth/login' && method === 'GET') {
        const value = await options.sessions.begin(cookie(req, browserName))
        res.writeHead(302, { location: value.location, 'set-cookie': setCookie(browserName, value.browser, 300), 'cache-control': 'no-store' }); res.end(); return
      }
      if (options.operatorLogin && url.pathname === '/auth/operator' && method === 'GET') {
        const state = url.searchParams.get('state') ?? ''
        if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AccessDenied('Invalid login state')
        // A non-CORS HTTP form navigation under no-referrer sends Origin: null in Chromium.
        // Keep same-origin provenance for this private form; cross-origin referrers remain suppressed.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" })
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loom 管理员登录</title><style>body{max-width:420px;margin:12vh auto;padding:24px;font:16px system-ui;color:#23352c;background:#fafaf7}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:16px}button{background:#344f40;color:white;border:0;border-radius:6px}</style><h1>Loom 管理员登录</h1><p>请输入通过 SSH 获取的临时登录码。登录码五分钟内有效，仅能使用一次。</p><form method="post" action="/auth/operator"><input type="hidden" name="state" value="${state}"><label>临时登录码<input name="code" type="password" autocomplete="one-time-code" required maxlength="43" minlength="43"></label><button>进入工作台</button></form></html>`); return
      }
      if (options.operatorLogin && url.pathname === '/auth/operator' && method === 'POST') {
        if (req.headers.origin !== options.origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new AccessDenied('Same-origin login form required')
        let encoded = ''
        for await (const chunk of req) { encoded += String(chunk); if (Buffer.byteLength(encoded) > 4096) throw new InvalidBody('Login form exceeds budget') }
        const form = new URLSearchParams(encoded)
        if (form.getAll('state').length !== 1 || form.getAll('code').length !== 1 || [...form.keys()].some(key => !['state', 'code'].includes(key))) throw new InvalidBody('Invalid login form')
        const value = await options.sessions.callback(form.get('state')!, cookie(req, browserName) ?? '', form.get('code')!)
        res.writeHead(303, { location: '/orchestrator/loom/', 'set-cookie': [setCookie(sessionName, value.token, 3600), setCookie(browserName, '', 0)], 'cache-control': 'no-store' }); res.end(); return
      }
      if (!options.operatorLogin && url.pathname === '/auth/callback' && method === 'GET') {
        const value = await options.sessions.callback(url.searchParams.get('state') ?? '', cookie(req, browserName) ?? '', url.searchParams.get('code') ?? '')
        res.writeHead(302, { location: '/orchestrator/loom/', 'set-cookie': [setCookie(sessionName, value.token, 3600), setCookie(browserName, '', 0)], 'cache-control': 'no-store' }); res.end(); return
      }
      const token = options.localOperator ? undefined : cookie(req, sessionName), write = !['GET', 'HEAD'].includes(method)
      if (write && (req.headers.origin !== options.origin || typeof req.headers['x-loom-csrf'] !== 'string')) throw new AccessDenied('Same-origin verified request required')
      const identityRoute = url.pathname === '/auth/session' || url.pathname === '/auth/logout' || url.pathname.startsWith('/orchestrator/api/loom/workbench/')
      const session = await authenticate(token, write ? String(req.headers['x-loom-csrf']) : undefined, !identityRoute)
      if (url.pathname === '/orchestrator/loom' && method === 'GET') { res.writeHead(308, { location: '/orchestrator/loom/', 'cache-control': 'no-store' }); res.end(); return }
      if (url.pathname === '/' && method === 'GET') { res.writeHead(302, { location: '/orchestrator/loom/', 'cache-control': 'no-store' }); res.end(); return }
      if (url.pathname === '/auth/session' && method === 'GET') { json(res, 200, session); return }
      if (url.pathname === '/auth/logout' && method === 'POST') {
        await options.sessions.revoke(token!); res.setHeader('set-cookie', setCookie(sessionName, '', 0)); json(res, 200, { loggedOut: true }); return
      }
      const prefix = '/orchestrator/api/loom'
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        const path = url.pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent)
        const requestId = write ? z.string().min(8).max(200).parse(req.headers['idempotency-key']) : 'read'
        if (path[0] === 'workbench') {
          if (!options.workbench) { json(res, 404, { error: 'Not found' }); return }
          if (method === 'GET' && path[1] === 'status' && path.length === 2) { json(res, 200, await options.workbench.status(session.actor)); return }
          if (method === 'GET' && path[1] === 'capabilities' && path.length === 2) { json(res, 200, await options.workbench.capabilities(session.actor)); return }
          if (method === 'GET' && path[1] === 'quick-create' && path.length === 2) { json(res, 200, await options.workbench.quickCreate(session.actor)); return }
          if (method === 'POST' && path[1] === 'verify' && path.length === 2) { json(res, 200, await options.workbench.verify(session.actor, await body(req))); return }
          if (method === 'POST' && path[1] === 'bind' && path.length === 2) { json(res, 200, await options.workbench.bind(session.actor, await body(req))); return }
          json(res, 404, { error: 'Not found' }); return
        }
        if (options.workspaces && path[0] === 'workspaces') {
          let value
          if (method === 'GET' && path.length === 1) value = await options.workspaces.list(session.actor)
          else if (method === 'GET' && path[1] === 'chats' && path.length === 2) value = await options.workspaces.chats(session.actor)
          else if (method === 'GET' && path[1] === 'members' && path.length === 2) value = await options.workspaces.members(session.actor, url.searchParams.get('chatId') ?? '')
          else if (method === 'POST' && path.length === 1) value = await options.workspaces.create(session.actor, await body(req))
          else if (method === 'POST' && path.length === 3 && path[2] === 'retry') { z.object({}).strict().parse(await body(req)); value = await options.workspaces.retry(session.actor, path[1]!) }
          else { json(res, 404, { error: 'Not found' }); return }
          await authenticate(token); json(res, 200, value); return
        }
        if (url.searchParams.getAll('workspace').length > 1) throw new AccessDenied('Ambiguous workspace selection')
        const workspace = url.searchParams.get('workspace') ?? undefined
        if (workspace) z.uuid().parse(workspace)
        const product = options.workspaces ? await options.workspaces.resolve(session.actor, workspace) : options.product
        const gateway = options.workspaces?.gateway ? await options.workspaces.gateway(session.actor, workspace) : options.gateway
        if (gateway && path[0] === 'gateway') {
          if (method === 'GET' && path.length === 2 && path[1] === 'info') { json(res, 200, await gateway.info(session.actor)); return }
          if (method === 'POST' && path.length === 2 && path[1] === 'pair') { json(res, 200, await gateway.pair(session.actor, await body(req))); return }
          if (method === 'POST' && path.length === 2 && path[1] === 'register') { json(res, 200, await gateway.register(session.actor, await body(req))); return }
          if (method === 'GET' && path.length === 2 && path[1] === 'devices') { json(res, 200, await gateway.devices(session.actor)); return }
          if (method === 'POST' && path.length === 4 && path[1] === 'devices' && path[3] === 'revoke') { json(res, 200, await gateway.revoke(session.actor, path[2]!)); return }
          json(res, 404, { error: 'Not found' }); return
        }
        if (path[0] === 'artifacts' && path[1] && path[2] === 'download' && method === 'GET') {
          const version = url.searchParams.has('version') ? z.coerce.number().int().positive().parse(url.searchParams.get('version')) : undefined
          const result = await product.options.artifacts.read(session.actor, path[1], version, true)
          await authenticate(token)
          await product.options.store.transaction(product.options.scope, tx => product.options.access.artifact(tx, session.actor, path[1]!, 'read', result.manifest))
          res.writeHead(200, { 'content-type': result.manifest.file?.mediaType ?? 'text/plain; charset=utf-8', 'cache-control': 'no-store',
            'content-disposition': `attachment; filename="result.${result.manifest.file ? 'docx' : 'txt'}"; filename*=UTF-8''${encodeURIComponent(result.manifest.filename ?? 'result.txt')}` })
          res.end(result.bytes); return
        }
        const result = await product.handle(session.actor, method, path, Object.fromEntries(url.searchParams), write ? await body(req) : undefined, requestId)
        json(res, 200, result); return
      }
      if (url.pathname.startsWith('/orchestrator/loom') && ['GET', 'HEAD'].includes(method)) {
        const asset = url.pathname.slice('/orchestrator/loom'.length).replace(/^\//, '') || 'index.html'
        if (asset !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(asset)) { json(res, 404, { error: 'Not found' }); return }
        let bytes = await readFile(join(options.assets, asset))
        if (asset === 'index.html') bytes = Buffer.from(bytes.toString('utf8').replace('<head>', `<head><meta name="loom-product-server" content="1">${options.workspaces ? '<meta name="loom-multiple-groups" content="1">' : ''}`))
        res.writeHead(200, { 'content-type': asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
          'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" })
        res.end(method === 'HEAD' ? undefined : bytes); return
      }
      json(res, 404, { error: 'Not found' })
    } catch (error) {
      if (options.operatorLogin && req.method === 'POST' && req.url?.split('?')[0] === '/auth/operator' && error instanceof AccessDenied) {
        const reasons: Record<string, { code: string; text: string }> = {
          'Same-origin login form required': { code: 'login_origin', text: '登录请求的来源校验未通过。请直接打开下方登录入口，在同一地址提交。' },
          'Login state or browser binding missing': { code: 'login_browser_missing', text: '浏览器未保留本次登录的校验信息。请重新打开登录入口，并允许本站 Cookie。' },
          'Login browser binding changed': { code: 'login_browser_changed', text: '登录页面与当前浏览器的校验信息不匹配。请重新打开登录入口，在新页面提交。' },
          'Login state expired or already used': { code: 'login_page_expired', text: '这个登录页面已经过期或已提交。请重新打开登录入口，再使用新的临时登录码。' },
          'Invalid operator code': { code: 'login_code_invalid', text: '临时登录码格式不正确。请仅复制终端输出中 code 的值，不包含引号或其他内容。' },
          'Operator code expired or already used': { code: 'login_code_expired', text: '临时登录码已过期、已使用或不再有效。请重新打开登录入口，然后在终端生成新码。' },
        }
        const reason = reasons[error.message] ?? { code: 'login_denied', text: '当前身份或应用授权未通过校验，请联系管理员核对。' }
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" })
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loom 登录未完成</title><style>body{max-width:440px;margin:12vh auto;padding:24px;font:16px system-ui;line-height:1.7;color:#23352c;background:#fafaf7}a{display:inline-block;background:#344f40;color:white;padding:10px 18px;border-radius:6px;text-decoration:none}small{display:block;margin-top:20px;color:#69736c}</style><h1>登录未完成</h1><p>${reason.text}</p><a href="/auth/login">重新打开登录页</a><small>诊断编号：${reason.code}。登录页面和临时登录码分别在五分钟后过期；失败后请重新打开页面。</small></html>`); return
      }
      if (error instanceof LoginRequired) {
        if ((req.headers.accept ?? '').includes('text/html') && req.method === 'GET') { res.writeHead(302, { location: '/auth/login', 'cache-control': 'no-store' }); res.end(); return }
        json(res, 401, { error: '请登录飞书并确认当前授权。', login: '/auth/login' }); return
      }
      if (error instanceof AccessDenied) { json(res, 403, { error: '当前身份或操作未获授权，请核对应用和主人范围。' }); return }
      json(res, error instanceof StateConflict ? 409 : error instanceof z.ZodError || error instanceof InvalidBody || error instanceof URIError ? 400 : 503,
        { error: error instanceof StateConflict ? error.message : error instanceof z.ZodError ? '请求参数不完整或无效。' : '服务暂不可用，请稍后重试。' })
    }
  }
}
