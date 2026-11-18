import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LinuxRunner, initializeRunner, permitPayload } from '../src/execution/runner/index.ts'
import type { RemoteRequest } from '../src/execution/protocol.ts'
import { hash } from '../src/state/hash.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('C2 real Linux process ownership', () => {
  it('keeps ownership while SIGSTOPped and recovers unknown after SIGKILL without replaying the file read', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'loom-runner-process-')); cleanup.push(() => rm(folder, { recursive: true, force: true }))
    const home = join(folder, 'runner'), root = join(folder, 'data'); await mkdir(root, { mode: 0o700 })
    await writeFile(join(root, 'records.txt'), 'R1 Synthetic\n'.repeat(20000), { mode: 0o600 })
    const keys = generateKeyPairSync('ed25519'), peer = { tenantId: 'tenant-test', spaceId: 'space-test', userId: 'owner-test', environmentId: 'linux-test' }
    await initializeRunner(home, peer, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    const runner = await LinuxRunner.open(home)
    await runner.grant({ id: 'grant', workspaceId: 'work', root, scope: 'personal', capabilities: ['fs.read'], extensions: ['.txt'], expiresAt: new Date(Date.now() + 3600000).toISOString() }); await runner.close()
    const args = { path: 'records.txt', offset: 0, limit: 1 }
    const request: RemoteRequest = { protocolVersion: 1, requestId: 'stable-read-call', ...peer, ticketId: 'task', assignmentId: 'assignment', sessionId: 'session', workspaceId: 'work', toolId: 'fs.read', toolVersion: 1, effect: 'read',
      resourceGrantId: 'grant', grantRevision: 1, controlRevision: 0, sessionEpoch: 1, expiresAt: new Date(Date.now() + 30000).toISOString(), args, argsHash: hash(args), permit: '' }
    request.permit = sign(null, permitPayload(request), keys.privateKey).toString('base64url')
    async function launch(mode: 'hold' | 'recover') {
      const child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./fixtures/runner-process.ts', import.meta.url)), JSON.stringify({ home, peer, request, mode })],
        { cwd: folder, env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
      let data = '', ended = false; const messages: any[] = [], wakes = new Set<() => void>()
      child.stdout.on('data', bytes => { data += String(bytes); let cut; while ((cut = data.indexOf('\n')) >= 0) { messages.push(JSON.parse(data.slice(0, cut))); data = data.slice(cut + 1); for (const wake of wakes) wake() } })
      const exit = new Promise<void>(done => child.once('exit', () => { ended = true; done(); for (const wake of wakes) wake() }))
      const kill = async () => { if (!ended) child.kill('SIGKILL'); await exit }; cleanup.push(kill)
      const next = () => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { wakes.delete(wake); reject(Error('Runner subprocess checkpoint timeout')) }, 5000)
        const wake = () => { if (!messages.length && !ended) return; clearTimeout(timer); wakes.delete(wake); messages.length ? resolve(messages.shift()) : reject(Error('Runner checkpoint missing')) }
        wakes.add(wake); wake()
      })
      return { next, exit, kill }
    }
    const first = await launch('hold'); expect(await first.next()).toEqual({ state: 'running', sequence: 2 })
    const competing = await launch('hold'); expect(await competing.next()).toEqual({ state: 'refused' }); await competing.exit
    await first.kill(); await writeFile(join(root, 'records.txt'), 'Changed after crash', { mode: 0o600 })
    const replacement = await launch('recover'), recovered = await replacement.next(); await replacement.exit
    expect(recovered).toMatchObject({ state: 'recovered', receipt: { requestId: request.requestId, status: 'unknown', sequence: 3 } })
    expect(recovered.receipt.result).toBeUndefined()
    const again = await LinuxRunner.open(home)
    try { const receipt = await again.transport(peer).dispatch(request, AbortSignal.timeout(5000)); expect(receipt).toMatchObject({ status: 'unknown', sequence: 3 }); await again.idle() }
    finally { await again.close() }
  }, 15000)
})
