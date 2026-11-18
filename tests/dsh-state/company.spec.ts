import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsyncOrchestrator } from '../../src/state/application.ts'
import { DurableArtifacts } from '../../src/state/artifacts.ts'
import { ConsumerStopping } from '../../src/state/consumer.ts'
import { NativeOfficeBackend } from '../../src/state/native.ts'
import { SqlSessionHandle } from '../../src/dsh-state/handle.ts'
import { feishuTrigger } from '../../src/sources/feishu-trigger.ts'
import { hash } from '../../src/state/hash.ts'
import { messageId } from '../../src/app/delivery.ts'
import type { JobContext, SessionLease } from '../../src/state/index.ts'
import type { Ticket } from '../../src/core/index.ts'
import type { WorkRequest } from '../../src/state/runtime.ts'
import { productFixture, testURL } from '../state-contract/fixtures/product.ts'
import { companyNativeFixture } from './fixtures/company.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close().catch(() => {}) })
const job = (): JobContext => ({ signal: new AbortController().signal, claim: {} as never, assertCurrent: async () => {} })
async function task(dialect: 'sqlite' | 'postgres') {
  const f = await productFixture(dialect, true); closes.push(f.close)
  const app = new AsyncOrchestrator({ ...f, authorize: f.access.authorize, requireWorkerBindings: true })
  const trigger = feishuTrigger(f.raw('managed', '仅根据虚构记录 R1 整理工作总结。'), 'ou_bot', 'cli_test')!; trigger.meta.loomSpace = f.scope.spaceId
  await app.receive({ id: randomUUID(), userId: 'ou_owner' }, 'installed', 'om_managed', trigger)
  await app.evaluateDue({ id: randomUUID(), userId: 'ou_owner' })
  const candidate = await app.candidate({ id: randomUUID(), userId: 'ou_owner' }, trigger.id)
  const decision = await app.decide({ id: randomUUID(), userId: 'ou_owner' }, trigger.id, { kind: 'accept', title: 'Synthetic summary', scope: 'R1 only', reason: 'fixture' })
  const ticket = (await f.store.transaction(f.scope, tx => tx.get<Ticket>('ticket', decision.ticketId!)))!.value
  const artifacts = new DurableArtifacts({ ...f, requireWorkerBindings: true, authorize: (...args) => f.access.artifact(...args) })
  const request: WorkRequest = { requestId: `domain.launch/${ticket.id}/1`, kind: 'domain.launch', ticket, assignmentId: ticket.assignments.at(-1)!.id, controlRevision: 0 }
  const host = async (work: Parameters<typeof companyNativeFixture>[2], overrides: { scratch?: string; legacyWorkspaceRoots?: string[] } = {}) => {
    const fixture = await companyNativeFixture(f.store, f.scope, work); closes.push(() => fixture.close())
    const backend = new NativeOfficeBackend({ ...f, app, artifacts, scratch: join(f.folder, 'compute'), context: fixture.context, nativeState: fixture.provider, ...overrides })
    return { ...fixture, backend }
  }
  return { ...f, app, ticket, artifacts, request, host, candidate }
}
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !testURL ? describe.skip : describe)(`company/provider unified lease: ${dialect}`, () => {
  it('uses the same managed lease protocol for Router assessment and drains its native writer', async () => {
    const f = await task(dialect)
    const host = await f.host(async (_agent, invoke) => {
      await invoke('orchestrator_eval_decide', { decision: 'ignore', title: 'Synthetic router check', scope: '', rule_assessments: f.settings.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched: false, reason: 'Synthetic ignore' })),
        direction: { implementation_requested: false, target_basis: 'undetermined', requires_design_decision: true, evidence: 'Synthetic contract only' }, reason: 'Synthetic ignore' })
    })
    expect(f.candidate).toBeDefined()
    const outcome = await host.backend.assess(f.candidate!, job())
    expect(host.failures).toEqual([]); expect(host.agents.size).toBe(0)
    expect(outcome).toMatchObject({ kind: 'ignore' })
    expect(await f.store.transaction(f.scope, tx => tx.leases.current(`loom-router-${hash(f.scope).slice(0, 24)}`))).toMatchObject({ until: 0 })
  })
  it('uses exactly the application epoch for native writes, tools, artifact and a real lifecycle drain receipt', async () => {
    const f = await task(dialect)
    let current!: SessionLease
    const host = await f.host(async (agent, invoke) => {
      await expect(invoke('bash', {})).rejects.toThrow('denied')
      const actual = await f.store.transaction(f.scope, async tx => {
        const lease = (await tx.leases.current(agent.id))!, binding = (await tx.get<any>('grant', `worker-binding/${f.ticket.id}/${f.request.assignmentId}`))!.value
        expect(binding).toMatchObject({ owner: lease.owner, epoch: lease.epoch, nativeState: 'sql-lease-v1' })
        return lease
      })
      current = actual
      const result = await invoke('orchestrator_read', { resource: `ticket/${f.ticket.id}` })
      expect(result.ticket.inputs.every((input: any) => input.readAt)).toBe(true)
      await invoke('orchestrator_report', { state: 'ready', summary: '已完成：R1 已整理。' })
    })
    expect(await host.backend.work(f.request, job())).toEqual({ state: 'done' })
    expect(host.failures).toEqual([]); expect(host.agents.size).toBe(0)
    expect(host.order.indexOf('guarded')).toBeLessThan(host.order.indexOf('preset-mounted'))
    expect(host.order.indexOf('permissions')).toBeLessThan(host.order.indexOf('published'))
    await expect(host.provider.open(`worker-${f.ticket.id}` as never, 'write')).rejects.toThrow('owned')
    const manifest = await f.artifacts.manifest('ou_owner', f.ticket.id); expect(manifest?.version).toBe(1)
    const sessionId = `worker-${f.ticket.id}`, reader = await host.provider.open(sessionId as never, 'read'), events = (await reader.read()).events
    expect(events.filter(event => event.type === 'user/message' && event.data.id === messageId(f.request.requestId))).toHaveLength(1)
    await f.store.transaction(f.scope, async tx => {
      expect(await tx.leases.current(sessionId)).toMatchObject({ owner: current.owner, epoch: current.epoch, until: 0 })
      expect((await tx.get<any>('grant', `native-quiescent/${sessionId}/${current.epoch}`))?.value).toMatchObject({ owner: current.owner, epoch: current.epoch, flushed: true })
      expect((await tx.get<any>('grant', `native-input/${hash({ session: sessionId, requestId: f.request.requestId })}`))?.value.status).toBe('consumed')
    })
  })
  it('waits for owned Agent disposal and provider close before confirming human takeover', async () => {
    const f = await task(dialect), entered = Promise.withResolvers<void>()
    const host = await f.host(async (_agent, _invoke, signal) => {
      entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const running = host.backend.work(f.request, job()); void running.catch(() => {})
    await entered.promise
    await f.app.changeControl({ id: randomUUID(), userId: 'ou_owner' }, f.ticket.id, 0, 'takeover')
    expect(await host.backend.stop({ ticket: f.ticket, revision: 1 }, job())).toEqual({ state: 'retry', delayMs: 1000 })
    await running.catch(() => {})
    expect(host.order).toContain('disposed'); expect(host.agents.size).toBe(0)
    expect(await host.backend.stop({ ticket: f.ticket, revision: 1 }, job())).toEqual({ state: 'done' })
    expect((await f.store.transaction(f.scope, tx => tx.get<any>('control', f.ticket.id)))!.value).toMatchObject({ mode: 'human', drained: true })
    expect(await f.artifacts.manifest('ou_owner', f.ticket.id)).toBeUndefined()
  })
  it('rejects old tool/report writes after epoch replacement, without issuing a false stop receipt or releasing the new owner', async () => {
    const f = await task(dialect), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let invoke!: (name: string, args: unknown) => Promise<unknown>
    const host = await f.host(async (_agent, call) => { invoke = call; entered.resolve(); await release.promise })
    const running = host.backend.work(f.request, job()); void running.catch(() => {})
    await entered.promise
    const sessionId = `worker-${f.ticket.id}`
    const { old, next } = await f.store.transaction(f.scope, async tx => {
      const old = (await tx.leases.current(sessionId))!; await tx.leases.release(old)
      const next = (await tx.leases.acquire(sessionId, 'replacement', 10_000))!; return { old, next }
    })
    await expect(invoke('orchestrator_report', { state: 'ready', summary: 'Must never be published' })).rejects.toThrow()
    await expect(f.app.report({ id: randomUUID(), userId: 'ou_owner' }, f.ticket.id, f.request.assignmentId, old, 0, { state: 'ready', summary: 'Stale callback' })).rejects.toThrow()
    release.resolve(); await expect(running).rejects.toThrow()
    expect(await f.artifacts.manifest('ou_owner', f.ticket.id)).toBeUndefined()
    await f.store.transaction(f.scope, async tx => {
      expect(await tx.leases.current(sessionId)).toMatchObject({ owner: next.owner, epoch: next.epoch, until: next.until })
      expect(await tx.get('grant', `native-quiescent/${sessionId}/${old.epoch}`)).toBeUndefined()
    })
    await f.store.transaction(f.scope, tx => tx.leases.release(next))
    expect((await host.backend.work(f.request, job())).state).toBe('hold')
    expect((await f.store.transaction(f.scope, tx => tx.get<any>('grant', `worker-binding/${f.ticket.id}/${f.request.assignmentId}`)))!.value.epoch).toBe(old.epoch)
  })
  it('applies global pause inside report and artifact transactions even while the native lease remains valid', async () => {
    const f = await task(dialect), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const host = await f.host(async () => { entered.resolve(); await release.promise })
    const running = host.backend.work(f.request, job()); void running.catch(() => {})
    await entered.promise
    const lease = await f.store.transaction(f.scope, async tx => {
      const row = (await tx.get<any>('settings', 'current'))!; row.value.settings.paused = true; await tx.put('settings', 'current', row.value, row.revision)
      return (await tx.leases.current(`worker-${f.ticket.id}`))!
    })
    await expect(f.app.report({ id: randomUUID(), userId: 'ou_owner' }, f.ticket.id, f.request.assignmentId, lease, 0, { state: 'ready', summary: 'Should not commit' })).rejects.toThrow('paused')
    await expect(f.artifacts.publish({ id: randomUUID(), userId: 'ou_owner' }, { subject: f.ticket.id, author: 'agent', body: 'Should not publish', expectedVersion: 0,
      writer: { lease, assignmentId: f.request.assignmentId, controlRevision: 0 } })).rejects.toThrow('paused')
    release.resolve(); await expect(running).rejects.toThrow()
    expect(await f.artifacts.manifest('ou_owner', f.ticket.id)).toBeUndefined()
  })
  it('reschedules an orderly proved drain without inventing a failed report, preserving the original input', async () => {
    const f = await task(dialect), entered = Promise.withResolvers<void>(), aborter = new AbortController()
    const first = await f.host(async (_agent, _invoke, signal) => {
      entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const running = first.backend.work(f.request, { ...job(), signal: aborter.signal })
    await entered.promise; aborter.abort(new ConsumerStopping('Consumer stopping'))
    expect(await running).toEqual({ state: 'retry', delayMs: 0 })
    const ticket = (await f.store.transaction(f.scope, tx => tx.get<Ticket>('ticket', f.ticket.id)))!.value
    expect(ticket.assignments.at(-1)?.report).toBeUndefined()
    expect(await f.artifacts.manifest('ou_owner', f.ticket.id)).toBeUndefined()
    await first.close()
    const next = await f.host(async (_agent, invoke) => { await invoke('orchestrator_report', { state: 'ready', summary: 'Resumed R1' }) })
    expect(await next.backend.work({ ...f.request, ticket }, job())).toEqual({ state: 'done' })
    const reader = await next.provider.open(`worker-${ticket.id}` as never, 'read')
    const events = (await reader.read()).events; await reader.close()
    expect(events.filter(event => event.type === 'user/message' && event.data.id === messageId(f.request.requestId))).toHaveLength(1)
    expect((await f.artifacts.manifest('ou_owner', ticket.id))?.version).toBe(1)
  })
  it.each(['pause', 'unknown'] as const)('holds an orderly drain if %s requires reconciliation', async mode => {
    const f = await task(dialect), entered = Promise.withResolvers<void>(), aborter = new AbortController()
    const host = await f.host(async (_agent, _invoke, signal) => {
      entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const running = host.backend.work(f.request, { ...job(), signal: aborter.signal }); await entered.promise
    await f.store.transaction(f.scope, async tx => {
      if (mode === 'pause') {
        const row = (await tx.get<any>('settings', 'current'))!; row.value.settings.paused = true; await tx.put('settings', 'current', row.value, row.revision)
      } else {
        const row = (await tx.get<any>('control', f.ticket.id))!; row.value.operations.push({ id: 'unconfirmed-write', status: 'unknown', at: await tx.now() }); await tx.put('control', f.ticket.id, row.value, row.revision)
      }
    })
    aborter.abort(new ConsumerStopping('Consumer stopping'))
    expect(await running).toMatchObject({ state: 'hold' })
    expect(await f.artifacts.manifest('ou_owner', f.ticket.id)).toBeUndefined()
  })
  it('does not convert an ownership-loss abort into an automatic retry', async () => {
    const f = await task(dialect), entered = Promise.withResolvers<void>(), aborter = new AbortController()
    const host = await f.host(async (_agent, _invoke, signal) => {
      entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const running = host.backend.work(f.request, { ...job(), signal: aborter.signal }); void running.catch(() => {})
    await entered.promise; aborter.abort(new Error('Job ownership unavailable'))
    await expect(running).rejects.toThrow()
    expect(await f.artifacts.manifest('ou_owner', f.ticket.id)).toBeUndefined()
  })
  it('does not acknowledge a failed input flush and resumes the same persisted input once under a fresh epoch', async () => {
    const f = await task(dialect)
    const host = await f.host(async (_agent, invoke) => { await invoke('orchestrator_report', { state: 'ready', summary: 'Recovered synthetic summary' }) })
    const original = SqlSessionHandle.prototype.flush, sessionId = `worker-${f.ticket.id}`
    let once = true
    const spy = vi.spyOn(SqlSessionHandle.prototype, 'flush').mockImplementation(async function(this: SqlSessionHandle, options) {
      await original.call(this, options)
      if (once && this.id === sessionId && (await this.read()).events.some(event => event.type === 'user/message')) { once = false; throw new Error('Fixture flush acknowledgement lost') }
    })
    await expect(host.backend.work(f.request, job())).rejects.toThrow()
    spy.mockRestore()
    expect(await f.artifacts.manifest('ou_owner', f.ticket.id)).toBeUndefined()
    const row = await f.store.transaction(f.scope, tx => tx.get<any>('grant', `native-input/${hash({ session: sessionId, requestId: f.request.requestId })}`))
    expect(row!.value.status).not.toBe('consumed')
    expect(await host.backend.work(f.request, job())).toEqual({ state: 'done' })
    const events = (await (await host.provider.open(sessionId as never, 'read')).read()).events
    expect(events.filter(event => event.type === 'user/message' && event.data.id === messageId(f.request.requestId))).toHaveLength(1)
    expect((await f.artifacts.manifest('ou_owner', f.ticket.id))?.version).toBe(1)
  })
  it('keeps an imported immutable cwd only in an explicit existing compatibility root', async () => {
    const f = await task(dialect)
    const first = await f.host(async (_agent, invoke) => { await invoke('orchestrator_report', { state: 'progress', summary: 'Legacy office checkpoint' }) })
    await first.backend.work(f.request, job()); const before = (await first.provider.stat(`worker-${f.ticket.id}` as never))!.header
    await first.close()
    const current = (await f.store.transaction(f.scope, tx => tx.get<Ticket>('ticket', f.ticket.id)))!.value
    const denied = await f.host(async () => {}, { scratch: join(f.folder, 'fresh-compute') })
    await expect(denied.backend.work({ ...f.request, ticket: current }, job())).rejects.toThrow('workspace')
    await denied.close()
    const next = await f.host(async (_agent, invoke) => { await invoke('orchestrator_report', { state: 'ready', summary: 'Compatible R1 result' }) },
      { scratch: join(f.folder, 'fresh-compute'), legacyWorkspaceRoots: [join(f.folder, 'compute')] })
    expect(await next.backend.work({ ...f.request, ticket: current }, job())).toEqual({ state: 'done' })
    expect((await next.provider.stat(`worker-${f.ticket.id}` as never))?.header).toEqual(before)
  })
  it('continues a running assignment in a new scoped host with changed delivery facts, preserving the original input snapshot', async () => {
    const f = await task(dialect)
    const first = await f.host(async (_agent, invoke) => { await invoke('orchestrator_report', { state: 'progress', summary: 'Synthetic intermediate checkpoint' }) })
    expect(await first.backend.work(f.request, job())).toEqual({ state: 'done' })
    await first.close(); await rm(join(f.folder, 'compute'), { recursive: true, force: true })
    const current = (await f.store.transaction(f.scope, tx => tx.get<Ticket>('ticket', f.ticket.id)))!.value
    expect(current.undelivered).toEqual([])
    const next = await f.host(async (_agent, invoke) => { await invoke('orchestrator_report', { state: 'ready', summary: 'Synthetic resumed final report' }) })
    expect(await next.backend.work({ ...f.request, ticket: current }, job())).toEqual({ state: 'done' })
    expect(next.failures).toEqual([])
    const events = (await (await next.provider.open(`worker-${f.ticket.id}` as never, 'read')).read()).events
    expect(events.filter(event => event.type === 'user/message' && event.data.id === messageId(f.request.requestId))).toHaveLength(1)
    expect((await f.artifacts.manifest('ou_owner', f.ticket.id))?.version).toBe(1)
  })
})
