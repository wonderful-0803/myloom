/** Exercises stdio framing with fake child streams, including hostile requests and lost processes. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexReadClient } from '../src/app/codex-rpc.ts'

afterEach(() => vi.useRealTimers())
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null as number | null,
    kill: vi.fn(() => { child.exitCode = 0; return true }) })
  const requests: any[] = []
  child.stdin.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) requests.push(JSON.parse(line)) })
  const launch = vi.fn(() => child) as unknown as typeof spawn
  const abort = new AbortController(), client = new CodexReadClient(abort.signal, launch, ['codex'])
  const respond = (id: unknown, result: unknown) => child.stdout.write(JSON.stringify({ id, result }) + '\n')
  return { child, requests, launch, abort, client, respond }
}
it('uses a short-lived analytics-disabled stdio reader, sends correct initialization, and refuses execution methods', async () => {
  const f = fixture()
  const initialized = f.client.initialize(); f.respond(1, { userAgent: 'test' }); await initialized
  expect(f.launch).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'], expect.anything())
  expect(f.requests[0]).toMatchObject({ method: 'initialize', params: { clientInfo: { name: 'loom_codex_history' } } })
  expect(f.requests[1]).toEqual({ method: 'initialized' })
  const listed = f.client.call('thread/list', { useStateDbOnly: true }); f.respond(2, { data: [], nextCursor: null }); await listed
  for (const method of ['thread/start','thread/resume','turn/start','turn/steer','command/exec','account/read'])
    await expect(f.client.call(method as never, {})).rejects.toThrow('只读')
  expect(f.requests.filter(r => r.method && r.method !== 'initialized').map(r => r.method)).toEqual(['initialize','thread/list'])
  f.client.close(); expect(f.child.kill).toHaveBeenCalled()
})
it('denies server tool/approval requests, ignores notifications and never relays diagnostics or remote error bodies', async () => {
  const f = fixture()
  const reading = f.client.call('thread/read', { threadId: 'id' })
  f.child.stderr.write('credential-canary')
  f.child.stdout.write(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'unsafe' } }) + '\n')
  f.child.stdout.write(JSON.stringify({ method: 'rawResponseItem/completed', params: { text: 'reasoning-canary' } }) + '\n')
  f.child.stdout.write(JSON.stringify({ id: 1, error: { code: -32000, message: 'credential-canary' } }) + '\n')
  await expect(reading).rejects.toThrow('接口拒绝')
  expect(f.requests.find(r => r.id === 'approval')).toEqual({ id: 'approval', error: { code: -32601, message: 'Read-only history client' } })
  expect(JSON.stringify(f.requests)).not.toMatch(/credential-canary|reasoning-canary/)
  f.client.close()
})
it('terminates timed-out or revoked reads and keeps protocol/buffer failures generic', async () => {
  vi.useFakeTimers()
  const f = fixture(), reading = f.client.call('thread/list', {})
  const expected = expect(reading).rejects.toThrow('读取超时')
  await vi.advanceTimersByTimeAsync(15_000); await expected
  expect(f.child.kill).toHaveBeenCalled()
  const g = fixture(), read = g.client.call('thread/read', {})
  const cancelled = expect(read).rejects.toThrow('只读连接')
  g.abort.abort(); await cancelled
  const huge = fixture(), pending = huge.client.call('thread/list', {})
  const rejected = expect(pending).rejects.toThrow('只读连接')
  huge.child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)); await rejected
  expect(huge.child.kill).toHaveBeenCalled()
})
