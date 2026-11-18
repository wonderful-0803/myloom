import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { AsyncOrchestrator, changeControl, confirmDrained, control, DurableOutbox, finishExecution, PostgresStateStore,
  reconcileExecution, registerExecution, SqliteStateStore, StateConflict } from '../../src/state/index.ts'
import type { CommandAuthority, DeliveryIntent, DurableControl, ExecutionEntry, ExecutionGrant, ExecutionIntent, StateStore } from '../../src/state/index.ts'
import type { Decision, Policy, Ticket, Trigger } from '../../src/core/index.ts'

const url = process.env.LOOM_STATE_TEST_DATABASE_URL
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('State tests require a disposable _test database')
const opened: StateStore[] = [], folders: string[] = []
afterEach(async () => { await Promise.all(opened.splice(0).map(value => value.close())); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
for (const kind of ['sqlite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !url ? describe.skip : describe
  suite(`durable command slice: ${kind}`, () => {
    async function fixture(options: { failPrepare?: boolean; wake?: () => void } = {}) {
      const folder = await mkdtemp(join(tmpdir(), 'loom-state-app-')); folders.push(folder)
      const path = join(folder, 'state.sqlite'), scope = { tenantId: `test-${randomUUID()}`, spaceId: 'one-owner' }
      const open = async () => {
        const db = kind === 'postgres' ? await PostgresStateStore.open({ connectionString: url }) : await SqliteStateStore.open(path)
        opened.push(db); return db
      }
      const store = await open()
      const policy: Policy = { version: 'test-v1', paused: false, evalTimeoutMs: 1000,
        gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention', sender: 'owner' } }),
        revalidate: () => true, admitsInferred: () => true }
      await store.transaction(scope, async tx => { await tx.put('installation', 'fixture', { owners: ['owner'], enabled: true }, 0) })
      const auth = async (tx: Parameters<Parameters<StateStore['transaction']>[1]>[0], command: { userId: string }): Promise<CommandAuthority> => {
        const config = (await tx.get<{ owners: string[]; enabled: boolean }>('installation', 'fixture'))?.value
        if (!config?.enabled || !config.owners.includes(command.userId)) throw new Error('Not an authorized owner')
        return { policy: () => policy, scope: { scope: () => ({ listened: true, observed: true }) },
          prepareTicket: ticket => { if (options.failPrepare) throw new Error('preparation rejected'); return ticket } }
      }
      const app = new AsyncOrchestrator({ store, scope, authorize: auth, wake: options.wake })
      const identity = (id = randomUUID()) => ({ id, userId: 'owner' })
      const trigger: Trigger = { id: 'event', source: 'fixture', human: true, addressed: 'mention', actor: { source: 'fixture', id: 'owner' },
        at: '2026-11-10T00:00:00.000Z', text: 'Only summarize these fictional notes', threads: [{ source: 'fixture', id: 'thread' }],
        channel: { source: 'fixture', thread: 'thread', address: { thread: 'thread' } }, meta: {} }
      async function accept(): Promise<Ticket> {
        await app.receive(identity(), 'fixture', 'native-1', trigger)
        const decision = await app.decide(identity(), trigger.id, { kind: 'accept', title: 'Summary', scope: 'Only the supplied notes', reason: 'explicit', acknowledgement: 'Accepted' })
        return (await store.transaction(scope, tx => tx.get<Ticket>('ticket', decision.ticketId!)))!.value
      }
      async function execution(ticket: Ticket): Promise<ExecutionIntent> {
        return store.transaction(scope, async tx => {
          const lease = (await tx.leases.acquire('session-1', 'compute-1', 10_000))!
          const grant: ExecutionGrant = { enabled: true, ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id, sessionId: lease.sessionId, userId: 'owner' }
          await tx.put('grant', 'grant-1', grant, 0)
          return { requestId: 'request-1', ticketId: ticket.id, assignmentId: grant.assignmentId, userId: 'owner', lease,
            controlRevision: 0, grantId: 'grant-1', grantRevision: 1, parameters: { tool: 'read', path: 'notes.txt' } }
        })
      }
      return { store, scope, app, identity, trigger, accept, execution, open, auth }
    }
    it('commits actual domain admission, one assignment, durable launch and acknowledgement; wakeup loss is harmless', async () => {
      const f = await fixture({ wake: () => { throw new Error('notification lost') } }), ticket = await f.accept()
      expect(ticket.assignments).toHaveLength(1)
      expect(await f.app.receive(f.identity(), 'fixture', 'native-1', f.trigger)).toBe('duplicate')
      const second = await f.app.decide(f.identity(), f.trigger.id, { kind: 'accept', title: 'Duplicate', scope: 'same', reason: 'retry' })
      expect(second.ticketId).toBe(ticket.id)
      await f.store.transaction(f.scope, async tx => {
        expect(await tx.scan('ticket')).toHaveLength(1)
        expect(await tx.scan('decision')).toHaveLength(1)
        expect((await tx.jobs.list()).filter(job => job.kind === 'domain.launch')).toHaveLength(1)
        expect(await tx.scan('outbox')).toHaveLength(1)
        expect((await control(tx, ticket.id)).value.mode).toBe('agent')
      })
    })
    it('does not persist a half decision, assignment, outbox or launch when preparation fails', async () => {
      const f = await fixture({ failPrepare: true })
      await f.app.receive(f.identity(), 'fixture', 'native-1', f.trigger)
      await expect(f.app.decide(f.identity(), f.trigger.id, { kind: 'accept', title: 'Fail', scope: 'notes', reason: 'test' })).rejects.toThrow('preparation rejected')
      await f.store.transaction(f.scope, async tx => {
        expect(await tx.scan('trigger')).toHaveLength(1)
        for (const family of ['decision', 'ticket', 'outbox'] as const) expect(await tx.scan(family)).toHaveLength(0)
        expect(await tx.jobs.list()).toHaveLength(0)
      })
    })
    it('deduplicates commands and native events, rejects changed content, and rechecks current owner authority on replay', async () => {
      const f = await fixture(), command = f.identity()
      expect(await f.app.receive(command, 'fixture', 'native-1', f.trigger)).toBe('stored')
      expect(await f.app.receive(command, 'fixture', 'native-1', f.trigger)).toBe('stored')
      await expect(f.app.receive(f.identity(), 'fixture', 'native-1', { ...f.trigger, text: 'changed' })).rejects.toBeInstanceOf(StateConflict)
      await expect(f.app.receive(command, 'fixture', 'native-1', { ...f.trigger, text: 'changed' })).rejects.toBeInstanceOf(StateConflict)
      await f.store.transaction(f.scope, async tx => { await tx.put('installation', 'fixture', { owners: [], enabled: true }, 1) })
      await expect(f.app.receive(command, 'fixture', 'native-1', f.trigger)).rejects.toThrow('authorized owner')
    })
    it('uses the current Session lease and control fence for reports and delivers through a persisted outbox intent', async () => {
      const f = await fixture(), ticket = await f.accept(), intent = await f.execution(ticket)
      await f.app.assignmentStarted(f.identity(), ticket.id, intent.assignmentId, intent.lease)
      const done = await f.app.report(f.identity(), ticket.id, intent.assignmentId, intent.lease, 0, { state: 'ready', summary: 'Completed from supplied notes' })
      expect(done.ended?.outcome).toBe('completed')
      const reply = await f.app.reply(f.identity(), { purpose: 'result', ticketId: ticket.id, text: 'Full report' })
      let sent = 0
      const outbox = new DurableOutbox(f.store, f.scope, { authorize: async tx => { await f.auth(tx, { userId: 'owner' }) }, send: async message => {
        if (message.id === reply.id) { sent++; expect(message.text).toBe('Full report') }; return 'provider-receipt'
      } })
      const prior = await f.store.transaction(f.scope, tx => tx.scan<DeliveryIntent>('outbox'))
      for (const row of prior.filter(row => row.id !== reply.id).sort((a, b) => a.value.order! - b.value.order!)) await outbox.deliver(row.id)
      expect(await outbox.deliver(reply.id)).toBe('sent')
      expect(await outbox.deliver(reply.id)).toBe('sent'); expect(sent).toBe(1)
    })
    it('serializes pause against execution registration and preserves unknown outcomes through a new adapter', async () => {
      const f = await fixture(), ticket = await f.accept(), intent = await f.execution(ticket)
      const created = await f.store.transaction(f.scope, tx => registerExecution(tx, intent))
      expect(created.created).toBe(true)
      expect((await f.store.transaction(f.scope, tx => registerExecution(tx, intent))).created).toBe(false)
      await expect(f.store.transaction(f.scope, tx => registerExecution(tx, { ...intent, parameters: { tool: 'write' } }))).rejects.toThrow('reused')
      await f.app.changeControl(f.identity(), ticket.id, 0, 'takeover')
      await expect(f.store.transaction(f.scope, tx => registerExecution(tx, { ...intent, requestId: 'request-2' }))).rejects.toThrow('held')
      await f.store.transaction(f.scope, async tx => { await finishExecution(tx, intent.requestId, 'unknown', { reason: 'connection lost' }); await confirmDrained(tx, ticket.id, 1) })
      await f.store.close()
      const next = await f.open()
      await next.transaction(f.scope, async tx => {
        expect((await control(tx, ticket.id)).value.mode).toBe('taking_over')
        expect((await tx.get<ExecutionEntry>('execution', intent.requestId))?.value.status).toBe('unknown')
      })
      await expect(next.transaction(f.scope, tx => changeControl(tx, ticket.id, 1, 'return', 'owner'))).rejects.toThrow('confirmed stopped')
      await next.transaction(f.scope, async tx => {
        await reconcileExecution(tx, intent.requestId, 'owner', 'Checked the device ledger: no write was executed', 'failed')
        expect((await control(tx, ticket.id)).value.mode).toBe('human')
        expect((await changeControl(tx, ticket.id, 1, 'return', 'owner')).revision).toBe(2)
      })
    })
    it('rechecks owner authorization for controls and serializes racing pause/dispatch on the same database fence', async () => {
      const f = await fixture(), ticket = await f.accept(), intent = await f.execution(ticket), peer = await f.open()
      const outcomes = await Promise.allSettled([
        peer.transaction(f.scope, tx => registerExecution(tx, intent)),
        f.app.changeControl(f.identity(), ticket.id, 0, 'pause'),
      ])
      expect(outcomes[1]!.status).toBe('fulfilled')
      await f.store.transaction(f.scope, async tx => {
        const fence = (await control(tx, ticket.id)).value
        expect(fence.mode).toBe('pausing')
        const entry = await tx.get('execution', intent.requestId)
        expect(fence.operations.some(op => op.id === intent.requestId)).toBe(!!entry)
        if (outcomes[0]!.status === 'fulfilled') expect(entry).toBeDefined()
        else expect(entry).toBeUndefined()
        await tx.put('installation', 'fixture', { owners: [], enabled: true }, 1)
      })
      await expect(f.app.changeControl(f.identity(), ticket.id, 1, 'resume')).rejects.toThrow('authorized owner')
    })
    it('rejects stale reports and revoked execution grants before creating a request', async () => {
      const f = await fixture(), ticket = await f.accept(), intent = await f.execution(ticket)
      await f.store.transaction(f.scope, async tx => {
        const grant = (await tx.get<ExecutionGrant>('grant', intent.grantId))!
        await tx.put('grant', intent.grantId, { ...grant.value, enabled: false }, grant.revision)
      })
      await expect(f.store.transaction(f.scope, tx => registerExecution(tx, intent))).rejects.toThrow('grant')
      await f.store.transaction(f.scope, tx => changeControl(tx, ticket.id, 0, 'pause', 'owner'))
      await expect(f.app.report(f.identity(), ticket.id, intent.assignmentId, intent.lease, 0, { state: 'ready', summary: 'late' })).rejects.toThrow('held')
      await f.store.transaction(f.scope, async tx => { expect(await tx.scan('execution')).toEqual([]); expect((await tx.get<Ticket>('ticket', ticket.id))?.value.ended).toBeUndefined() })
    })
    it('does not resend when provider submission succeeds but receipt storage is unavailable', async () => {
      const f = await fixture(), ticket = await f.accept()
      const id = (await f.store.transaction(f.scope, tx => tx.scan<DeliveryIntent>('outbox')))[0]!.id
      let sends = 0
      const outbox = new DurableOutbox(f.store, f.scope, { authorize: async tx => { await f.auth(tx, { userId: 'owner' }) }, send: async () => { sends++; await f.store.close(); return 'accepted-by-provider' } }, 15)
      await expect(outbox.deliver(id)).rejects.toThrow('closed')
      await setTimeout(35)
      const next = await f.open(), recovered = new DurableOutbox(next, f.scope, { authorize: async () => {}, send: async () => { sends++; return 'duplicate' } })
      expect(await recovered.deliver(id)).toBe('unknown'); expect(await recovered.deliver(id)).toBe('unknown'); expect(sends).toBe(1)
      await next.transaction(f.scope, async tx => {
        const row = (await tx.get<DurableControl>('control', ticket.id))!
        expect(row.value.mode).toBe('pausing'); expect(row.value.operations[0]?.status).toBe('unknown')
      })
    })
    it('refuses altered persisted delivery bytes before invoking the transport', async () => {
      const f = await fixture(); await f.accept()
      const row = (await f.store.transaction(f.scope, tx => tx.scan<DeliveryIntent>('outbox')))[0]!
      await f.store.transaction(f.scope, tx => tx.put('outbox', row.id, { ...row.value, message: { ...row.value.message, text: 'altered' } }, row.revision))
      let sends = 0
      const outbox = new DurableOutbox(f.store, f.scope, { authorize: async () => {}, send: async () => { sends++; return 'receipt' } })
      await expect(outbox.deliver(row.id)).rejects.toThrow('integrity')
      expect(sends).toBe(0)
    })
  })
}
