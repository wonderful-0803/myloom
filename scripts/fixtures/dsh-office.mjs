/** Actual rc.3 Loader, registry, presets, permissions, AgentLoop and pi-ai adapter, with isolated company state. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { createRequire } from 'node:module'
import { CompanyServer, initializeCompany, PostgresStateStore } from './lib/state.js'
import { NativeOfficeBackend } from './lib/company.js'
const [phase, tenantId, scenario = 'restart'] = process.argv.slice(2), folder = process.env.LOOM_B5_ROOT
const scope = { tenantId, spaceId: tenantId.slice(3) }, provider = 'b5-model', model = process.env.LOOM_B5_MODEL_ID ?? 'synthetic'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const privateJSON = async (name, value) => writeFile(join(folder, name), JSON.stringify(value), { mode: 0o600 })
let nativeError, expectedStop = false
const until = async check => { const end = Date.now() + 90_000; while (Date.now() < end) { if (nativeError) throw nativeError; if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)) } throw new Error(`B5 ${phase}/${scenario}: expected state not reached`) }
if (phase === 'seed') {
  const store = await PostgresStateStore.open({ connectionString: process.env.LOOM_DSH_B5_DATABASE_URL })
  try {
    const since = new Date(Date.now() - 60_000).toISOString()
    const settings = { sources: { github: { enabled: false }, feishu: { enabled: true, config: { ownerOnly: true, directMessages: true, chats: [{ chatId: 'oc_b5', listen: 'all' }] } } },
      policy: { rules: [{ id: 'summary', name: 'Synthetic summaries', enabled: true, instruction: 'Summarize supplied fictional R1/R2 work records, preserve record identifiers; no other data or writes.' }], sources: { feishu: { allowed: [{ id: 'ou_b5' }], workspace: { mode: 'group', operator: 'ou_b5', chatId: 'oc_b5', name: 'Synthetic group', masters: [{ id: 'ou_b5', name: 'Synthetic owner' }], spaceId: scope.spaceId, since } } } },
      eval: { mode: 'auto', model: { provider, model } }, executor: { model: { provider, model } } }
    await initializeCompany(store, scope, { id: 'b5-installed', appId: 'cli_b5', botId: 'ou_bot', tenantKey: 'b5-tenant', operator: 'ou_b5', name: 'Synthetic bot', enabled: true, since }, settings)
  } finally { await store.close() }
}
const workerPreset = 'dsh-superagent-worker', routerPreset = 'dsh-superagent-router'
await privateJSON('contract.json', { harnessVersion: '0.2.1-rc.3', profileRevision: digest('b5-office-profile-v1'), presets: { [workerPreset]: digest('[]\n'), [routerPreset]: digest('[]\n') }, models: [{ provider, model }, ...(scenario === 'selection' ? [{ provider, model: 'synthetic-next' }] : [])] })
const modulePath = name => new URL(`./node_modules/@deepseek-ai/${name}/lib/index.js`, import.meta.url).pathname
let entries = [
  { name: new URL('./lib/dsh-state.js', import.meta.url).pathname, config: { ...scope, databaseUrlEnv: 'LOOM_DSH_B5_DATABASE_URL' } },
  ...['dsh-session', 'dsh-agent', 'dsh-session-projection', 'dsh-storage'].map(name => ({ name: modulePath(name) })),
  { name: modulePath('dsh-agent-preset-registry'), config: { default: workerPreset } },
  { name: new URL('./presets.mjs', import.meta.url).pathname },
  { name: new URL('./lib/dsh-metadata.js', import.meta.url).pathname, config: { contractFile: join(folder, 'contract.json'), units: ['workspace'] } },
  { name: modulePath('dsh-storage-domain'), config: { backend: 'loom-sql' } },
  { name: modulePath('dsh-workspace') },
  { name: modulePath('dsh-system-prompt') }, { name: modulePath('dsh-llm') },
  { name: modulePath('dsh-llm-pi-ai'), config: { providers: { [provider]: { api: 'openai-completions', baseURL: process.env.LOOM_B5_MODEL_URL, apiKeyEnv: 'LOOM_B5_MODEL_KEY', defaultMaxTokens: 1500,
    models: [model, ...(scenario === 'selection' ? ['synthetic-next'] : [])].map(id => ({ id, input: ['text'], maxTokens: 1500, contextWindow: 32000 })) } } } },
  { name: modulePath('dsh-agent-default-model'), config: { provider, model } },
  { name: new URL('./deny-shell.mjs', import.meta.url).pathname },
  { name: modulePath('dsh-user-approval'), config: { policy: 'never' } },
  { name: modulePath('dsh-permission-presets'), config: { presets: { 'read-only': { sandbox: 'read-only', approval: 'never' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } } },
  { name: modulePath('dsh-tools'), config: { mode: 'native', maxParallelSubCalls: 1 } },
  { name: modulePath('dsh-agent-loop'), config: { agents: [], maxParallelToolCalls: 1 } },
]
let fullProfile = false
if (process.env.LOOM_B6_PROFILE_FILE) {
  const yaml = createRequire(await realpath(new URL('./node_modules/@deepseek-ai/dsh-app-boot/package.json', import.meta.url)))('js-yaml')
  const original = await readFile(process.env.LOOM_B6_PROFILE_FILE, 'utf8'), rows = yaml.load(original, { schema: entryListSchema })
  assert.ok(Array.isArray(rows))
  const disabled = new Set(['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu', 'session-persistence-jsonl', 'session-title-llm'])
  const byId = new Map(rows.map(row => [row.id, row]))
  for (const id of disabled) { const row = byId.get(id); if (row) row.disabled = true }
  const pick = id => { const row = byId.get(id); assert.ok(row, `Full profile lacks ${id}`); row.config ??= {}; return row }
  pick('llm-pi-ai').config = entries.find(row => row.name === modulePath('dsh-llm-pi-ai')).config
  pick('webserver').disabled = false; pick('webserver').config = { host: '127.0.0.1', port: 0 }
  pick('web-runtime').config = { ...pick('web-runtime').config, printUrl: false }
  pick('agent-default-model').config = { provider, model }
  pick('storage-json').config.root = join(folder, 'unrelated-metadata')
  pick('storage-domain').config = { ...pick('storage-domain').config, backend: 'json', routes: { workspace: 'loom-sql' } }
  pick('attachment-local').config = { dshHome: join(folder, 'durable-native-home') }
  pick('agent-loop').config.agents = []
  const presets = {}
  for (const preset of [workerPreset, routerPreset]) {
    const declaration = rows.find(row => row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === preset)
    assert.ok(declaration, `Full profile lacks role ${preset}`)
    presets[preset] = digest(yaml.dump(declaration.config.plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 }))
  }
  await privateJSON('contract.json', { harnessVersion: '0.2.1-rc.3', profileRevision: digest(original), presets, models: [{ provider, model }, ...(scenario === 'selection' ? [{ provider, model: 'synthetic-next' }] : [])] })
  entries = [...rows, ...entries.filter(row => ['./lib/dsh-state.js', './lib/dsh-metadata.js'].some(name => row.name === new URL(name, import.meta.url).pathname))]
  fullProfile = true
}
await privateJSON('profile.json', entries)
let root, server, ctx
const files = [], texts = [], raw = { message_id: 'om_b5', chat_id: 'oc_b5', chat_type: 'group', sender_id: 'ou_b5', sender_type: 'user', create_time: String(Date.now()), mentions: [{ id: 'ou_bot' }],
  content: '仅根据以下虚构记录总结今日工作，保留编号。R1：完成访谈整理。R2：明天复核渠道字段。不读取其他资料。' }
try {
  root = await boot('loom-b5', join(folder, 'profile.json'), [], host => { provideCmdline(host, { args: ['--no-open', '--host', '127.0.0.1', '--port', '0'], exit: code => { throw new Error(`Unexpected profile exit ${code}`) } }) })
  await root.inject(['agents', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'llm', 'agentPresets', 'agentDefaultModel', 'sessionProjections'], child => { ctx = child })
  assert.ok(ctx, 'Required Harness services must really be active')
  const native = ctx.sessionPersistence, store = native.authority.store
  const wire = { verify: async () => {}, lark: async args => { if (args.includes('/open-apis/im/v1/messages')) return { items: [], has_more: false }; texts.push('sent'); return { message_id: `om_b5_receipt_${texts.length}` } },
    file: async (target, filename, bytes) => { files.push({ target, filename, bytes: Buffer.from(bytes) }); return `om_b5_file_${files.length}` },
    async *events(signal, ready) { ready?.(); if (phase === 'seed') yield raw; if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) } }
  const assets = join(folder, 'assets'); await mkdir(assets, { recursive: true }); await writeFile(join(assets, 'index.html'), '<html><head></head><body>B5</body></html>')
  server = await CompanyServer.open({ store, scope, installationId: 'b5-installed', blobRoot: join(folder, 'objects'), scratch: join(folder, 'scratch'), assets, origin: 'http://127.0.0.1:3085', port: 0, cli: 'never-invoked', wire, development: true,
    login: { authorizeUrl: state => `https://synthetic.invalid/?state=${state}`, exchange: async () => ({ openId: 'ou_b5', tenantKey: 'b5-tenant', expiresIn: 3600 }) },
    backend: async services => {
      const backend = new NativeOfficeBackend({ ...services, context: ctx, nativeState: native })
      for (const name of ['assess', 'work']) { const original = backend[name].bind(backend); backend[name] = async (...args) => { try { return await original(...args) } catch (error) { if (!expectedStop) nativeError = error; console.error(`B5 native ${name}:`, error); throw error } } }
      return backend
    } })
  await server.start()
  let ticketId, first
  if (phase === 'seed') {
    await until(async () => { const rows = await store.transaction(scope, tx => tx.scan('ticket')); ticketId = rows[0]?.id; if (['failed', 'ready'].includes(rows[0]?.value.assignments.at(-1)?.report?.state)) throw new Error('B5 worker ended before the required source-read interruption'); if (!ticketId) { const decisions = await store.transaction(scope, tx => tx.scan('decision')); if (decisions.some(row => row.value.kind !== 'accept')) throw new Error('B5 Router did not accept the explicit synthetic request'); return false }; return (await server.product.progress('ou_b5', ticketId)).toolCalls >= 2 && await readFile(join(folder, 'barrier.json')).then(() => true, () => false) })
    first = { ticketId, header: (await native.stat(`worker-${ticketId}`)).header }
    if (scenario === 'crash') {
      await privateJSON('expected.json', first)
      console.log(JSON.stringify({ phase, scenario, header: first.header, ticketId, actualAgentLoop: true, crashCheckpoint: true, filesDelivered: 0 }))
      setInterval(() => {}, 1000); await new Promise(() => {})
    }
    if (scenario === 'selection') ctx.agents.get(`worker-${ticketId}`).session.append('model/selection', { provider, model: 'synthetic-next' })
    if (scenario === 'takeover') {
      expectedStop = true
      await server.product.handle('ou_b5', 'POST', ['tasks', ticketId, 'control'], {}, { revision: 0, action: 'takeover' }, 'b5-takeover')
      await until(async () => (await store.transaction(scope, tx => tx.get('control', ticketId))).value.mode === 'human')
      await server.product.handle('ou_b5', 'PUT', ['artifacts', ticketId], {}, { version: 0, body: '人工补充：保留这项决策。[H1]' }, 'b5-human-edit')
    }
    await server.stop()
    const jobs = await store.transaction(scope, tx => tx.jobs.list()), fence = (await store.transaction(scope, tx => tx.get('control', ticketId))).value
    const binding = (await store.transaction(scope, tx => tx.get('grant', `native-task-owner/${ticketId}`))).value
    assert.ok((await store.transaction(scope, tx => tx.get('grant', `native-quiescent/${binding.sessionId}/${binding.epoch}`))).value.flushed)
    if (scenario !== 'takeover') assert.ok(jobs.some(job => ['domain.launch', 'domain.input'].includes(job.kind) && !job.held), 'A safely drained job must remain retryable')
    else assert.equal(fence.mode, 'human')
    assert.equal(files.length, 0); await privateJSON('expected.json', first)
  } else if (phase === 'recover') {
    first = JSON.parse(await readFile(join(folder, 'expected.json'), 'utf8')); ticketId = first.ticketId
    assert.deepEqual((await native.stat(`worker-${ticketId}`)).header, first.header)
    if (scenario === 'takeover') {
      const before = (await native.stat(`worker-${ticketId}`)).eventCount
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal((await native.stat(`worker-${ticketId}`)).eventCount, before, 'Human control must survive a new compute process')
      await server.product.handle('ou_b5', 'POST', ['tasks', ticketId, 'control'], {}, { revision: 1, action: 'return' }, 'b5-return')
    }
    await until(async () => files.length === 1); await server.runtime.idle()
    assert.ok((await server.product.snapshot('ou_b5')).tasks.find(task => task.id === ticketId).completed)
    const published = await server.artifacts.read('ou_b5', ticketId), body = published.bytes.toString('utf8')
    assert.ok(body.includes('R1') && body.includes('R2'))
    const delivered = await server.artifacts.read('ou_b5', ticketId, published.manifest.version, true)
    assert.deepEqual(files[0].bytes, delivered.bytes, 'Delivered bytes must match the fixed version, including actual Word output')
    if (scenario === 'takeover') {
      assert.ok(body.includes('H1'), 'The new version must preserve the human revision')
      assert.equal(published.manifest.version, 2)
      const human = await server.artifacts.read('ou_b5', ticketId, 1)
      assert.equal(human.manifest.author, 'human'); assert.ok(human.bytes.toString('utf8').includes('H1'))
    }
    assert.deepEqual(files[0].target, { messageId: 'om_b5', threaded: true })
    await server.stop(); await server.start().then(() => { throw new Error('Stopped server cannot restart in-place') }, () => {})
    const reader = await native.open(`worker-${ticketId}`, 'read'), events = (await reader.read()).events; await reader.close()
    if (process.env.LOOM_B6_DENY_PROBE === '1') {
      const denied = events.find(event => event.type === 'tool/call' && event.data.name === 'subagent')
      assert.ok(denied)
      assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.toolCallId === denied.data.callId && event.data.message.isError))
      assert.equal((await native.list()).filter(entry => entry.header.origin === 'subagent').length, 0)
    }
    assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'blocked', 'Final scoped pre-step must stop cleanly, not fail the next request')
    const finalCall = events.findLast(event => event.type === 'tool/call')
    assert.equal(finalCall.data.name, 'orchestrator_report')
    assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.toolCallId === finalCall.data.callId && !event.data.message.isError), 'Final tool result must survive the clean stop')
    if (scenario === 'selection') assert.equal(events.findLast(event => event.type === 'request/header').data.header.config.model, 'synthetic-next')
    const originals = events.filter(event => event.type === 'user/message' && event.data.content[0]?.text?.startsWith('{"ticket_id"'))
    assert.equal(new Set(originals.map(event => event.data.id)).size, originals.length)
    await privateJSON('completed.json', { ticketId, eventCount: events.length })
    console.log(JSON.stringify({ phase, scenario, header: first.header, ticketId, originalInputIds: originals.map(event => event.data.id), nativeEvents: events.length,
      fullProductionComputeProfile: fullProfile, actualAgentLoop: true, actualPresetRegistry: true, actualPiAiAdapter: true, filesDelivered: files.length, humanRevisionPreserved: scenario === 'takeover', pendingModelSelectionRestored: scenario === 'selection' }))
  }
  if (phase === 'inspect') {
    const completed = JSON.parse(await readFile(join(folder, 'completed.json'), 'utf8'))
    await server.runtime.idle(); await new Promise(resolve => setTimeout(resolve, 250)); await server.runtime.idle()
    assert.equal(files.length, 0, 'Completed delivery must not be replayed by a third compute process')
    assert.equal((await native.stat(`worker-${completed.ticketId}`)).eventCount, completed.eventCount)
    const head = await server.artifacts.manifest('ou_b5', completed.ticketId)
    assert.ok(head)
    const report = await server.artifacts.read('ou_b5', completed.ticketId, head.version)
    assert.ok(report.bytes.toString('utf8').includes('R1'))
    console.log(JSON.stringify({ phase, scenario, completedTaskPreserved: true, nativeEventsUnchanged: true, filesDelivered: 0, durableArtifactReadable: true }))
  }
  if (phase === 'seed') console.log(JSON.stringify({ phase, scenario, header: first.header, ticketId, actualAgentLoop: true, safelyDrained: true, filesDelivered: files.length }))
} finally { await server?.stop(); await root?.fiber.dispose() }
