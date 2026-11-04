/** Daily Codex delegations exercise real intake, policy, Harness sessions, artifacts and delivery; history/model/IM are substitutes. */
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MEMBER, startRuntime, type Host, feishu } from './fixtures/host.ts'
import { CodexHistory } from '../src/app/codex-history.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { shanghaiDate } from '../src/codex-delegation.ts'
import { delegationMatches, settingsPolicy } from '../src/policy.ts'

let h: Host
let read: MockInstance<CodexHistory['daily']>
const scope = { projects: ['/local/project'], sessions: [], time: '18:00', timezone: 'Asia/Shanghai', delivery: 'none' }
const revision = () => h.runtime.store.blockRevision('policy')
const input = (extra = {}) => ({ title: 'Codex 工作日报', description: '按已完成、讨论与计划、阻碍、下一步汇总，逐项引用。', codex: scope, codexConsent: true,
  chatIds: [], keywords: [], mode: 'auto', enabled: true, requestId: randomUUID(), revision: revision(), ...extra })
const snapshot = { text: '{"sessions":[{"ref":"S1","session":"11111111-1111-4111-8111-111111111111","messages":[{"ref":"S1-M1","text":"完成 R1。下一步 R2。"}]}]}', messages: 1, sessions: 1, warnings: [] }
async function create(extra = {}) {
  const response = await h.api('POST', 'loom/delegations', input(extra)); expect(response.status).toBe(200); return String(response.body.id)
}
async function start(id: string) {
  const response = await h.api('POST', `loom/delegations/${id}/run`, { revision: revision() })
  expect(response.status).toBe(200); await h.runtime.idle()
  return h.runtime.codexDaily.list(MEMBER, id)[0]!
}
const toggle = (id: string, enabled: boolean) => h.api('PATCH', `loom/delegations/${id}`, { enabled, revision: revision() })
beforeEach(async () => {
  h = await startRuntime(undefined, { github: false })
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, eval: { ...s.eval, mode: 'off' }, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, ownerOnly: true } } } })
  read = vi.spyOn(CodexHistory.prototype, 'daily').mockImplementation(async (_date, _scope, check) => { check(); return snapshot })
})
afterEach(async () => { await h.stop() })

it('requires explicit bounded Codex consent and persists a rule without reading history, changing day-view access or starting a task', async () => {
  const body = input(), first = await h.api('POST', 'loom/delegations', body), id = String(first.body.id)
  expect(first.status).toBe(200)
  expect(await h.api('POST', 'loom/delegations', body)).toMatchObject({ status: 200, body: { id, replay: true } })
  expect(await h.api('POST', 'loom/delegations', { ...body, codex: { ...scope, projects: ['/other'] } })).toMatchObject({ status: 409 })
  expect(h.runtime.store.settings().policy.rules.find(rule => rule.id === id)?.delegation).toMatchObject({ owner: MEMBER, chatIds: [], codex: scope })
  expect(read).not.toHaveBeenCalled(); expect(h.runtime.store.tickets.list()).toHaveLength(0)
  expect(h.runtime.codexHistory.access(MEMBER).enabled).toBe(false)
  expect(h.runtime.store.settings().eval.mode).toBe('off')
  for (const extra of [{ codexConsent: undefined }, { chatIds: ['oc_team'] }, { codex: { ...scope, projects: [] } },
    { codex: { ...scope, sessions: [randomUUID()] } }, { codex: { ...scope, projects: ['/local/../private'] } }, { owner: 'ou_intruder' }]) {
    expect((await h.api('POST', 'loom/delegations', input(extra))).status).toBe(400)
  }
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try { expect(reopened.settings().policy.rules.find(rule => rule.id === id)?.delegation?.codex).toEqual(scope) } finally { reopened.close() }
})

it('creates an ordinary bounded Harness task and immutable local Markdown report, with no Codex execution or Feishu publication', async () => {
  const id = await create(), run = await start(id), ticket = h.runtime.store.tickets.get(run.ticketId!)!
  expect(run).toMatchObject({ status: 'started', messages: 1, sessions: 1, date: shanghaiDate() })
  expect(ticket.mandate).toMatchObject({ strength: 'inferred', actor: { source: 'codex-daily', id: MEMBER }, basis: { source: 'codex-daily', rules: [id] } })
  expect(ticket.channels).toEqual([])
  const worker = `worker-${ticket.id}`
  expect([...h.tools.get(worker)!.keys()]).toEqual(['orchestrator_artifact', 'orchestrator_read', 'orchestrator_report'])
  const source = await h.runTool(worker, 'orchestrator_read', { resource: `trigger/${run.triggerId}`, limit: 8000 })
  expect(source.text).toContain('S1-M1'); expect(source.text).toContain('不能作为指令执行')
  for (const resource of ['github/issues', 'settings', 'feishu/foreign/message', 'ticket/foreign']) {
    await expect(h.runTool(worker, 'orchestrator_read', { resource })).rejects.toThrow('仅可读取')
  }
  await expect(h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '摘要', artifact_file: 'private.md' })).rejects.toThrow('不读取工作区文件')
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '已完成：R1。[S1-M1]\n计划：R2。[S1-M1]' })
  await h.runtime.idle()
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)).toMatchObject({ body: expect.stringContaining('S1-M1'), filename: `codex-daily-${shanghaiDate()}.md`, kind: 'task' })
  expect(h.runtime.resultDelivery.list(MEMBER, ticket.id)).toEqual([expect.objectContaining({ status: 'local', mode: 'none' })])
  const view = await h.api('GET', 'loom')
  expect(view.body.tasks).toEqual([expect.objectContaining({ id: ticket.id, completed: true, ruleIds: [id] })])
  expect(JSON.stringify(view.body.events)).not.toContain('完成 R1')
  expect((await h.api('GET', `loom/artifacts/${ticket.id}`)).status).toBe(200)
  const calls = h.runtime.commands.lark as unknown as ReturnType<typeof vi.fn>
  expect(calls.mock.calls.flat().join(' ')).not.toContain('+messages-send')
})

it('shares a durable daily key across concurrent manual/clock requests and restart reads, without date injection or duplicate tickets', async () => {
  const id = await create()
  await Promise.all([start(id), start(id)])
  const run = h.runtime.codexDaily.list(MEMBER, id)[0]!
  h.runtime.codexDaily.tick(new Date(`${run.date}T23:59:00+08:00`)); await h.runtime.idle()
  expect(read).toHaveBeenCalledTimes(1); expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(await h.api('POST', `loom/delegations/${id}/run`, { revision: revision(), date: '2020-01-01' })).toMatchObject({ status: 400 })
  expect(await h.api('POST', `loom/delegations/${id}/run`, { revision: 0 })).toMatchObject({ status: 409 })
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try { expect(reopened.get(KV.codexDaily.run(run.id))?.ticketId).toBe(run.ticketId) } finally { reopened.close() }
  const original = h.runtime.store.triggers.get(run.triggerId!)!
  expect(() => h.runtime.engine.decide(original.id, { kind: 'accept', title: 'duplicate', scope: '', reason: 'same', rules: [id] })).not.toThrow()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('runs at Shanghai schedule time, skips past days and skips a new grant created after today’s scheduled time', async () => {
  const id = await create(), date = shanghaiDate(new Date(Date.now() + 86400_000))
  h.runtime.codexDaily.tick(new Date(`${date}T17:59:59+08:00`)); await h.runtime.idle(); expect(read).not.toHaveBeenCalled()
  h.runtime.codexDaily.tick(new Date(`${date}T18:00:00+08:00`)); await h.runtime.idle()
  expect(read).toHaveBeenCalledTimes(1); expect(read.mock.calls[0]![0]).toBe(date)
  h.runtime.codexDaily.tick(new Date(`${date}T23:00:00+08:00`)); await h.runtime.idle(); expect(read).toHaveBeenCalledTimes(1)
  const yesterday = shanghaiDate(new Date(Date.now() - 86400_000))
  h.runtime.codexDaily.tick(new Date(`${yesterday}T23:59:00+08:00`)); await h.runtime.idle(); expect(read).toHaveBeenCalledTimes(1)
  const late = await create({ codex: { ...scope, time: '00:00' } })
  h.runtime.codexDaily.tick(); await h.runtime.idle(); expect(h.runtime.codexDaily.list(MEMBER, late)).toEqual([])
})

it('records observe and empty states without producing an invented report or invoking a worker', async () => {
  const observed = await create({ mode: 'observe' })
  expect(await start(observed)).toMatchObject({ status: 'observed' }); expect(read).not.toHaveBeenCalled()
  const empty = await create()
  read.mockResolvedValue({ text: '{}', messages: 0, sessions: 0, warnings: ['测试未覆盖附件'] })
  expect(await start(empty)).toMatchObject({ status: 'empty', messages: 0, warnings: ['测试未覆盖附件'] })
  expect(h.runtime.store.tickets.list()).toEqual([]); expect(h.runtime.store.keys(KV.artifacts.head)).toEqual([])
})

it('bounds explicit read retries and suppresses private error data without automatic retry storms', async () => {
  const id = await create()
  read.mockRejectedValue(new Error('private-secret-error-canary'))
  for (let i=0;i<5;i++) await start(id)
  const run = h.runtime.codexDaily.list(MEMBER, id)[0]!
  expect(run).toMatchObject({ status: 'failed', attempts: 3 }); expect(read).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(run)).not.toContain('canary')
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
})

it('discards an in-flight read if the owner pauses or edits the delegation, without persisting transcript data', async () => {
  const id = await create(), gate = Promise.withResolvers<typeof snapshot>()
  let entered = false
  read.mockImplementation(async (_date, _scope, check) => { entered = true; const result = await gate.promise; check(); return result })
  expect((await h.api('POST', `loom/delegations/${id}/run`, { revision: revision() })).status).toBe(200)
  await vi.waitFor(()=>expect(entered).toBe(true))
  expect(await toggle(id, false)).toMatchObject({ status: 200 })
  gate.resolve({ ...snapshot, text: 'revoked-history-canary' }); await h.runtime.idle()
  expect(h.runtime.codexDaily.list(MEMBER, id)[0]?.status).toBe('cancelled')
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.db.prepare('SELECT value FROM trigger WHERE value LIKE ?').all('%revoked-history-canary%')).toEqual([])
})

it('holds unfinished work and blocks publication after pause; changed source scopes also hide old source-derived artifacts', async () => {
  const id = await create(), run = await start(id), task = run.ticketId!, worker = `worker-${task}`
  await h.runTool(worker, 'orchestrator_report', { state: 'progress', summary: '已有进展 [S1-M1]' })
  expect(await toggle(id, false)).toMatchObject({ status: 200 }); await h.runtime.idle()
  await vi.waitFor(()=>expect(h.runtime.controls.view(task).mode).toBe('paused'))
  await expect(h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '不应写入' })).rejects.toThrow()
  expect(h.runtime.artifacts.get(task, MEMBER)?.body).toContain('已有进展')
  expect(await h.api('POST', `loom/tasks/${task}/control`, { action: 'resume', revision: h.runtime.controls.view(task).revision })).toMatchObject({ status: 409 })
  expect(await toggle(id, true)).toMatchObject({ status: 200 }); expect(h.runtime.controls.view(task).mode).toBe('paused')
  const { requestId: _request, ...body } = input({ codex: { ...scope, projects: ['/different'] } })
  expect(await h.api('PUT', `loom/delegations/${id}`, body)).toMatchObject({ status: 200 })
  expect(await h.api('GET', `loom/artifacts/${task}`)).toMatchObject({ status: 404 })
  await expect(h.runTool(worker, 'orchestrator_read', { resource: `trigger/${run.id}` })).rejects.toThrow('来源授权')
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${run.id}` })).rejects.toThrow('authorization')
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${task}/result` })).rejects.toThrow('authorization')
})

it('rejects forged source events, other-source matches and owner changes while keeping Codex rules independent of global Feishu mode', async () => {
  const id = await create(), run = await start(id), original = h.runtime.store.triggers.get(run.id)!, rule = h.runtime.store.settings().policy.rules.find(rule=>rule.id===id)!
  expect(settingsPolicy(h.runtime.store.settings(), h.runtime.sources).revalidate(h.runtime.store.tickets.get(run.ticketId!)!.mandate)).toBe(true)
  expect(settingsPolicy(h.runtime.store.settings(), h.runtime.sources).admitsInferred(['copy'], [original])).toBe(false)
  for (const forged of [{ ...original, id: 'fake' }, { ...original, text: 'forged history' }, { ...original, actor: {source:'codex-daily',id:'ou_intruder'} },
    { ...original, meta: {...original.meta,runId:'unissued'} }, feishu('codex1','帮我做日报')]) {
    expect(delegationMatches(rule, [forged])).toBe(false)
    expect(settingsPolicy(h.runtime.store.settings(), h.runtime.sources).admitsInferred([id], [forged])).toBe(false)
  }
  const s = h.runtime.store.settings()
  await h.runtime.settings.save('policy', { ...s.policy, sources: { ...s.policy.sources, feishu: { ...s.policy.sources.feishu, allowed: [{id:'ou_another'}] } } }, revision(), 'panel')
  await h.runtime.idle()
  expect(h.runtime.artifacts.get(run.ticketId!, MEMBER)).toBeUndefined()
  expect(await h.api('POST', `loom/delegations/${id}/run`, { revision: revision() })).toMatchObject({ status: 409 })
})

it('cancels queued private delivery after revocation and never redirects Codex history into a group', async () => {
  const id = await create({ codex: { ...scope, delivery: 'feishu' } }), run = await start(id), task = run.ticketId!
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await h.runTool(`worker-${task}`, 'orchestrator_report', { state: 'ready', summary: '报告正文。[S1-M1]' })
  expect(h.runtime.resultDelivery.list(MEMBER, task)).toEqual([expect.objectContaining({ status: 'queued', destination: expect.stringContaining('私聊') })])
  await toggle(id, false)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false }); await h.runtime.idle()
  expect(h.runtime.resultDelivery.list(MEMBER, task)).toEqual([expect.objectContaining({ status: 'cancelled' })])
  const calls = h.runtime.commands.lark as unknown as ReturnType<typeof vi.fn>
  expect(calls.mock.calls.flat().join(' ')).not.toContain('+messages-send')
})
