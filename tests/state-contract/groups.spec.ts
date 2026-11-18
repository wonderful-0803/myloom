import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CompanyServer, CompanyGroups, GroupEventBroker, CompanyCapacity, productHttp, groupCompanyConfig, AccessDenied } from '../../src/state/index.ts'
import type { FeishuWire, SettingsRecord, CompanyGroupRecord, CompanyBackend } from '../../src/state/index.ts'
import { NativeOfficeBackend } from '../../src/state/native.ts'
import { nativeFixture } from './fixtures/native.ts'
import { productFixture, testURL } from './fixtures/product.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function until(check: () => boolean | Promise<boolean>) { const end = performance.now() + 8000; while (performance.now() < end) { if (await check()) return; await delay(10) } throw Error('Multi-group checkpoint timeout') }
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !testURL ? describe.skip : describe)(`independent group host: ${dialect}`, () => {
  async function fixture(failFirstBoot = false) {
    const f = await productFixture(dialect, true); closes.push(f.close)
    const lifetime = new AbortController(), queue: unknown[] = []; let wake: (() => void) | undefined, watches = 0
    const files: { target: { messageId?: string }; body: string }[] = []
    let loginActor = 'ou_owner'
    const wire: FeishuWire = { verify: async () => {}, async *events(signal, ready) {
      watches++; ready?.(); const abort = () => wake?.(); signal.addEventListener('abort', abort, { once: true })
      try { while (!signal.aborted) { if (queue.length) yield queue.shift(); else await new Promise<void>(done => { wake = done; if (signal.aborted) done() }) } }
      finally { signal.removeEventListener('abort', abort) }
    }, lark: async <T>(args: string[]): Promise<T> => {
      if (args.includes('/open-apis/im/v1/messages')) return { items: [], has_more: false } as T
      if (args.includes('/open-apis/im/v1/chats')) return { items: [{ chat_id: 'oc_test', name: 'A' }, { chat_id: 'oc_second', name: 'B' }], has_more: false } as T
      if (args.some(arg => arg.startsWith('/open-apis/im/v1/chats/'))) return { name: 'Verified B' } as T
      if (args.includes('+chat-members-list')) return { users: [{ member_id: 'ou_owner', name: 'Owner' }, { member_id: 'ou_third', name: 'Third' }], has_more: false } as T
      return { message_id: 'om_text_' + randomUUID() } as T
    }, file: async (target, _filename, bytes) => { files.push({ target, body: Buffer.from(bytes).toString() }); return 'om_file_' + randomUUID() } }
    const broker = new GroupEventBroker(wire, { store: f.store, scope: f.scope, access: f.access, appId: 'cli_test', botId: 'ou_bot' }), capacity = new CompanyCapacity(2, 1)
    const assets = join(f.folder, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<html><head></head><body>groups</body></html>')
    const hosts: ReturnType<typeof nativeFixture>[] = [], servers: CompanyServer[] = []
    const make = async (spaceId: string, chatId: string) => {
      // Separate contexts even when task/session IDs happen to be equal.
      const host = nativeFixture(async (agent, invoke) => {
        const envelope = JSON.parse(agent.session.snapshotEvents().find((e: any) => e.type === 'user/message').data.content[0].text)
        const { ticket } = await invoke('orchestrator_read', { resource: `ticket/${envelope.ticket_id}` })
        const { trigger } = await invoke('orchestrator_read', { resource: `trigger/${ticket.origin.triggerId}` })
        await invoke('orchestrator_report', { state: 'ready', summary: String(trigger.text) })
      }); hosts.push(host)
      const server = await CompanyServer.open({ store: f.store, scope: { ...f.scope, spaceId }, installationId: 'installed', blobRoot: join(f.folder, 'objects'), scratch: join(f.folder, 'compute', spaceId), assets,
        origin: 'http://127.0.0.1:3085', port: 0, cli: 'never-called', wire: broker.subscribe(chatId), embedded: true, development: true,
        login: { authorizeUrl: state => `https://login.example/?state=${state}`, exchange: async () => ({ openId: loginActor, tenantKey: 'test-tenant', expiresIn: 3600 }) },
        backend: async services => { const native = new NativeOfficeBackend({ ...services, context: host.context }); return capacity.wrap({ assess: async () => ({ kind: 'accept', title: 'Fictional summary', scope: 'Only supplied records', reason: 'test' }), work: (...args) => native.work(...args), stop: (...args) => native.stop(...args), close: () => native.close() }) } })
      servers.push(server); await server.start(); return server
    }
    const primary = await make(f.scope.spaceId, 'oc_test')
    const groups = await CompanyGroups.open({ store: f.store, primary, wire, factory: (record: CompanyGroupRecord) => {
      if (failFirstBoot) { failFirstBoot = false; throw Error('Synthetic native boot interruption') }
      return make(record.spaceId, record.chatId)
    } })
    const running = broker.run(lifetime.signal)
    closes.push(async () => { lifetime.abort(); await groups.close(); await running })
    const publish = (raw: unknown) => { queue.push(raw); wake?.() }
    const create = (patch = {}) => groups.create('ou_owner', { chatId: 'oc_second', masters: ['ou_owner', 'ou_third'], mode: 'auto', requestId: randomUUID(), ...patch })
    await until(() => primary.sourceHealth === 'ready')
    return { ...f, groups, broker, primary, servers, wire, files, hosts, create, publish, watches: () => watches, actor: (value: string) => { loginActor = value }, assets }
  }
  it('shares one real connection and creates distinct task/context/artifact authorities with original-thread delivery', async () => {
    const f = await fixture(), added = await f.create(), second = f.servers[1]!
    await until(() => second.sourceHealth === 'ready')
    f.publish(f.raw('groupA', 'A_ONLY fictional R1', { sender_id: 'ou_second' }))
    f.publish(f.raw('groupB', 'B_ONLY fictional R2', { chat_id: 'oc_second', sender_id: 'ou_third' }))
    f.publish(f.raw('ignored', 'UNREGISTERED', { chat_id: 'oc_unregistered' }))
    await until(() => f.files.length === 2)
    expect(f.watches()).toBe(1); const a = await f.primary.product.snapshot('ou_second'), b = await second.product.snapshot('ou_third')
    expect(a.tasks).toHaveLength(1); expect(b.tasks).toHaveLength(1)
    expect(a.events.every(event => !event.text.includes('B_ONLY'))).toBe(true); expect(b.events.every(event => !event.text.includes('A_ONLY'))).toBe(true)
    expect(f.files).toEqual(expect.arrayContaining([{ target: { messageId: 'om_groupA', threaded: true }, body: 'A_ONLY fictional R1' }, { target: { messageId: 'om_groupB', threaded: true }, body: 'B_ONLY fictional R2' }]))
    await expect(f.groups.resolve('ou_second', added.spaceId)).rejects.toBeInstanceOf(AccessDenied)
    await expect(second.product.artifact('ou_second', b.tasks[0]!.id)).rejects.toBeInstanceOf(AccessDenied)
    await expect(f.primary.product.artifact('ou_owner', b.tasks[0]!.id)).rejects.toBeInstanceOf(AccessDenied)
    await expect(second.product.handle('ou_owner', 'POST', ['tasks', a.tasks[0]!.id, 'control'], {}, { action: 'pause', revision: 0 }, 'wrong-group-control')).rejects.toBeInstanceOf(AccessDenied)
    expect(f.hosts.every(host => host.failures.length === 0)).toBe(true)
  }, 15000)
  it('requires verified membership and immutable registration; fresh scopes default to no copied business rules or history', async () => {
    const f = await fixture(), requestId = randomUUID(), input = { requestId, mode: 'observe' }
    await expect(f.groups.create('ou_second', { chatId: 'oc_second', masters: ['ou_owner'], mode: 'auto', requestId })).rejects.toBeInstanceOf(AccessDenied)
    await expect(f.create({ masters: ['ou_owner', 'ou_invented'] })).rejects.toBeInstanceOf(AccessDenied)
    const first = await f.create(input), again = await f.create(input); expect(first.spaceId).toBe(again.spaceId); expect(f.servers).toHaveLength(2)
    await expect(f.create({ requestId, mode: 'auto' })).rejects.toThrow('变化')
    const settings = await f.store.transaction({ ...f.scope, spaceId: first.spaceId }, tx => tx.get<SettingsRecord>('settings', 'current'))
    expect(settings!.value.settings.policy.rules.map(rule => rule.id)).toEqual(['office-summary', 'office-data', 'office-research'])
    expect(settings!.value.settings.eval.mode).toBe('observe')
    expect((await f.groups.list('ou_second')).groups).toHaveLength(1)
    expect((await f.groups.list('ou_third')).groups.map(group => group.spaceId)).toEqual([first.spaceId])
    expect((await f.servers[1]!.product.snapshot('ou_owner')).events).toHaveLength(0)
  })
  it('uses shared login while checking the selected group on every HTTP request, revocation and source toggle', async () => {
    const f = await fixture(), added = await f.create(), second = f.servers[1]!, sessions = f.primary.sessions.withMembership(actor => f.groups.authorize(actor))
    f.actor('ou_third'); const begin = await sessions.begin(), auth = await sessions.callback(new URL(begin.location).searchParams.get('state')!, begin.browser, 'fixture')
    const server = createServer(productHttp({ product: f.primary.product, sessions, origin: 'http://127.0.0.1:3085', assets: f.assets, development: true, workspaces: f.groups }))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); closes.push(() => new Promise<void>(done => server.close(() => done())))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, cookie = `loom_session=${auth.token}`
    const request = (path: string, init = {}) => fetch(origin + path, { ...init, headers: { cookie } })
    expect((await request('/orchestrator/api/loom?workspace=' + added.spaceId)).status).toBe(200)
    expect((await request('/orchestrator/api/loom?workspace=' + f.scope.spaceId)).status).toBe(403)
    expect((await request('/orchestrator/api/loom?workspace=' + added.spaceId + '&workspace=' + f.scope.spaceId)).status).toBe(403)
    expect((await request('/orchestrator/api/loom?workspace=' + randomUUID())).status).toBe(403)
    const before = (await second.product.snapshot('ou_owner')).policyRevision!
    await second.product.handle('ou_owner', 'PUT', ['workspace', 'source'], {}, { revision: before, enabled: false }, 'disable-source-only-B')
    expect(f.primary.sourceHealth).toBe('ready')
    const disabled = await f.store.transaction(second.scope, tx => second.access.configuration(tx))
    const skipped = f.raw('disabled-period', 'MUST_NOT_REPLAY', { chat_id: 'oc_second', sender_id: 'ou_third' })
    await delay(5)
    await second.product.handle('ou_owner', 'PUT', ['workspace', 'source'], {}, { revision: disabled.row.value.revision, enabled: true }, 'reenable-source-only-B')
    const enabled = await f.store.transaction(second.scope, tx => second.access.configuration(tx))
    expect(Date.parse(enabled.installation.since)).toBeGreaterThan(Number(skipped.create_time))
    expect(enabled.settings.paused).toBe(true)
    expect(enabled.group!.since).toBe(disabled.group!.since)
    f.publish(skipped); await delay(60)
    expect((await second.product.snapshot('ou_owner')).events).toHaveLength(0)
    await second.product.handle('ou_owner', 'PUT', ['workspace', 'source'], {}, { revision: enabled.row.value.revision, enabled: false }, 'disable-B-again')
    const config = await f.store.transaction(second.scope, tx => second.access.configuration(tx))
    await second.product.handle('ou_owner', 'PUT', ['workspace'], {}, { mode: 'group', revision: config.row.value.revision, chatId: 'oc_second', masters: [{ id: 'ou_owner' }] }, 'remove-third-user')
    expect((await request('/orchestrator/api/loom?workspace=' + added.spaceId)).status).toBe(403)
    expect((await f.groups.list('ou_owner')).groups.find(group => group.spaceId === added.spaceId)?.enabled).toBe(false)
  })
  it('persists failed registration for an explicit retry with the same scope and rejects a corrupt group directory', async () => {
    const f = await fixture(true), requestId = randomUUID()
    await expect(f.create({ requestId })).rejects.toThrow('Synthetic native boot')
    const pending = (await f.groups.list('ou_owner')).groups.find(group => group.chatId === 'oc_second')!
    expect(pending.state).toBe('error')
    expect((await f.groups.retry('ou_owner', pending.spaceId)).spaceId).toBe(pending.spaceId)
    expect((await f.create({ requestId })).spaceId).toBe(pending.spaceId)
    expect(f.servers).toHaveLength(2)
    await f.store.transaction(f.scope, async tx => {
      const row = (await tx.get<any>('installation', 'group-directory'))!
      await tx.put('installation', row.id, { ...row.value, groups: [...row.value.groups, row.value.groups[0]] }, row.revision)
    })
    await expect(f.groups.resolve('ou_owner', f.scope.spaceId)).rejects.toThrow('unique')
  })
})
it('holds the legacy bot lease and interrupts only the overflowing subscription without losing the other group', async () => {
  const f = await productFixture('sqlite', true); closes.push(f.close)
  const lifetime = new AbortController(), queue: unknown[] = []; let wake: (() => void) | undefined, received = 0, opens = 0
  const wire: FeishuWire = { lark: async () => ({}) as any, async *events(signal, ready) {
    opens++; ready?.(); const abort = () => wake?.(); signal.addEventListener('abort', abort)
    try { while (!signal.aborted) { if (queue.length) { received++; yield queue.shift() } else await new Promise<void>(done => { wake = done; if (signal.aborted) done() }) } }
    finally { signal.removeEventListener('abort', abort) }
  } }
  const broker = new GroupEventBroker(wire, { store: f.store, scope: f.scope, access: f.access, appId: 'cli_test', botId: 'ou_bot', maxPending: 1 })
  const a = broker.subscribe('oc_test'), b = broker.subscribe('oc_second')
  expect(() => broker.subscribe('oc_test')).toThrow('already')
  const running = broker.run(lifetime.signal); closes.push(async () => { lifetime.abort(); await running })
  await until(() => broker.ready)
  expect(await f.store.transaction(f.scope, tx => tx.leases.acquire('source/installed', 'old-single-source', 1000))).toBeUndefined()
  const stream = a.events(lifetime.signal)[Symbol.asyncIterator](), first = stream.next()
  queue.push(f.raw('one', 'A1')); wake?.(); expect((await first).done).toBe(false)
  queue.push(f.raw('two', 'A2'), f.raw('three', 'A3'), f.raw('B', 'B_ONLY', { chat_id: 'oc_second' })); wake?.()
  await until(() => received === 4)
  expect((await stream.next()).done).toBe(true) // Source runs persisted history recovery before resubscribing.
  const other = b.events(lifetime.signal)[Symbol.asyncIterator](); expect((await other.next()).value).toEqual(expect.objectContaining({ content: 'B_ONLY' })); await other.return?.()
  const resumed = a.events(lifetime.signal)[Symbol.asyncIterator](), pending = resumed.next()
  queue.push(f.raw('four', 'A4')); wake?.(); expect((await pending).value).toEqual(expect.objectContaining({ content: 'A4' })); await resumed.return?.()
  expect(opens).toBe(1)
  lifetime.abort(); await running
  expect(await f.store.transaction(f.scope, tx => tx.leases.acquire('source/installed', 'new-owner', 1000))).toBeDefined()
})
describe('group company config', () => {
  it('never carries the company gateway or remote-execution profile into a group', () => {
    const primary = { tenantId: 'tenant', spaceId: 'primary', installationId: 'installed', databaseUrlEnv: 'LOOM_DATABASE_URL', origin: 'http://127.0.0.1:3084',
      cli: 'lark', blobRoot: '/var/lib/loom/objects', scratch: '/var/lib/loom/compute', legacyWorkspaceRoots: ['/old'], workerTools: { read: true },
      gateway: { host: '192.168.0.158', port: 3443 }, remoteExecution: { environmentId: 'linux-2' } }
    const value = groupCompanyConfig(primary, { spaceId: 'group', attachmentHome: '/var/lib/loom/groups/group/native', scratch: '/var/lib/loom/groups/group/compute' })
    expect(value).not.toHaveProperty('gateway'); expect(value).not.toHaveProperty('remoteExecution')
    expect(value).toMatchObject({ tenantId: 'tenant', installationId: 'installed', databaseUrlEnv: 'LOOM_DATABASE_URL', spaceId: 'group',
      attachmentHome: '/var/lib/loom/groups/group/native', scratch: '/var/lib/loom/groups/group/compute', legacyWorkspaceRoots: [], workerTools: { read: true } })
    expect(primary.gateway).toBeDefined(); expect(primary.remoteExecution).toBeDefined(); expect(primary.legacyWorkspaceRoots).toEqual(['/old'])
  })
})
it('shares model/worker slots without blocking stop or starting another worker on a full host', async () => {
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>(), work = vi.fn(async () => { started.resolve(); await gate.promise; return { state: 'done' as const } }), stop = vi.fn(async () => ({ state: 'done' as const }))
  const capacity = new CompanyCapacity(1, 1), backend = capacity.wrap({ work, stop, assess: async () => ({ kind: 'ignore', reason: 'fixture' }), close: async () => {} } satisfies CompanyBackend)
  const job = { signal: AbortSignal.timeout(5000), assertCurrent: async () => {} } as any
  const first = backend.work({} as any, job); await started.promise
  expect(await backend.work({} as any, job)).toEqual({ state: 'retry', delayMs: 1000 }); expect(work).toHaveBeenCalledOnce()
  await backend.stop({} as any, job); expect(stop).toHaveBeenCalledOnce(); gate.resolve(); await first
})
