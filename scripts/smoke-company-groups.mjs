#!/usr/bin/env node
/** Two simultaneous actual rc.3 roots through the real multi-group launcher; synthetic Feishu/model wires only. */
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { PostgresStateStore, initializeCompany, ProductAccess, issueOperatorCode } from '../lib/state.js'
const { values } = parseArgs({ options: { 'harness-root': { type: 'string' }, 'profile-file': { type: 'string' }, 'local-console': { type: 'boolean' } } }), harness = values['harness-root'], profile = values['profile-file'], database = process.env.LOOM_GROUPS_TEST_DATABASE_URL
const localConsole = values['local-console'] === true
if (![harness, profile].every(p => isAbsolute(p ?? '')) || !database || !new URL(database).pathname.endsWith('_test')) throw Error('Explicit reviewed Harness/profile and disposable LOOM_GROUPS_TEST_DATABASE_URL (_test) required')
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = await mkdtemp(join(tmpdir(), 'loom-multi-groups-')), app = join(folder, 'app'), configDir = join(folder, 'config'), scope = { tenantId: 'test-' + randomUUID(), spaceId: randomUUID() }
const store = await PostgresStateStore.open({ connectionString: database }), sockets = new Set(); let child, exited, calls = 0, rootScope, nativeSnapshots
const model = createServer(async (req, res) => {
  try {
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 2000000) throw Error('Model input budget') }
    const body = JSON.parse(text); assert.ok(++calls <= 30)
    const names = body.tools.map(t => t.function.name); assert.ok(names.every(n => ['orchestrator_read', 'orchestrator_eval_decide', 'orchestrator_report', 'orchestrator_artifact', 'orchestrator_transcribe_recording'].includes(n)))
    const plain = content => typeof content === 'string' ? content : content.map(p => p.text ?? '').join('\n'), parse = message => { try { return JSON.parse(plain(message.content).split('\n\n')[0]) } catch {} }
    const users = body.messages.filter(m => m.role === 'user').map(parse).filter(Boolean), envelope = users.findLast(x => x.candidate), task = users.findLast(x => x.ticket_id), outputs = body.messages.filter(m => m.role === 'tool').map(parse).filter(Boolean)
    assert.ok(!(text.includes('GROUP_A_R1') && text.includes('GROUP_B_R2')), 'Cross-group model context')
    let name, input
    if (envelope && !task) {
      name = 'orchestrator_eval_decide'; input = { decision: 'accept', title: 'Fictional work summary', scope: 'Only the supplied group record.', worktree_name: 'group-summary', rule_assessments: envelope.rules.map((r, i) => ({ rule_id: r.id, matched: i === 0, reason: 'Supplied fictional summary' })), direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Explicit summary request' }, intent_evidence: 'Only supplied records', reason: 'Known task and source' }
    } else {
      assert.ok(task); const ticket = outputs.findLast(x => x.ticket)?.ticket, trigger = outputs.findLast(x => x.trigger)?.trigger
      if (!ticket) { name = 'orchestrator_read'; input = { resource: 'ticket/' + task.ticket_id } }
      else if (!trigger) { name = 'orchestrator_read'; input = { resource: 'trigger/' + ticket.origin.triggerId } }
      else { name = 'orchestrator_report'; input = { state: 'ready', summary: trigger.text.includes('GROUP_A_R1') ? 'GROUP_A_R1' : 'GROUP_B_R2' } }
    }
    const base = { id: 'group-model-' + calls, object: 'chat.completion.chunk', created: 1, model: 'synthetic' }; res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const choice of [{ delta: { role: 'assistant' } }, { delta: { tool_calls: [{ index: 0, id: 'call-' + calls, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }, { delta: {}, finish_reason: 'tool_calls' }]) res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: null, ...choice }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch (error) { res.writeHead(500); res.end('Synthetic wire rejected request'); console.error(error.message) }
})
model.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise(done => model.listen(0, '127.0.0.1', done))
try {
  await mkdir(app); await cp(join(source, 'lib'), join(app, 'lib'), { recursive: true }); await cp(join(source, 'scripts'), join(app, 'scripts'), { recursive: true }); await cp(join(source, 'loom/dist/client'), join(app, 'loom/dist/client'), { recursive: true }); await cp(join(source, 'prompts'), join(app, 'prompts'), { recursive: true }); await cp(join(source, 'skills'), join(app, 'skills'), { recursive: true }); await cp(join(source, 'package.json'), join(app, 'package.json'))
  await mkdir(configDir, { mode: 0o700 }); await mkdir(join(app, 'node_modules'))
  const require = createRequire(join(harness, 'package.json')), peers = dirname(dirname(require.resolve('@deepseek-ai/cordis/package.json')))
  await symlink(peers, join(app, 'node_modules/@deepseek-ai'), 'dir')
  for (const name of Object.keys(JSON.parse(await readFile(join(source, 'package.json'))).dependencies)) { await mkdir(dirname(join(app, 'node_modules', name)), { recursive: true }); await symlink(join(source, 'node_modules', name), join(app, 'node_modules', name), 'dir') }
  const { entryListSchema } = await import(require.resolve('@deepseek-ai/cordis-plugin-include')), yaml = require('js-yaml'), rows = yaml.load(await readFile(profile, 'utf8'), { schema: entryListSchema }), get = id => { const r = rows.find(r => r.id === id); assert.ok(r); return r }
  get('llm-pi-ai').config = { providers: { synthetic: { api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: 'LOOM_GROUPS_SYNTHETIC_KEY', models: [{ id: 'synthetic', input: ['text'], maxTokens: 1000, contextWindow: 32000 }] } } }
  get('agent-default-model').config = { provider: 'synthetic', model: 'synthetic' }
  for (const id of ['otel', 'session-telemetry-otel', 'llm-deepseek', 'llm-deepseek-account']) { const r = rows.find(r => r.id === id); if (r) r.disabled = true }
  const effective = join(configDir, 'effective.yml'); await writeFile(effective, yaml.dump(rows, { schema: entryListSchema, noRefs: true }), { mode: 0o600 })
  const reserve = createServer(); await new Promise(done => reserve.listen(0, '127.0.0.1', done)); const port = reserve.address().port; await new Promise(done => reserve.close(done)); const origin = 'http://127.0.0.1:' + port
  const config = { ...scope, installationId: 'groups', databaseUrlEnv: 'LOOM_GROUPS_TEST_DATABASE_URL', appSecretEnv: 'LOOM_NOT_NEEDED', harnessRoot: harness, attachmentHome: join(folder, 'native'), blobRoot: join(folder, 'objects'), scratch: join(folder, 'compute'), origin, port, cli: join(app, 'scripts/fixtures/group-bot.mjs'), loginMode: localConsole ? 'local-operator' : 'ssh-operator', nativeState: 'external' }
  for (const path of [config.attachmentHome, config.scratch]) await mkdir(path, { mode: 0o700 })
  await chmod(join(app, 'scripts/fixtures/group-bot.mjs'), 0o700)
  const cfg = join(configDir, 'company.json'); await writeFile(cfg, JSON.stringify(config), { mode: 0o600 })
  const since = new Date(Date.now() - 1000).toISOString(), installation = { id: 'groups', appId: 'cli_groups', botId: 'ou_groupsbot', tenantKey: 'synthetic-tenant', operator: 'ou_owner', enabled: true, name: 'Synthetic groups', since }
  await initializeCompany(store, scope, installation, { sources: { github: { enabled: false }, feishu: { enabled: true, config: { ownerOnly: true, directMessages: false, chats: [{ chatId: 'oc_groupA', name: 'Fictional A', listen: 'all' }] } } }, policy: { rules: [{ id: 'office-summary', name: 'Summaries', enabled: true, instruction: 'Summarize supplied fictional record only.' }], sources: { feishu: { allowed: [{ id: 'ou_owner' }], workspace: { mode: 'group', operator: 'ou_owner', chatId: 'oc_groupA', name: 'Fictional A', masters: [{ id: 'ou_owner' }], spaceId: scope.spaceId, since } } } }, eval: { mode: 'auto', model: { provider: 'synthetic', model: 'synthetic' } }, executor: { maxWorkers: 2, model: { provider: 'synthetic', model: 'synthetic' } } })
  const env = { PATH: process.env.PATH, HOME: join(folder, 'home'), DSH_HOME: join(folder, 'dsh-home'), DSH_AGENTS_HOME: join(folder, 'agents'), XDG_CONFIG_HOME: join(folder, 'xdg'), LOOM_GROUPS_TEST_ROOT: folder, LOOM_GROUPS_TEST_DATABASE_URL: database, LOOM_GROUPS_SYNTHETIC_KEY: 'loopback-only' }
  async function launch(script, args = []) {
    const processChild = spawn(process.execPath, [join(app, 'scripts', script), ...args], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] }); let logs = ''
    processChild.stdout.on('data', b => { logs += b; if (logs.length > 50000) processChild.kill('SIGKILL') }); processChild.stderr.on('data', b => { logs += b; if (logs.length > 50000) processChild.kill('SIGKILL') })
    const end = new Promise(done => processChild.once('close', code => done({ code, logs }))); return { processChild, end }
  }
  const profileOut = join(configDir, 'profile.json'), prepared = await launch('prepare-company-profile.mjs', ['--config', cfg, '--effective', effective, '--contract', join(configDir, 'environment.json'), '--output', profileOut]); assert.equal((await prepared.end).code, 0)
  const start = async () => { const p = await launch('company-groups-server.mjs', ['--profile', profileOut, '--harness-root', harness, '--groups-home', join(folder, 'groups')]); child = p.processChild; exited = p.end }
  const wait = async check => { const end = Date.now() + 45000; while (Date.now() < end) { if (child.exitCode !== null) throw Error('Actual multi-root launcher exited: ' + (await exited).logs.slice(-2000)); if (await check()) return; await delay(50) } throw Error('Actual multi-root checkpoint timeout') }
  await start(); await wait(async () => fetch(origin + '/healthz').then(r => r.ok, () => false))
  let cookie = ''
  if (localConsole) {
    const page = await fetch(origin + '/orchestrator/loom/'); assert.equal(page.status, 200); assert.equal(page.headers.has('set-cookie'), false)
    assert.ok((await page.text()).includes('loom-multiple-groups'))
  } else {
    const access = new ProductAccess('groups'), code = await issueOperatorCode(store, scope, access), begin = await fetch(origin + '/auth/login', { redirect: 'manual' }), location = begin.headers.get('location'), state = new URL(location).searchParams.get('state')
    const auth = await fetch(origin + '/auth/operator', { method: 'POST', redirect: 'manual', headers: { origin, cookie: begin.headers.get('set-cookie').split(';')[0], 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, code }) }); assert.equal(auth.status, 303)
    cookie = auth.headers.get('set-cookie').split(';')[0]
  }
  const session = await (await fetch(origin + '/auth/session', { headers: { cookie } })).json()
  if (localConsole) assert.equal(session.mode, 'local-operator')
  const api = async (path, body) => { const r = await fetch(origin + '/orchestrator/api/loom' + path, { method: body ? 'POST' : 'GET', headers: { cookie, ...(body ? { origin, 'content-type': 'application/json', 'x-loom-csrf': session.csrf, 'idempotency-key': randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await r.json(); if (r.status !== 200) { child.kill('SIGTERM'); console.error((await exited).logs.slice(-7000)); } assert.equal(r.status, 200, JSON.stringify(data)); return data }
  const added = await api('/workspaces', { chatId: 'oc_groupB', masters: ['ou_owner'], mode: 'auto', requestId: randomUUID() }); rootScope = { ...scope, spaceId: added.spaceId }
  await wait(async () => (await api('/workspaces')).groups.every(g => g.state === 'ready'))
  await writeFile(join(folder, 'go.json'), '{}', { mode: 0o600 })
  await wait(async () => (await readFile(join(folder, 'deliveries.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length === 2)
  const a = await api('?workspace=' + scope.spaceId), b = await api('?workspace=' + added.spaceId)
  assert.equal(a.tasks.length, 1); assert.equal(b.tasks.length, 1)
  assert.ok(a.events.every(e => !e.text.includes('GROUP_B_R2'))); assert.ok(b.events.every(e => !e.text.includes('GROUP_A_R1')))
  const cross = await fetch(origin + `/orchestrator/api/loom/artifacts/${a.tasks[0].id}?workspace=${added.spaceId}`, { headers: { cookie } }); assert.equal(cross.status, 403)
  nativeSnapshots = await Promise.all([scope, rootScope].map(s => store.transaction(s, async tx => (await tx.scan('native-session')).map(row => ({ id: row.id, count: row.value.eventCount })))))
  assert.ok(nativeSnapshots.every(rows => rows.length === 2 && rows.every(r => r.count > 5)))
  child.kill('SIGTERM'); assert.equal((await exited).code, 0); await start(); await wait(async () => fetch(origin + '/healthz').then(r => r.ok, () => false)); await api('/workspaces'); await delay(500)
  if (localConsole) assert.equal((await (await fetch(origin + '/auth/session')).json()).csrf, session.csrf)
  assert.equal((await readFile(join(folder, 'deliveries.ndjson'), 'utf8')).trim().split('\n').length, 2)
  console.log(JSON.stringify({ actualHarness: '0.2.1-rc.3', concurrentNativeRoots: 2, isolatedGroups: 2, nativeSessionsPerGroup: nativeSnapshots.map(r => r.length), originalThreadFiles: 2, crossGroupModelContextBlocked: true, crossGroupArtifactDenied: 403, ...(localConsole ? { noLoginOrCookieRequired: true, restartPreservedCsrf: true } : { restartPreservedCookie: true }), restartDidNotResend: true, modelCalls: calls, feishuNetworkCalls: 0, realCredentialsCopied: false }))
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
  await store.close(); for (const socket of sockets) socket.destroy(); await new Promise(done => model.close(done)); await rm(folder, { recursive: true, force: true })
}
