import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DeviceGateway, connectionPayload, GatewayRequestLedger, signConnectionChallenge, StateGatewayDirectory, StateGatewayLedgerBackend } from '../src/execution/gateway.ts'
import { RunnerOffline } from '../src/execution/router.ts'
import { RunnerSimulator } from '../src/execution/simulator.ts'
import { permitPayload } from '../src/execution/runner/config.ts'
import type { RemoteRequest } from '../src/execution/protocol.ts'
import { intentHash } from '../src/execution/protocol.ts'
import { hash } from '../src/state/hash.ts'
import { SqliteStateStore } from '../src/state/sqlite.ts'

const binding = { tenantId: 'tenant-test', spaceId: 'personal-test', userId: 'owner-test', environmentId: 'linux-2' }
const result = { kind: 'text' as const, text: 'R1：来自设备', truncated: false }

function request(gateway: DeviceGateway): RemoteRequest {
  const args = { path: 'notes/daily.txt', offset: 0, limit: 100 }
  const base = { protocolVersion: 1 as const, requestId: randomUUID(), ...binding, ticketId: 'ticket-test', assignmentId: 'assignment-test', sessionId: 'session-test', workspaceId: 'project-test', toolId: 'fs.read' as const, toolVersion: 1 as const, effect: 'read' as const, resourceGrantId: 'grant-test', grantRevision: 1, controlRevision: 0, sessionEpoch: 1, expiresAt: new Date(Date.now() + 30_000).toISOString(), argsHash: hash(args), args }
  return { ...base, permit: gateway.signPermit(base) }
}

async function connected() {
  const gateway = new DeviceGateway(), keys = generateKeyPairSync('ed25519')
  const challenge = await gateway.createPairing(binding, undefined, ['fs.read']), device = await gateway.registerPairing(challenge.id, challenge.code, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), ['fs.read'])
  const runner = new RunnerSimulator(request => {
    const signature = Buffer.from(request.permit, 'base64url')
    if (!verify(null, permitPayload(request), gateway.publicKey, signature)) throw Error('permit')
  }, async () => result)
  const connection = await gateway.issueConnectionChallenge(device.deviceId)
  await gateway.connect(device.deviceId, connection.nonce, signConnectionChallenge(device.deviceId, connection.nonce, keys.privateKey), runner)
  return { gateway, device, runner }
}

describe('C3 device gateway', () => {
  it('binds a device to the authorized owner and accepts a connection only with a fresh device signature', async () => {
    const gateway = new DeviceGateway(), keys = generateKeyPairSync('ed25519'), challenge = await gateway.createPairing(binding)
    const device = await gateway.registerPairing(challenge.id, challenge.code, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    expect(device).toMatchObject({ ...binding, status: 'offline', connectionEpoch: 0 })
    await expect(gateway.registerPairing(challenge.id, challenge.code, device.devicePublicKey)).rejects.toThrow('invalid')
    const connection = await gateway.issueConnectionChallenge(device.deviceId)
    await expect(gateway.connect(device.deviceId, connection.nonce, 'bad', { dispatch: vi.fn(), query: vi.fn(), cancel: vi.fn() })).rejects.toThrow('proof')
  })

  it('routes a request to the registered device, persists the receipt boundary and deduplicates retries', async () => {
    const { gateway, device, runner } = await connected(), transport = gateway.transport(device.deviceId), first = request(gateway)
    const accepted = await transport.dispatch(first, AbortSignal.timeout(5000))
    expect(accepted).toMatchObject({ requestId: first.requestId, status: 'accepted' })
    await runner.idle()
    const done = await transport.query({ protocolVersion: 1, requestId: first.requestId, intentHash: intentHash(first) }, AbortSignal.timeout(5000))
    expect(done).toMatchObject({ status: 'succeeded', result })
    const dispatch = vi.spyOn(runner, 'dispatch')
    expect(await transport.dispatch(first, AbortSignal.timeout(5000))).toMatchObject({ status: 'succeeded', result })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await gateway.requestLedger().all()).toHaveLength(1)
  })

  it('rejects a changed request and never lets a request cross the device binding', async () => {
    const { gateway, device } = await connected(), transport = gateway.transport(device.deviceId), first = request(gateway)
    await transport.dispatch(first, AbortSignal.timeout(5000))
    const changedArgs = { path: 'private.txt', offset: 0, limit: 1 }, changedRequest = { ...first, args: changedArgs, argsHash: hash(changedArgs) }, { permit: _oldPermit, ...changedRequestBody } = changedRequest
    await expect(transport.dispatch({ ...changedRequest, permit: gateway.signPermit(changedRequestBody) }, AbortSignal.timeout(5000))).rejects.toThrow('identity conflict')
    const changedBinding = { ...first, environmentId: 'other-device' }, { permit: _permit, ...changedBindingBody } = changedBinding
    await expect(transport.dispatch({ ...changedBinding, permit: gateway.signPermit(changedBindingBody) }, AbortSignal.timeout(5000))).rejects.toThrow('outside')
  })

  it('marks a device offline on revoke and expires stale connections', async () => {
    let now = Date.now(); const gateway = new DeviceGateway({ now: () => now, connectionTtlMs: 10 }), keys = generateKeyPairSync('ed25519'), challenge = await gateway.createPairing(binding), device = await gateway.registerPairing(challenge.id, challenge.code, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    const transport = { dispatch: vi.fn(), query: vi.fn(), cancel: vi.fn() }, connection = await gateway.issueConnectionChallenge(device.deviceId)
    await gateway.connect(device.deviceId, connection.nonce, signConnectionChallenge(device.deviceId, connection.nonce, keys.privateKey), transport)
    now += 11
    await expect(gateway.transport(device.deviceId).dispatch(request(gateway), AbortSignal.timeout(500))).rejects.toBeInstanceOf(RunnerOffline)
    await gateway.revoke(device.deviceId)
    expect(await gateway.device(device.deviceId)).toMatchObject({ status: 'revoked' })
    await expect(gateway.issueConnectionChallenge(device.deviceId)).rejects.toThrow('not available')
  })

  it('keeps the gateway request ledger across a new process-side ledger instance', async () => {
    const store = await SqliteStateStore.open(':memory:'), scope = { tenantId: 'tenant-state-test', spaceId: 'personal-state' }
    try {
      const gateway = new DeviceGateway(), first = request(gateway), backend = new StateGatewayLedgerBackend(store, scope)
      const ledger = new GatewayRequestLedger(backend), accepted = { protocolVersion: 1 as const, requestId: first.requestId, intentHash: intentHash(first), sequence: 1, status: 'accepted' as const }
      await ledger.accept(first, 'device-state', accepted)
      const restarted = new GatewayRequestLedger(new StateGatewayLedgerBackend(store, scope))
      expect(await restarted.get(first.requestId, intentHash(first))).toMatchObject({ deviceId: 'device-state', receipt: { status: 'accepted' } })
      const done = { protocolVersion: 1 as const, requestId: first.requestId, intentHash: intentHash(first), sequence: 3, status: 'succeeded' as const, result, resultHash: hash(result) }
      await restarted.update(first, done)
      expect(await ledger.get(first.requestId, intentHash(first))).toMatchObject({ receipt: { status: 'succeeded', result } })
    } finally { await store.close() }
  })

  it('restores pairing consumption and revocation from StateStore across gateway instances', async () => {
    const store = await SqliteStateStore.open(':memory:'), scope = { tenantId: 'tenant-directory-test', spaceId: 'personal-directory' }, directory = new StateGatewayDirectory(store, scope)
    try {
      const first = new DeviceGateway({ directory }), keys = generateKeyPairSync('ed25519'), localBinding = { ...binding, tenantId: scope.tenantId, spaceId: scope.spaceId }, challenge = await first.createPairing(localBinding, undefined, ['fs.read'])
      const second = new DeviceGateway({ directory }), device = await second.registerPairing(challenge.id, challenge.code, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), ['fs.read'])
      expect(await first.device(device.deviceId)).toMatchObject({ ...localBinding, status: 'offline', capabilities: ['fs.read'] })
      const connection = await first.issueConnectionChallenge(device.deviceId)
      await first.connect(device.deviceId, connection.nonce, signConnectionChallenge(device.deviceId, connection.nonce, keys.privateKey), { dispatch: async () => ({}), query: async () => ({}), cancel: async () => ({}) })
      expect(await store.transaction(scope, tx => tx.scan<any>('audit', { relation: 'signal.runner', limit: 10 }))).toHaveLength(1)
      await first.disconnect(device.deviceId, 1)
      expect(await store.transaction(scope, tx => tx.scan<any>('audit', { relation: 'signal.runner', limit: 10 }))).toHaveLength(2)
      await first.revoke(device.deviceId)
      const restarted = new DeviceGateway({ directory })
      expect(await restarted.device(device.deviceId)).toMatchObject({ status: 'revoked' })
      await expect(restarted.registerPairing(challenge.id, challenge.code, device.devicePublicKey)).rejects.toThrow('invalid')
    } finally { await store.close() }
  })
})
