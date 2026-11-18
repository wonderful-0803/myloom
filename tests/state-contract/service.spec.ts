import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { CompanyServer, DurableFeishuSource, AsyncTaskRuntime, DurableArtifacts } from '../../src/state/index.ts'
import { NativeOfficeBackend } from '../../src/state/native.ts'
import { groupWorkspace } from '../../src/group-mode.ts'
import { feishuTrigger } from '../../src/sources/feishu-trigger.ts'
import type { FeishuWire, SettingsRecord, StateStore } from '../../src/state/index.ts'
import { productFixture, testURL } from './fixtures/product.ts'
import { nativeFixture } from './fixtures/native.ts'
import { companyNativeFixture } from '../dsh-state/fixtures/company.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
// Result delivery may retry after the native stop receipt; its durable backoff can exceed three seconds.
async function until(check: () => Promise<boolean>) { const end = performance.now() + 10000; while (performance.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error('Expected durable service state was not reached') }
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !testURL ? describe.skip : describe)(`company service: ${dialect}`, () => {
  it('runs the SQL native provider through actual durable job guards and original-thread result delivery', async () => {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const host = await companyNativeFixture(f.store, f.scope, async (agent, invoke) => {
      const input = JSON.parse(agent.session.snapshotEvents().findLast((event: any) => event.type === 'user/message').data.content[0].text)
      await invoke('orchestrator_read', { resource: `ticket/${input.ticket_id}` })
      await invoke('orchestrator_report', { state: 'ready', summary: 'SQL managed synthetic report' })
    }); closes.push(() => host.close())
    const raw = f.raw('sql-native', '仅根据虚构 R1 总结工作'), files: Buffer[] = []
    const wire: FeishuWire = { verify: async () => {}, lark: async args => args.includes('/open-apis/im/v1/messages') ? { items: [], has_more: false } as any : { message_id: 'om_sql_receipt' } as any,
      file: async (_target, _filename, bytes) => { files.push(Buffer.from(bytes)); return 'om_sql_file' },
      async *events(signal, ready) { ready?.(); yield raw; if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } }
    const assets = join(f.folder, 'sql-assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<html><head></head><body>fixture</body></html>')
    const server = await CompanyServer.open({ store: f.store, scope: f.scope, installationId: 'installed', blobRoot: join(f.folder, 'objects'), scratch: join(f.folder, 'sql-compute'), assets,
      origin: 'http://127.0.0.1:3085', port: 0, cli: 'never-invoked', wire, development: true,
      login: { authorizeUrl: state => `https://login.example/?state=${state}`, exchange: async () => ({ openId: 'ou_owner', tenantKey: 'test-tenant', expiresIn: 3600 }) },
      backend: async services => { const native = new NativeOfficeBackend({ ...services, context: host.context, nativeState: host.provider });
        return { assess: async () => ({ kind: 'accept', title: 'Synthetic SQL summary', scope: 'R1 only', reason: 'fixture' }), work: (...args) => native.work(...args), stop: (...args) => native.stop(...args), close: () => native.close() } } })
    closes.push(() => server.stop()); await server.start(); await until(async () => files.length === 1); await server.runtime.idle()
    expect(host.failures).toEqual([]); expect(host.agents.size).toBe(0)
    expect(files[0]!.toString()).toBe('SQL managed synthetic report')
    const snapshot = await server.product.snapshot('ou_owner'); expect(snapshot.tasks[0]?.completed).toBe(true)
    const record = await host.provider.stat(`worker-${snapshot.tasks[0]!.id}` as never); expect(record?.eventCount).toBeGreaterThan(0)
  }, 15_000)
  it.each([false, true])('runs source → native Session → report → file with unknown delivery=%s and reopens without resending', async uncertain => {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const files: { target: unknown; bytes: Buffer }[] = [], texts: string[] = [], raw = f.raw('native', '仅用以下虚构记录整理工作总结：R1 完成整理。')
    const wire: FeishuWire = { verify: async () => {}, lark: async args => {
      if (args.includes('/open-apis/im/v1/messages')) return { items: [], has_more: false } as any
      texts.push(args[args.indexOf('--markdown') + 1]!); return { message_id: `om_receipt${texts.length}` } as any
    }, file: async (target, _filename, bytes) => { files.push({ target, bytes: Buffer.from(bytes) }); if (uncertain) throw new Error('Fixture: accepted file, response lost'); return 'om_file_receipt' },
      async *events(signal, ready) { ready?.(); yield raw; if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } }
    const host = nativeFixture(async (_agent, invoke) => {
      await expect(invoke('orchestrator_unregistered_plugin', {})).rejects.toThrow('denied')
      // Deliberately invoke before the native delivery flush has finished to exercise the input barrier.
      const inbox = JSON.parse(_agent.session.snapshotEvents().find((e: any) => e.type === 'user/message').data.content[0].text)
      const result = await invoke('orchestrator_read', { resource: `ticket/${inbox.ticket_id}` })
      expect(result.ticket.inputs.every((value: any) => !!value.readAt)).toBe(true)
      await invoke('orchestrator_report', { state: 'ready', summary: '已完成：完成整理。[R1]' })
    })
    const assets = join(f.folder, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<html><head></head><body>fixture</body></html>')
    const open = () => CompanyServer.open({ store: f.store, scope: f.scope, installationId: 'installed', blobRoot: join(f.folder, 'objects'), scratch: join(f.folder, 'compute'), assets,
      origin: 'http://127.0.0.1:3085', port: 0, cli: 'never-invoked', wire, development: true,
      login: { authorizeUrl: state => `https://login.example/?state=${state}`, exchange: async () => ({ openId: 'ou_owner', tenantKey: 'test-tenant', expiresIn: 3600 }) },
      backend: async services => { const native = new NativeOfficeBackend({ ...services, context: host.context }); return { assess: async () => ({ kind: 'accept', title: 'Synthetic summary', scope: 'R1 only', reason: 'fixture' }), work: (...args) => native.work(...args), stop: (...args) => native.stop(...args), close: () => native.close() } } })
    const server = await open(); closes.push(() => server.stop()); const address = await server.start()
    await until(async () => files.length === 1)
    await server.runtime.idle()
    expect(host.failures).toEqual([]); expect(host.denied).toEqual(['orchestrator_unregistered_plugin'])
    const snapshot = await server.product.snapshot('ou_owner'), task = snapshot.tasks[0]!
    expect(snapshot.tasks).toHaveLength(1); expect(task.completed).toBe(true)
    expect(files[0]!.target).toEqual({ messageId: 'om_native', threaded: true }); expect(files[0]!.bytes.toString()).toBe('已完成：完成整理。[R1]')
    expect((await server.product.progress('ou_owner', task.id))).toMatchObject({ phase: uncertain ? 'pausing' : 'completed', toolCalls: 2, outputTokens: 23 })
    if (uncertain) {
      const receipt = snapshot.resultDeliveries[0]!
      expect(receipt.status).toBe('unknown'); expect(task.control.pending).toBe(1)
      await expect(server.product.handle('ou_owner', 'POST', ['tasks', task.id, 'reconcile'], {}, { kind: 'result', id: receipt.id, revision: task.control.revision, outcome: 'succeeded', evidence: 'Fixture provider lookup confirmed the original file exists.' }, 'reconcile-no-receipt')).rejects.toThrow('receipt')
      await server.product.handle('ou_owner', 'POST', ['tasks', task.id, 'reconcile'], {}, { kind: 'result', id: receipt.id, revision: task.control.revision, outcome: 'succeeded', receipt: 'om_file_receipt', evidence: 'Fixture provider lookup confirmed the original file exists.' }, 'reconcile-with-receipt')
      const after = (await server.product.snapshot('ou_owner')).tasks[0]!
      expect(after.control).toMatchObject({ mode: 'paused', pending: 0 })
    }
    const begin = await server.sessions.begin(), session = await server.sessions.callback(new URL(begin.location).searchParams.get('state')!, begin.browser, 'fixture-code')
    const response = await fetch(`http://127.0.0.1:${address.port}/orchestrator/api/loom`, { headers: { cookie: `loom_session=${session.token}` } })
    expect(response.status).toBe(200); expect((await response.json() as any).tasks[0].id).toBe(task.id)
    await server.stop(); await rm(join(f.folder, 'compute'), { recursive: true, force: true })
    const next = await open(); closes.push(() => next.stop()); await next.start(); await next.runtime.idle()
    expect((await next.product.artifact('ou_owner', task.id)).body).toContain('完成整理')
    expect((await next.product.progress('ou_owner', task.id)).outputTokens).toBe(23)
    expect(files).toHaveLength(1)
  }, 20_000)
  it('reauthorizes group context, fences a second listener and retains a failed history cursor instead of skipping events', async () => {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const raw = f.raw('context', 'Other participant context', { sender_id: 'ou_observer', mentions: [] })
    const runtime = new AsyncTaskRuntime({ store: f.store, scope: f.scope, actorId: 'ou_owner', authorize: f.access.authorize,
      assess: async () => { throw new Error('Context must not start Router') }, work: async () => { throw new Error('Context must not start Worker') }, stop: async () => ({ state: 'done' }),
      delivery: { authorize: async () => {}, send: async () => { throw new Error('No sends') } } }); closes.push(() => runtime.stop())
    const wire: FeishuWire = { async *events() {}, lark: async () => ({ items: [], has_more: true } as any) }
    const source = new DurableFeishuSource({ store: f.store, scope: f.scope, access: f.access, runtime, wire, bot: { cli: 'fixture', appId: 'cli_test', botId: 'ou_bot', name: 'Fixture', brand: 'feishu' } })
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('source/installed', 'first', 30_000)))!
    expect(await f.store.transaction(f.scope, tx => tx.leases.acquire('source/installed', 'second', 30_000))).toBeUndefined()
    expect(await source.ingest(raw, lease)).toBe('stored'); expect(await source.ingest(raw, lease)).toBe('duplicate')
    expect(await f.store.transaction(f.scope, tx => tx.scan('ticket'))).toEqual([])
    const signalRows = await f.store.transaction(f.scope, tx => tx.scan<any>('audit', { relation: 'signal.feishu', recent: true, limit: 10 }))
    expect(signalRows).toHaveLength(1); expect(signalRows[0]!.value).toMatchObject({ kind: 'message' })
    await expect(source.recover(lease, AbortSignal.timeout(2000))).rejects.toThrow('cursor did not advance')
    expect(await f.store.transaction(f.scope, tx => tx.get('source-state', 'history/oc_test'))).toBeUndefined()
    const containers: string[] = []
    wire.lark = async args => {
      const params = JSON.parse(args[args.indexOf('--params') + 1]!)
      containers.push(params.container_id_type)
      const message = { message_id: params.container_id_type === 'chat' ? 'om_new_root' : 'om_offline_reply', chat_id: 'oc_test', create_time: String(Date.now()), msg_type: 'text', thread_id: 'omt_new',
        ...(params.container_id_type === 'thread' ? { root_id: 'om_new_root' } : {}), sender: { id: 'ou_observer', sender_type: 'user' }, body: { content: JSON.stringify({ text: 'Offline topic context' }) } }
      return { items: [message], has_more: false } as any
    }
    await source.recover(lease, AbortSignal.timeout(2000))
    expect(containers).toEqual(['chat', 'thread'])
    const watermark = (await f.store.transaction(f.scope, tx => tx.get<{ recoveredThrough: string }>('source-state', 'history/oc_test')))!.value.recoveredThrough
    await source.ingest(f.raw('live_reply', 'A later live reply', { sender_id: 'ou_observer', mentions: [], thread_id: 'omt_live', root_id: 'om_live_root' }), lease)
    expect((await f.store.transaction(f.scope, tx => tx.get<{ recoveredThrough: string }>('source-state', 'history/oc_test')))!.value.recoveredThrough).toBe(watermark)
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get<SettingsRecord>('settings', 'current'))!; row.value.settings.policy.sources.feishu!.workspace = { ...groupWorkspace(row.value.settings)!, masters: [{ id: 'ou_owner', name: 'Owner' }] }; await tx.put('settings', 'current', row.value, row.revision) })
    await expect(f.store.transaction(f.scope, tx => f.access.user(tx, 'ou_second'))).rejects.toThrow('authorized')
    await f.store.transaction(f.scope, tx => tx.leases.release(lease))
    await expect(source.ingest(raw, lease)).rejects.toThrow()
    let failFirst = true, sourceErrors = 0, sourceReady = false
    const lifetime = new AbortController(), recoveringStore: StateStore = { dialect: f.store.dialect, close: () => f.store.close(), transaction: (scope, work) => {
      if (failFirst) { failFirst = false; return Promise.reject(new Error('Fixture transient database outage')) }
      return f.store.transaction(scope, work)
    } }
    const recovering = new DurableFeishuSource({ store: recoveringStore, scope: f.scope, access: f.access, runtime,
      bot: { cli: 'fixture', appId: 'cli_test', botId: 'ou_bot', name: 'Fixture', brand: 'feishu' },
      wire: { lark: async () => ({ items: [], has_more: false } as any), async *events(_signal, ready) { ready?.() } },
      health: state => { if (state === 'error') sourceErrors++; if (state === 'ready') { sourceReady = true; lifetime.abort() } } })
    await recovering.run(lifetime.signal)
    expect(sourceErrors).toBe(1); expect(sourceReady).toBe(true)
  })
  it('batches unaddressed owner messages in one short-lived Feishu intake thread', async () => {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const runtime = new AsyncTaskRuntime({ store: f.store, scope: f.scope, actorId: 'ou_owner', authorize: f.access.authorize,
      assess: async () => ({ kind: 'ignore', reason: 'fixture' }), work: async () => ({ state: 'done' as const }), stop: async () => ({ state: 'done' as const }),
      delivery: { authorize: async () => {}, send: async () => 'never' } }); closes.push(() => runtime.stop())
    const source = new DurableFeishuSource({ ...f, runtime, wire: { async *events() {}, lark: async () => ({ items: [], has_more: false }) as any }, bot: { cli: 'fixture', appId: 'cli_test', botId: 'ou_bot', name: 'Fixture', brand: 'feishu' } })
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('source/installed', 'batch-test', 30_000)))!
    const first = f.raw('batch-1', '先给出记录', { mentions: [], create_time: String(Date.now()) }), second = f.raw('batch-2', '再整理成总结', { mentions: [], create_time: String(Date.now() + 500) })
    await source.ingest(first, lease); await source.ingest(second, lease)
    const threads = await f.store.transaction(f.scope, tx => tx.scan<any>('thread', { limit: 20 }))
    const batch = threads.find(row => row.id.startsWith('feishu:feishu:batch:'))
    expect(batch?.value.pending).toHaveLength(2); expect(batch?.value.evaluateAfter).toBeTruthy()
  })
  it('recovers the CLI/history image representation without changing the committed source or accepting another image', async () => {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const runtime = new AsyncTaskRuntime({ store: f.store, scope: f.scope, actorId: 'ou_owner', authorize: f.access.authorize,
      assess: async () => { throw Error('Not started') }, work: async () => { throw Error('Not started') }, stop: async () => ({ state: 'done' }), delivery: { authorize: async () => {}, send: async () => 'never' } }); closes.push(() => runtime.stop())
    const timestamp = String(Date.now() - 100), raw = f.raw('picture', '[Image: img_fictional]', { create_time: timestamp, mentions: [], msg_type: 'image' })
    const message = { message_id: 'om_picture', chat_id: 'oc_test', create_time: timestamp, msg_type: 'image', sender: { id: 'ou_owner', sender_type: 'user' }, body: { content: JSON.stringify({ image_key: 'img_fictional' }) } }
    const wire: FeishuWire = { async *events() {}, lark: async () => ({ items: [message], has_more: false }) as any }
    const source = new DurableFeishuSource({ ...f, runtime, wire, bot: { cli: 'never', appId: 'cli_test', botId: 'ou_bot', name: 'Fixture', brand: 'feishu' } })
    let lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('subscription/installed', 'picture-test', 30000)))!
    expect(await source.ingest(raw, lease)).toBe('stored')
    await source.recover(lease, AbortSignal.timeout(3000))
    expect((await f.store.transaction(f.scope, tx => tx.scan<any>('trigger')))[0]!.value.text).toBe('[Image: img_fictional]')
    await f.store.transaction(f.scope, tx => tx.leases.release(lease))
    lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('subscription/installed', 'picture-recovery', 30000)))!
    expect(await source.ingest({ ...raw, content: message.body.content }, lease)).toBe('duplicate')
    await expect(source.ingest({ ...raw, content: '{"image_key":"img_another"}' }, lease)).rejects.toThrow(/changed content|different parameters/)
    await expect(source.ingest({ ...raw, content: '{"image_key":"img_fictional","caption":"extra input"}' }, lease)).rejects.toThrow(/changed content|different parameters/)
    await expect(source.ingest({ ...raw, content: message.body.content, sender_id: 'ou_second' }, lease)).rejects.toThrow(/changed content|different parameters/)
    const reverse = { ...raw, message_id: 'om_reverse', content: message.body.content }
    expect(await source.ingest(reverse, lease)).toBe('stored')
    await f.store.transaction(f.scope, tx => tx.leases.release(lease))
    lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('subscription/installed', 'picture-recovery-again', 30000)))!
    expect(await source.ingest({ ...reverse, content: raw.content }, lease)).toBe('duplicate')
  })
  it('keeps a threaded history replay idempotent after canonicalizing its root', async () => {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const runtime = new AsyncTaskRuntime({ store: f.store, scope: f.scope, actorId: 'ou_owner', authorize: f.access.authorize,
      assess: async () => { throw Error('Not started') }, work: async () => { throw Error('Not started') }, stop: async () => ({ state: 'done' }), delivery: { authorize: async () => {}, send: async () => 'never' } }); closes.push(() => runtime.stop())
    const timestamp = String(Date.now() - 100), raw = f.raw('threaded-picture', '原始线程内容', { sender_id: 'ou_observer', mentions: [], create_time: timestamp, thread_id: 'omt_threaded', root_id: 'om_root' })
    const message = { message_id: 'om_threaded-picture', chat_id: 'oc_test', create_time: String(Number(timestamp) - 50), msg_type: 'text', thread_id: 'omt_threaded', root_id: 'om_root', sender: { id: 'ou_observer', sender_type: 'user' }, body: { content: JSON.stringify({ text: '历史接口的同一条消息' }) } }
    const source = new DurableFeishuSource({ ...f, runtime, wire: { async *events() {}, lark: async () => ({ items: [message], has_more: false }) as any }, bot: { cli: 'never', appId: 'cli_test', botId: 'ou_bot', name: 'Fixture', brand: 'feishu' } })
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('subscription/installed', 'threaded-replay', 30000)))!
    expect(await source.ingest(raw, lease)).toBe('stored')
    await expect(source.recover(lease, AbortSignal.timeout(3000))).resolves.toBeUndefined()
  })
})
