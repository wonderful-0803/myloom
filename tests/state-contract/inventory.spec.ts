import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../../src/app/store.ts'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('inventories a frozen legacy database without values, raw keys, credentials or writes to the source', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'loom-inventory-')); folders.push(folder)
  const source = join(folder, 'legacy.sqlite'), out = join(folder, 'inventory.json'), store = new Store(source)
  store.set('unknown-secret-key', 'PRIVATE_TEST_CREDENTIAL_SENTINEL')
  store.set('task-control:private-task-id', { mode: 'paused', revision: 1 })
  store.close()
  const hash = async () => createHash('sha256').update(await readFile(source)).digest('hex'), before = await hash()
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/state-inventory.mjs', '--source', source, '--out', out], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const text = await readFile(out, 'utf8'), report = JSON.parse(text)
  expect(report.mode).toBe('read-only'); expect(report.migrationReady).toBe(false)
  expect(report.kv['controls.task'].count).toBe(1); expect(report.unmappedKeys).toBe(1)
  expect(text).not.toContain('PRIVATE_TEST_CREDENTIAL_SENTINEL'); expect(text).not.toContain('private-task-id'); expect(text).not.toContain('unknown-secret-key')
  expect(await hash()).toBe(before); expect((await stat(out)).mode & 0o777).toBe(0o600)
  const apply = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/state-inventory.mjs', '--source', source, '--apply', out], { encoding: 'utf8' })
  expect(apply.status).toBe(1); expect(await hash()).toBe(before)
})
