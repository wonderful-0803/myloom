import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceGateway } from '../src/execution/gateway.ts'
import { TlsGatewayServer, TlsRunnerClient } from '../src/execution/tls.ts'
import type { RemoteRequest, RemoteReceipt } from '../src/execution/protocol.ts'
import { intentHash } from '../src/execution/protocol.ts'
import type { RemoteTransport } from '../src/execution/router.ts'
import type { RunnerConfig } from '../src/execution/runner/config.ts'
import { hash } from '../src/state/hash.ts'
import { setTimeout as delay } from 'node:timers/promises'

const binding = { tenantId: 'tenant-tls', spaceId: 'personal-tls', userId: 'owner-tls', environmentId: 'linux-tls' }
const folders: string[] = []
const available = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function certificate() {
  const folder = await mkdtemp(join(tmpdir(), 'loom-tls-')); folders.push(folder)
  const keyPath = join(folder, 'server.key'), certPath = join(folder, 'server.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
  return { key: await readFile(keyPath), cert: await readFile(certPath) }
}

function request(gateway: DeviceGateway): RemoteRequest {
  const args = { path: 'notes/daily.txt', offset: 0, limit: 100 }
  const base = { protocolVersion: 1 as const, requestId: randomUUID(), ...binding, ticketId: 'ticket-tls', assignmentId: 'assignment-tls', sessionId: 'session-tls', workspaceId: 'project-tls', toolId: 'fs.read' as const, toolVersion: 1 as const, effect: 'read' as const, resourceGrantId: 'grant-tls', grantRevision: 1, controlRevision: 0, sessionEpoch: 1, expiresAt: new Date(Date.now() + 30_000).toISOString(), argsHash: hash(args), args }
  return { ...base, permit: gateway.signPermit(base) }
}

describe.skipIf(!available)('active TLS Runner connection', () => {
  it('connects outbound, authenticates with the device key, serves RPCs and maintains heartbeat', async () => {
    const cert = await certificate(), gatewayKeys = generateKeyPairSync('ed25519'), deviceKeys = generateKeyPairSync('ed25519')
    const gateway = new DeviceGateway({ keyPair: gatewayKeys }), challenge = await gateway.createPairing(binding, undefined, ['fs.read']), device = await gateway.registerPairing(challenge.id, challenge.code, deviceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), ['fs.read'])
    const accepted = (value: RemoteRequest): RemoteReceipt => ({ protocolVersion: 1, requestId: value.requestId, intentHash: intentHash(value), sequence: 1, status: 'accepted' })
    const done = (value: RemoteRequest): RemoteReceipt => ({ protocolVersion: 1, requestId: value.requestId, intentHash: intentHash(value), sequence: 3, status: 'succeeded', result: { kind: 'text', text: '来自 Linux Runner', truncated: false }, resultHash: hash({ kind: 'text', text: '来自 Linux Runner', truncated: false }) })
    let dispatched: RemoteRequest | undefined
    const runnerTransport: RemoteTransport = { dispatch: vi.fn(async value => { const current = value as RemoteRequest; dispatched = current; return accepted(current) }), query: vi.fn(async () => done(dispatched!)), cancel: vi.fn(async () => ({ ...accepted(dispatched!), status: 'cancelled' as const, error: 'cancelled' as const, sequence: 2 })) }
    const config: RunnerConfig = { version: 1, binding, deviceId: device.deviceId, gatewayPublicKey: gatewayKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), devicePublicKey: deviceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), devicePrivateKey: deviceKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
    const server = new TlsGatewayServer({ gateway, key: cert.key, cert: cert.cert, host: '127.0.0.1', port: 0, rpcTimeoutMs: 5000 }), address = await server.start()
    const client = new TlsRunnerClient(config, runnerTransport, { host: '127.0.0.1', port: address.port, ca: cert.cert, servername: 'localhost', heartbeatMs: 20, reconnectMs: 20, maxReconnectMs: 50 })
    let activeServer = server
    try {
      await client.start(); await client.waitForConnection(5000)
      expect(client.status).toBe('connected')
      expect(await gateway.device(device.deviceId)).toMatchObject({ status: 'online' })
      const before = (await gateway.device(device.deviceId))?.lastSeen
      await delay(70)
      expect((await gateway.device(device.deviceId))?.lastSeen).not.toBe(before)
      const transport = gateway.transport(device.deviceId), first = request(gateway)
      expect(await transport.dispatch(first, AbortSignal.timeout(5000))).toMatchObject({ status: 'accepted', requestId: first.requestId })
      expect(runnerTransport.dispatch).toHaveBeenCalledTimes(1)
      expect(await transport.query({ protocolVersion: 1, requestId: first.requestId, intentHash: intentHash(first) }, AbortSignal.timeout(5000))).toMatchObject({ status: 'succeeded', requestId: first.requestId })
      await server.stop(); await vi.waitFor(() => expect(client.status).toBe('connecting'), { timeout: 5000 })
      activeServer = new TlsGatewayServer({ gateway, key: cert.key, cert: cert.cert, host: '127.0.0.1', port: address.port, rpcTimeoutMs: 5000 }); await activeServer.start(); await client.waitForConnection(5000)
      expect(await gateway.device(device.deviceId)).toMatchObject({ status: 'online' })
    } finally {
      await client.stop(); await vi.waitFor(async () => expect((await gateway.device(device.deviceId))?.status).toBe('offline'), { timeout: 5000 }); await activeServer.stop()
    }
  })
})
