import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, link, rename, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { LinuxRunner, initializeRunner, permitPayload } from '../src/execution/runner/index.ts'
import { RunnerLedger } from '../src/execution/runner/ledger.ts'
import { SafeTextFiles } from '../src/execution/runner/files.ts'
import type { RemoteRequest, RemoteReceipt } from '../src/execution/protocol.ts'
import { intentHash } from '../src/execution/protocol.ts'
import { hash } from '../src/state/hash.ts'
import { ExecutionRouter } from '../src/execution/router.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'loom-runner-c2-')); cleanup.push(() => rm(folder, { recursive: true, force: true }))
  const home = join(folder, 'runner'), root = join(folder, 'project'); await mkdir(root, { mode: 0o700 })
  await mkdir(join(root, 'notes'), { mode: 0o700 }); await writeFile(join(root, 'notes', 'daily.txt'), 'R1：完成资料整理。\nR2：明天复核汇总。\n', { mode: 0o600 })
  const keys = generateKeyPairSync('ed25519'), peer = { tenantId: 'tenant-test', spaceId: 'personal-test', userId: 'owner-test', environmentId: 'linux-test' }
  await initializeRunner(home, peer, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())
  let runner = await LinuxRunner.open(home); cleanup.push(() => runner.close())
  const grant = { id: 'grant-test', workspaceId: 'project-test', scope: 'personal', root, capabilities: ['fs.read', 'fs.glob', 'fs.grep', 'fs.stat'], extensions: ['.txt', '.md', '.json'], expiresAt: new Date(Date.now() + 3600000).toISOString() }
  await runner.grant(grant)
  const request = (patch: Partial<RemoteRequest> = {}) => {
    const args = patch.args ?? { path: 'notes/daily.txt', offset: 0, limit: 100 }
    const value: RemoteRequest = { protocolVersion: 1, requestId: randomUUID(), tenantId: peer.tenantId, spaceId: peer.spaceId, userId: peer.userId, environmentId: peer.environmentId,
      ticketId: 'ticket-test', assignmentId: 'assignment-test', sessionId: 'session-test', workspaceId: 'project-test', toolId: 'fs.read', toolVersion: 1, effect: 'read',
      resourceGrantId: 'grant-test', grantRevision: 1, controlRevision: 0, sessionEpoch: 1, expiresAt: new Date(Date.now() + 30000).toISOString(), permit: '', ...patch, args, argsHash: hash(args) }
    value.permit = sign(null, permitPayload(value), keys.privateKey).toString('base64url'); return value
  }
  const query = (r: RemoteRequest) => ({ protocolVersion: 1 as const, requestId: r.requestId, intentHash: intentHash(r) })
  const run = async (r = request()) => { const transport = runner.transport(peer); await transport.dispatch(r, AbortSignal.timeout(5000)); await runner.idle(); return await transport.query(query(r), AbortSignal.timeout(5000)) as RemoteReceipt }
  return { folder, home, root, peer, grant, request, query, run, get runner() { return runner }, restart: async () => { await runner.close(); runner = await LinuxRunner.open(home) } }
}
describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('C2 Linux read-only device', () => {
  it('runs real read/glob/literal grep in an explicitly selected root and keeps a bounded C1 receipt', async () => {
    const f = await fixture()
    expect(await f.run()).toMatchObject({ status: 'succeeded', result: { kind: 'text', text: 'R1：完成资料整理。\nR2：明天复核汇总。\n', truncated: false } })
    expect(await f.run(f.request({ toolId: 'fs.glob', args: { pattern: '**/*.txt', limit: 100 } }))).toMatchObject({ status: 'succeeded', result: { kind: 'paths', paths: ['notes/daily.txt'], truncated: false } })
    expect(await f.run(f.request({ toolId: 'fs.grep', args: { query: 'R2', pattern: '**/*.txt', limit: 100 } }))).toMatchObject({ status: 'succeeded', result: { kind: 'matches', matches: [{ path: 'notes/daily.txt', line: 2, text: 'R2：明天复核汇总。' }] } })
    expect(await f.run(f.request({ toolId: 'fs.stat', args: { path: 'notes/daily.txt' } }))).toMatchObject({ status: 'succeeded', result: { kind: 'stat', path: 'notes/daily.txt', bytes: expect.any(Number), modifiedAt: expect.any(String) } })
    expect(await f.run(f.request({ args: { path: 'notes/daily.txt', offset: 1, limit: 1 } }))).toMatchObject({ result: { text: 'R2：明天复核汇总。', truncated: true } })
  })
  it('returns real device text through the C1 router and never invokes a server-local fallback', async () => {
    const f = await fixture(), remote = f.request(), local = vi.fn(async () => { throw Error('Must not execute on the compute host') })
    const router = new ExecutionRouter({ prepare: async () => remote, check: async () => {} }, f.runner.transport(f.peer), { pollMs: 1 })
    const result = await router.run({ version: 1, requestId: remote.requestId, operation: 'tool', input: { name: 'read', arguments: remote.args },
      binding: { actor: { source: 'feishu', id: f.peer.userId }, spaceId: f.peer.spaceId, ticketId: remote.ticketId, assignmentId: remote.assignmentId, sessionId: remote.sessionId, controlRevision: 0,
        target: { kind: 'runner', environmentId: f.peer.environmentId, workspaceId: remote.workspaceId }, directory: '/server/scratch' } }, { signal: AbortSignal.timeout(5000), authorize: () => {} }, local)
    expect(result).toMatchObject({ isError: false, value: { kind: 'text', text: expect.stringContaining('R1') } }); expect(local).not.toHaveBeenCalled()
  })
  it('persists a result across restart and deduplicates after the source changes; conflicting intent never reruns', async () => {
    const f = await fixture(), request = f.request(), first = await f.run(request)
    await writeFile(join(f.root, 'notes/daily.txt'), 'Changed source')
    await f.restart(); expect(await f.run(request)).toEqual(first)
    const changed = f.request({ ...request, args: { path: 'notes/daily.txt', offset: 1, limit: 1 } })
    await expect(f.run(changed)).rejects.toThrow('conflict')
    expect((await stat(join(f.home, 'device.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(f.home, 'receipts.sqlite'))).mode & 0o777).toBe(0o600)
    expect((await stat(f.home)).mode & 0o777).toBe(0o700)
    expect((await readFile(join(f.home, 'device.json'), 'utf8'))).not.toContain('Changed source')
  })
  it('rejects forged/expired/long-lived permits, modified identities, ungranted scope and unknown capabilities before acceptance', async () => {
    const f = await fixture(), request = f.request()
    for (const bad of [{ ...request, permit: '0'.repeat(86) }, { ...request, args: { path: '../private.txt', offset: 0, limit: 1 } },
      f.request({ expiresAt: new Date(Date.now() - 1).toISOString() }), f.request({ expiresAt: new Date(Date.now() + 120000).toISOString() }),
      f.request({ userId: 'different-owner' }), f.request({ spaceId: 'group-test' }), f.request({ workspaceId: 'other-project' }), f.request({ grantRevision: 2 }),
      { ...request, toolId: 'bash' }]) await expect(f.run(bad as RemoteRequest)).rejects.toThrow()
    expect(() => f.runner.transport({ ...f.peer, userId: 'other-owner' })).toThrow('peer denied')
    expect(await f.run(request)).toMatchObject({ status: 'succeeded', sequence: 3 })
  })
  it('rejects old epochs and controls, and persists these fences across a restart', async () => {
    const f = await fixture(); await f.run(f.request({ sessionEpoch: 2, controlRevision: 1 })); await f.restart()
    await expect(f.run(f.request({ sessionEpoch: 1, controlRevision: 1 }))).rejects.toThrow('denied')
    await expect(f.run(f.request({ sessionEpoch: 2, controlRevision: 0 }))).rejects.toThrow('denied')
  })
  it('does not inherit access from another user or shared space; shared-group grants require explicit local selection', async () => {
    const f = await fixture()
    await expect(f.run(f.request({ spaceId: 'shared-group' }))).rejects.toThrow('peer denied')
    expect(f.runner.grants()[0]?.scope).toBe('personal')
    await f.runner.grant({ ...f.grant, scope: 'shared-group' }, 1)
    expect(f.runner.grants()[0]?.scope).toBe('shared-group')
    await expect(f.run(f.request({ spaceId: 'shared-group', grantRevision: 2 }))).rejects.toThrow('peer denied')
  })
  it('denies root/state/alias grants and retains revocation and CAS instead of accepting an old revision', async () => {
    const f = await fixture()
    await expect(f.runner.grant({ ...f.grant, root: f.folder }, 1)).rejects.toThrow()
    await expect(f.runner.grant({ ...f.grant, root: f.home }, 1)).rejects.toThrow()
    const alias = join(f.folder, 'alias'); await symlink(f.root, alias)
    await expect(f.runner.grant({ ...f.grant, root: alias }, 1)).rejects.toThrow()
    expect(f.runner.revoke('grant-test', 1)).toMatchObject({ revision: 2, enabled: false }); await f.restart()
    await expect(f.run()).rejects.toThrow('denied')
    await expect(f.runner.grant(f.grant, 1)).rejects.toThrow('revision')
  })
  it.each(['link-file', 'link-parent', 'hard-link', 'hidden', 'non-text', 'large', 'special'])('fails closed on %s without returning private bytes', async kind => {
    const f = await fixture(), outside = join(f.folder, 'private.txt'); await writeFile(outside, 'PRIVATE_SENTINEL', { mode: 0o600 })
    let path = 'unsafe.txt'
    if (kind === 'link-file') await symlink(outside, join(f.root, path))
    if (kind === 'link-parent') { await symlink(f.folder, join(f.root, 'linked')); path = 'linked/private.txt' }
    if (kind === 'hard-link') await link(outside, join(f.root, path))
    if (kind === 'hidden') { path = '.env.txt'; await writeFile(join(f.root, path), 'PRIVATE_SENTINEL', { mode: 0o600 }) }
    if (kind === 'non-text') await writeFile(join(f.root, path), Buffer.from([0, 255, 1]), { mode: 0o600 })
    if (kind === 'large') await writeFile(join(f.root, path), Buffer.alloc(1048577, 65), { mode: 0o600 })
    if (kind === 'special') { const { execFileSync } = await import('node:child_process'); execFileSync('mkfifo', [join(f.root, path)]) }
    const receipt = await f.run(f.request({ args: { path, offset: 0, limit: 100 } }))
    expect(receipt.status).toBe('failed'); expect(receipt.result).toBeUndefined(); expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SENTINEL')
  })
  it('pins the root inode and refuses a replaced root even at the same canonical path', async () => {
    const f = await fixture(); await rename(f.root, f.root + '-moved'); await mkdir(f.root, { mode: 0o700 }); await mkdir(join(f.root, 'notes')); await writeFile(join(f.root, 'notes/daily.txt'), 'PRIVATE_SENTINEL')
    expect(await f.run()).toMatchObject({ status: 'failed', error: 'denied' })
  })
  it('rechecks opened directory handles after a parent is moved and replaced during the file read', async () => {
    const f = await fixture(), replacement = join(f.folder, 'private'); await mkdir(replacement, { mode: 0o700 })
    await writeFile(join(replacement, 'daily.txt'), 'PRIVATE_SENTINEL', { mode: 0o600 })
    type Opened = { at(path: string, work: (file: unknown) => Promise<unknown>): Promise<unknown> }
    const prototype = SafeTextFiles.prototype as unknown as Opened, original = prototype.at
    vi.spyOn(prototype, 'at').mockImplementation(function (this: Opened, path, work) {
      return original.call(this, path, async file => {
        await rename(join(f.root, 'notes'), join(f.folder, 'moved-notes'))
        await symlink(replacement, join(f.root, 'notes'))
        return work(file)
      })
    })
    const receipt = await f.run(); expect(receipt).toMatchObject({ status: 'failed', error: 'denied' }); expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SENTINEL')
  })
  it('does not return success or stop proof while cancellation is merely requested', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = SafeTextFiles.prototype.execute
    vi.spyOn(SafeTextFiles.prototype, 'execute').mockImplementation(async function (this: SafeTextFiles, request) { entered.resolve(); await release.promise; return original.call(this, request) })
    const request = f.request(), transport = f.runner.transport(f.peer)
    await transport.dispatch(request, AbortSignal.timeout(5000)); await entered.promise
    expect(await transport.cancel({ ...f.query(request), reason: 'pause' }, AbortSignal.timeout(5000))).toMatchObject({ status: 'running' })
    release.resolve(); await f.runner.idle()
    expect(await transport.query(f.query(request), AbortSignal.timeout(5000))).toMatchObject({ status: 'cancelled', error: 'cancelled' })
  })
  it('rechecks a local revocation before releasing a result and denies cached payload retrieval after revoke', async () => {
    const f = await fixture(), complete = f.request(); await f.run(complete)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = SafeTextFiles.prototype.execute
    vi.spyOn(SafeTextFiles.prototype, 'execute').mockImplementation(async function (this: SafeTextFiles, request) { entered.resolve(); await release.promise; return original.call(this, request) })
    const request = f.request(), transport = f.runner.transport(f.peer); await transport.dispatch(request, AbortSignal.timeout(5000)); await entered.promise
    f.runner.revoke('grant-test', 1); release.resolve(); await f.runner.idle()
    await expect(transport.query(f.query(complete), AbortSignal.timeout(5000))).rejects.toThrow('denied')
    await expect(transport.cancel({ ...f.query(complete), reason: 'revoke' }, AbortSignal.timeout(5000))).rejects.toThrow('denied')
    expect(await transport.cancel({ ...f.query(request), reason: 'revoke' }, AbortSignal.timeout(5000))).toMatchObject({ status: 'cancelled' })
  })
  it('cancels queued work without starting it and denies an active request superseded by a new durable fence', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = SafeTextFiles.prototype.execute
    const execute = vi.spyOn(SafeTextFiles.prototype, 'execute').mockImplementation(async function (this: SafeTextFiles, request) { entered.resolve(); await release.promise; return original.call(this, request) })
    const first = f.request(), queued = f.request(), next = f.request({ sessionEpoch: 2, controlRevision: 1 }), transport = f.runner.transport(f.peer), signal = AbortSignal.timeout(5000)
    await transport.dispatch(first, signal); await entered.promise
    await transport.dispatch(queued, signal)
    expect(await transport.cancel({ ...f.query(queued), reason: 'pause' }, signal)).toMatchObject({ status: 'cancelled', sequence: 2 })
    await transport.dispatch(next, signal); release.resolve(); await f.runner.idle()
    expect(await transport.query(f.query(first), signal)).toMatchObject({ status: 'failed', error: 'denied' })
    expect(await transport.query(f.query(next), signal)).toMatchObject({ status: 'succeeded' })
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('rechecks a permit that expires after acceptance before reading or returning a payload', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = SafeTextFiles.prototype.execute
    vi.spyOn(SafeTextFiles.prototype, 'execute').mockImplementation(async function (this: SafeTextFiles, request) { entered.resolve(); await release.promise; return original.call(this, request) })
    const request = f.request(), transport = f.runner.transport(f.peer), signal = AbortSignal.timeout(5000)
    await transport.dispatch(request, signal); await entered.promise
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(request.expiresAt) + 1); release.resolve(); await f.runner.idle()
    expect(await transport.query(f.query(request), signal)).toMatchObject({ status: 'failed', error: 'denied' })
  })
  it('bounds Unicode output, matching results and scans; only literal grep is supported', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'big.txt'), '陆兮'.repeat(30000), { mode: 0o600 })
    const result = await f.run(f.request({ args: { path: 'big.txt', offset: 0, limit: 1 } }))
    expect(result).toMatchObject({ status: 'succeeded', result: { truncated: true } }); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(80000)
    await writeFile(join(f.root, 'escaped.txt'), '\\"'.repeat(60000), { mode: 0o600 })
    const escaped = await f.run(f.request({ args: { path: 'escaped.txt', offset: 0, limit: 1 } }))
    expect(escaped).toMatchObject({ status: 'succeeded', result: { truncated: true } }); expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThan(80000)
    expect(await f.run(f.request({ toolId: 'fs.grep', args: { query: '陆兮', pattern: 'big.txt', limit: 10 } }))).toMatchObject({ status: 'succeeded', result: { truncated: true } })
    expect(await f.run(f.request({ toolId: 'fs.glob', args: { pattern: '**/*.txt', limit: 1 } }))).toMatchObject({ status: 'succeeded', result: { truncated: true } })
    expect(await f.run(f.request({ toolId: 'fs.grep', args: { query: '(a+)+$', pattern: '**/*.txt', limit: 10 } }))).toMatchObject({ status: 'succeeded', result: { matches: [] } })
    for (let i = 0; i < 2001; i++) await writeFile(join(f.root, 'entry-' + i), '', { mode: 0o600 })
    expect(await f.run(f.request({ toolId: 'fs.glob', args: { pattern: '**/not-present.txt', limit: 10 } }))).toMatchObject({ status: 'failed', error: 'budget' })
  })
  it('expires sensitive cached bytes but retains a durable tombstone that prevents reexecution', async () => {
    const f = await fixture(), request = f.request(); await f.run(request); await f.runner.close()
    const { loadRunner } = await import('../src/execution/runner/config.ts'), ledger = await RunnerLedger.open(f.home, await loadRunner(f.home))
    try { ledger.prune(Date.now() + 3600001); expect(() => ledger.get(request.requestId, intentHash(request))).toThrow('tombstone') } finally { ledger.close() }
    await f.restart(); await expect(f.run(request)).rejects.toThrow('tombstone')
    expect((await readFile(join(f.home, 'receipts.sqlite'))).includes(Buffer.from('R1：完成资料整理。'))).toBe(false)
  })
  it('refuses duplicate local owners, permissive files and changed pinned gateway identities', async () => {
    const f = await fixture(); await expect(LinuxRunner.open(f.home)).rejects.toThrow()
    await f.runner.close(); await chmod(join(f.home, 'device.json'), 0o644); await expect(LinuxRunner.open(f.home)).rejects.toThrow('private')
    await chmod(join(f.home, 'device.json'), 0o600)
    const file = join(f.home, 'device.json'), config = JSON.parse(await readFile(file, 'utf8')); config.binding.spaceId = 'different-scope'; await writeFile(file, JSON.stringify(config))
    await expect(LinuxRunner.open(f.home)).rejects.toThrow('identity/version')
  })
})
