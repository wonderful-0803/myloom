/** Standing delegations use the real owner API, policy evaluator, executor and immutable artifact services. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { assessmentOutcome, delegationMatches, settingsPolicy, type Assessment } from '../src/policy.ts'
import { policySection } from '../src/app/prompts.ts'
import type { LoomSnapshot } from '../src/app/loom-types.ts'
import type { Trigger } from '../src/core/index.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime(undefined, { github: false })
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, eval: { ...s.eval, mode: 'observe' },
    sources: { ...s.sources, feishu: { ...source, config: { ...source.config, ownerOnly: true } } } })
})
afterEach(async () => { await h.stop() })
const revision = () => h.runtime.store.blockRevision('policy')
const input = (extra = {}) => ({ title: '整理我的工作记录', description: '根据本人工作记录整理总结，标记来源；不联系他人。',
  chatIds: [CHAT], keywords: ['工作记录'], enabled: true, mode: 'auto', requestId: randomUUID(), revision: revision(), ...extra })
async function create(extra = {}) {
  const result = await h.api('POST', 'loom/delegations', input(extra))
  expect(result.status).toBe(200)
  return String(result.body.id)
}
async function snapshot() { return (await h.api('GET', 'loom')).body as unknown as LoomSnapshot }
const event = (id: string, text = '工作记录：R1 完成访谈；R2 明天复核渠道。', extra = {}) =>
  feishu(id, text, { mentions: [], create_time: String(Date.now() + 100), ...extra })
function assessment(trigger: Trigger, matched: string[]): Assessment {
  return { decision: 'accept', title: '工作记录总结', scope: '仅整理当前消息 R1、R2，按来源交付总结。', reason: '本人持续委托和新记录共同提供目标与依据。',
    intent_evidence: trigger.text, worktree_name: 'work-summary',
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: '持续委托规定目标，当前记录提供具体材料。' },
    rule_assessments: h.runtime.store.settings().policy.rules.filter(rule => rule.enabled)
      .map(rule => ({ rule_id: rule.id, matched: matched.includes(rule.id), reason: matched.includes(rule.id) ? '符合委托目标与范围' : '不符合此规则' })) }
}
async function decide(trigger: Trigger, matched: string[]) {
  h.runtime.receive(trigger); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  const result = await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', { trigger_id: trigger.id, ...assessment(trigger, matched) })
  await h.runtime.idle()
  return result
}
async function accept(trigger: Trigger, id: string) {
  const result = await decide(trigger, [id, 'copy'])
  expect(result).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  return h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
}

it('persists one owner-scoped policy and a configuration receipt, without fabricating a trigger or starting work', async () => {
  const body = input(), before = h.runtime.store.settings().policy.sources
  const response = await h.api('POST', 'loom/delegations', body)
  expect(response.status).toBe(200)
  const id = String(response.body.id)
  expect(h.runtime.store.settings().eval.mode).toBe('observe')
  expect(h.runtime.store.settings().policy.sources).toEqual(before)
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.candidates()).toEqual([])
  expect(h.runtime.store.db.prepare('SELECT count(*) AS n FROM trigger').get()?.n).toBe(0)
  expect(h.runtime.delegations.activity(MEMBER)).toEqual([expect.objectContaining({ delegationId: id, action: 'created', revision: revision() })])
  const view = await snapshot()
  expect(view.delegations).toEqual([expect.objectContaining({ id, enabled: true, available: true, taskIds: [], chatIds: [CHAT] })])
  expect(view.events).toEqual([expect.objectContaining({ system: true, chat: '持续委托' })])
  expect(policySection(h.runtime.store.settings()).text).toContain('This instruction supplies the ongoing work request')
  expect(await h.api('POST', 'loom/delegations', body)).toMatchObject({ status: 200, body: { id, replay: true } })
  expect(await h.api('POST', 'loom/delegations', { ...body, title: '变更重放' })).toMatchObject({ status: 409 })
  expect(h.runtime.delegations.activity(MEMBER)).toHaveLength(1)
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    expect(reopened.settings().policy.rules.find(rule => rule.id === id)?.delegation?.owner).toBe(MEMBER)
    expect(reopened.keys(KV.delegations.activity)).toHaveLength(1)
  } finally { reopened.close() }
})

it('rejects stale saves, forged owners and unobserved groups without losing unrelated policies or writing a receipt', async () => {
  const stale = input(), id = await create(), count = h.runtime.store.settings().policy.rules.length
  expect(await h.api('POST', 'loom/delegations', stale)).toMatchObject({ status: 409 })
  expect(await h.api('POST', 'loom/delegations', input({ owner: 'ou_intruder' }))).toMatchObject({ status: 400 })
  expect(await h.api('POST', 'loom/delegations', input({ chatIds: ['oc_other'] }))).toMatchObject({ status: 400 })
  expect(await h.api('PATCH', `loom/delegations/${id}`, { enabled: false, revision: 0 })).toMatchObject({ status: 409 })
  expect(await h.api('PATCH', 'loom/delegations/unknown', { enabled: false, revision: revision() })).toMatchObject({ status: 404 })
  expect(h.runtime.store.settings().policy.rules).toHaveLength(count)
  expect(h.runtime.delegations.activity(MEMBER)).toHaveLength(1)
})

it('creates a genuine inferred ticket and worker under a per-rule auto delegation while legacy rules stay observational', async () => {
  const id = await create(), trigger = event('standing1'), ticket = await accept(trigger, id)
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'candidate', mode: 'observe', standing_delegations: [{ rule_id: id, mode: 'auto' }] }))
  expect(ticket.mandate).toMatchObject({ strength: 'inferred', basis: { rules: [id], observation: { mode: 'observe' } } })
  expect(h.agents.has(`worker-${ticket.id}`)).toBe(true)
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` }))
    .toMatchObject({ text: expect.stringContaining('本人工作记录') })
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'ready', summary: '已完成：访谈。[R1]\n下一步：复核渠道。[R2]' })
  const view = await snapshot()
  expect(view.delegations[0]?.taskIds).toEqual([ticket.id])
  expect(view.tasks).toEqual([expect.objectContaining({ id: ticket.id, completed: true, ruleIds: [id] })])
  expect(view.artifacts).toEqual([expect.objectContaining({ subject: ticket.id, author: 'agent', version: 1, sources: [expect.objectContaining({ triggerId: trigger.id })] })])
  h.runtime.receive(trigger); await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(await decide(event('legacy2', '把文案改为“浏览网页”'), ['copy'])).toMatchObject({ decision: 'ignore' })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('keeps independent delegations and task sessions without requiring an imperative in every new message', async () => {
  const first = await create(), second = await create({ title: '整理我的资料线索', description: '对本人发出的资料记录整理两句摘要，仅用本消息。', keywords: ['资料记录'] })
  const a = await accept(event('parallel1'), first)
  const b = await accept(event('parallel2', '资料记录：R3 一个测试项目提供消息路由功能。'), second)
  expect(a.id).not.toBe(b.id)
  expect(a.mandate.basis.rules).toEqual([first])
  expect(b.mandate.basis.rules).toEqual([second])
  expect(h.agents.has(`worker-${a.id}`)).toBe(true)
  expect(h.agents.has(`worker-${b.id}`)).toBe(true)
  expect((await snapshot()).delegations.map(item => item.taskIds)).toEqual([[a.id], [b.id]])
})

it('filters false model matches by native sender, source, group, freshness and optional keywords', async () => {
  const id = await create(), rule = h.runtime.store.settings().policy.rules.find(rule => rule.id === id)!
  const original = event('bounds1')
  const invalid: Trigger[] = [
    event('bounds2', undefined, { sender_id: 'ou_intruder' }), event('bounds3', undefined, { chat_id: 'oc_other' }),
    event('bounds4', undefined, { chat_type: 'p2p' }), event('bounds5', '普通闲聊'),
    { ...original, at: '2026-01-01T00:00:00.000Z' }, { ...original, source: 'github' }, { ...original, human: false },
  ]
  const policy = settingsPolicy(h.runtime.store.settings(), h.runtime.sources)
  for (const trigger of invalid) {
    expect(delegationMatches(rule, [trigger])).toBe(false)
    expect(assessmentOutcome(assessment(trigger, [id]), h.runtime.store.settings(), 'inferred', [trigger]).kind).toBe('ignore')
    expect(policy.admitsInferred([id], [trigger])).toBe(false)
  }
  expect(policy.admitsInferred([id], [])).toBe(false)
  expect(policy.admitsInferred([id], [original])).toBe(true)
  expect(assessmentOutcome({ ...assessment(original, [id]), direction: { implementation_requested: true, target_basis: 'undetermined', requires_design_decision: true, evidence: '未决定交付目标' } },
    h.runtime.store.settings(), 'inferred', [original])).toMatchObject({ kind: 'ignore', reason: { code: 'directionUnsettled' } })
})

it('supports observe-only delegations and saves edited boundaries without activating historical events', async () => {
  const id = await create({ mode: 'observe' }), old = event('edit1')
  expect(await decide(old, [id])).toMatchObject({ decision: 'ignore' })
  expect(h.runtime.store.tickets.list()).toEqual([])
  const body = input({ mode: 'auto', title: '仅整理新的工作记录' })
  const { requestId: _request, ...edit } = body
  expect(await h.api('PUT', `loom/delegations/${id}`, edit)).toMatchObject({ status: 200 })
  const rule = h.runtime.store.settings().policy.rules.find(rule => rule.id === id)!
  expect(delegationMatches(rule, [{ ...old, at: new Date(Date.parse(rule.delegation!.since) - 1).toISOString() }])).toBe(false)
  expect(h.runtime.delegations.activity(MEMBER).map(item => item.action)).toContain('updated')
  await accept(event('edit2'), id)
})

it('refuses forged engine acceptance when a real candidate falls outside the standing rule', async () => {
  const id = await create(), trigger = event('forged1', '普通闲聊：周末愉快')
  h.runtime.receive(trigger); await h.runtime.idle()
  expect(() => h.runtime.engine.decide(trigger.id, { kind: 'accept', title: '强制接单', scope: '伪造匹配', reason: 'forged', rules: [id] })).toThrow()
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
})

it('pauses unfinished work, prevents new acceptance, and preserves history and deliverables when switched off', async () => {
  const id = await create(), done = await accept(event('pause1'), id)
  await h.runTool(`worker-${done.id}`, 'orchestrator_report', { state: 'ready', summary: '完成 R1。[R1]' })
  const live = await accept(event('pause2'), id)
  expect(await h.api('PATCH', `loom/delegations/${id}`, { enabled: false, revision: revision() })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.controls.view(live.id).mode).toBe('paused'))
  expect(h.runtime.store.settings().policy.rules.find(rule => rule.id === id)?.enabled).toBe(false)
  expect(h.runtime.artifacts.get(done.id, MEMBER)?.body).toBe('完成 R1。[R1]')
  expect((await snapshot()).delegations[0]).toMatchObject({ enabled: false, taskIds: expect.arrayContaining([done.id, live.id]) })
  expect(await decide(event('pause3'), ['copy'])).toMatchObject({ decision: 'ignore' })
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
  expect(await h.api('POST', `loom/tasks/${live.id}/control`, { action: 'resume', revision: h.runtime.controls.view(live.id).revision })).toMatchObject({ status: 409 })
  expect(await h.api('PATCH', `loom/delegations/${id}`, { enabled: true, revision: revision() })).toMatchObject({ status: 200 })
  expect(h.runtime.controls.view(live.id).mode).toBe('paused')
})

it('refuses a pending candidate after the delegation is disabled and rechecks source authorization at the engine gate', async () => {
  const id = await create(), trigger = event('pending1')
  h.runtime.receive(trigger); await h.runtime.idle()
  const proposal = assessment(trigger, [id])
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  await h.api('PATCH', `loom/delegations/${id}`, { enabled: false, revision: revision() })
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', { trigger_id: trigger.id, ...proposal })).rejects.toThrow()
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  await h.api('PATCH', `loom/delegations/${id}`, { enabled: true, revision: revision() })
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, chats: [{ chatId: CHAT, listen: 'mentions' }] } } } })
  expect(settingsPolicy(h.runtime.store.settings(), h.runtime.sources).admitsInferred([id], [event('pending2')])).toBe(false)
  expect((await snapshot()).delegations[0]?.available).toBe(false)
})

it('prevents model-origin policy mutation from granting or changing a standing delegation', async () => {
  const id = await create(), policy = h.runtime.store.settings().policy
  for (const rules of [policy.rules.map(rule => rule.id === id ? { ...rule, enabled: false } : rule), policy.rules.filter(rule => rule.id !== id)]) {
    await expect(h.runtime.settings.save('policy', { ...policy, rules }, revision(), 'tool')).rejects.toThrow('只能由本机所有者')
  }
  expect(h.runtime.store.settings().policy).toEqual(policy)
  expect(h.runtime.delegations.activity(MEMBER)).toHaveLength(1)
})

it('holds automatic delegation tasks when the receiving source is revoked through versioned settings', async () => {
  const id = await create(), ticket = await accept(event('revoke1'), id), s = h.runtime.store.settings(), source = s.sources.feishu!
  await h.runtime.settings.save('source:feishu', { ...source, config: { ...source.config, chats: [], otherChats: 'none' } }, h.runtime.store.blockRevision('source:feishu'), 'panel')
  await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  expect((await snapshot()).tasks).toEqual([])
  expect((await snapshot()).delegations[0]?.available).toBe(false)
})
