import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { startRuntime, feishu, MEMBER, CHAT, type Host } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'

let h: Host
const rules = JSON.parse(readFileSync(new URL('../examples/personal.settings.json', import.meta.url), 'utf8')).policy.rules
beforeEach(async () => { h = await startRuntime(undefined, { github: false }) })
afterEach(async () => { await h.stop() })
function configure(limit = 3) {
  const settings = h.runtime.store.settings(), source = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'observe' },
    executor: { ...settings.executor, model: { provider: 'fake', model: 'summary-test' } }, policy: { ...settings.policy, rules },
    sources: { ...settings.sources, feishu: { ...source, config: { ...source.config, draftsEnabled: true,
      draftChats: [{ chatId: CHAT }], draftDailyLimit: limit } } } })
}
const stream = (wait?: Promise<void>) => {
  const mock = vi.fn(async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    expect(options.tools).toEqual([]); expect(options.maxTokens).toBe(900)
    expect(options.messages).toHaveLength(1)
    if (wait) await wait
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已完成：R1 整理访谈；下一步：R2 复核。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  Object.assign(h.ctx.llm, { stream: mock }); return mock
}
async function observe(id: string, text = '工作总结草稿：R1 完成访谈整理；R2 明天复核。') {
  const trigger = { ...feishu(id, text, { mentions: [] }), at: new Date().toISOString() }
  h.runtime.receive(trigger); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', {
    trigger_id: trigger.id, decision: 'accept', title: '今日工作总结', worktree_name: 'daily-summary', scope: 'Summarize only supplied records.',
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: text },
    intent_evidence: text, reason: 'Owner supplied a bounded work summary request.',
    rule_assessments: rules.map((rule: { id: string }) => ({ rule_id: rule.id, matched: rule.id === 'office-summary', reason: 'This is a summary.' })),
  })
  return trigger
}

it('keeps observe decisions silent while producing one private, tool-free, provenance-bound draft', async () => {
  configure(); const model = stream()
  const trigger = await observe('quiet1'); await h.runtime.idle()
  const [draft] = h.runtime.quietDrafts.list(MEMBER)
  expect(draft).toMatchObject({ status: 'ready', sourceIds: [trigger.id] })
  expect(h.runtime.artifacts.get(draft!.id, MEMBER)).toMatchObject({ kind: 'draft', version: 1 })
  expect(h.runtime.artifacts.get(draft!.id, 'ou_other')).toBeUndefined()
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  expect(vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(0)
  const decision = h.runtime.store.decisions.get(draft!.decisionId)!
  expect(decision).toMatchObject({ kind: 'ignore', audit: { would_accept: true } })
  h.runtime.quietDrafts.observe(decision); await h.runtime.idle()
  expect(model).toHaveBeenCalledTimes(1)
})

it('charges the daily budget before a call and does not replay an interrupted attempt', async () => {
  configure(1); const model = stream()
  await observe('quiet2'); await h.runtime.idle()
  await observe('quiet3'); await h.runtime.idle()
  expect(model).toHaveBeenCalledTimes(1)
  const drafts = h.runtime.quietDrafts.list(MEMBER)
  expect(drafts.map(draft => draft.status).sort()).toEqual(['budget', 'ready'])
  const draft = drafts.find(item => item.status === 'ready')!
  h.runtime.store.set(KV.drafts.record(draft.id), { ...draft, status: 'running' })
  h.runtime.effects.enqueue('draft', draft.id, {}); await h.runtime.idle()
  expect(h.runtime.store.get(KV.drafts.record(draft.id))?.status).toBe('interrupted')
  expect(model).toHaveBeenCalledTimes(1)
})

it('drops results when the source is revoked during generation and never starts tools or sends', async () => {
  configure(); const pending = Promise.withResolvers<void>(), model = stream(pending.promise)
  await observe('quiet4')
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1))
  const settings = h.runtime.store.settings(), source = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...source, config: { ...source.config, chats: [] } } } })
  pending.resolve(); await h.runtime.idle()
  const records = h.runtime.store.keys(KV.drafts.record).map(name => h.runtime.store.get(name)!)
  expect(records[0]?.status).toBe('stale')
  expect(h.runtime.artifacts.get(records[0]!.id, MEMBER)).toBeUndefined()
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('uses a real private command for the same bounded draft pipeline without invoking the router', async () => {
  configure(); const model = stream()
  const trigger = { ...feishu('quiet5', '/助手 起草\n工作总结：R1 完成访谈；R2 明天复核。', { chat_type: 'p2p', mentions: [] }), at: new Date().toISOString() }
  expect(h.runtime.receive(trigger)).toBe('stored'); await h.runtime.idle()
  expect(model).toHaveBeenCalledTimes(1)
  expect(h.runtime.quietDrafts.list(MEMBER)[0]).toMatchObject({ mode: 'requested', status: 'ready' })
  expect(h.runtime.engine.candidate(trigger.id)).toBeUndefined()
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('does not draft outside the configured group, for external material, or while the feature is disabled', async () => {
  configure(); const model = stream()
  await observe('quiet6', '工作总结：请检索 https://example.invalid 后再总结。'); await h.runtime.idle()
  const settings = h.runtime.store.settings(), source = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...source, config: { ...source.config, draftsEnabled: false } } } })
  await observe('quiet7'); await h.runtime.idle()
  expect(model).not.toHaveBeenCalled()
  expect(h.runtime.quietDrafts.list(MEMBER)).toEqual([])
})

it('binds actual Feishu reply_to and root-query references, preserves versions and exports the human edit in private', async () => {
  configure(); stream(); await observe('quote1'); await h.runtime.idle()
  let sent = 0
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => args.includes('+messages-reply') ? { message_id: `om_reply${++sent}` } : {})
  const incoming = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    ...feishu(id, text, { chat_type: 'p2p', mentions: [], ...extra }), at: new Date().toISOString(),
  })
  const box = incoming('box', '草稿箱'); h.runtime.receive(box); await h.runtime.idle()
  expect(h.runtime.store.get(KV.feishu.assistant(box.id))?.artifactVersion).toBe(1)
  const root = { root_id: 'om_box', reply_to: 'om_box', thread_id: 'omt_actualcli' }
  const edit = incoming('edit', '编辑这份草稿', root)
  expect(edit.meta.parentId).toBe('om_box')
  h.runtime.receive(edit); await h.runtime.idle()
  expect(h.runtime.store.get(KV.feishu.assistant(edit.id))?.editor?.version).toBe(1)
  const save = incoming('save', '改稿为：\n本人修订的三行总结。', root)
  h.runtime.receive(save); await h.runtime.idle()
  const [draft] = h.runtime.quietDrafts.list(MEMBER)
  expect(h.runtime.artifacts.get(draft!.id, MEMBER)).toMatchObject({ version: 2, author: 'human', editedByTrigger: save.id, body: '本人修订的三行总结。' })
  h.runtime.receive(incoming('stale', '改稿为：\n旧引用不能覆盖新版', root)); await h.runtime.idle()
  expect(h.runtime.artifacts.get(draft!.id, MEMBER)?.version).toBe(2)
  h.runtime.receive(incoming('export', '导出这份草稿', root)); await h.runtime.idle()
  const replies = vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('+messages-reply'))
  expect(replies.every(([args]) => !args.includes('--reply-in-thread'))).toBe(true)
  expect(replies.at(-1)![0]).toContain('--file')
  expect(h.runtime.artifacts.get(draft!.id, MEMBER, 1)?.author).toBe('agent')
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('continues an explicitly selected private draft without reply clicks, persists its version, and never upgrades an old quote', async () => {
  configure(); stream(); await observe('focus1'); await h.runtime.idle()
  let sent = 0
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => args.includes('+messages-reply') ? { message_id: `om_focusreply${++sent}` } : {})
  const direct = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ ...feishu(id, text, { chat_type: 'p2p', mentions: [], ...extra }), at: new Date().toISOString() })
  h.runtime.receive(direct('focusbox', '草稿箱')); await h.runtime.idle()
  const focus = h.runtime.store.get(KV.feishu.assistantFocus(MEMBER, CHAT))!
  expect(h.runtime.store.get(KV.feishu.assistant(focus.requestId))?.artifactVersion).toBe(1)
  h.runtime.receive(direct('focusedit', '编辑这份草稿')); await h.runtime.idle()
  const save = direct('focussave', '改稿为：\n本人直接发送的新版')
  h.runtime.receive(save); await h.runtime.idle()
  const [draft] = h.runtime.quietDrafts.list(MEMBER)
  expect(h.runtime.artifacts.get(draft!.id, MEMBER)).toMatchObject({ version: 2, author: 'human', body: '本人直接发送的新版' })
  h.runtime.receive(direct('focusstale', '改稿为：\n不能将旧引用升级为 v2', { root_id: 'om_focusbox', reply_to: 'om_focusbox' })); await h.runtime.idle()
  expect(h.runtime.artifacts.get(draft!.id, MEMBER)?.version).toBe(2)
  h.runtime.receive(direct('focusexport', '导出')); await h.runtime.idle()
  const replies = vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('+messages-reply'))
  expect(replies.at(-1)![0]).toContain('--file')
  h.runtime.receive(direct('focusconfirm', '确认这份草稿')); await h.runtime.idle()
  expect(h.runtime.quietDrafts.get(draft!.id, MEMBER)).toMatchObject({ status: 'confirmed', confirmedVersion: 2 })
  h.runtime.artifacts.edit(draft!.id, MEMBER, 2, '又一版本')
  expect(h.runtime.quietDrafts.get(draft!.id, MEMBER)?.status).toBe('ready')
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('cancels a running private draft without losing the confirmation response or starting another model call', async () => {
  configure(); const pending = Promise.withResolvers<void>(), model = stream(pending.promise)
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ message_id: 'om_cancelreply' })
  const trigger = { ...feishu('cancel1', '/助手 起草\n工作总结：R1 完成访谈。', { chat_type: 'p2p', mentions: [] }), at: new Date().toISOString() }
  h.runtime.receive(trigger)
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1))
  await h.runtime.effects.idle('assistant')
  const [draft] = h.runtime.quietDrafts.list(MEMBER)
  const cancel = { ...feishu('cancel2', `/助手 忽略草稿 ${draft!.id}`, { chat_type: 'p2p', mentions: [] }), at: new Date().toISOString() }
  h.runtime.receive(cancel); await h.runtime.effects.idle('assistant')
  expect(h.runtime.store.get(KV.feishu.assistant(cancel.id))?.status).toBe('sent')
  expect(h.runtime.store.get(KV.feishu.assistant(cancel.id))?.text).toContain('取消')
  pending.resolve(); await h.runtime.idle()
  expect(h.runtime.store.get(KV.drafts.record(draft!.id))?.status).toBe('discarded')
  expect(h.runtime.artifacts.get(draft!.id, MEMBER)).toBeUndefined()
  expect(model).toHaveBeenCalledTimes(1)
})
