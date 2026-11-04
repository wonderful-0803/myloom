'use strict'
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { Onboarding, modelInput } = require('../onboarding.cjs')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-setup-')); roots.push(root)
  const project = path.join(root, 'project')
  for (const file of ['package.json', 'scripts/personal-superagent', 'scripts/dsh-superagent', 'lib/index.js', 'lib/personal-setup.js', 'loom/dist/client/index.html']) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), file === 'package.json' ? '{"name":"dsh-superagent"}' : '')
  }
  const calls = [], requests = [], runtimeCalls = []
  const setup = new Onboarding({ directory: path.join(root, 'prefs'), dataRoot: path.join(root, 'data'), projectRoot: project,
    legacy: { backendRoot: project, serviceURL: 'http://127.0.0.1:3082' } }, {
    executable: name => '/bin/' + name, port: async () => 35001,
    run: async (program, args, commandOptions, input) => {
      calls.push({ program, args, options: commandOptions, input })
      if (args.includes('--from-default-profile')) { const profile = args[1]; const dir = path.join(commandOptions.env.DSH_HOME, 'profiles', profile); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), '{}') }
      return JSON.stringify({ appId: 'cli_test', identities: { bot: { verified: true, status: 'ready' }, user: { available: false } } })
    },
    request: async (url, requestOptions) => {
      requests.push({ url, options: requestOptions })
      if (url.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'test-access-token' }
      if (url.includes('bot/v3/info')) return { code: 0, bot: { open_id: 'ou_bot', app_name: 'Test bot' } }
      if (url.includes('/members?')) return { code: 0, data: { items: [{ member_id: 'ou_owner', name: '本人' }, { member_id: 'ou_bot', name: '机器人' }], has_more: false } }
      if (url.includes('im/v1/chats?')) return { code: 0, data: { items: [{ chat_id: 'oc_test', name: '<script>test group</script>' }], has_more: false } }
      if (url.endsWith('/chat/completions')) return { choices: [{ message: { content: 'LOOM_OK' } }] }
      if (url.includes('/orchestrator/api/loom')) {
        if (options.conflict) return { connection: { appId: 'cli_test', name: 'Existing assistant' }, tasks: [{ completed: false }] }
        throw new Error('offline')
      }
      throw new Error('unexpected request')
    },
    runtime: config => ({ probe: async () => ({ phase: options.unknown ? 'unavailable' : 'stopped' }), action: async (action, explicit) => { runtimeCalls.push({ config, action, explicit }); return { connected: true, phase: 'ready', components: [{ name: 'feishu', state: 'ready' }] } } }),
  })
  return { setup, calls, requests, runtimeCalls, root }
}
async function ready(fixture) {
  const { setup } = fixture
  await setup.action('prepare')
  await setup.action('model', { baseURL: 'https://models.example/v1', model: 'my-model', apiKey: 'test-model-secret' })
  await setup.action('bot', { appId: 'cli_test', appSecret: 'test-application-secret' })
  await setup.action('members', { chatId: 'oc_test' })
  await setup.action('scope', { owner: 'ou_owner', directMessages: true, chats: [{ chatId: 'oc_test', listen: 'all' }], mode: 'observe' })
}
test('fresh setup neither imports credentials nor probes or starts a previous assistant', () => {
  const { setup, calls, requests, runtimeCalls } = fixture()
  assert.equal(setup.view().step, 0); assert.equal(setup.view().model, null); assert.equal(setup.view().bot, null)
  assert.equal(calls.length, 0); assert.equal(requests.length, 0); assert.equal(runtimeCalls.length, 0)
})
test('an engine selected by the native picker survives reopening, including spaces, and freezes after preparation', async () => {
  const item = fixture(), chosen = path.join(item.root, 'chosen engine')
  fs.cpSync(item.setup.projectRoot, chosen, { recursive: true })
  item.setup.selectProject(chosen)
  const restored = new Onboarding({ directory: path.join(item.root, 'prefs'), dataRoot: path.join(item.root, 'data'), projectRoot: '/missing' })
  assert.equal(restored.projectRoot, fs.realpathSync(chosen)); assert.equal(restored.environment()[0].available, true)
  assert.throws(() => item.setup.selectProject(path.join(item.root, 'missing')), /构建/)
  await item.setup.action('prepare')
  assert.throws(() => item.setup.selectProject(chosen), /准备环境前/)
  assert.ok(item.calls.some(call => call.args.includes('link:' + chosen)))
})
test('prepares an independent home, verifies actual API contracts, keeps secrets out of views and argv, and starts only on reviewed consent', async () => {
  const item = fixture(); await ready(item)
  const { setup, calls, requests, runtimeCalls } = item
  assert.equal(setup.view().step, 4); assert.equal(runtimeCalls.length, 0)
  assert.ok(calls.every(call => !call.args.join(' ').includes('secret')))
  assert.ok(!JSON.stringify(setup.view()).includes('test-model-secret'))
  assert.ok(!JSON.stringify(setup.view()).includes('test-application-secret'))
  for (const file of ['dsh/.credentials.yaml', 'lark/app-secret', 'lark/config.json']) assert.equal(fs.statSync(path.join(setup.root, file)).mode & 0o777, 0o600)
  const config = JSON.parse(fs.readFileSync(path.join(setup.root, 'lark/config.json')))
  assert.equal(config.strictMode, 'bot'); assert.deepEqual(config.apps[0].users, []); assert.equal(config.apps[0].appSecret.source, 'file')
  assert.ok(calls[0].options.env.DSH_HOME.startsWith(setup.root))
  await assert.rejects(setup.action('start', { consent: false }), /确认/)
  assert.equal(runtimeCalls.length, 0)
  await setup.action('start', { consent: true })
  assert.equal(setup.active, false); assert.equal(runtimeCalls.length, 1)
  assert.match(runtimeCalls[0].config.profile, /^loom-[a-f0-9]{12}$/)
  const initial = JSON.parse(calls.find(call => call.args[0]?.endsWith('initialize-desktop-assistant.cjs')).input)
  assert.equal(initial.owner, 'ou_owner'); assert.equal(initial.mode, 'observe'); assert.equal(initial.chats[0].chatId, 'oc_test')
  assert.ok(requests.filter(call => call.url.endsWith('/chat/completions')).every(call => !call.options.body.includes('ou_owner')))
})
test('refuses an active or unverifiable original listener without stopping it, writing state, or launching a second worker', async () => {
  for (const options of [{ conflict: true }, { unknown: true }]) {
    const item = fixture(options); await ready(item)
    await assert.rejects(item.setup.action('start', { consent: true }), /原助手|已有助手/)
    assert.equal(item.runtimeCalls.length, 0)
    assert.ok(!item.calls.some(call => call.args[0]?.includes('initialize-desktop-assistant')))
  }
})
test('rejects scope expansion, bot identities as owner, duplicates, unknown chat IDs and unsafe model URLs', async () => {
  const item = fixture(); await ready(item)
  const base = { owner: 'ou_owner', directMessages: true, chats: [], mode: 'observe' }
  for (const changed of [{ owner: 'ou_bot' }, { chats: [{ chatId: 'oc_foreign', listen: 'all' }] }, { chats: [{ chatId: 'oc_test', listen: 'all' }, { chatId: 'oc_test', listen: 'all' }] }, { directMessages: false }, { mode: 'anything' }])
    await assert.rejects(item.setup.action('scope', { ...base, ...changed }))
  await assert.rejects(item.setup.action('members', { chatId: 'oc_foreign' }))
  for (const url of ['file:///etc/passwd', 'http://example.com', 'https://u:p@example.com', 'https://example.com?key=secret', 'javascript:alert(1)']) assert.throws(() => modelInput({ baseURL: url, model: 'test' }))
})
test('reloads only its own saved metadata and blocks concurrent configuration operations', async () => {
  const item = fixture(); await ready(item)
  const restored = new Onboarding({ directory: path.join(item.root, 'prefs'), dataRoot: path.join(item.root, 'data'), projectRoot: item.setup.projectRoot })
  assert.equal(restored.view().step, 4); assert.equal(restored.config.bot.appId, 'cli_test')
  item.setup.busy = true
  await assert.rejects(item.setup.action('start', { consent: true }), /上一步/)
  assert.equal(item.runtimeCalls.length, 0)
})
