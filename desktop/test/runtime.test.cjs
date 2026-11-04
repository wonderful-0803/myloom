'use strict'
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { RuntimeLink, installation } = require('../runtime.cjs')
const policy = require('../policy.cjs')
const directories = []
afterEach(() => { for (const folder of directories.splice(0)) fs.rmSync(folder, { recursive: true, force: true }) })
function fixture(initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-desktop-')); directories.push(root)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh-superagent' }))
  for (const name of ['scripts/personal-superagent', 'scripts/dsh-superagent', 'lib/index.js', 'loom/dist/client/index.html']) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), '')
  }
  const calls = [], status = { pids: [123], cwd: root, url: 'http://127.0.0.1:3082', manually_stopped: false, health: { runtime: 'ready', feishu: 'ready', evals: 'error' }, setup: null, ...initial }
  const snapshot = { paused: false, model: 'dashscope/qwen3.8-flash', tasks: [{ id: 't1', title: '总结', status: 'open', completed: false }], artifacts: [{ subject: 'a1' }], connection: { appId: 'cli_test', name: '个人助手' } }
  const runtime = new RuntimeLink({ backendRoot: root }, { executable: () => '/fake/binary', request: async () => snapshot,
    run: async (program, args, options) => {
      calls.push({ program, args, options })
      if (args[0] === 'start') { status.pids = [123]; status.manually_stopped = false }
      if (args[0] === 'stop') { status.pids = []; status.manually_stopped = true }
      return { code: 0, stdout: JSON.stringify(status) }
    } })
  return { root, runtime, status, snapshot, calls }
}
test('reuses the existing service and sanitizes the desktop status without copying any credentials or artifact bodies', async () => {
  const { runtime, calls, status } = fixture()
  status.errors = { evals: 'private-provider-error' }
  const state = await runtime.probe()
  assert.equal(state.connected, true); assert.equal(state.model, 'dashscope/qwen3.8-flash'); assert.equal(state.tasks, 1)
  assert.ok(!JSON.stringify(state).includes('private-provider-error'))
  await runtime.action('start', true)
  assert.equal(calls.filter(call => call.args[0] === 'start').length, 0)
  assert.ok(calls.every(call => !call.options.shell))
})
test('starts only one stopped personal service and preserves the explicit-stop marker on automatic recovery', async () => {
  const { runtime, calls } = fixture({ pids: [], manually_stopped: true })
  await runtime.action('start')
  assert.equal(calls.filter(call => call.args[0] === 'start').length, 0)
  await Promise.all([runtime.action('start', true), runtime.action('start', true)])
  assert.equal(calls.filter(call => call.args[0] === 'start').length, 1)
  assert.equal(runtime.state.connected, true)
})
test('uses respect-stop for automatic starts, and stops only after an explicit caller action', async () => {
  const { runtime, calls } = fixture({ pids: [] })
  await runtime.action('start')
  assert.ok(calls.find(call => call.args[0] === 'start').args.includes('--respect-stop'))
  await runtime.probe()
  await runtime.action('stop')
  assert.equal(calls.filter(call => call.args[0] === 'stop').length, 0)
  await runtime.action('stop', true)
  assert.equal(runtime.state.phase, 'stopped'); assert.equal(runtime.state.intentionallyStopped, true)
})
test('refuses duplicate processes, a mismatched repository and an unavailable running workspace without starting another service', async () => {
  for (const change of [{ pids: [123, 456] }, { cwd: '/different-repository' }, { setup: { detail: 'private setup details' } }]) {
    const { runtime, calls } = fixture(change)
    await runtime.action('start', true)
    assert.equal(calls.filter(call => call.args[0] === 'start').length, 0)
    assert.equal(runtime.state.connected, false)
    assert.ok(!JSON.stringify(runtime.state).includes('private setup details'))
  }
  const { runtime, calls } = fixture()
  runtime.request = async () => { throw new Error('secret') }
  await runtime.action('start', true)
  assert.equal(runtime.state.phase, 'unavailable'); assert.equal(calls.filter(call => call.args[0] === 'start').length, 0)
})
test('reports missing dependencies and build outputs before attempting to execute anything', async () => {
  const { root, runtime, calls } = fixture()
  fs.rmSync(path.join(root, 'lib/index.js'))
  assert.equal(installation(root).valid, false)
  runtime.find = () => undefined
  await runtime.action('start', true)
  assert.equal(runtime.state.phase, 'missing'); assert.equal(calls.length, 0)
  assert.ok(runtime.state.missing.some(message => message.includes('dsh')))
})
test('joins concurrent status checks and reports malformed control output safely', async () => {
  const { runtime, calls } = fixture()
  await Promise.all([runtime.probe(), runtime.probe(), runtime.probe()])
  assert.equal(calls.length, 1)
  runtime.run = async () => ({ code: 1, stdout: 'credential-bearing stderr is not displayed' })
  assert.equal((await runtime.probe()).phase, 'unavailable')
  assert.ok(!JSON.stringify(runtime.state).includes('credential-bearing'))
})
test('restricts service targets, workspace navigation, IPC shell URLs and file downloads', () => {
  const base = 'http://127.0.0.1:3082'
  for (const invalid of ['https://example.com', 'http://localhost:3082', 'http://127.0.0.1:3082/other', 'http://u:p@127.0.0.1:3082', 'http://127.0.0.1:3082?x=1']) assert.throws(() => policy.serviceURL(invalid))
  assert.ok(policy.workspaceNavigation(policy.workspaceURL(base, 'tasks'), base))
  for (const invalid of [base + '/', base + '/orchestrator/loom/?token=1', 'file:///etc/passwd', 'https://example.com']) assert.equal(policy.workspaceNavigation(invalid, base), false)
  assert.ok(policy.workspaceRequest(base + '/orchestrator/api/loom/tasks/t1/progress', base))
  assert.equal(policy.workspaceRequest(base + '/orchestrator/api/settings', base), false)
  assert.equal(policy.workspaceRequest('https://example.com/pixel', base), false)
  assert.ok(policy.workspaceRequest('blob:' + base + '/file', base))
  assert.equal(policy.workspaceRequest('blob:https://evil.example/file', base), false)
  assert.ok(policy.localShell('file:///opt/loom/ui/index.html', '/opt/loom/ui/index.html'))
  assert.equal(policy.localShell('file:///opt/loom/ui/index.html?code=1', '/opt/loom/ui/index.html'), false)
  assert.ok(!policy.downloadName('../.hidden\nreport.txt').includes('/'))
})
test('denies unsafe external links and only notifies on fresh meaningful task transitions', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com', 'https://127.0.0.1', 'https://u:p@example.com', 'https://box.local']) assert.equal(policy.externalLink(url), false)
  assert.ok(policy.externalLink('https://github.com/deepseek-ai/dsh-superagent-prototype'))
  const before = { tasks: [{ id: '1', title: '总结', completed: false, status: 'open' }] }
  const after = { tasks: [{ id: '1', title: '总结', completed: true, status: 'ended' }] }
  assert.deepEqual(policy.notificationChanges(undefined, after), [])
  assert.equal(policy.notificationChanges(before, after).length, 1)
  assert.deepEqual(policy.notificationChanges(after, after), [])
  assert.equal(policy.notificationChanges(before, { tasks: [{ ...before.tasks[0], status: 'blocked' }] })[0].page, 'tasks')
})
