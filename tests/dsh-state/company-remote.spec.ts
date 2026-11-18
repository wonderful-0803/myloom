import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsyncOrchestrator, DurableArtifacts } from '../../src/state/index.ts'
import { NativeOfficeBackend } from '../../src/state/native.ts'
import { feishuTrigger } from '../../src/sources/feishu-trigger.ts'
import type { JobContext } from '../../src/state/index.ts'
import type { Ticket } from '../../src/core/index.ts'
import type { WorkRequest } from '../../src/state/runtime.ts'
import { productFixture } from '../state-contract/fixtures/product.ts'
import { companyNativeFixture } from './fixtures/company.ts'

const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close().catch(() => {}) })

it('routes a company Worker remote read tool through the ExecutionPort without invoking a local fallback', async () => {
  const f = await productFixture('sqlite', true); closes.push(f.close)
  const app = new AsyncOrchestrator({ ...f, authorize: f.access.authorize, requireWorkerBindings: true }), trigger = feishuTrigger(f.raw('remote', '只读取虚构 Runner 文件并总结。'), 'ou_bot', 'cli_test')!
  trigger.meta.loomSpace = f.scope.spaceId
  await app.receive({ id: randomUUID(), userId: 'ou_owner' }, 'installed', 'om_remote', trigger)
  const decision = await app.decide({ id: randomUUID(), userId: 'ou_owner' }, trigger.id, { kind: 'accept', title: 'Remote read fixture', scope: 'Only remote fixture', reason: 'test' })
  const original = (await f.store.transaction(f.scope, tx => tx.get<Ticket>('ticket', decision.ticketId!)))!.value
  const ticket: Ticket = { ...original, execution: { name: 'remote-read-fixture', directory: join(f.folder, 'server-scratch'), assignment: '', target: { kind: 'runner', environmentId: 'linux-test', workspaceId: 'workspace-test' } } }
  await f.store.transaction(f.scope, async tx => { const row = await tx.get<Ticket>('ticket', ticket.id); await tx.put('ticket', ticket.id, ticket, row?.revision ?? 0) })
  const assignmentId = ticket.assignments.at(-1)!.id, request: WorkRequest = { requestId: `domain.launch/${ticket.id}/remote`, kind: 'domain.launch', ticket, assignmentId, controlRevision: 0 }
  const port = { run: vi.fn(async (_request: unknown, _options: unknown, local: () => Promise<unknown>) => {
    await expect(local()).rejects.toThrow('compute-host fallback')
    return { isError: false, value: { kind: 'text', text: 'R1：来自远程 Runner。', truncated: false }, content: [{ type: 'text', text: 'remote' }] }
  }) }
  const fixture = await companyNativeFixture(f.store, f.scope, async (_agent, invoke) => {
    const value = await invoke('loom_remote_read', { path: 'notes/daily.txt', offset: 0, limit: 100 })
    expect(value.value.text).toContain('远程 Runner')
    await invoke('orchestrator_report', { state: 'ready', summary: '已完成：读取远程 Runner 文件。' })
  }); closes.push(fixture.close)
  const artifacts = new DurableArtifacts({ ...f, requireWorkerBindings: true, authorize: (...args) => f.access.artifact(...args) })
  const backend = new NativeOfficeBackend({ ...f, app, artifacts, scratch: join(f.folder, 'compute'), context: fixture.context, nativeState: fixture.provider, execution: port as never, remoteExecution: { environmentId: 'linux-test', workspaceId: 'workspace-test', resourceGrantId: 'grant-test', grantRevision: 1 } })
  closes.push(() => backend.close())
  const job: JobContext = { signal: new AbortController().signal, claim: {} as never, assertCurrent: async () => {} }
  expect(await backend.work(request, job)).toEqual({ state: 'done' })
  expect(port.run).toHaveBeenCalledOnce()
  expect(port.run.mock.calls[0]![0]).toMatchObject({ operation: 'tool', input: { name: 'read', arguments: { path: 'notes/daily.txt' } }, binding: { target: { kind: 'runner', environmentId: 'linux-test' }, sessionEpoch: expect.any(Number) } })
})
