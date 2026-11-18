import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { createServer as createTcpServer } from 'node:net'
import { mkdir, readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { CompanyServer } from '../../src/state/server.ts'
import { productFixture } from './fixtures/product.ts'

const closes: (() => Promise<unknown>)[] = [], folders: string[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function freePort(): Promise<number> {
  const server = createTcpServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port
}

it.skipIf(process.platform === 'win32')('starts the optional CompanyServer TLS Gateway beside the product listener', async () => {
  const f = await productFixture('sqlite', true); closes.push(f.close)
  const certFolder = await mkdtemp(join(tmpdir(), 'loom-company-gateway-')); folders.push(certFolder); const key = join(certFolder, 'server.key'), cert = join(certFolder, 'server.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
  const identityKey = join(certFolder, 'gateway.key'), tlsPort = await freePort(), assets = join(certFolder, 'assets'); await mkdir(assets)
  const wire = { verify: async () => {}, lark: async () => ({ items: [], has_more: false }), async *events(signal: AbortSignal, ready?: () => void) { ready?.(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } } as any
  const server = await CompanyServer.open({ store: f.store, scope: f.scope, installationId: 'installed', blobRoot: join(f.folder, 'objects'), scratch: join(f.folder, 'compute'), assets,
    origin: 'http://127.0.0.1:0', port: 0, cli: 'fixture', wire, development: true, gateway: { host: '127.0.0.1', port: tlsPort, tlsKey: key, tlsCert: cert, identityKey },
    login: { authorizeUrl: state => `https://login.example/?state=${state}`, exchange: async () => ({ openId: 'ou_owner', tenantKey: 'test-tenant', expiresIn: 3600 }) },
    backend: async () => ({ assess: async () => ({ kind: 'ignore', reason: 'fixture' }), work: async () => ({ state: 'hold', reason: 'fixture' }), stop: async () => ({ state: 'done' }), close: async () => {} }) })
  closes.push(() => server.stop()); const address = await server.start(); expect(address.port).toBeGreaterThan(0); expect(server.gateway).toBeDefined()
  await new Promise<void>((resolve, reject) => { const socket = tlsConnect({ host: '127.0.0.1', port: tlsPort, rejectUnauthorized: false }, () => { socket.destroy(); resolve() }); socket.once('error', reject) })
  expect((await server.gateway!.devicesForOwner(f.scope.tenantId, f.scope.spaceId, 'ou_owner'))).toEqual([])
})
