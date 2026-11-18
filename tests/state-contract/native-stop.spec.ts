import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AsyncTaskRuntime, DurableArtifacts } from '../../src/state/index.ts'
import { NativeOfficeBackend } from '../../src/state/native.ts'
import { feishuTrigger } from '../../src/sources/feishu-trigger.ts'
import type { JobContext } from '../../src/state/index.ts'
import type { Ticket } from '../../src/core/index.ts'
import { productFixture, testURL } from './fixtures/product.ts'
import { nativeFixture } from './fixtures/native.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !testURL ? describe.skip : describe)(`native stop receipt: ${dialect}`, () => {
  it('never confirms another compute process stopped merely because its Session is absent locally or its lease expired', async () => {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const runtime = new AsyncTaskRuntime({ ...f, actorId: 'ou_owner', authorize: f.access.authorize,
      assess: async () => ({ kind: 'ignore', reason: 'fixture' }), work: async () => ({ state: 'hold', reason: 'remote fixture owns the turn' }), stop: async () => ({ state: 'hold', reason: 'explicit native receipt needed' }),
      delivery: { authorize: async () => {}, send: async () => 'om_fixture' } }); closes.push(() => runtime.stop())
    const trigger = feishuTrigger(f.raw('stop', 'Summarize fictional R1'), 'ou_bot', 'cli_test')!; trigger.meta.loomSpace = f.scope.spaceId
    await runtime.receive({ id: randomUUID(), userId: 'ou_owner' }, 'installed', 'om_stop', trigger)
    const decision = await runtime.app.decide({ id: randomUUID(), userId: 'ou_owner' }, trigger.id, { kind: 'accept', title: 'Synthetic native stop', scope: 'R1 only', reason: 'fixture' })
    await runtime.idle()
    const ticket = (await f.store.transaction(f.scope, tx => tx.get<Ticket>('ticket', decision.ticketId!)))!.value, sessionId = `worker-${ticket.id}`, assignmentId = ticket.assignments.at(-1)!.id
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire(sessionId, 'other-compute', 30_000)))!
    await f.store.transaction(f.scope, tx => tx.put('grant', `worker-binding/${ticket.id}/${assignmentId}`, { sessionId, owner: lease.owner, epoch: lease.epoch, userId: 'ou_owner', ticketId: ticket.id, assignmentId }, 0))
    await runtime.app.changeControl({ id: randomUUID(), userId: 'ou_owner' }, ticket.id, 0, 'takeover'); await runtime.idle()
    const fixture = nativeFixture(async () => { throw new Error('This process must not launch the missing Session') })
    const artifacts = new DurableArtifacts({ ...f, authorize: (...args) => f.access.artifact(...args) }), backend = new NativeOfficeBackend({ ...f, artifacts, app: runtime.app, context: fixture.context, scratch: join(f.folder, 'scratch') })
    closes.push(() => backend.close())
    const context = { signal: new AbortController().signal, assertCurrent: async () => {}, claim: {} } as JobContext
    expect(await backend.stop({ ticket, revision: 1 }, context)).toEqual({ state: 'retry', delayMs: 1000 })
    await f.store.transaction(f.scope, tx => tx.leases.release(lease))
    expect((await backend.stop({ ticket, revision: 1 }, context)).state).toBe('hold')
    expect((await f.store.transaction(f.scope, tx => tx.get<any>('control', ticket.id)))!.value).toMatchObject({ mode: 'taking_over', drained: false })
    await f.store.transaction(f.scope, tx => tx.put('grant', `native-quiescent/${sessionId}/${lease.epoch}`, { sessionId, owner: lease.owner, epoch: lease.epoch, flushed: true, at: new Date().toISOString() }, 0))
    expect(await backend.stop({ ticket, revision: 1 }, context)).toEqual({ state: 'done' })
    expect((await f.store.transaction(f.scope, tx => tx.get<any>('control', ticket.id)))!.value).toMatchObject({ mode: 'human', drained: true })
    expect(fixture.agents.size).toBe(0)
  })
})
