import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { AsyncTaskRuntime, ConsumerStopping, control, DeliveryPending, DurableConsumer, DurableOutbox, PostgresStateStore, SqliteStateStore, StateConflict } from '../../src/state/index.ts'
import type { AsyncRuntimeOptions, CommandAuthority, DeliveryIntent, JobContext, StateStore } from '../../src/state/index.ts'
import type { Policy, Ticket } from '../../src/core/index.ts'
import { feishuTrigger } from '../../src/sources/feishu-trigger.ts'

const url = process.env.LOOM_STATE_TEST_DATABASE_URL
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Runtime tests require a disposable _test database')
const stores: StateStore[] = [], folders: string[] = [], consumers: { stop(): Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(consumers.splice(0).map(value => value.stop()))
  await Promise.all(stores.splice(0).map(value => value.close()))
  await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
for (const kind of ['sqlite', 'postgres'] as const) (kind === 'postgres' && !url ? describe.skip : describe)(`async background kernel: ${kind}`, () => {
  async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), 'loom-state-runtime-')); folders.push(folder)
    const path = join(folder, 'state.sqlite'), scope = { tenantId: `test-${randomUUID()}`, spaceId: 'personal' }
    const open = async () => {
      const store = kind === 'postgres' ? await PostgresStateStore.open({ connectionString: url }) : await SqliteStateStore.open(path)
      stores.push(store); return store
    }
    const store = await open(), peer = await open()
    return { store, peer, open, scope }
  }
  it('enforces a shared pool across independent adapters, same-assignment exclusion and conflicting configuration rejection', async () => {
    const f = await fixture(), pool = { name: 'workers', limit: 1 }
    await f.store.transaction(f.scope, async tx => {
      await tx.jobs.enqueue('launch', 'a', {}); await tx.jobs.enqueue('input', 'a', {}); await tx.jobs.enqueue('launch', 'b', {})
    })
    const claims = await Promise.all([f.store, f.peer].map((store, i) => store.transaction(f.scope, tx => tx.jobs.claim(`p${i}`, 10_000, ['launch', 'input'], pool))))
    expect(claims.filter(Boolean)).toHaveLength(1)
    const first = claims.find(Boolean)!
    await expect(f.peer.transaction(f.scope, tx => tx.jobs.claim('bad', 10_000, ['launch'], { ...pool, limit: 2 }))).rejects.toBeInstanceOf(StateConflict)
    await f.store.transaction(f.scope, async tx => {
      // New input generation must not erase the live turn's concurrency slot.
      await tx.jobs.enqueue('launch', first.key, { new: true })
      expect(await tx.jobs.claim('third', 10_000, ['launch', 'input'], pool)).toBeUndefined()
      expect(await tx.jobs.renew(first, 10_000)).toBeUndefined()
      expect(await tx.jobs.complete(first)).toBe(false)
      expect(await tx.jobs.claim('third', 10_000, ['input'], pool)).toBeDefined()
    })
    // A larger pool still excludes launch/input for the same assignment key.
    const another = { ...f.scope, spaceId: 'two-slots' }, larger = { name: 'workers', limit: 2 }
    await f.store.transaction(another, async tx => {
      await tx.jobs.enqueue('launch', 'same', {}); await tx.jobs.enqueue('input', 'same', {})
      expect(await tx.jobs.claim('one', 10_000, ['launch'], larger)).toBeDefined()
      expect(await tx.jobs.claim('two', 10_000, ['input'], larger)).toBeUndefined()
    })
  })
  it('holds thrown handlers without automatic retries; explicit generation-CAS reconciliation survives reopening', async () => {
    const f = await fixture(); let calls = 0
    await f.store.transaction(f.scope, tx => tx.jobs.enqueue('write', 'one', { fictional: true }))
    const broken = new DurableConsumer({ ...f, lanes: [{ kinds: ['write'], concurrency: 1, pool: { name: 'writes', limit: 1 }, handle: async () => { calls++; throw new Error('provider timeout contains a secret') } }] })
    consumers.push(broken)
    await broken.idle(); await broken.idle(); expect(calls).toBe(1)
    await broken.stop(); await f.store.close()
    const restored = await f.open()
    await restored.transaction(f.scope, async tx => {
      expect((await tx.jobs.list())[0]?.held).toContain('reconcile')
      expect(await tx.jobs.resume('write', 'one', 999)).toBe(false)
      expect(await tx.jobs.resume('write', 'one', 1)).toBe(true)
    })
    const recovered = new DurableConsumer({ store: restored, scope: f.scope, lanes: [{ kinds: ['write'], concurrency: 1, pool: { name: 'writes', limit: 1 }, handle: async ctx => {
      await ctx.assertCurrent(); calls++; return { state: 'done' }
    } }] }); consumers.push(recovered)
    await recovered.idle(); expect(calls).toBe(2)
    expect(await restored.transaction(f.scope, tx => tx.jobs.list())).toEqual([])
  })
  it('renews a long handler and retains its slot after supersession/abort until the handler actually settles', async () => {
    const f = await fixture(), begun = deferred(), release = deferred(); let context!: JobContext
    await f.store.transaction(f.scope, tx => tx.jobs.enqueue('work', 'turn', {}))
    const consumer = new DurableConsumer({ ...f, ttlMs: 900, lanes: [{ kinds: ['work'], concurrency: 1, pool: { name: 'workers', limit: 1 }, handle: async ctx => {
      context = ctx; begun.resolve(); await release.promise; return { state: 'done' }
    } }] }); consumers.push(consumer)
    consumer.kick(); await begun.promise
    try {
      await setTimeout(1200)
      expect(await f.peer.transaction(f.scope, tx => tx.jobs.claim('peer', 10_000, ['work'], { name: 'workers', limit: 1 }))).toBeUndefined()
      await f.peer.transaction(f.scope, tx => tx.jobs.enqueue('work', 'turn', { newer: true }))
      await expect(context.assertCurrent()).rejects.toThrow()
      expect(context.signal.aborted).toBe(true)
      expect(await f.peer.transaction(f.scope, tx => tx.jobs.claim('peer', 10_000, ['work'], { name: 'workers', limit: 1 }))).toBeUndefined()
    } finally { release.resolve() }
    await consumer.stop()
    const next = await f.peer.transaction(f.scope, tx => tx.jobs.claim('peer', 10_000, ['work'], { name: 'workers', limit: 1 }))
    expect(next?.generation).toBe(2); expect(next?.value).toEqual({ newer: true })
  })
  it('does not equate cancellation with actual completion or free capacity while a backend ignores abort', async () => {
    const f = await fixture(), begun = deferred(), release = deferred(); let context!: JobContext
    await f.store.transaction(f.scope, tx => tx.jobs.enqueue('work', 'turn', {}))
    const consumer = new DurableConsumer({ ...f, ttlMs: 900, lanes: [{ kinds: ['work'], concurrency: 1, pool: { name: 'workers', limit: 1 }, handle: async ctx => {
      context = ctx; begun.resolve(); await release.promise; return { state: 'hold', reason: 'Backend needs receipt inspection' }
    } }] }); consumers.push(consumer); consumer.kick(); await begun.promise
    let stopped = false; const stopping = consumer.stop().then(() => { stopped = true })
    expect(context.signal.reason).toBeInstanceOf(ConsumerStopping)
    try {
      await setTimeout(1200)
      await f.peer.transaction(f.scope, async tx => {
        await tx.jobs.cancel('work', 'turn'); await tx.jobs.enqueue('work', 'other', {})
        expect(await tx.jobs.claim('peer', 10_000, ['work'], { name: 'workers', limit: 1 })).toBeUndefined()
      })
      expect(stopped).toBe(false)
    } finally { release.resolve(); await stopping }
    expect(await f.peer.transaction(f.scope, tx => tx.jobs.claim('peer', 10_000, ['work'], { name: 'workers', limit: 1 }))).toBeDefined()
  })
  async function taskFixture() {
    const f = await fixture()
    await f.store.transaction(f.scope, tx => tx.put('installation', 'feishu-fixture', { owners: ['owner'], enabled: true }, 0))
    const policy: Policy = { version: 'fixture', paused: false, evalTimeoutMs: 60_000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention', sender: 'owner' } }),
      revalidate: () => true, admitsInferred: () => true }
    const authorize: AsyncRuntimeOptions['authorize'] = async (tx, command): Promise<CommandAuthority> => {
      const installation = (await tx.get<{ owners: string[]; enabled: boolean }>('installation', 'feishu-fixture'))?.value
      if (!installation?.enabled || !installation.owners.includes(command.userId)) throw new Error('Current owner authorization required')
      return { policy: () => policy, scope: { scope: () => ({ listened: true, observed: true }) } }
    }
    const trigger = feishuTrigger({ message_id: 'message-1', chat_id: 'test-chat', chat_type: 'group', sender_id: 'owner', sender_type: 'user',
      content: 'Summarize only fictional notes R1 finished R2 tomorrow', create_time: '1794268800000', mentions: [{ id: 'bot' }] }, 'bot', 'app')!
    expect(trigger).toBeDefined()
    return { ...f, authorize, trigger, policy }
  }
  it('runs a normalized synthetic Feishu event through actual Engine assessment, worker facts and ordered delivery after adapter replacement', async () => {
    const f = await taskFixture(), sent: string[] = [], requests: string[] = []
    let runtime!: AsyncTaskRuntime
    const options: AsyncRuntimeOptions = { store: f.store, scope: f.scope, actorId: 'owner', authorize: f.authorize,
      assess: async candidate => {
        // Reading from another connection here proves network/model callbacks are outside the state transaction.
        expect((await f.peer.transaction(f.scope, tx => tx.get('thread', candidate.thread.key)))?.value).toBeDefined()
        return { kind: 'accept', title: 'Fictional summary', scope: 'Supplied R1/R2 only', reason: 'explicit', acknowledgement: 'Accepted' }
      },
      work: async (request, ctx) => {
        await ctx.assertCurrent(); requests.push(request.requestId)
        const identity = (suffix: string) => ({ id: `${request.requestId}/${suffix}`, userId: 'owner' })
        const lease = await options.store.transaction(f.scope, tx => tx.leases.acquire(`session:${request.assignmentId}`, 'fixture-worker', 10_000))
        expect(lease).toBeDefined()
        await runtime.app.assignmentStarted(identity('started'), request.ticket.id, request.assignmentId, lease!)
        const inputIds = request.ticket.undelivered
        await runtime.app.workerFact(identity('delivered'), request.ticket.id, request.assignmentId, lease!, request.controlRevision, { kind: 'inputsDelivered', inputIds })
        await runtime.app.workerFact(identity('read'), request.ticket.id, request.assignmentId, lease!, request.controlRevision, { kind: 'inputsRead', inputIds })
        await runtime.app.report(identity('report'), request.ticket.id, request.assignmentId, lease!, request.controlRevision, { state: 'ready', summary: 'R1 finished; R2 tomorrow' })
        await runtime.app.workerFact(identity('ended'), request.ticket.id, request.assignmentId, lease!, request.controlRevision, { kind: 'turnEnded' })
        await runtime.app.reply(identity('reply'), { purpose: 'result', ticketId: request.ticket.id, text: 'R1 finished; R2 tomorrow' })
        return { state: 'done' }
      }, stop: async () => ({ state: 'done' }),
      delivery: { authorize: async tx => { await f.authorize(tx, { id: 'send', userId: 'owner', name: 'delivery' }) }, send: async message => { sent.push(message.kind); return `synthetic-receipt-${message.id}` } } }
    // Persist intake without starting any background loops, then replace the adapter/runtime.
    const { AsyncOrchestrator } = await import('../../src/state/index.ts')
    await new AsyncOrchestrator(options).receive({ id: 'ingress', userId: 'owner' }, 'feishu-fixture', 'message-1', f.trigger)
    await f.store.close(); options.store = await f.open()
    runtime = new AsyncTaskRuntime(options); consumers.push(runtime)
    await runtime.idle()
    expect(requests).toHaveLength(1); expect(sent).toEqual(['acknowledgement', 'reply'])
    await options.store.transaction(f.scope, async tx => {
      const tickets = await tx.scan<Ticket>('ticket'); expect(tickets).toHaveLength(1)
      expect(tickets[0]!.value.ended?.outcome).toBe('completed')
      expect(tickets[0]!.value.undelivered).toEqual([])
      expect((await tx.scan<DeliveryIntent>('outbox')).every(row => row.value.status === 'sent')).toBe(true)
      expect((await control(tx, tickets[0]!.id)).value.mode).toBe('agent')
      expect(await tx.jobs.list()).toEqual([])
    })
    await runtime.idle(); expect(requests).toHaveLength(1); expect(sent).toHaveLength(2)
  })
  it('rechecks persisted authority before consuming jobs, and never calls a worker after owner revocation', async () => {
    const f = await taskFixture(); let work = 0
    const { AsyncOrchestrator } = await import('../../src/state/index.ts')
    const app = new AsyncOrchestrator(f)
    await app.receive({ id: 'receive', userId: 'owner' }, 'feishu-fixture', 'message-1', f.trigger)
    await app.decide({ id: 'accept', userId: 'owner' }, f.trigger.id, { kind: 'accept', title: 'test', scope: 'fictional', reason: 'explicit' })
    await f.store.transaction(f.scope, tx => tx.put('installation', 'feishu-fixture', { owners: [], enabled: false }, 1))
    const runtime = new AsyncTaskRuntime({ ...f, actorId: 'owner', assess: async () => ({ kind: 'ignore', reason: 'not expected' }),
      work: async () => { work++; return { state: 'done' } }, stop: async () => ({ state: 'done' }), delivery: { authorize: async () => { throw new Error('revoked') }, send: async () => { throw new Error('must not send') } } })
    consumers.push(runtime); await runtime.idle(); expect(work).toBe(0)
    expect((await f.store.transaction(f.scope, tx => tx.jobs.list())).some(job => job.kind === 'domain.launch' && job.held)).toBe(true)
    expect(runtime.jobsHealth.get()?.state).toBe('error')
  })
  it('expires and replaces a delivered assessment through async clock commands, rejecting a late old decision', async () => {
    const f = await taskFixture(), { AsyncOrchestrator } = await import('../../src/state/index.ts'), app = new AsyncOrchestrator(f)
    f.policy.evalTimeoutMs = 1
    const identity = (id: string) => ({ id, userId: 'owner' })
    await app.receive(identity('receive'), 'feishu-fixture', 'message-1', f.trigger)
    await app.evaluateDue(identity('pass-1'))
    const before = (await app.candidate(identity('read-1'), f.trigger.id))!
    await app.candidateDelivered(identity('delivered'), before.thread.key, before.evalId)
    await setTimeout(30)
    await app.evaluateDue(identity('pass-2'))
    const after = (await app.candidate(identity('read-2'), f.trigger.id))!
    expect(after.evalId).not.toBe(before.evalId)
    await expect(app.decide(identity('late'), f.trigger.id, { evalId: before.evalId, kind: 'accept', title: 'Stale', scope: 'none', reason: 'old model response' })).rejects.toThrow()
    await f.store.transaction(f.scope, async tx => {
      expect(await tx.scan('ticket')).toEqual([])
      expect((await tx.jobs.list()).filter(job => job.kind === 'domain.assess').map(job => job.key)).toEqual([after.evalId])
    })
  })
  it('prevents result delivery overtaking an acknowledgement, including an unknown predecessor receipt', async () => {
    const f = await taskFixture(), { AsyncOrchestrator } = await import('../../src/state/index.ts'), app = new AsyncOrchestrator(f)
    const identity = (id: string) => ({ id, userId: 'owner' })
    await app.receive(identity('receive'), 'feishu-fixture', 'message-1', f.trigger)
    const decision = await app.decide(identity('accept'), f.trigger.id, { kind: 'accept', title: 'test', scope: 'fictional', reason: 'explicit', acknowledgement: 'Accepted' })
    const ticketId = decision.ticketId!, ticket = (await f.store.transaction(f.scope, tx => tx.get<Ticket>('ticket', ticketId)))!.value
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('test-session', 'fixture-worker', 10_000)))!
    const assignmentId = ticket.assignments.at(-1)!.id
    await app.assignmentStarted(identity('start'), ticketId, assignmentId, lease)
    const callbackId = identity('ready'), report = { state: 'ready' as const, summary: 'Fictional' }
    await app.report(callbackId, ticketId, assignmentId, lease, 0, report)
    const renewed = (await f.store.transaction(f.scope, tx => tx.leases.renew(lease, 20_000)))!
    await expect(app.report(callbackId, ticketId, assignmentId, renewed, 0, report)).resolves.toBeDefined()
    const reply = await app.reply(identity('result'), { purpose: 'result', ticketId, text: 'Full fictional report' })
    let sends = 0
    const outbox = new DurableOutbox(f.store, f.scope, { authorize: async () => {}, send: async () => { sends++; throw new Error('Ambiguous provider timeout') } })
    await expect(outbox.deliver(reply.id)).rejects.toBeInstanceOf(DeliveryPending)
    expect(sends).toBe(0)
    const earlier = (await f.store.transaction(f.scope, tx => tx.scan<DeliveryIntent>('outbox'))).find(row => row.id !== reply.id)!
    expect(await outbox.deliver(earlier.id)).toBe('unknown')
    await expect(outbox.deliver(reply.id)).rejects.toBeInstanceOf(DeliveryPending)
    expect(sends).toBe(1)
    expect((await f.store.transaction(f.scope, tx => tx.get<DeliveryIntent>('outbox', reply.id)))?.value.status).toBe('pending')
  })
})
