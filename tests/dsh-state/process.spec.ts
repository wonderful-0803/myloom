import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
const url = process.env.LOOM_STATE_TEST_DATABASE_URL
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Native process tests require a disposable _test database')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(dialect: 'sqlite' | 'postgres') {
  const folder = await mkdtemp(join(tmpdir(), 'loom-native-process-'))
  cleanup.push(() => rm(folder, { recursive: true, force: true }))
  const tenantId = `test-${randomUUID()}`, path = join(folder, 'state.sqlite')
  async function launch(mode: 'hold' | 'recover') {
    // Each replacement starts with an empty and different cwd. The only authority is the shared DB.
    const cwd = await mkdtemp(join(folder, 'compute-'))
    const child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./fixtures/process.ts', import.meta.url)), JSON.stringify({ dialect, tenantId, path, mode })],
      { cwd, env: { PATH: process.env.PATH, ...(dialect === 'postgres' ? { LOOM_STATE_TEST_DATABASE_URL: url } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', ended = false
    const messages: any[] = [], waiters = new Set<() => void>()
    child.stdout.on('data', chunk => {
      output += String(chunk)
      for (;;) { const cut = output.indexOf('\n'); if (cut < 0) break; const line = output.slice(0, cut); output = output.slice(cut + 1); try { messages.push(JSON.parse(line)); for (const wake of waiters) wake() } catch {} }
    })
    const exit = new Promise<void>(done => child.once('exit', () => { ended = true; done(); for (const wake of waiters) wake() }))
    const kill = async () => { if (!ended) child.kill('SIGKILL'); await exit }
    cleanup.push(kill)
    const next = () => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(wake); reject(new Error('Native subprocess did not reach its checkpoint')) }, 7000)
      const wake = () => {
        if (!messages.length && !ended) return
        clearTimeout(timer); waiters.delete(wake)
        if (messages.length) resolve(messages.shift()); else reject(new Error('Native subprocess exited without a checkpoint'))
      }
      waiters.add(wake); wake()
    })
    return { child, next, kill, exit, cwd }
  }
  return { launch }
}
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !url ? describe.skip : describe)(`native two-process recovery: ${dialect}`, () => {
  it('refuses a competing process, then restores the same committed Session after SIGKILL in an empty compute directory', async () => {
    const f = await fixture(dialect), first = await f.launch('hold'), saved = await first.next()
    expect(saved).toMatchObject({ state: 'ready', id: 'worker-stable', count: 2 })
    const competing = await f.launch('hold'); expect(await competing.next()).toMatchObject({ state: 'owned' }); await competing.exit
    await first.kill(); await delay(1000)
    const replacement = await f.launch('recover'), recovered = await replacement.next()
    // Restore's native end-seed marker is persisted before the new selection, just as agent-loop does.
    expect(recovered).toMatchObject({ state: 'recovered', id: saved.id, before: 2, after: 4, header: saved.header })
    expect(replacement.cwd).not.toBe(first.cwd); await replacement.exit
  }, 15_000)
  it.skipIf(process.platform === 'win32')('fences the old process after SIGSTOP, lease expiry, replacement ownership and SIGCONT', async () => {
    const f = await fixture(dialect), first = await f.launch('hold'); expect((await first.next()).state).toBe('ready')
    first.child.kill('SIGSTOP'); await delay(1100)
    const next = await f.launch('hold'); expect((await next.next()).state).toBe('ready')
    first.child.kill('SIGCONT'); first.child.stdin.write('append\n')
    expect(await first.next()).toMatchObject({ state: 'fenced', error: 'SessionOwnershipLostError' })
    await first.kill(); await next.kill()
  }, 15_000)
})
