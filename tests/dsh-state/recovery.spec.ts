import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { localComputeIdentity, observeCompute } from '../../src/dsh-state/compute.ts'
import { computeOwnerKey, nativeStopProved, recoverNativeSession } from '../../src/dsh-state/recovery.ts'
import { metadataFixture, testURL } from './fixtures/metadata.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
describe.skipIf(process.platform !== 'linux')('Linux compute evidence', () => {
  it('recognizes itself, PID reuse, another host and a different PID namespace without mistaking SIGSTOP for exit', async () => {
    const here = (await localComputeIdentity())!
    expect(await observeCompute(here)).toBe('alive')
    expect(await observeCompute({ ...here, start: String(BigInt(here.start) + 1n) })).toBe('dead')
    expect(await observeCompute({ ...here, host: '0'.repeat(64) })).toBe('unverifiable')
    expect(await observeCompute({ ...here, namespace: 'pid:[1]' })).toBe('unverifiable')
    expect(await observeCompute({ ...here, uid: here.uid + 1 })).toBe('unverifiable')
  })
})
for (const dialect of ['sqlite', 'postgres'] as const) (process.platform !== 'linux' || dialect === 'postgres' && !testURL ? describe.skip : describe)(`proved native crash recovery: ${dialect}`, () => {
  async function fixture() {
    const f = await metadataFixture(dialect); cleanup.push(f.close)
    const owner = randomUUID(), child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./fixtures/recovery-process.ts', import.meta.url)),
      JSON.stringify({ dialect, path: join(f.folder, 'state.sqlite'), scope: f.scope, owner })], { env: { PATH: process.env.PATH, ...(testURL ? { LOOM_STATE_TEST_DATABASE_URL: testURL } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let ended = false
    const exited = new Promise<void>(resolve => child.once('exit', () => { ended = true; resolve() }))
    const kill = async () => { if (!ended) child.kill('SIGKILL'); await exited }
    cleanup.push(kill)
    const binding = await Promise.race([once(child.stdout!, 'data').then(([bytes]) => JSON.parse(String(bytes))), exited.then(() => { throw new Error('Crash fixture exited before its durable checkpoint') }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Crash fixture timed out')), 7000); timer.unref() })])
    return { ...f, child, binding, kill }
  }
  it('rejects recovery of a live or stopped owner, then proves SIGKILL death and preserves the committed prefix without a fake flush receipt', async () => {
    const f = await fixture()
    expect(await recoverNativeSession(f.store, f.scope, f.binding)).toBe('alive')
    f.child.kill('SIGSTOP')
    expect(await recoverNativeSession(f.store, f.scope, f.binding)).toBe('alive')
    await f.kill()
    expect(await recoverNativeSession(f.store, f.scope, f.binding)).toBe('recovered')
    expect(await recoverNativeSession(f.store, f.scope, f.binding)).toBe('already-recovered')
    await f.store.transaction(f.scope, async tx => {
      expect(await nativeStopProved(tx, f.binding)).toBe(true)
      expect(await tx.get('grant', `native-quiescent/${f.binding.sessionId}/${f.binding.epoch}`)).toBeUndefined()
      expect((await tx.get<any>('grant', `native-recovered/${f.binding.sessionId}/${f.binding.epoch}`))?.value).toMatchObject({ eventCount: 1, kind: 'process-exit-prefix-v1' })
      expect(await tx.leases.current(f.binding.sessionId)).toMatchObject({ until: 0 })
      expect(await tx.scan('native-event')).toHaveLength(1)
    })
  })
  it('does not use an uninspectable owner record or a missing native prefix as proof', async () => {
    const f = await fixture(); await f.kill()
    await f.store.transaction(f.scope, async tx => {
      const row = (await tx.get<any>('grant', computeOwnerKey(f.binding.owner)))!; row.value.identity.namespace = 'pid:[1]'; await tx.put('grant', row.id, row.value, row.revision)
    })
    expect(await recoverNativeSession(f.store, f.scope, f.binding)).toBe('unverifiable')
    expect(await f.store.transaction(f.scope, tx => nativeStopProved(tx, f.binding))).toBe(false)
  })
  it('rejects consumed inputs missing their committed message and does not release another epoch', async () => {
    const f = await fixture(); await f.kill()
    await f.store.transaction(f.scope, async tx => {
      await tx.put('grant', 'native-input/bad', { sessionId: f.binding.sessionId, protocol: 'sql-lease-v1', status: 'consumed', payload: 'missing', textHash: '0'.repeat(64), basis: 'fixture' }, 0)
    })
    expect(await recoverNativeSession(f.store, f.scope, f.binding)).toBe('unsafe')
    await f.store.transaction(f.scope, async tx => {
      await tx.leases.release((await tx.leases.current(f.binding.sessionId))!); await tx.leases.acquire(f.binding.sessionId, 'replacement', 60_000)
    })
    expect(await recoverNativeSession(f.store, f.scope, f.binding)).toBe('unsafe')
    expect((await f.store.transaction(f.scope, tx => tx.leases.current(f.binding.sessionId)))?.owner).toBe('replacement')
  })
})
