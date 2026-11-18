import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { PostgresStateStore, SqliteStateStore } from '../../src/state/index.ts'
import type { StateStore } from '../../src/state/index.ts'

const url = process.env.LOOM_STATE_TEST_DATABASE_URL
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Crash tests require a disposable _test database')
const folders: string[] = [], stores: StateStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
for (const kind of ['sqlite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !url ? describe.skip : describe
  suite(`process-crash recovery: ${kind}`, () => {
    for (const phase of ['before', 'after', 'claimed'] as const) it(`SIGKILL at ${phase} checkpoint, then recover from an empty new process`, async () => {
      const folder = await mkdtemp(join(tmpdir(), 'loom-state-crash-')); folders.push(folder)
      const path = join(folder, 'state.sqlite'), tenantId = `test-${randomUUID()}`
      const child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./fixtures/crash.ts', import.meta.url)), JSON.stringify({ kind, phase, path, tenantId })],
        { env: { PATH: process.env.PATH, ...(kind === 'postgres' ? { LOOM_STATE_TEST_DATABASE_URL: url } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
      const exit = new Promise<void>(done => { child.once('exit', () => done()) })
      try {
        await new Promise<void>((done, reject) => {
          const timeout = setTimeout(() => reject(new Error('Isolated crash fixture did not reach checkpoint')), 5000)
          let output = ''
          child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('READY\n')) { clearTimeout(timeout); done() } })
          child.once('error', () => { clearTimeout(timeout); reject(new Error('Cannot start isolated crash fixture')) })
          child.once('exit', code => { clearTimeout(timeout); if (!output.includes('READY\n')) reject(new Error(`Crash fixture exited before checkpoint (${code})`)) })
        })
        child.kill('SIGKILL'); await exit
        if (phase === 'claimed') await delay(350)
        const store = kind === 'postgres' ? await PostgresStateStore.open({ connectionString: url }) : await SqliteStateStore.open(path)
        stores.push(store)
        await store.transaction({ tenantId, spaceId: 'crash' }, async tx => {
          expect(!!await tx.get('ticket', 'task')).toBe(phase !== 'before')
          const job = await tx.jobs.claim('replacement', 10_000, ['launch'], { name: 'workers', limit: 1 })
          expect(!!job).toBe(phase !== 'before')
          if (job) {
            expect(job.key).toBe('task'); expect(job.sequence).toBe(1); expect(job.attempts).toBe(phase === 'claimed' ? 2 : 1)
            expect(await tx.jobs.complete(job)).toBe(true)
          }
          expect(await tx.jobs.claim('second', 10_000, ['launch'])).toBeUndefined()
        })
      } finally { child.kill('SIGKILL'); await exit }
    }, 10_000)
  })
}
