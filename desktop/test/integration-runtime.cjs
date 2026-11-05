'use strict'
// Opt-in real Harness boot/stop; Feishu and model HTTP use fixtures, no credentials are imported.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const assert = require('node:assert/strict')
const { Onboarding, responseJSON, write } = require('../onboarding.cjs')
const { RuntimeLink, executable } = require('../runtime.cjs')
const nativeCommands = require('../commands.cjs')
const { NativeWindowsControl } = require('../native-windows.cjs')
const { commandEnvironment } = require('../platform.cjs')
process.env.PATH = commandEnvironment().PATH
process.env.DSH_TELEMETRY_DISABLED = '1'
const execute = promisify(execFile), projectRoot = path.resolve(__dirname, '../..')
async function main() {
  const directory = fs.mkdtempSync(path.join(projectRoot, '.artifacts/desktop-real-setup-'))
  fs.chmodSync(directory, 0o700)
  const api = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'LOOM_OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })) })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const fakeCLI = path.join(directory, process.platform === 'win32' ? 'fixture-lark-cli.cjs' : 'fixture-lark-cli')
  if (process.platform === 'win32') write(fakeCLI, `const a=process.argv.slice(2);\nif(a[0]==='auth'&&a[1]==='status') console.log(JSON.stringify({appId:'cli_loomacceptance',brand:'feishu',identities:{bot:{status:'ready',verified:true},user:{available:false}}}));\nelse if(a[0]==='config'&&a[1]==='strict-mode') console.log('strict-mode: bot');\nelse if(a[0]==='event'&&a[1]==='consume'){console.error('[event] ready fixture-only');process.stdin.resume();}\nelse if(a.includes('/open-apis/bot/v3/info')) console.log(JSON.stringify({code:0,bot:{open_id:'ou_fixturebot',app_name:'Acceptance fixture'}}));\nelse console.log(JSON.stringify({ok:true,identity:'bot',data:{items:[],chats:[],has_more:false}}));\n`)
  else write(fakeCLI, '#!/usr/bin/env python3\nimport json,sys,time\na=sys.argv[1:]\n'
    + 'if a[:2]==["auth","status"]: print(json.dumps({"appId":"cli_loomacceptance","brand":"feishu","identities":{"bot":{"status":"ready","verified":True},"user":{"available":False}}}))\n'
    + 'elif a[:2]==["config","strict-mode"]: print("strict-mode: bot")\n'
    + 'elif a[:2]==["event","consume"]:\n print("[event] ready fixture-only",file=sys.stderr,flush=True)\n for line in sys.stdin: pass\n'
    + 'elif "/open-apis/bot/v3/info" in a: print(json.dumps({"code":0,"bot":{"open_id":"ou_fixturebot","app_name":"Acceptance fixture"}}))\n'
    + 'else: print(json.dumps({"ok":True,"identity":"bot","data":{"items":[],"chats":[],"has_more":False}}))\n')
  fs.chmodSync(fakeCLI, 0o700)
  const setup = new Onboarding({ directory: path.join(directory, 'preferences'), dataRoot: path.join(directory, 'data'), projectRoot }, {
    executable: name => name === 'lark-cli' ? fakeCLI : process.platform === 'win32' ? nativeCommands.executable(name, process.env, projectRoot) : executable(name),
    request: async (url, options) => {
      if (url.includes('open.feishu.cn/open-apis/auth/')) return { code: 0, tenant_access_token: 'fixture-access-token' }
      if (url.includes('open.feishu.cn/open-apis/bot/')) return { code: 0, bot: { open_id: 'ou_fixturebot', app_name: 'Acceptance fixture' } }
      if (url.includes('open.feishu.cn/open-apis/im/')) return { code: 0, data: { items: [], has_more: false } }
      if (url.startsWith('http://127.0.0.1:')) return responseJSON(url, options)
      throw new Error('External network forbidden in runtime acceptance')
    },
  })
  setup.changed = () => process.stdout.write(setup.message + '\n')
  let acceptance
  try {
    await setup.action('prepare')
    await setup.action('model', { baseURL: `http://127.0.0.1:${api.address().port}/v1`, model: 'fixture-model', apiKey: 'fixture-model-key' })
    await setup.action('bot', { appId: 'cli_loomacceptance', appSecret: 'fixture-application-secret' })
    await setup.action('scope', { owner: 'ou_fixtureowner', directMessages: true, mode: 'observe', chats: [] })
    if (process.env.LOOM_TEST_FAILED_START_EDIT === '1') {
      const factory = setup.runtimeFactory; let first = true
      setup.runtimeFactory = config => {
        const value = factory(config), action = value.action.bind(value)
        value.action = async (name, explicit) => {
          const state = await action(name, explicit)
          // Inject only the readiness failure; the Harness itself really boots and really stops.
          if (name === 'start' && first) { first = false; return { ...state, components: [{ name: 'feishu', state: 'error' }] } }
          return state
        }
        return value
      }
      await assert.rejects(setup.action('start', { consent: true }), /飞书消息长连接尚未就绪/)
      assert.equal(setup.config.frozen, true); assert.equal(setup.active, true)
      await setup.action('edit')
      assert.equal(setup.view().frozen, false)
      await setup.action('scope', { owner: 'ou_fixtureowner', directMessages: true, mode: 'auto', chats: [] })
    }
    await setup.action('start', { consent: true })
    const runtime = new RuntimeLink(setup.connection()); const state = await runtime.probe()
    assert.equal(state.connected, true); assert.equal(state.tasks, 0); assert.equal(state.artifacts, 0)
    assert.equal(state.model, 'loom/fixture-model')
    const snapshot = await responseJSON(setup.config.serviceURL + '/orchestrator/api/loom', { headers: { 'x-orchestrator-request': '1' } })
    assert.equal(snapshot.connection.appId, 'cli_loomacceptance')
    acceptance = { nativeWindows: process.platform === 'win32', actualHarnessStarted: true, actualSettingsInitialized: true,
      actualLoomConnected: true, zeroTasksAndArtifacts: true, failedStartEditRetried: process.env.LOOM_TEST_FAILED_START_EDIT === '1', externalAPIs: 'fixtures; not live Feishu or paid model acceptance', connection: setup.connection(), model: state.model }
  } finally {
    // Stop only this unique test profile, even when setup failed before Loom became connected.
    let stopError
    try {
      if (process.platform === 'win32' && setup.config.serviceURL) {
        const control = new NativeWindowsControl(setup.connection(), { timeout: 15000 })
        await control.invoke('stop', true)
        const stopped = await control.status()
        assert.deepEqual(stopped.pids, []); assert.equal(stopped.manually_stopped, true)
        if (acceptance) acceptance.actualHarnessStopped = true
      }
      else if (process.platform !== 'win32') await execute(path.join(projectRoot, 'scripts/personal-superagent'), ['stop', '--profile', setup.profile, '--url', setup.config.serviceURL, '--stop-timeout', '15'], { env: setup.env(), timeout: 20000 })
    } catch (error) { stopError = error }
    await new Promise(resolve => api.close(resolve))
    if (stopError) throw stopError
    if (acceptance) {
      write(path.join(directory, 'acceptance.json'), JSON.stringify(acceptance, null, 2))
      process.stdout.write('Real Harness onboarding acceptance passed: ' + directory + '\n')
    }
  }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
