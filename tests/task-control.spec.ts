/** Real Store and Runtime boundaries for pause, handover, queued replies and crash recovery. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { TaskControls } from '../src/app/task-control.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import type { Context } from '@deepseek-ai/cordis'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { github: false }) })
afterEach(async () => { await h.stop() })
it('refuses handover after a job stop times out, and retries only on an explicit operator action', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('11', '停止确认测试'))
  const job = h.jobs.run(sessionId)
  h.jobs.service.kill.mockReturnValue('requested')
  h.jobs.service.wait.mockResolvedValue({ id: job, owner: sessionId, status: 'running' })
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).detail).toContain('has not stopped'))
  expect(h.runtime.controls.view(ticket.id).mode).toBe('taking_over')
  expect(() => h.runtime.controls.change(ticket.id, 'return', 1)).toThrow('not finished')
  h.jobs.end(job)
  h.runtime.controls.change(ticket.id, 'takeover', 1)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
})
it('collects descendant shell jobs before handover even when their agent was released', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('12', '子任务停止测试'))
  const child = h.subagents.spawn(sessionId)
  const job = h.jobs.run(child)
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  expect(h.jobs.service.kill).toHaveBeenCalledWith(job, child, 'Human task handover')
})
it('wraps native tool dispatch so cancellation and handover track the real tool lifetime', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('10', '原生工具测试'))
  const ctx = (h.agents.get(sessionId) as unknown as { ctx: Context }).ctx
  const execution = { name: 'bash', signal: new AbortController().signal }
  const pending = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const result = ctx.waterfall('tools/execute', execution as never, async () => {
    signal = execution.signal
    await pending.promise
    return { content: [] } as never
  })
  expect(h.runtime.controls.view(ticket.id).operations.map(op => op.name)).toContain('bash')
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  expect(signal?.aborted).toBe(true)
  expect(h.runtime.controls.view(ticket.id).mode).toBe('taking_over')
  pending.resolve(); await result
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  await expect(ctx.waterfall('tools/execute', execution as never, async () => ({ content: [] }) as never)).rejects.toThrow('human control')
})
it('does not hand over until a real operation settles, and blocks further tools and stale resume requests', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '整理测试资料'))
  const pending = Promise.withResolvers<void>()
  let aborted = false
  const operation = h.runtime.controls.run(ticket.id, 'external-write', async signal => {
    signal.addEventListener('abort', () => { aborted = true })
    await pending.promise
  })
  const response = await h.api('POST', `tickets/${ticket.id}/control`, { action: 'takeover', revision: 0 })
  expect(response.body).toMatchObject({ mode: 'taking_over', revision: 1 })
  expect(aborted).toBe(true)
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'stale' })).rejects.toThrow('human control')
  expect((await h.api('POST', `tickets/${ticket.id}/control`, { action: 'return', revision: 1 })).status).toBe(409)
  pending.resolve(); await operation
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  expect((await h.api('POST', `tickets/${ticket.id}/control`, { action: 'return', revision: 0 })).status).toBe(409)
  expect((await h.api('POST', `tickets/${ticket.id}/control`, { action: 'return', revision: 1 })).body).toMatchObject({ mode: 'agent', revision: 2 })
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'note' && input.text.includes('preserve human edits'))).toBe(true)
})
it('holds a task across new human messages without holding other tasks', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('2', '任务 A'))
  h.runtime.controls.change(ticket.id, 'pause', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  const follow = feishu('3', '补充资料', { root_id: trigger.meta.messageId, mentions: [] })
  h.runtime.receive(follow); await h.runtime.idle()
  expect(h.runtime.controls.held(ticket.id)).toBe(true)
  const other = await h.acceptedTicket(feishu('4', '任务 B'))
  expect(h.runtime.controls.held(other.ticket.id)).toBe(false)
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs).toContainEqual(expect.objectContaining({ triggerId: follow.id }))
})
it('tombstones queued old replies so return does not publish them after human editing', async () => {
  const { ticket } = await h.acceptedTicket(feishu('5', '任务'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.outbox.send({ id: 'old-result', kind: 'reply', ticketId: ticket.id, text: 'old result', channel: ticket.channels[0]! })
  h.runtime.controls.change(ticket.id, 'pause', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  expect(h.runtime.store.receipts.get('old-result')).toMatchObject({ status: 'dropped', dropped: { reason: 'controlChanged' } })
  h.runtime.controls.change(ticket.id, 'resume', 1)
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('old result'))).toBe(false)
})
it('shows an already-started send as in flight and records its actual completion before takeover', async () => {
  const { ticket } = await h.acceptedTicket(feishu('6', '任务'))
  const pending = Promise.withResolvers<unknown>()
  vi.mocked(Commands.prototype.lark).mockReturnValueOnce(pending.promise)
  h.runtime.outbox.send({ id: 'inflight-result', kind: 'reply', ticketId: ticket.id, text: 'sent before hold', channel: ticket.channels[0]! })
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).operations.some(op => op.name === 'reply:inflight-result')).toBe(true))
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  expect(h.runtime.controls.view(ticket.id).mode).toBe('taking_over')
  pending.resolve({}); await h.runtime.sendReplies()
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  expect(h.runtime.store.receipts.get('inflight-result')?.status).toBe('sent')
})
it('retains an aborted send with no result as unknown, and never replays its stale body on return', async () => {
  const { ticket } = await h.acceptedTicket(feishu('13', '发送不确定结果测试'))
  const pending = Promise.withResolvers<unknown>()
  vi.mocked(Commands.prototype.lark).mockReturnValueOnce(pending.promise)
  h.runtime.outbox.send({ id: 'lost-send', kind: 'reply', ticketId: ticket.id, text: 'stale after handover', channel: ticket.channels[0]! })
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).operations.some(op => op.name === 'reply:lost-send')).toBe(true))
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  pending.reject(new Error('client aborted without a remote response'))
  await h.runtime.sendReplies()
  const unknown = h.runtime.controls.view(ticket.id).operations.filter(op => op.status === 'unknown')
  expect(unknown.map(op => op.name)).toEqual(['reply:lost-send'])
  expect(h.runtime.controls.view(ticket.id).mode).toBe('taking_over')
  expect(h.runtime.store.receipts.get('lost-send')).toMatchObject({ status: 'dropped', dropped: { reason: 'controlChanged' } })
  h.runtime.controls.change(ticket.id, 'resolve', 1, { ids: unknown.map(op => op.id), note: 'Checked Feishu: the old result arrived; keep human edits and do not resend.' })
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  h.runtime.controls.change(ticket.id, 'return', 2)
  const before = vi.mocked(Commands.prototype.lark).mock.calls.length
  await h.runtime.sendReplies()
  expect(vi.mocked(Commands.prototype.lark).mock.calls.length).toBe(before)
})
it('keeps unknown operations after restart and requires an explicit external-state review', async () => {
  const { ticket } = await h.acceptedTicket(feishu('7', '任务'))
  h.runtime.store.set(KV.controls.task(ticket.id), { mode: 'taking_over', revision: 1, drained: false, history: [],
    operations: [{ id: 'uncertain', name: 'write', status: 'running', startedAt: new Date().toISOString() }] })
  const controls = new TaskControls({ store: h.runtime.store, quiesce: async () => {}, resume: vi.fn() })
  controls.recover()
  await vi.waitFor(() => expect(controls.view(ticket.id).drained).toBe(true))
  expect(controls.view(ticket.id)).toMatchObject({ mode: 'taking_over', operations: [{ status: 'unknown' }] })
  expect(() => controls.change(ticket.id, 'return', 1)).toThrow('not finished')
  controls.change(ticket.id, 'resolve', 1, { ids: ['uncertain'], note: 'Checked external destination and preserved the human revision.' })
  await vi.waitFor(() => expect(controls.view(ticket.id).mode).toBe('human'))
  controls.dispose()
})
it('filters non-owner replies before they can wake an existing personal task', async () => {
  const stored = h.runtime.store.settings().sources.feishu!
  await h.runtime.settings.save('source:feishu', { ...stored, config: { ...stored.config, ownerOnly: true } },
    h.runtime.store.blockRevision('source:feishu'), 'panel')
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('8', '任务'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done' })
  const other = feishu('9', '改写全部内容', { sender_id: 'ou_stranger', root_id: trigger.meta.messageId })
  expect(h.runtime.receive(other)).toBe('filtered')
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeDefined()
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === other.id)).toBe(false)
})
