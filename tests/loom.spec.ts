import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime, feishu, MEMBER, type Host } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime(undefined, { github: false })
  const s = h.runtime.store.settings(), feishu = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...feishu, config: { ...feishu.config, ownerOnly: true } } } })
})
afterEach(async () => { await h.stop() })
async function ready() {
  const value = await h.acceptedTicket(feishu('loom1', '整理工作总结，保留 R1 来源'))
  await h.runTool(value.sessionId, 'orchestrator_report', { state: 'ready', summary: '已完成 R1。' })
  return value
}
it('serves the real owner snapshot and report without creating work or disclosing configuration paths', async () => {
  const { ticket } = await ready(), before = h.runtime.store.tickets.list()
  const response = await h.api('GET', 'loom')
  expect(response.status).toBe(200)
  expect(response.body.tasks).toEqual([expect.objectContaining({ id: ticket.id, completed: true })])
  expect(response.body.artifacts).toEqual([expect.objectContaining({ subject: ticket.id, version: 1, body: '已完成 R1。' })])
  expect(h.runtime.store.tickets.list()).toEqual(before)
  expect(JSON.stringify(response.body)).not.toMatch(/smtpCli|mailCli|stateDir|appSecret|apiKey/)
  expect(await h.api('GET', `loom/artifacts/${ticket.id}/export?version=1`)).toMatchObject({ status: 200, body: { filename: 'result.txt', content: expect.stringContaining('已完成 R1。') } })
  expect(await h.api('POST', `loom/tasks/${ticket.id}/control`, { action: 'pause', revision: 0, owner: 'ou_intruder' })).toMatchObject({ status: 400 })
})
it('requires drained takeover, preserves the original and rejects stale owner edits through the HTTP adapter', async () => {
  const { ticket } = await ready()
  expect(await h.api('PUT', `loom/artifacts/${ticket.id}`, { version: 1, body: '抢写' })).toMatchObject({ status: 409 })
  expect(await h.api('POST', `loom/tasks/${ticket.id}/control`, { action: 'takeover', revision: 0 })).toMatchObject({ status: 200 })
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  expect(await h.api('PUT', `loom/artifacts/${ticket.id}`, { version: 1, body: '本人补充核对 R1。' })).toMatchObject({ status: 200, body: { version: 2, author: 'human', editedVia: 'loom' } })
  expect(await h.api('PUT', `loom/artifacts/${ticket.id}`, { version: 1, body: '覆盖旧版' })).toMatchObject({ status: 409 })
  expect(h.runtime.artifacts.get(ticket.id, MEMBER, 1)?.body).toBe('已完成 R1。')
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)?.sources).toHaveLength(1)
  expect(await h.api('POST', `loom/tasks/${ticket.id}/control`, { action: 'return', revision: 0 })).toMatchObject({ status: 409 })
})
it('withdraws task, artifact, history and controls when source permission is revoked', async () => {
  const { ticket } = await ready(), s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, chats: [], otherChats: 'none' } } } })
  expect(await h.api('GET', 'loom')).toMatchObject({ status: 200, body: { tasks: [], artifacts: [] } })
  expect(await h.api('GET', `loom/artifacts/${ticket.id}?version=1`)).toMatchObject({ status: 404 })
  expect(await h.api('GET', `loom/artifacts/${ticket.id}/export?version=1`)).toMatchObject({ status: 404 })
  expect(await h.api('POST', `loom/tasks/${ticket.id}/control`, { action: 'pause', revision: 0 })).toMatchObject({ status: 404 })
})
it('uses the existing draft version and confirmation state without creating a task or posting to Feishu', async () => {
  const trigger = feishu('loomDraft', '工作总结：R1 完成访谈。', { mentions: [] })
  h.runtime.store.triggers.save(trigger)
  const id = 'd'.repeat(32), at = new Date().toISOString()
  h.runtime.store.set(KV.drafts.record(id), { id, decisionId: '', owner: MEMBER, chatId: String(trigger.meta.chatId), thread: '', sourceIds: [trigger.id],
    fingerprint: '', title: '总结草稿', at, policyVersion: '', configHash: '', status: 'ready' })
  h.runtime.artifacts.draft(id, MEMBER, '总结草稿', '第一稿 [R1]', [trigger.id])
  expect(await h.api('POST', `loom/drafts/${id}`, { action: 'confirm', version: 1 })).toMatchObject({ status: 200 })
  expect(h.runtime.quietDrafts.get(id, MEMBER)?.status).toBe('confirmed')
  expect(await h.api('PUT', `loom/artifacts/${id}`, { version: 1, body: '本人改稿 [R1]' })).toMatchObject({ status: 200, body: { version: 2 } })
  expect(h.runtime.quietDrafts.get(id, MEMBER)?.status).toBe('ready')
  expect(await h.api('POST', `loom/drafts/${id}`, { action: 'confirm', version: 1 })).toMatchObject({ status: 409 })
  expect(await h.api('POST', `loom/drafts/${id}`, { action: 'discard' })).toMatchObject({ status: 200 })
  expect(await h.api('GET', `loom/artifacts/${id}`)).toMatchObject({ status: 404 })
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  expect(h.runtime.artifacts.history(id, MEMBER)).toHaveLength(2)
  const queued = 'e'.repeat(32)
  h.runtime.store.set(KV.drafts.record(queued), { ...h.runtime.store.get(KV.drafts.record(id))!, id: queued, status: 'queued' })
  expect(await h.api('POST', `loom/drafts/${queued}`, { action: 'discard' })).toMatchObject({ status: 200 })
  expect(h.runtime.store.get(KV.drafts.record(queued))?.status).toBe('discarded')
})
it('previews a stored mail permit, rejects tampered confirmation and submits at most once', async () => {
  const { ticket } = await ready(), s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, mailProvider: '163', smtpCli: '/fake/163' } } } })
  const run = vi.mocked(Commands.prototype.run).mockImplementation(async (_program, args, cwd) => {
    if (args[0] === 'identity') return JSON.stringify({ ok: true, data: { provider: '163', owner: MEMBER, appId: 'cli_bot', accountId: 'a'.repeat(32), address: 'owner@163.com', verifiedAt: new Date().toISOString() } })
    const request = JSON.parse(readFileSync(join(cwd!, 'request.json'), 'utf8'))
    return JSON.stringify({ ok: true, data: { status: 'submitted', message_id: request.messageId } })
  })
  const response = await h.api('POST', `loom/tasks/${ticket.id}/mail`, {})
  expect(response.status).toBe(200)
  const proposal = response.body.proposal as { token: string; artifactVersion: number }
  expect(proposal.artifactVersion).toBe(1)
  expect(JSON.stringify(proposal)).not.toMatch(/cli|accountId/)
  expect(run.mock.calls.filter(([, args]) => args[0] === 'send')).toHaveLength(0)
  expect(await h.api('POST', `loom/mail/${proposal.token}`, { action: 'confirm', to: 'intruder@163.com' })).toMatchObject({ status: 400 })
  expect(await h.api('POST', `loom/mail/${proposal.token}`, { action: 'confirm' })).toMatchObject({ status: 200, body: { proposal: { status: 'submitted' } } })
  expect(await h.api('POST', `loom/mail/${proposal.token}`, { action: 'confirm' })).toMatchObject({ status: 200 })
  expect(run.mock.calls.filter(([, args]) => args[0] === 'send')).toHaveLength(1)
})
it('refuses ambiguous or non-personal deployments rather than accepting an owner from a browser', async () => {
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, ownerOnly: false } } } })
  expect(await h.api('GET', 'loom')).toMatchObject({ status: 503 })
  expect(await h.api('PUT', 'loom/automation', { mode: 'auto', revision: h.runtime.store.blockRevision('eval') })).toMatchObject({ status: 503 })
  expect(await h.api('PATCH', 'loom/rules/copy', { enabled: false, revision: h.runtime.store.blockRevision('policy') })).toMatchObject({ status: 503 })
})

it('changes only the automation mode with CAS, preserving role models, budgets, sources and historical observations', async () => {
  const s = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...s, eval: { ...s.eval, mode: 'observe' } })
  const old = feishu('modeOld', '把文案改为“浏览网页”', { mentions: [] })
  h.runtime.receive(old); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: old.id })
  const assessment = { decision: 'accept', title: '修订文案', worktree_name: 'copy-label', scope: '修改文案为浏览网页', reason: '明确给出目标', intent_evidence: old.text,
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: old.text },
    rule_assessments: s.policy.rules.filter(r => r.enabled).map(r => ({ rule_id: r.id, matched: r.id === 'copy', reason: '文案规则' })) }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', { trigger_id: old.id, ...assessment })).toMatchObject({ decision: 'ignore' })
  const before = h.runtime.store.settings(), revision = h.runtime.store.blockRevision('eval')
  expect(await h.api('PUT', 'loom/automation', { mode: 'auto', revision })).toMatchObject({ status: 200, body: { mode: 'auto' } })
  await h.runtime.idle()
  const after = h.runtime.store.settings()
  expect(after).toEqual({ ...before, eval: { ...before.eval, mode: 'auto' } })
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(await h.api('PUT', 'loom/automation', { mode: 'observe', revision })).toMatchObject({ status: 409 })
  expect(await h.api('PUT', 'loom/automation', { mode: 'off', revision: h.runtime.store.blockRevision('eval'), model: 'overwritten' })).toMatchObject({ status: 400 })
  const fresh = feishu('modeNew', '把文案改为“浏览网页”', { mentions: [] })
  h.runtime.receive(fresh); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: fresh.id })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', { trigger_id: fresh.id, ...assessment })).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(await h.api('PUT', 'loom/automation', { mode: 'observe', revision: h.runtime.store.blockRevision('eval') })).toMatchObject({ status: 200, body: { mode: 'observe' } })
  expect(await h.api('PUT', 'loom/automation', { mode: 'off', revision: h.runtime.store.blockRevision('eval') })).toMatchObject({ status: 200, body: { mode: 'off' } })
})

it('switches existing base rules without changing instructions or delegated authorities', async () => {
  const created = await h.api('POST', 'loom/delegations', { title: '工作记录总结', chatIds: ['oc_team'], keywords: [], enabled: true, mode: 'auto', revision: h.runtime.store.blockRevision('policy'), requestId: crypto.randomUUID() })
  expect(created.status).toBe(200)
  const before = h.runtime.store.settings(), revision = h.runtime.store.blockRevision('policy')
  expect(await h.api('PATCH', 'loom/rules/copy', { enabled: false, revision })).toMatchObject({ status: 200, body: { id: 'copy', enabled: false } })
  expect(h.runtime.store.settings()).toEqual({ ...before, policy: { ...before.policy, rules: before.policy.rules.map(r => r.id === 'copy' ? { ...r, enabled: false } : r) } })
  expect(await h.api('PATCH', 'loom/rules/copy', { enabled: true, revision })).toMatchObject({ status: 409 })
  expect(await h.api('PATCH', `loom/rules/${created.body.id}`, { enabled: false, revision: h.runtime.store.blockRevision('policy') })).toMatchObject({ status: 404 })
  expect(await h.api('PATCH', 'loom/rules/copy', { enabled: true, revision: h.runtime.store.blockRevision('policy'), instruction: '越权变更' })).toMatchObject({ status: 400 })
  expect(await h.api('PATCH', 'loom/rules/unknown', { enabled: true, revision: h.runtime.store.blockRevision('policy') })).toMatchObject({ status: 404 })
  const view = await h.api('GET', 'loom')
  expect(view.body.automation).toMatchObject({ revision: h.runtime.store.blockRevision('eval'), maxWorkers: before.executor.maxWorkers, timeoutSeconds: before.eval.timeoutSeconds })
})

it('links intake events to the same authorized live task in one snapshot and preserves decision history through completion', async () => {
  const trigger=feishu('eventLive','整理本条资料，标明来源')
  h.runtime.receive(trigger);await h.runtime.idle()
  const pending=await h.api('GET','loom')
  expect((pending.body.events as {id:string;processing?:string;taskIds?:string[]}[]).find(event=>event.id===trigger.id)).toMatchObject({processing:'evaluating',taskIds:[]})
  const {ticket,sessionId}=await h.acceptedTicket(trigger)
  let view=await h.api('GET','loom')
  expect((view.body.events as {id:string;decision?:string;taskIds?:string[]}[]).find(event=>event.id===trigger.id)).toMatchObject({decision:'accept',taskIds:[ticket.id]})
  expect(view.body.tasks).toEqual([expect.objectContaining({id:ticket.id,status:'open',executionState:'running'})])
  await h.runTool(sessionId,'orchestrator_report',{state:'ready',summary:'已完成资料整理。'})
  view=await h.api('GET','loom')
  expect((view.body.events as {id:string;decision?:string;taskIds?:string[]}[]).find(event=>event.id===trigger.id)).toMatchObject({decision:'accept',taskIds:[ticket.id]})
  expect(view.body.tasks).toEqual([expect.objectContaining({id:ticket.id,completed:true})])
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('never discloses a task association through an otherwise visible event after one of its source contexts is revoked',async()=>{
  const {ticket,trigger}=await h.acceptedTicket(feishu('eventScope1','整理记录'))
  const revoked=feishu('eventScope2','额外私人资料',{chat_id:'oc_revoked'})
  h.runtime.store.triggers.save(revoked)
  const current=h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({...current,inputs:[...current.inputs,{id:'source-revoked',kind:'trigger',triggerId:revoked.id,at:revoked.at}]})
  const view=await h.api('GET','loom')
  expect(view.body.tasks).toEqual([])
  expect((view.body.events as {id:string;taskIds?:string[]}[]).find(event=>event.id===trigger.id)).toMatchObject({taskIds:[]})
  expect((view.body.events as {id:string}[]).some(event=>event.id===revoked.id)).toBe(false)
})
