import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, MEMBER, type Host } from './fixtures/host.ts'
import { contentHash } from '../src/app/artifacts.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { github: false }) })
afterEach(async () => { await h.stop() })

it('keeps immutable revisions and refuses a worker that did not acknowledge a human edit', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('artifact1', '工作总结：R1 完成访谈。'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '助手第一稿 [R1]' })
  const first = h.runtime.artifacts.get(ticket.id, MEMBER)!
  expect(first).toMatchObject({ version: 1, author: 'agent', hash: contentHash('助手第一稿 [R1]') })
  expect(first.sources[0]?.triggerId).toBe(ticket.origin.triggerId)
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  const edited = h.runtime.artifacts.edit(ticket.id, MEMBER, 1, '本人补充：已核对 R1。')
  expect(edited.version).toBe(2)
  expect(h.runtime.artifacts.snapshot(h.runtime.store.tickets.get(ticket.id)!)?.body).toBe(edited.body)
  expect(h.runtime.artifacts.get(ticket.id, MEMBER, 1)).toEqual(first)
  expect(() => h.runtime.artifacts.edit(ticket.id, MEMBER, 1, '过期改稿')).toThrow('版本已变化')
  h.runtime.controls.change(ticket.id, 'return', 1)
  await h.runtime.idle()
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '覆盖本人内容' })).rejects.toThrow('Human artifact changed')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  const saved = await h.runTool(sessionId, 'orchestrator_artifact', {})
  expect(saved).toMatchObject({ version: 2, body: edited.body })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '保留本人补充，并完成复核。', artifact_version: 2 })
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)?.version).toBe(3)
  expect(h.runtime.artifacts.history(ticket.id, MEMBER).map(value => value.body)).toEqual([first.body, edited.body, '保留本人补充，并完成复核。'])
})

it('requires drained human control to edit, refuses other owners and withdraws reads with the origin scope', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('artifact2', '工作总结：R1 完成核对。'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '私人产物' })
  expect(() => h.runtime.artifacts.edit(ticket.id, MEMBER, 1, '抢写')).toThrow('接管')
  expect(h.runtime.artifacts.get(ticket.id, 'ou_other')).toBeUndefined()
  const settings = h.runtime.store.settings(), source = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...source,
    config: { ...source.config, chats: [], otherChats: 'none' } } } })
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)).toBeUndefined()
  expect(h.runtime.artifacts.history(ticket.id, MEMBER)).toEqual([])
})

it('carries human-edit provenance into later worker versions and withdraws derived context after that source is revoked', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('provenance1', '总结指定群记录'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '初稿' })
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  const edit = feishu('provenance2', '本人私聊补充的改稿', { chat_type: 'p2p' })
  h.runtime.store.triggers.save(edit)
  h.runtime.artifacts.edit(ticket.id, MEMBER, 1, '本人改稿', edit.id)
  h.runtime.controls.change(ticket.id, 'return', 1); await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '保留本人补充的定稿', artifact_version: 2 })
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)?.sources.some(source => source.triggerId === edit.id)).toBe(true)
  const settings = h.runtime.store.settings(), source = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, paused: true })
  h.runtime.outbox.send({ id: 'derived-result', kind: 'reply', ticketId: ticket.id,
    channel: feishu('provenance1', '').channel!, text: '保留本人补充的定稿' })
  expect(h.runtime.outbox.status('derived-result')).toBe('pending')
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...source,
    config: { ...source.config, directMessages: false } } } })
  await h.runtime.idle()
  expect(h.runtime.outbox.status('derived-result')).toBe('dropped')
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)).toBeUndefined()
  expect(h.runtime.artifacts.snapshot(h.runtime.store.tickets.get(ticket.id)!)).toBeUndefined()
  expect(h.runtime.artifacts.get(ticket.id, MEMBER, 1)?.body).toBe('初稿')
})
