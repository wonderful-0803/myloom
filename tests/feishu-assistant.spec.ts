import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { assistantCommand } from '../src/app/feishu-assistant.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { github: false }) })
afterEach(async () => { await h.stop() })
const command = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  ...feishu(id, text, extra), at: new Date().toISOString(),
})
const replies = () => vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('+messages-reply'))
const lastText = () => { const args = replies().at(-1)![0]; return args[args.indexOf('--text') + 1]! }

it('queries owned tasks without creating work, resuming a completed task or feeding the command to the model', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '总结三条虚构记录'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '已完成：记录核对。来源 R1。' })
  const query = command('2', '我的任务', { chat_type: 'p2p', mentions: [] })
  expect(h.runtime.receive(query)).toBe('stored'); await h.runtime.idle()
  expect(lastText()).toContain(ticket.id)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeDefined()
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === query.id)).toBe(false)
  expect(h.runtime.engine.candidate(query.id)).toBeUndefined()
  expect(h.runtime.receive(query)).toBe('duplicate'); await h.runtime.idle()
  expect(replies().filter(([args]) => args.includes('om_2'))).toHaveLength(1)
})

it('exports the saved report as a real file to the owner in private, and never reads an arbitrary local path', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('3', '汇总虚构数据'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '合计 12.80。来源：本任务 CSV。' })
  h.runtime.receive(command('4', `/助手 导出 ${ticket.id}`, { chat_type: 'p2p' })); await h.runtime.idle()
  const [args, cwd] = replies().at(-1)!
  expect(args).toEqual(expect.arrayContaining(['--file', './result.txt', '--message-id', 'om_4']))
  expect(cwd).toBeDefined()
  expect(readFileSync(join(cwd!, 'result.txt'), 'utf8')).toContain('合计 12.80')
  h.runtime.receive(command('5', '/助手 导出 /etc/passwd', { chat_type: 'p2p' })); await h.runtime.idle()
  expect(lastText()).toContain('未找到唯一')
})

it('authenticates both incoming commands and pending deliveries, including when ownerOnly is off', async () => {
  const { ticket } = await h.acceptedTicket(feishu('6', '只有原所有者可看'))
  const bad = command('7', `/助手 状态 ${ticket.id}`, { sender_id: 'ou_stranger', chat_type: 'p2p' })
  expect(h.runtime.receive(bad)).toBe('filtered'); await h.runtime.idle()
  expect(replies().some(([args]) => args.includes('om_7'))).toBe(false)
  const source = h.runtime.store.settings().sources.feishu!
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), sources: { ...h.runtime.store.settings().sources,
    feishu: { ...source, enabled: false } } })
  expect(h.runtime.receive(command('8', '我的任务', { chat_type: 'p2p' }))).toBe('filtered')
})

it('uses the real source ingress and drops queued private results after the owner is revoked', async () => {
  const { ticket } = await h.acceptedTicket(feishu('24', '待发查询权限复核'))
  const query = command('25', `/助手 状态 ${ticket.id}`, { chat_type: 'p2p' })
  expect(h.runtime.context({ kind: 'feishu', health: [] }).receive(query)).toBe('stored')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
    feishu: { ...settings.policy.sources.feishu, allowed: [] } } } })
  await h.runtime.idle()
  expect(h.runtime.store.get(KV.feishu.assistant(query.id))?.status).toBe('dropped')
  expect(replies().some(([args]) => args.includes('om_25'))).toBe(false)
})

it('removes revoked source tasks from a pending private list even while private chat remains allowed', async () => {
  const { ticket } = await h.acceptedTicket(feishu('28', '待撤销的群任务'))
  const query = command('29', '我的任务', { chat_type: 'p2p' })
  h.runtime.receive(query)
  const settings = h.runtime.store.settings(), source = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    feishu: { ...source, config: { ...source.config, chats: [], otherChats: 'none' } } } })
  await h.runtime.idle()
  expect(lastText()).not.toContain(ticket.id)
  expect(lastText()).toContain('没有可显示')
})

it('keeps group queries bound to their original task and withholds report bodies and other task IDs', async () => {
  const a = await h.acceptedTicket(feishu('9', '任务 A'))
  const b = await h.acceptedTicket(feishu('10', '任务 B'))
  await h.runTool(a.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PRIVATE_REPORT_SENTINEL' })
  const extra = { root_id: 'om_9', parent_id: 'om_9', mentions: [] }
  h.runtime.receive(command('11', '/助手 状态', extra)); await h.runtime.idle()
  expect(lastText()).toContain(a.ticket.id)
  expect(lastText()).not.toContain('PRIVATE_REPORT_SENTINEL')
  h.runtime.receive(command('12', `/助手 状态 ${b.ticket.id}`, extra)); await h.runtime.idle()
  expect(lastText()).not.toContain(b.ticket.id)
  h.runtime.receive(command('13', '/助手 产物', extra)); await h.runtime.idle()
  expect(lastText()).toContain('私聊')
  expect(lastText()).not.toContain('PRIVATE_REPORT_SENTINEL')
})

it('pauses and takes over through Feishu, rejects stale resume revisions and never auto-resumes on query', async () => {
  const { ticket } = await h.acceptedTicket(feishu('14', '受控任务'))
  const extra = { root_id: 'om_14', parent_id: 'om_14', mentions: [] }
  const pause = command('15', '/助手 暂停', extra)
  h.runtime.receive(pause); await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  h.runtime.receive(command('16', '/助手 状态', extra)); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).toBe('paused')
  expect(lastText()).toContain('r1')
  h.runtime.receive(command('17', '/助手 继续 r0', extra)); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).toBe('paused')
  h.runtime.receive(command('18', '/助手 继续 r1', extra)); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).toBe('agent')
  expect(h.runtime.receive(pause)).toBe('duplicate')
  expect(h.runtime.controls.view(ticket.id).mode).toBe('agent')
  h.runtime.receive(command('19', '/助手 接管', extra)); await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  h.runtime.receive(command('20', '/助手 交还 r3', extra)); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).toBe('agent')
})

it('refuses expired or quoted control instructions and does not repeat an uncertain send', async () => {
  const { ticket } = await h.acceptedTicket(feishu('21', '消息重放保护'))
  h.runtime.receive(feishu('22', '/助手 暂停', { root_id: 'om_21' })); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).toBe('agent')
  expect(assistantCommand(command('26', '> /助手 暂停'))).toBeUndefined()
  expect(assistantCommand(command('27', '文档内容：\n/助手 接管'))).toBeUndefined()
  const trigger = command('23', '我的任务', { chat_type: 'p2p' })
  vi.mocked(Commands.prototype.lark).mockRejectedValueOnce(new Error('response lost'))
  h.runtime.receive(trigger); await h.runtime.idle()
  expect(h.runtime.store.get(KV.feishu.assistant(trigger.id))?.status).toBe('unknown')
  const count = replies().length
  h.runtime.effects.enqueue('assistant', trigger.id, {}); await h.runtime.idle()
  expect(replies()).toHaveLength(count)
  expect(h.runtime.receive(trigger)).toBe('duplicate')
})

it('resumes from a quoted status snapshot without copying IDs, but refuses an older quote after another pause', async () => {
  const { ticket } = await h.acceptedTicket(feishu('natural1', '引用状态控制'))
  h.runtime.controls.change(ticket.id, 'pause', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ message_id: 'om_statusreply' })
  h.runtime.receive(command('natural2', `/助手 状态 ${ticket.id}`, { chat_type: 'p2p' })); await h.runtime.idle()
  const reply = { chat_type: 'p2p', parent_id: 'om_statusreply', root_id: 'om_statusreply' }
  h.runtime.receive(command('natural3', '继续这个任务', reply)); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).toBe('agent')
  h.runtime.controls.change(ticket.id, 'pause', 2)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  h.runtime.receive(command('natural4', '继续这个任务', reply)); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).toBe('paused')
  expect(h.runtime.controls.view(ticket.id).revision).toBe(3)
})

it('uses only the explicitly selected private task and clears focus when a multiple-task list needs a selection', async () => {
  const a = await h.acceptedTicket(feishu('focusa', '任务 A')), b = await h.acceptedTicket(feishu('focusb', '任务 B'))
  let sent = 0
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => args.includes('+messages-reply') ? { message_id: `om_taskfocus${++sent}` } : {})
  h.runtime.receive(command('focus1', `/助手 状态 ${a.ticket.id}`, { chat_type: 'p2p' })); await h.runtime.idle()
  h.runtime.receive(command('focus2', '暂停这个任务', { chat_type: 'p2p' })); await h.runtime.idle()
  expect(h.runtime.controls.view(a.ticket.id).mode).not.toBe('agent')
  expect(h.runtime.controls.view(b.ticket.id).mode).toBe('agent')
  h.runtime.receive(command('focus3', '我的任务', { chat_type: 'p2p' })); await h.runtime.idle()
  h.runtime.receive(command('focus4', '暂停这个任务', { chat_type: 'p2p' })); await h.runtime.idle()
  expect(h.runtime.controls.view(b.ticket.id).mode).toBe('agent')
  expect(lastText()).toContain('未找到唯一')
})
