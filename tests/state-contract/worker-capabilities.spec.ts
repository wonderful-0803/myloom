import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { WorkerCapabilities, WorkerToolsSchema, workerCapabilityManifest } from '../../src/state/worker-capabilities.ts'
import { taskPath, workerSandboxArgv } from '../../src/state/worker-sandbox.ts'

const run = promisify(execFile), folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'loom-worker-capabilities-'))); folders.push(root)
  const cwd = join(root, 'group', 'task'); await mkdir(cwd, { recursive: true, mode: 0o700 })
  const agent = { session: { header: { cwd } } } as never
  return { root, cwd, agent, capabilities: new WorkerCapabilities(agent, { root, readRoots: [], confined: true }) }
}
it('restores native execution, filesystem, web, skill and job tools independently of office rule names', async () => {
  const { capabilities } = await fixture()
  for (const name of ['web_search', 'web_fetch', 'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill', 'todo_write', 'skill']) expect(capabilities.allowed(name), name).toBe(true)
  expect(capabilities.allowed('plugin_install')).toBe(false)
  expect(new WorkerCapabilities({} as never, undefined).allowed('bash')).toBe(false)
  const plugin = WorkerToolsSchema.parse({ spreadsheet_analyze: { effect: 'read', description: 'Reviewed spreadsheet connector' } })
  const configured = new WorkerCapabilities({} as never, undefined, plugin)
  expect(configured.allowed('spreadsheet_analyze')).toBe(true)
  expect(configured.policy.spreadsheet_analyze).toMatchObject({ version: 1, executor: 'native', resources: [], requiresGrant: false })
  expect(workerCapabilityManifest(configured.policy).find(item => item.id === 'spreadsheet_analyze')).toMatchObject({ name: 'spreadsheet_analyze', effect: 'read', version: 1 })
  expect(() => new WorkerCapabilities({} as never, undefined, { bash: { effect: 'read', description: 'Bypass' } })).toThrow()
})
it('rejects other groups, symlink escape and privilege escalation while allowing task artifacts', async () => {
  const { root, cwd, capabilities } = await fixture(), secret = join(root, 'database-private.json')
  await writeFile(secret, 'fictional-secret'); await symlink(root, join(cwd, 'escape'))
  for (const path of [secret, '../other-group/file', 'escape/database-private.json']) await expect(taskPath(cwd, path)).rejects.toThrow()
  await expect(taskPath(cwd, 'reports/new.txt', true)).resolves.toBe(join(cwd, 'reports/new.txt'))
  const signal = new AbortController().signal
  await expect(capabilities.before({ name: 'bash', arguments: { command: 'echo ok', sandbox_permissions: 'require_escalated' }, signal })).rejects.toThrow('escalate')
  await expect(capabilities.before({ name: 'glob', arguments: { pattern: '../**' }, signal })).rejects.toThrow('Glob')
})
it('requires a connector authorization adapter for external tools and never grants them from skill text', async () => {
  const { agent } = await fixture(), plugins = WorkerToolsSchema.parse({ send_mail: { effect: 'external', description: 'Explicitly scoped mail connector' } })
  expect(new WorkerCapabilities(agent, undefined, plugins).allowed('send_mail')).toBe(false)
  expect(plugins.send_mail).toMatchObject({ executor: 'connector', requiresGrant: true })
  expect(new WorkerCapabilities(agent, undefined, plugins, { authorize: async () => {} }).allowed('send_mail')).toBe(true)
})
it.skipIf(process.platform !== 'linux')('runs real code in a private environment without host files, inherited credentials or server networking', async () => {
  const { root, cwd } = await fixture(), secret = join(root, 'other-group-secret')
  await writeFile(secret, 'fictional-other-group-data')
  const argv = await workerSandboxArgv(['bash', '-c', `test ! -e '${secret}' && test -z "$LOOM_SYNTHETIC_SECRET" && python3 -c 'import socket; assert len(socket.if_nameindex()) == 1; print(2 + 3)' > result.txt && cat result.txt`], { mode: 'workspace-write', workspaceRoot: cwd }, { root, runner: '/usr/bin/bwrap' })
  const result = await run(argv[0]!, argv.slice(1), { env: { ...process.env, LOOM_SYNTHETIC_SECRET: 'fictional-key' }, timeout: 10_000 })
  expect(result.stdout.trim()).toBe('5')
  await expect(workerSandboxArgv(['true'], { mode: 'danger-full-access', workspaceRoot: cwd }, { root, runner: '/usr/bin/bwrap' })).rejects.toThrow()
})
