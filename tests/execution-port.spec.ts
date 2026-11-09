/** Execution boundary integration: real Runtime/Store, native dispatch, filesystem preparation and human control. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { executionRequest, ExecutionOutcomeUnknown, LocalExecutionPort } from '../src/execution/port.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { github: false }) })
afterEach(async () => { await h.stop() })
const context = (id: string) => (h.agents.get(id) as unknown as { ctx: Context }).ctx
const native = (id: string, next: () => Promise<ToolExecutionResult>, name = 'bash') => context(id).waterfall('tools/execute',
  { name, callId: 'native-call-1', arguments: { command: 'pwd' }, signal: new AbortController().signal } as never, next)

it('prepares a real local workspace through the shared port and preserves the native tool result envelope', async () => {
  const boundary = vi.spyOn(h.runtime.execution, 'run')
  const { ticket, sessionId } = await h.acceptedTicket(feishu('701', '执行接口本机测试'))
  expect(ticket.execution?.target).toEqual({ kind: 'local' })
  expect(existsSync(ticket.execution!.directory)).toBe(true)
  expect(boundary.mock.calls.some(([request]) => request.operation === 'prepare' && request.binding.ticketId === ticket.id)).toBe(true)
  const result: ToolExecutionResult = { isError: false, value: { cwd: ticket.execution!.directory }, content: [{ type: 'text', text: 'native output' }], meta: { kept: true } }
  expect(await native(sessionId, async () => result)).toBe(result)
  const request = boundary.mock.calls.find(([request]) => request.operation === 'tool')![0]
  expect(request).toMatchObject({ requestId: 'native-call-1', operation: 'tool', binding: {
    ticketId: ticket.id, sessionId, actor: ticket.mandate.actor, controlRevision: 0, target: { kind: 'local' },
  }, input: { name: 'bash', arguments: { command: 'pwd' } } })
})

it('supports legacy tickets without a target through the explicit local interpretation', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('702', '历史任务'))
  const execution = { ...ticket.execution! }; delete execution.target
  h.runtime.store.tickets.save({ ...ticket, execution })
  const next = vi.fn(async () => ({ isError: false, value: null, content: [] }) as ToolExecutionResult)
  await native(sessionId, next)
  expect(next).toHaveBeenCalledOnce()
})

it.each([
  { kind: 'runner', environmentId: 'device-linux-2', workspaceId: 'project-1' },
  { kind: 'runner', environmentId: '', workspaceId: 'project-1' },
  { kind: 'unexpected' },
  null,
])('refuses unavailable or malformed targets without invoking a local tool: %j', async target => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('703', '远程边界'))
  h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, target: target as never } })
  const next = vi.fn()
  await expect(native(sessionId, next)).rejects.toThrow(/fallback is forbidden/)
  expect(next).not.toHaveBeenCalled()
})

it('refuses a Runner launch before probing/creating its workspace or launching a local process/session', async () => {
  const { ticket } = await h.acceptedTicket(feishu('704', '禁止本地回退'))
  const directory = join(h.directory, 'remote-workspace-must-not-appear')
  h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, directory,
    target: { kind: 'runner', environmentId: 'linux-2', workspaceId: 'private-project' } } })
  h.subprocess.spawn.mockClear(); h.controller.create.mockClear()
  h.runtime.executor.resumeTask(ticket.id)
  await h.runtime.idle()
  expect(existsSync(directory)).toBe(false)
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
  expect(h.controller.create).not.toHaveBeenCalled()
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.summary).toContain('local fallback is forbidden')
  await expect(h.runtime.sessions.ensure(`worker-${ticket.id}`, directory, 'remote', 'worker')).rejects.toThrow('Runner sessions are not enabled')
  expect(() => h.runtime.artifacts.readReportFile(h.runtime.store.tickets.get(ticket.id)!, 'result.md')).toThrow('local file access is forbidden')
})

it('carries the parent task binding to a subagent while preserving its actual session identity', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('705', '子任务继承'))
  const childId = h.subagents.spawn(sessionId)
  h.agents.delete(childId)
  await h.controller.create({ sessionId: childId } as never)
  const child = h.agents.get(childId)!
  Object.assign((child as unknown as { session: object }).session, { header: { parentSession: sessionId } })
  await h.ctx.parallel('agent/created', { agent: child } as never)
  const boundary = vi.spyOn(h.runtime.execution, 'run')
  await native(childId, async () => ({ isError: false, value: null, content: [] }))
  expect(boundary.mock.calls[0]![0].binding).toMatchObject({ ticketId: ticket.id, sessionId: childId, target: { kind: 'local' } })
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  expect(boundary.mock.calls.some(([request]) => request.operation === 'confirm-stopped')).toBe(true)
})

it('rechecks a queued request binding immediately before dispatch', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('706', '目标变更'))
  const pending = Promise.withResolvers<void>(), original = h.runtime.execution.run.bind(h.runtime.execution)
  vi.spyOn(h.runtime.execution, 'run').mockImplementation(async (request, options, local) => {
    if (request.operation === 'tool') await pending.promise
    return original(request, options, local)
  })
  const next = vi.fn(), dispatched = native(sessionId, next)
  h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, directory: join(h.directory, 'another-workspace') } })
  pending.resolve()
  await expect(dispatched).rejects.toThrow('binding changed')
  expect(next).not.toHaveBeenCalled()
})

it('refuses a queued native invocation when its task ended before dispatch', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('710', '排队期间结束'))
  const pending = Promise.withResolvers<void>(), original = h.runtime.execution.run.bind(h.runtime.execution)
  vi.spyOn(h.runtime.execution, 'run').mockImplementation(async (request, options, local) => {
    if (request.operation === 'tool') await pending.promise
    return original(request, options, local)
  })
  const next = vi.fn(), dispatched = native(sessionId, next)
  h.runtime.engine.stopTicket(ticket.id)
  pending.resolve()
  await expect(dispatched).rejects.toThrow('Ticket ended')
  expect(next).not.toHaveBeenCalled()
})

it('does not transfer control on an unconfirmed remote stop', async () => {
  const { ticket } = await h.acceptedTicket(feishu('707', '停止不可确认'))
  h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!,
    target: { kind: 'runner', environmentId: 'offline-linux', workspaceId: 'project' } } })
  h.runtime.controls.change(ticket.id, 'takeover', 0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).detail).toContain('has not stopped'))
  expect(h.runtime.controls.view(ticket.id).mode).toBe('taking_over')
})

it('retains ambiguous execution outcomes and pauses the task pending reconciliation', async () => {
  const { ticket } = await h.acceptedTicket(feishu('708', '回执丢失'))
  await expect(h.runtime.controls.run(ticket.id, 'runner-write', async () => { throw new ExecutionOutcomeUnknown('receipt lost') })).rejects.toThrow('receipt lost')
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).drained).toBe(true))
  expect(h.runtime.controls.view(ticket.id)).toMatchObject({ mode: 'pausing', operations: [{ name: 'runner-write', status: 'unknown' }] })
  expect(() => h.runtime.controls.change(ticket.id, 'resume', 1)).toThrow('not finished')
})

it('never reports an aborted callback as settled until the real invocation returns', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('709', '取消真实生命周期'))
  const request = executionRequest(ticket, sessionId, 0, 'prepare', { command: '', variables: {} })
  const controller = new AbortController(), work = Promise.withResolvers<void>(), port = new LocalExecutionPort()
  let settled = false
  const result = port.run(request, { signal: controller.signal, authorize() {} }, async signal => {
    expect(signal).toBe(controller.signal); await work.promise
  }).finally(() => { settled = true })
  controller.abort(); await Promise.resolve()
  expect(settled).toBe(false)
  work.resolve(); await result
  expect(settled).toBe(true)
})
