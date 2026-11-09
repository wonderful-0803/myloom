/**
 * HTTP surface of the team gateway, bound to loopback. Workspaces authenticate with their own token and may only stream their
 * events and run gateway-checked CLI calls; the admin token manages workspaces and, in simulation, injects Feishu events.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Gateway } from './gateway.ts'
import type { RawMessageEvent, SimulatedFeishu } from './feishu.ts'
import type { TeamStore } from './store.ts'

export interface TeamServerOptions {
  gateway: Gateway; store: TeamStore; adminToken: string; simulation?: SimulatedFeishu
  /** Upstream model for the `/ws/model` proxy; workspaces authenticate with their own token and never see this key. */
  model?: { baseURL: string; apiKey: string }
  /** Serve only the workspace endpoints, for the listener containers reach. */
  workspaceOnly?: boolean
}
const MODEL_PATHS = /^\/ws\/model\/(chat\/completions|completions|models|embeddings)$/
const LIMIT = 8 * 1024 * 1024

async function raw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > LIMIT) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}
async function body(request: IncomingMessage): Promise<unknown> {
  const data = await raw(request)
  try { return data.length ? JSON.parse(data.toString('utf8')) : {} } catch { throw new HttpError(400, 'invalid JSON') }
}
/** An error that maps to an HTTP status and a safe message. */
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const bearer = (request: IncomingMessage): string => /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
const same = (left: string, right: string): boolean => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right))
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

export function teamServer(options: TeamServerOptions): Server {
  const { gateway, store, simulation } = options
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://gateway'), path = url.pathname, method = request.method ?? 'GET'
      if (method === 'GET' && path === '/health') return send(response, 200, { ok: true })
      if (path.startsWith('/ws/')) {
        const workspace = store.byToken(bearer(request))
        if (!workspace) throw new HttpError(401, 'unknown workspace token')
        if (method === 'GET' && path === '/ws/events') {
          if (workspace.status !== 'active') throw new HttpError(403, 'workspace disabled')
          const after = url.searchParams.get('after'), wait = Math.min(Number(url.searchParams.get('wait') ?? 0) || 0, 30)
          return send(response, 200, { events: await gateway.pull(workspace, after === null ? undefined : Number(after), wait * 1000) })
        }
        const model = MODEL_PATHS.exec(path)
        if (model && options.model) {
          if (workspace.status !== 'active') throw new HttpError(403, 'workspace disabled')
          const payload = method === 'POST' ? await raw(request) : undefined
          const upstream = await fetch(options.model.baseURL.replace(/\/$/, '') + '/' + model[1], { method,
            headers: { authorization: `Bearer ${options.model.apiKey}`, 'content-type': request.headers['content-type'] ?? 'application/json', accept: request.headers.accept ?? '*/*' },
            ...payload ? { body: new Uint8Array(payload) } : {} })
          store.audit('model', { path: model[1]!, status: upstream.status }, workspace.id, new Date().toISOString())
          response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
          if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
          return void response.end()
        }
        if (method === 'POST' && path === '/ws/cli') {
          const input = await body(request) as { argv?: unknown; files?: unknown }
          if (!Array.isArray(input.argv) || !input.argv.every(item => typeof item === 'string')) throw new HttpError(400, 'argv must be strings')
          const files = input.files && typeof input.files === 'object' ? input.files as Record<string, number> : {}
          return send(response, 200, await gateway.cli(workspace, input.argv, files))
        }
        throw new HttpError(404, 'not found')
      }
      if (options.workspaceOnly) throw new HttpError(404, 'not found')
      if (!same(bearer(request), options.adminToken)) throw new HttpError(401, 'admin token required')
      if (method === 'GET' && path === '/admin/workspaces') return send(response, 200, { workspaces: store.workspaces() })
      const disable = /^\/admin\/workspaces\/(ws_[0-9a-f]+)\/disable$/.exec(path)
      if (method === 'POST' && disable) {
        if (!store.workspace(disable[1]!)) throw new HttpError(404, 'no such workspace')
        gateway.disable(disable[1]!); return send(response, 200, { ok: true })
      }
      if (method === 'GET' && path === '/admin/audit') return send(response, 200, { audit: store.auditTrail() })
      if (simulation && method === 'POST' && path === '/sim/chats') {
        const input = await body(request) as { chat_id: string; name: string; members: { openId: string; name: string }[] }
        simulation.defineChat(input.chat_id, input.name, input.members ?? []); return send(response, 200, { ok: true })
      }
      if (simulation && method === 'POST' && path === '/sim/events') {
        const input = await body(request)
        const event = input as RawMessageEvent
        if (event?.event?.message) simulation.observe(event)
        return send(response, 200, await gateway.ingest(input))
      }
      if (simulation && method === 'GET' && path === '/sim/sent') return send(response, 200, { sent: simulation.sent, reactions: simulation.reactions })
      throw new HttpError(404, 'not found')
    })().catch((error: unknown) => {
      if (response.headersSent) return response.end()
      send(response, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
}
