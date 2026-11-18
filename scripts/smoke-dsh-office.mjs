#!/usr/bin/env node
/** Real rc.3 office-loop verification. Only disposable SQL scopes and synthetic sources; default model wire is loopback. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { 'harness-root': { type: 'string' }, live: { type: 'boolean', default: false }, scenario: { type: 'string' }, 'profile-file': { type: 'string' }, 'deny-probe': { type: 'boolean', default: false } } })
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), harness = values['harness-root'], url = process.env.LOOM_DSH_B5_DATABASE_URL
if (!harness || !isAbsolute(harness) || !url || !new URL(url).pathname.endsWith('_test')) throw new Error('Explicit installed Harness root and disposable LOOM_DSH_B5_DATABASE_URL (_test) required')
const manifest = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@deepseek-ai/dsh'); assert.equal(manifest.version, '0.2.1-rc.3')
const live = values.live
if (live && values.scenario === 'selection') throw new Error('The pending-selection scenario uses two loopback test models; use the default scripted wire for it')
if (live && (!process.env.LOOM_B5_LIVE_URL || !process.env.LOOM_B5_LIVE_KEY || !process.env.LOOM_B5_LIVE_MODEL)) throw new Error('Live probe requires explicit private model URL/key/model environment; no account discovery')
let phase = 'seed', calls = 0, scenario = '', relayCalls = 0, currentWork
const requests = [], sockets = new Set(), denied = new Set()
function plain(content) { return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : '' }
function parsed(text) { try { return JSON.parse(text.split('\n\n')[0]) } catch { return undefined } }
const reply = (res, name, input) => {
  const callId = `b5-call-${calls}`, id = `b5-completion-${calls}`, base = { id, object: 'chat.completion.chunk', created: 1, model: 'synthetic' }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const choice of [{ delta: { role: 'assistant' } }, { delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }, { delta: {}, finish_reason: 'tool_calls' }])
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: null, ...choice }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}
const wire = createServer(async (req, res) => {
  try {
    const buffers = []; for await (const chunk of req) { buffers.push(chunk); if (buffers.reduce((n, b) => n + b.length, 0) > 2_000_000) throw new Error('Synthetic wire budget exceeded') }
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8')); if (++calls > 80) throw new Error('Probe model-call budget exceeded')
    const names = (body.tools ?? []).map(tool => tool.function.name)
    assert.ok(names.length > 0 && names.every(name => ['orchestrator_eval_decide', 'orchestrator_read', 'orchestrator_report', 'orchestrator_artifact', 'orchestrator_transcribe_recording'].includes(name)), `Unexpected tools in scoped office request: ${names.join(',')}`)
    const users = body.messages.filter(message => message.role === 'user').map(message => parsed(plain(message.content))).filter(Boolean)
    const envelope = users.findLast(value => value.candidate), candidate = envelope?.candidate, task = users.findLast(value => value.ticket_id)
    const outputs = body.messages.filter(message => message.role === 'tool').map(message => parsed(plain(message.content))).filter(Boolean)
    requests.push({ phase, scenario, tools: names, model: body.model, task: !!task, sourceRead: outputs.some(value => value.trigger), stream: body.stream === true })
    // Both wires stop before another request once the first worker has really consumed two tool results.
    if (phase === 'seed' && task && outputs.filter(value => value.ticket || value.trigger).length >= 2) { await writeFile(join(currentWork, 'barrier.json'), '{}', { mode: 0o600 }); req.on('close', () => res.destroy()); return }
    if (live) {
      if (++relayCalls > 30) throw new Error('Live model-call budget exceeded')
      const target = new URL('chat/completions', process.env.LOOM_B5_LIVE_URL.replace(/\/?$/, '/'))
      const lifetime = new AbortController(); res.on('close', () => lifetime.abort())
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LOOM_B5_LIVE_KEY}` },
        body: JSON.stringify({ ...body, model: process.env.LOOM_B5_LIVE_MODEL }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(45_000)]) })
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' })
      for await (const chunk of response.body) res.write(chunk)
      res.end(); return
    }
    if (candidate && !task) {
      const summaryRule = envelope.rules.find(rule => /summary|summar|总结|纪要/.test(JSON.stringify(rule))) ?? envelope.rules[0]
      reply(res, 'orchestrator_eval_decide', { decision: 'accept', title: 'Synthetic B5 daily summary', scope: 'Only supplied R1/R2 records; preserve their identifiers.', worktree_name: 'synthetic-daily',
        rule_assessments: envelope.rules.map(rule => ({ rule_id: rule.id, matched: rule.id === summaryRule.id, reason: 'Synthetic summary request' })),
        direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Explicit request to summarize supplied fictional records' },
        intent_evidence: 'Summarize only these fictional R1/R2 records.', reason: 'Known source, task and deliverable' }); return
    }
    assert.ok(task)
    if (values['deny-probe'] && phase === 'seed' && !denied.has(task.ticket_id)) { denied.add(task.ticket_id); reply(res, 'subagent', { task: 'Forbidden synthetic delegation' }); return }
    const ticket = outputs.findLast(value => value.ticket)?.ticket
    if (!ticket) { reply(res, 'orchestrator_read', { resource: `ticket/${task.ticket_id}` }); return }
    if (!outputs.some(value => value.trigger)) { reply(res, 'orchestrator_read', { resource: `trigger/${ticket.origin.triggerId}` }); return }
    const head = task.current_artifact
    if (head?.author === 'human' && !outputs.some(value => value.body)) { reply(res, 'orchestrator_artifact', { version: head.version }); return }
    reply(res, 'orchestrator_report', { state: 'ready', summary: `已完成：完成访谈整理。[R1]\n下一步：明天复核渠道字段。[R2]${head?.author === 'human' ? '\n人工补充：保留这项决策。[H1]' : ''}`, artifact_version: head?.version ?? 0 })
  } catch (error) { if (res.destroyed) return; console.error('B5 isolated model wire:', error.message); if (!res.headersSent) res.writeHead(500); res.end('Isolated B5 wire failed') }
})
wire.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise(resolve => wire.listen(0, '127.0.0.1', resolve))
const folder = await mkdtemp(join(tmpdir(), 'loom-b5-office-'))
const env = { PATH: process.env.PATH, HOME: join(folder, 'home'), XDG_CONFIG_HOME: join(folder, 'config'), XDG_CACHE_HOME: join(folder, 'cache'), DSH_AGENTS_HOME: join(folder, 'agents'), DSH_HOME: join(folder, 'dsh-home'), LOOM_DSH_B5_DATABASE_URL: url,
  LOOM_B5_MODEL_URL: `http://127.0.0.1:${wire.address().port}/v1`, LOOM_B5_MODEL_KEY: 'synthetic-loopback-only', LOOM_B6_DENY_PROBE: values['deny-probe'] ? '1' : '', LOOM_B5_MODEL_ID: live ? process.env.LOOM_B5_LIVE_MODEL : 'synthetic' }
try {
  await cp(join(root, 'lib'), join(folder, 'lib'), { recursive: true }); await mkdir(join(folder, 'node_modules'))
  const harnessRequire = createRequire(join(harness, 'package.json')), peerRoot = dirname(dirname(harnessRequire.resolve('@deepseek-ai/cordis/package.json')))
  await symlink(peerRoot, join(folder, 'node_modules', '@deepseek-ai'), 'dir')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const dependency of Object.keys(pkg.dependencies)) {
    const target = join(folder, 'node_modules', dependency); await mkdir(dirname(target), { recursive: true }); await symlink(join(root, 'node_modules', dependency), target, 'dir')
  }
  if (values['profile-file']) { assert.ok(isAbsolute(values['profile-file'])); await cp(values['profile-file'], join(folder, 'base-profile.yml')); env.LOOM_B6_PROFILE_FILE = join(folder, 'base-profile.yml') }
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'dsh-superagent', version: pkg.version, type: 'module' }))
  for (const directory of ['prompts', 'skills']) await cp(join(root, directory), join(folder, directory), { recursive: true })
  for (const [source, target] of [['dsh-office.mjs', 'probe.mjs'], ['b5-presets.mjs', 'presets.mjs'], ['b5-deny-shell.mjs', 'deny-shell.mjs']]) await cp(join(root, 'scripts', 'fixtures', source), join(folder, target))
  const results = []
  for (scenario of values.scenario ? [values.scenario] : live ? ['restart', 'takeover'] : ['restart', 'takeover', 'selection', 'crash']) {
    assert.ok(['restart', 'takeover', 'selection', 'crash'].includes(scenario)); const work = join(folder, scenario), tenantId = `b5-${randomUUID()}`; await mkdir(work, { mode: 0o700 }); currentWork = work
    for (phase of ['seed', 'recover', 'inspect']) {
      const cwd = await mkdtemp(join(work, 'compute-'))
      if (phase === 'recover') await rm(join(work, 'scratch'), { recursive: true, force: true })
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(folder, 'probe.mjs'), phase, tenantId, scenario], { cwd, env: { ...env, LOOM_B5_ROOT: work }, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = '', killedAtCheckpoint = false
        child.stdout.on('data', data => {
          stdout += data
          if (scenario === 'crash' && phase === 'seed' && !killedAtCheckpoint && stdout.split('\n').some(line => { try { return JSON.parse(line).crashCheckpoint === true } catch { return false } })) {
            killedAtCheckpoint = true; child.kill('SIGKILL')
          }
        }); child.stderr.on('data', data => { stderr += data })
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`B5 ${scenario}/${phase} timed out`)) }, 120_000)
        child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer)
          if (code !== 0 && !(killedAtCheckpoint && signal === 'SIGKILL')) { reject(new Error(`B5 ${scenario}/${phase} failed (${code}): ${stderr.replaceAll(url, '[database]')}\n${stdout.slice(-8000)}`)); return }
          try { resolve(stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1)) } catch (error) { reject(error) }
        })
      })
      assert.ok(result); results.push(result)
    }
  }
  console.log(JSON.stringify({ harness: '0.2.1-rc.3', mode: live ? 'live-model-synthetic-office' : 'scripted-model-actual-office-loop', modelWireCalls: calls, liveModelCalls: relayCalls,
    sources: 'synthetic-only', feishu: 'isolated transport only', results, requests }, null, 2))
} finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => wire.close(resolve)); await rm(folder, { recursive: true, force: true }) }
