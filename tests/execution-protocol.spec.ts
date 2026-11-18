import { createHmac, timingSafeEqual } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionRouter, RunnerOffline } from '../src/execution/router.ts'
import { RunnerSimulator } from '../src/execution/simulator.ts'
import { checkedRequest, checkedReceipt, ReceiptCursor, intentHash } from '../src/execution/protocol.ts'
import type { RemoteRequest, RemoteReceipt } from '../src/execution/protocol.ts'
import type { RemoteTransport } from '../src/execution/router.ts'
import type { ExecutionRequest } from '../src/execution/port.ts'
import { ExecutionOutcomeUnknown } from '../src/execution/port.ts'
import { hash } from '../src/state/hash.ts'

const result = { kind: 'text' as const, text: 'Synthetic R1', truncated: false }
function fixture(execute = vi.fn(async (_request: RemoteRequest, _signal: AbortSignal) => result)) {
  const key = Buffer.alloc(32, 7), sign = (value: RemoteRequest) => createHmac('sha256', key).update(intentHash(value)).digest('base64url')
  const request: ExecutionRequest<'tool'> = { version: 1, requestId: 'stable-tool-call', binding: { ticketId: 'ticket-1', assignmentId: 'assignment-1', sessionId: 'worker-1', actor: { source: 'feishu', id: 'ou_owner' }, spaceId: 'space-1',
    target: { kind: 'runner', environmentId: 'linux-2', workspaceId: 'project-1' }, directory: '/server/scratch-not-a-device-path', controlRevision: 0 }, operation: 'tool', input: { name: 'read', arguments: { path: 'report.txt', offset: 0, limit: 100 } } }
  let permitted = true
  const remote = (): RemoteRequest => {
    const value: RemoteRequest = { protocolVersion: 1, requestId: request.requestId, tenantId: 'tenant-1', spaceId: 'space-1', userId: 'ou_owner', ticketId: 'ticket-1', assignmentId: 'assignment-1', sessionId: 'worker-1', environmentId: 'linux-2', workspaceId: 'project-1', toolId: 'fs.read', toolVersion: 1, effect: 'read', resourceGrantId: 'grant-1', grantRevision: 1, controlRevision: 0, sessionEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z', argsHash: hash(request.input.arguments), args: request.input.arguments, permit: 'placeholder'.repeat(4) }
    value.permit = sign(value); return value
  }
  const verify = (value: RemoteRequest) => { if (!timingSafeEqual(Buffer.from(value.permit), Buffer.from(sign(value)))) throw new Error('Invalid permit') }
  const authority = { prepare: vi.fn(async () => remote()), check: vi.fn(async () => { if (!permitted) throw new Error('revoked') }) }, simulator = new RunnerSimulator(verify, execute)
  const router = new ExecutionRouter(authority, simulator, { pollMs: 1, responseMs: 50 }), controller = new AbortController(), local = vi.fn(async () => ({ isError: false as const, value: 'LOCAL', content: [] }))
  const options = { signal: controller.signal, authorize: vi.fn(() => { if (!permitted) throw new Error('revoked') }) }
  return { request, remote, simulator, authority, router, controller, local, options, execute, revoke: () => { permitted = false }, sign }
}
describe('C1 remote protocol and opt-in router', () => {
  it('validates data-only read capability and returns a reconstructed DSH envelope without any local invocation', async () => {
    const f = fixture(), actual = await f.router.run(f.request, f.options, f.local)
    expect(actual).toMatchObject({ isError: false, value: result }); expect(f.execute).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled()
    expect(f.authority.check.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(f.remote())).not.toContain('/server/scratch')
  })
  it('keeps the existing local adapter and does not consult remote authority', async () => {
    const f = fixture(); f.request.binding.target = { kind: 'local' }
    expect(await f.router.run(f.request, f.options, f.local)).toMatchObject({ value: 'LOCAL' }); expect(f.authority.prepare).not.toHaveBeenCalled()
  })
  it.each(['bash', 'write', 'edit', 'subagent', 'job_start', 'unknown'])('denies unreviewed capability %s without side effects', async name => {
    const f = fixture(); f.request.input.name = name
    await expect(f.router.run(f.request, f.options, f.local)).rejects.toThrow('not installed'); expect(f.local).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it.each(['../private.txt', '/etc/passwd', 'folder/../../secret', 'folder\\secret'])('rejects unsafe device path %s before admission', async path => {
    const f = fixture(); f.request.input.arguments = { path, offset: 0, limit: 100 }
    await expect(f.router.run(f.request, f.options, f.local)).rejects.toThrow(); expect(f.authority.prepare).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled()
  })
  it('rejects same-ID intent changes and forged or expired permits; duplicates execute once', async () => {
    const f = fixture(), request = f.remote(), signal = f.controller.signal
    await f.simulator.dispatch(request, signal); await f.simulator.idle(); await f.simulator.dispatch(request, signal); expect(f.execute).toHaveBeenCalledOnce()
    const changed = { ...request, workspaceId: 'other-project' }; changed.permit = f.sign(changed)
    await expect(f.simulator.dispatch(changed, signal)).rejects.toThrow('changed intent')
    await expect(f.simulator.dispatch({ ...request, permit: '0'.repeat(43) }, signal)).rejects.toThrow('permit')
    const expired = { ...request, requestId: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' }; expired.permit = f.sign(expired)
    await expect(f.simulator.dispatch(expired, signal)).rejects.toThrow('expired'); expect(f.execute).toHaveBeenCalledOnce()
  })
  it('waits/refuses an offline Runner and never falls back to server files', async () => {
    const f = fixture(); f.simulator.online = false
    await expect(f.router.run(f.request, f.options, f.local)).rejects.toBeInstanceOf(RunnerOffline); expect(f.local).not.toHaveBeenCalled()
  })
  it('rechecks authorization after asynchronous admission and refuses a substituted environment', async () => {
    const f = fixture(); f.authority.prepare.mockImplementation(async () => { f.revoke(); return f.remote() })
    await expect(f.router.run(f.request, f.options, f.local)).rejects.toThrow('revoked'); expect(f.execute).not.toHaveBeenCalled()
    const other = fixture(); other.authority.prepare.mockImplementation(async () => ({ ...other.remote(), environmentId: 'other-device' }))
    await expect(other.router.run(other.request, other.options, other.local)).rejects.toThrow('binding'); expect(other.execute).not.toHaveBeenCalled()
  })
  it('does not mistake a cancellation request for an actual stopped operation', async () => {
    const done = Promise.withResolvers<typeof result>(), entered = Promise.withResolvers<void>(), f = fixture(vi.fn(async () => { entered.resolve(); return done.promise }))
    const running = f.router.run(f.request, f.options, f.local); await entered.promise; f.controller.abort()
    await expect(running).rejects.toBeInstanceOf(ExecutionOutcomeUnknown)
    expect(f.local).not.toHaveBeenCalled(); done.resolve(result); await f.simulator.idle()
  })
  it('treats dispatch response loss as unknown, then queries the same request without replaying its body', async () => {
    const f = fixture(), transport: RemoteTransport = { dispatch: async (request, signal) => { await f.simulator.dispatch(request, signal); await f.simulator.idle(); throw Error('lost receipt') }, query: (...args) => f.simulator.query(...args), cancel: (...args) => f.simulator.cancel(...args) }
    const router = new ExecutionRouter(f.authority, transport, { responseMs: 30 })
    await expect(router.run(f.request, f.options, f.local)).rejects.toBeInstanceOf(ExecutionOutcomeUnknown)
    const remote = f.remote(), receipt = checkedReceipt(await transport.query({ protocolVersion: 1, requestId: remote.requestId, intentHash: intentHash(remote) }, f.controller.signal), remote)
    expect(receipt.status).toBe('succeeded'); expect(f.execute).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled()
  })
  it('validates receipt type, identity, sequence and result digest before using device data', () => {
    const f = fixture(), request = f.remote(), cursor = new ReceiptCursor(request)
    const accepted: RemoteReceipt = { protocolVersion: 1, requestId: request.requestId, intentHash: intentHash(request), sequence: 1, status: 'accepted' }
    const success: RemoteReceipt = { ...accepted, sequence: 3, status: 'succeeded', result, resultHash: hash(result) }
    cursor.accept(accepted); cursor.accept(success); expect(cursor.accept(accepted)).toEqual(success)
    expect(() => cursor.accept({ ...success, resultHash: '0'.repeat(64) })).toThrow()
    expect(() => cursor.accept({ ...accepted, sequence: 4 })).toThrow('regress')
    expect(() => checkedReceipt({ ...success, requestId: 'someone-else' }, request)).toThrow('identity')
    expect(() => checkedReceipt({ ...success, result: { ...result, rawStderr: 'private' } }, request)).toThrow()
    expect(() => checkedRequest({ ...request, serverSecret: 'not-forwardable' })).toThrow()
    expect(() => checkedRequest({ ...request, effect: 'write' })).toThrow()
  })
  it('accepts the bounded remote stat capability without treating metadata as file contents', () => {
    const f = fixture(), request = f.remote()
    const statRequest = { ...request, requestId: 'stat-request', toolId: 'fs.stat' as const, args: { path: 'report.txt' }, argsHash: hash({ path: 'report.txt' }) }
    statRequest.permit = f.sign(statRequest)
    const receipt: RemoteReceipt = { protocolVersion: 1, requestId: statRequest.requestId, intentHash: intentHash(statRequest), sequence: 3,
      status: 'succeeded', result: { kind: 'stat', path: 'report.txt', bytes: 12, modifiedAt: '2099-01-01T00:00:00.000Z' }, resultHash: hash({ kind: 'stat', path: 'report.txt', bytes: 12, modifiedAt: '2099-01-01T00:00:00.000Z' }) }
    expect(checkedReceipt(receipt, statRequest)).toEqual(receipt)
  })
})
