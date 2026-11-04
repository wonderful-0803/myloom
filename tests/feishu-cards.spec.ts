import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, MEMBER, CHAT, type Host } from './fixtures/host.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { assistantCard } from '../src/app/feishu-cards.ts'

let h: Host, sent = 0
beforeEach(async () => { h = await startRuntime(undefined, { github: false }); sent = 0 })
afterEach(async () => { await h.stop() })
const command = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ ...feishu(id, text, { chat_type: 'p2p', ...extra }), at: new Date().toISOString() })
function cardsOn() {
  const settings = h.runtime.store.settings(), source = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...source, config: { ...source.config, cardsEnabled: true } } } })
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => args.includes('+messages-reply') ? { message_id: `om_card${++sent}` } : {})
}
function grantFor(action: string) {
  return h.runtime.store.keys(KV.cards.grant).map(name => h.runtime.store.get(name)!).filter(value => value.action === action).at(-1)!
}
const eventFor = (grant: ReturnType<typeof grantFor>, event_id = 'native-1', extra: Record<string, unknown> = {}) => ({
  type: 'card.action.trigger', event_id, operator_id: MEMBER, chat_id: CHAT, message_id: grant.messageId,
  timestamp: String(Date.now()), host: 'im_message', action_tag: 'button', action_value: JSON.stringify({ grant: grant.token }), ...extra,
})

it('renders actual Card 2.0 messages and authenticates the native callback against the sent card', async () => {
  const { ticket } = await h.acceptedTicket(feishu('card1', '总结记录'))
  cardsOn()
  h.runtime.receive(command('card2', '我的任务')); await h.runtime.idle()
  const select = grantFor('状态')
  expect(select.messageId).toMatch(/^om_card/)
  const call = vi.mocked(Commands.prototype.lark).mock.calls.find(([args]) => args.includes('--content'))![0]
  expect(JSON.parse(call[call.indexOf('--content') + 1]!)).toMatchObject({ schema: '2.0' })
  const native = h.runtime.context({ kind: 'feishu', health: [] }).cardAction!
  expect(await native(eventFor(select, 'wrong-user', { operator_id: 'ou_other' }))).toBe('filtered')
  expect(await native(eventFor(select, 'forwarded', { message_id: 'om_forwarded' }))).toBe('filtered')
  expect(await native(eventFor(select))).toBe('stored'); await h.runtime.idle()
  expect(await native(eventFor(select))).toBe('duplicate')
  const pause = grantFor('暂停')
  expect(await native(eventFor(pause, 'pause'))).toBe('stored'); await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  h.runtime.receive(command('card9', `/助手 状态 ${ticket.id}`)); await h.runtime.idle()
  const resume = grantFor('继续')
  h.runtime.controls.change(ticket.id, 'resume', 1)
  h.runtime.controls.change(ticket.id, 'pause', 2)
  expect(await native(eventFor(resume, 'stale-resume'))).toBe('stored'); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).revision).toBe(3)
  expect(h.runtime.controls.view(ticket.id).mode).not.toBe('agent')
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('saves a form as a new version once and refuses stale or edited grant payloads', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('card3', '总结工作'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '旧正文' })
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  cardsOn()
  h.runtime.receive(command('card4', `/助手 编辑 ${ticket.id}`)); await h.runtime.idle()
  const save = grantFor('保存改稿')
  const event = eventFor(save, 'save', { action_name: `save_${save.token}`, form_value: JSON.stringify({ body: '本人确认的新正文' }) })
  expect(h.runtime.feishuAssistant.receiveCard(event)).toBe('stored'); await h.runtime.idle()
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)).toMatchObject({ version: 2, author: 'human', body: '本人确认的新正文' })
  expect(h.runtime.feishuAssistant.receiveCard({ ...event, event_id: 'second' })).toBe('filtered')
  expect(h.runtime.artifacts.history(ticket.id, MEMBER)).toHaveLength(2)
})

it('escapes model and human text, binds natural references, and rejects multiple commands without execution', async () => {
  const card = JSON.stringify(assistantCard('产物', '<at id=all></at> [danger](https://example.invalid)'))
  expect(card).not.toContain('<at')
  const { ticket } = await h.acceptedTicket(feishu('card5', '总结工作'))
  h.runtime.receive(command('card6', `/助手 状态 ${ticket.id}`)); await h.runtime.idle()
  h.runtime.receive(command('card7', '暂停这个任务', { parent_id: 'om_card6', root_id: 'om_card6' })); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).not.toBe('agent')
  h.runtime.receive(command('card8', `/助手 继续 ${ticket.id} r1\n/助手 邮箱`)); await h.runtime.idle()
  expect(h.runtime.controls.view(ticket.id).mode).not.toBe('agent')
})
