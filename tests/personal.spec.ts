import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { defaultPrompts } from '../src/app/prompts.ts'

const personal = SettingsSchema.parse(JSON.parse(readFileSync(new URL('../examples/personal.settings.json', import.meta.url), 'utf8')))
let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { github: false }) })
afterEach(async () => { await h.stop() })

describe('Feishu-only personal assistant', () => {
  it('starts without a repository or GitHub account and advertises only available skills', async () => {
    expect(h.runtime.configured()).toBe(true)
    expect(h.runtime.setupProblem).toBeUndefined()
    expect(h.runtime.deployment.github).toBeUndefined()
    expect(h.runtime.deployment.repository).toBe('')
    expect(h.runtime.prompts.skills(defaultPrompts()).map(([name]) => name)).toEqual(['feishu', 'office'])
    expect(h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.some(arg => arg.endsWith('agent-gh')))).toBe(false)
    expect((await h.api('GET', 'state')).body).toMatchObject({ setup: { problem: null, accounts: { repository: '', agent: '', feishu: { botId: 'ou_bot' } } } })
    vi.mocked(Commands.prototype.gh).mockRestore()
    await expect(h.runtime.commands.gh(['api', 'user'])).rejects.toThrow('no working agent CLI')
    await expect(h.runtime.commands.api('issues')).rejects.toThrow('no working agent CLI')
  })

  it('keeps setup pending when no Source is usable and reports errors in the only configured bot', async () => {
    const setup = new Setup({ context: h.ctx, machine: h.runtime.machine, lifetime: h.runtime.lifetime, restart: vi.fn() })
    const settings = h.runtime.store.settings()
    const empty = { ...settings, sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} } } }
    expect(await setup.run(empty)).toBe(false)
    expect(setup.configured()).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'deployment', code: 'sourceUnset' })
    const broken = { ...empty, sources: { ...empty.sources, feishu: { enabled: true, config: { cli: '/not/a/working/bot-cli' } } } }
    expect(await setup.run(broken)).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'feishu', code: 'feishuCliFailed' })
  })

  it('checks an account before re-enabling GitHub instead of accepting an empty integration', async () => {
    const { settings, store } = h.runtime
    await expect(settings.save('source:github', { enabled: true, config: {} }, store.blockRevision('source:github'), 'panel')).rejects.toThrow('names no repository')
    expect(store.settings().sources.github?.enabled).toBe(false)
  })

  it('completes an office deliverable without a PR and delivers its result once', async () => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '总结本话题今天的项目进展，列出来源。'))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '项目进展：资料已收齐。来源：本话题消息 om_1；范围：今天。' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    expect(h.runtime.store.tickets.get(ticket.id)?.follows ?? []).toEqual([])
    const reply = { purpose: 'result', ticket_id: ticket.id, text: '资料已收齐，来源：om_1。' }
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_reply', reply)).toEqual({ status: 'sent' })
    await h.runtime.idle()
    expect(h.runtime.store.read.droppedReplies(10)).toEqual([])
    const replies = h.runtime.store.db.prepare("SELECT value FROM outbox WHERE json_extract(value, '$.text') = ?").all(reply.text)
    expect(replies).toHaveLength(1)
    await h.runTool(h.runtime.masterId, 'orchestrator_reply', reply)
    await h.runtime.idle()
    expect(h.runtime.store.db.prepare("SELECT value FROM outbox WHERE json_extract(value, '$.text') = ?").all(reply.text)).toHaveLength(1)
    const sends = vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes(reply.text))
    expect(sends).toHaveLength(1)
    expect(sends[0]?.[0]).toEqual(expect.arrayContaining(['--message-id', 'om_1', '--reply-in-thread', '--idempotency-key']))
  })

  it('resumes the same office task on a human follow-up after completion', async () => {
    const { ticket, sessionId, trigger } = await h.acceptedTicket(feishu('2', '总结这个话题，输出工作进展。'))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '已整理工作进展，来源为本话题。' })
    const followup = feishu('3', '补上下一步安排。', { root_id: trigger.meta.messageId, parent_id: trigger.meta.messageId, mentions: [] })
    h.runtime.receive(followup)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(h.runtime.store.tickets.get(ticket.id)?.inputs).toContainEqual(expect.objectContaining({ triggerId: followup.id }))
    expect(h.runtime.store.decisions.byThread(followup.threads[0]!.source + ':' + followup.threads[0]!.id)).toHaveLength(1)
  })

  it('rejects a PR report when repository integration is unavailable', async () => {
    const { sessionId } = await h.acceptedTicket(feishu('6', '总结本话题。'))
    await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done', pr_number: 1 })).rejects.toThrow('no working agent CLI')
  })

  it('does not admit an unlisted sender as a new personal request', async () => {
    const trigger = feishu('4', '读取个人资料并汇总。', { sender_id: 'ou_stranger' })
    h.runtime.receive(trigger)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toEqual([])
    expect(h.runtime.engine.candidate(trigger.id)).toBeUndefined()
  })

  it('validates the personal settings template and observes proactive office work silently', async () => {
    const source = personal.sources.feishu!
    expect(feishuKind.schema.parse(source.config)).toMatchObject({ directMessages: true, otherChats: 'none', chats: [] })
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, rules: personal.policy.rules }, eval: { ...settings.eval, mode: 'observe' } })
    const trigger = feishu('5', '请按本话题消息总结今天进展。', { mentions: [] })
    h.runtime.receive(trigger)
    await h.runtime.idle()
    await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', {
      trigger_id: trigger.id, decision: 'accept', title: '工作总结', worktree_name: 'daily-summary', scope: 'Summarize this thread today.',
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: trigger.text },
      intent_evidence: trigger.text, reason: 'The owner requested a summary of this thread.',
      rule_assessments: personal.policy.rules.map(rule => ({ rule_id: rule.id, matched: rule.id === 'office-summary', reason: rule.id === 'office-summary' ? 'A defined summary request.' : 'Another task type.' })),
    })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toEqual([])
    const decision = h.runtime.store.decisions.byThread(trigger.threads[0]!.source + ':' + trigger.threads[0]!.id)[0]!
    expect(decision).toMatchObject({ kind: 'ignore', audit: { would_accept: true } })
    expect(h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  })

  it('starts inferred office work in auto mode without an acknowledgement or duplicate ticket', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, rules: personal.policy.rules } })
    const trigger = feishu('7', '需要按本话题整理今天进展和阻碍。', { mentions: [] })
    h.runtime.receive(trigger)
    await h.runtime.idle()
    await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', {
      trigger_id: trigger.id, decision: 'accept', title: '今日进展', worktree_name: 'work-summary', scope: 'Summarize today in this thread.',
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: trigger.text },
      intent_evidence: trigger.text, reason: 'The owner needs a bounded work summary.',
      rule_assessments: personal.policy.rules.map(rule => ({ rule_id: rule.id, matched: rule.id === 'office-summary', reason: rule.id === 'office-summary' ? 'The requested summary.' : 'A different task.' })),
    })
    await h.runtime.idle()
    const tickets = h.runtime.store.tickets.list()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]?.mandate).toMatchObject({ strength: 'inferred', scope: 'Summarize today in this thread.' })
    expect(h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
    expect(h.runtime.receive(trigger)).toBe('duplicate')
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
  })
})
