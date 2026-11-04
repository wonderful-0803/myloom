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
const execute = promisify(execFile), projectRoot = path.resolve(__dirname, '../..')
async function main() {
  const directory = fs.mkdtempSync(path.join(projectRoot, '.artifacts/desktop-real-setup-'))
  fs.chmodSync(directory, 0o700)
  const api = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'LOOM_OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })) })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const fakeCLI = path.join(directory, 'fixture-lark-cli')
  write(fakeCLI, '#!/usr/bin/env python3\nimport json,sys,time\na=sys.argv[1:]\n'
    + 'if a[:2]==["auth","status"]: print(json.dumps({"appId":"cli_loomacceptance","brand":"feishu","identities":{"bot":{"status":"ready","verified":True},"user":{"available":False}}}))\n'
    + 'elif a[:2]==["config","strict-mode"]: print("strict-mode: bot")\n'
    + 'elif a[:2]==["event","consume"]:\n print("[event] ready fixture-only",file=sys.stderr,flush=True)\n for line in sys.stdin: pass\n'
    + 'elif "/open-apis/bot/v3/info" in a: print(json.dumps({"code":0,"bot":{"open_id":"ou_fixturebot","app_name":"Acceptance fixture"}}))\n'
    + 'else: print(json.dumps({"ok":True,"identity":"bot","data":{"items":[],"chats":[],"has_more":False}}))\n')
  fs.chmodSync(fakeCLI, 0o700)
  const setup = new Onboarding({ directory: path.join(directory, 'preferences'), dataRoot: path.join(directory, 'data'), projectRoot }, {
    executable: name => name === 'lark-cli' ? fakeCLI : executable(name),
    request: async (url, options) => {
      if (url.includes('open.feishu.cn/open-apis/auth/')) return { code: 0, tenant_access_token: 'fixture-access-token' }
      if (url.includes('open.feishu.cn/open-apis/bot/')) return { code: 0, bot: { open_id: 'ou_fixturebot', app_name: 'Acceptance fixture' } }
      if (url.includes('open.feishu.cn/open-apis/im/')) return { code: 0, data: { items: [], has_more: false } }
      if (url.startsWith('http://127.0.0.1:')) return responseJSON(url, options)
      throw new Error('External network forbidden in runtime acceptance')
    },
  })
  setup.changed = () => process.stdout.write(setup.message + '\n')
  try {
    await setup.action('prepare')
    await setup.action('model', { baseURL: `http://127.0.0.1:${api.address().port}/v1`, model: 'fixture-model', apiKey: 'fixture-model-key' })
    await setup.action('bot', { appId: 'cli_loomacceptance', appSecret: 'fixture-application-secret' })
    await setup.action('scope', { owner: 'ou_fixtureowner', directMessages: true, mode: 'observe', chats: [] })
    await setup.action('start', { consent: true })
    const runtime = new RuntimeLink(setup.connection()); const state = await runtime.probe()
    assert.equal(state.connected, true); assert.equal(state.tasks, 0); assert.equal(state.artifacts, 0)
    assert.equal(state.model, 'loom/fixture-model')
    const snapshot = await responseJSON(setup.config.serviceURL + '/orchestrator/api/loom', { headers: { 'x-orchestrator-request': '1' } })
    assert.equal(snapshot.connection.appId, 'cli_loomacceptance')
    write(path.join(directory, 'acceptance.json'), JSON.stringify({ actualHarnessStarted: true, actualSettingsInitialized: true,
      actualLoomConnected: true, zeroTasksAndArtifacts: true, externalAPIs: 'fixtures; not live Feishu or paid model acceptance', connection: setup.connection(), model: state.model }, null, 2))
    process.stdout.write('Real Harness onboarding acceptance passed: ' + directory + '\n')
  } finally {
    // Stop only this unique test profile, even when setup failed before Loom became connected.
    try { await execute(path.join(projectRoot, 'scripts/personal-superagent'), ['stop', '--profile', setup.profile, '--url', setup.config.serviceURL, '--stop-timeout', '15'], { env: setup.env(), timeout: 20000 }) } catch {}
    await new Promise(resolve => api.close(resolve))
  }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
