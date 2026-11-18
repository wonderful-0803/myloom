import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { productHttp } from '../src/state/http.ts'

const servers: Server[] = [], folders: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('protects gateway pairing and device management with the existing owner session and CSRF boundary', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'loom-gateway-http-')); folders.push(folder); await writeFile(join(folder, 'index.html'), '<html><head></head></html>')
  const gateway = { info: vi.fn(async (actor: string) => ({ actor, host: '192.168.0.158', port: 3443 })), pair: vi.fn(async (actor: string, input: unknown) => ({ actor, input, code: 'one-time' })), register: vi.fn(async () => ({ deviceId: 'device-1' })), devices: vi.fn(async () => [{ deviceId: 'device-1' }]), revoke: vi.fn(async (_actor: string, id: string) => ({ deviceId: id, status: 'revoked' })) }
  const sessions = { localOperator: vi.fn(async () => ({ actor: 'ou_owner', csrf: 'csrf', until: null })) } as any
  let handler: ReturnType<typeof productHttp>
  const server = createServer((req, res) => { void handler(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  handler = productHttp({ product: {} as any, sessions, origin, assets: folder, development: true, localOperator: true, gateway })
  const base = { origin, 'content-type': 'application/json', 'x-loom-csrf': 'csrf', 'idempotency-key': 'gateway-test' }
  const info = await fetch(`${origin}/orchestrator/api/loom/gateway/info`)
  expect(info.status).toBe(200); expect(await info.json()).toMatchObject({ host: '192.168.0.158', port: 3443 }); expect(gateway.info).toHaveBeenCalledWith('ou_owner')
  const pair = await fetch(`${origin}/orchestrator/api/loom/gateway/pair`, { method: 'POST', headers: base, body: JSON.stringify({ environmentId: 'linux-2' }) })
  expect(pair.status).toBe(200); expect(await pair.json()).toMatchObject({ actor: 'ou_owner', code: 'one-time' }); expect(gateway.pair).toHaveBeenCalledWith('ou_owner', { environmentId: 'linux-2' })
  const missingCsrf = await fetch(`${origin}/orchestrator/api/loom/gateway/pair`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'idempotency-key': 'missing-csrf' }, body: '{}' })
  expect(missingCsrf.status).toBe(403)
  expect((await (await fetch(`${origin}/orchestrator/api/loom/gateway/devices`)).json()).map((row: any) => row.deviceId)).toEqual(['device-1'])
  const revoke = await fetch(`${origin}/orchestrator/api/loom/gateway/devices/device-1/revoke`, { method: 'POST', headers: base, body: '{}' })
  expect(revoke.status).toBe(200); expect(gateway.revoke).toHaveBeenCalledWith('ou_owner', 'device-1')
})
