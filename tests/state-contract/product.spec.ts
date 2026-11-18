import { randomUUID } from 'node:crypto'
import { createServer, get as httpGet } from 'node:http'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessDenied, AsyncTaskRuntime, bytesHash, confirmDrained, DurableArtifacts, LocalBlobStore, PostgresStateStore,
  ProductAccess, ProductSessions, productHttp, SqliteStateStore, StateConflict, StateProduct } from '../../src/state/index.ts'
import type { BlobCatalog, StateStore, SettingsRecord, ArtifactPublish } from '../../src/state/index.ts'
import { hash } from '../../src/state/hash.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuTrigger } from '../../src/sources/feishu-trigger.ts'
import { renderDocx } from '../../src/document-render.ts'
import { DOCX_MIME } from '../../src/document-format.ts'
import { validateDocx } from '../../src/state/docx.ts'
import { issueOperatorCode, OperatorLogin, requireConsoleOrigin } from '../../src/state/operator-login.ts'

const url = process.env.LOOM_STATE_TEST_DATABASE_URL
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Product tests require disposable _test database')
const stores: StateStore[] = [], folders: string[] = [], stops: (() => Promise<unknown>)[] = []
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())); await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
for (const kind of ['sqlite', 'postgres'] as const) (kind === 'postgres' && !url ? describe.skip : describe)(`external-state product: ${kind}`, () => {
  async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), 'loom-product-')); folders.push(folder)
    const scope = { tenantId: `test-${randomUUID()}`, spaceId: 'personal' }, path = join(folder, 'state.sqlite')
    const open = async () => { const store = kind === 'postgres' ? await PostgresStateStore.open({ connectionString: url }) : await SqliteStateStore.open(path); stores.push(store); return store }
    const store = await open(), blobs = await LocalBlobStore.open(join(folder, 'objects')), access = new ProductAccess('installed')
    await store.transaction(scope, async tx => {
      await tx.put('installation', 'installed', { id: 'installed', appId: 'cli_test', botId: 'ou_bot', tenantKey: 'test-tenant', operator: 'ou_owner', name: 'Test', enabled: true, since: '2026-11-10T00:00:00.000Z' }, 0)
      await tx.put<SettingsRecord>('settings', 'current', { revision: 1, actor: 'ou_owner', at: '2026-11-10T00:00:00.000Z', settings: SettingsSchema.parse({ sources: { github: { enabled: false }, feishu: { enabled: true, config: { ownerOnly: true, directMessages: true, chats: [{ chatId: 'oc_test', listen: 'all' }] } } }, policy: { sources: { feishu: { allowed: [{ id: 'ou_owner' }] } } }, eval: { mode: 'auto' } }) }, 0)
    })
    const artifacts = new DurableArtifacts({ store, scope, blobs, authorize: (tx, actor, subject, operation, version) => access.artifact(tx, actor, subject, operation, version) })
    const runtime = new AsyncTaskRuntime({ store, scope, actorId: 'ou_owner', authorize: access.authorize,
      assess: async () => ({ kind: 'ignore', reason: 'fixture' }), work: async () => ({ state: 'hold', reason: 'Explicit fixture backend' }), stop: async () => ({ state: 'done' }),
      delivery: { authorize: async () => {}, send: async () => { throw new Error('No external messages in this test') } } })
    stops.push(() => runtime.stop())
    const product = new StateProduct({ store, scope, access, runtime, artifacts }), identity = (id: string = randomUUID()) => ({ id, userId: 'ou_owner' })
    const trigger = feishuTrigger({ message_id: 'om_test', chat_id: 'oc_test', chat_type: 'group', sender_id: 'ou_owner', sender_type: 'user', content: 'Summarize fictional record R1', create_time: String(Date.parse('2026-11-11T00:00:00Z')), mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_test')!
    await runtime.app.receive(identity(), 'installed', 'om_test', trigger)
    const decision = await runtime.app.decide(identity(), trigger.id, { kind: 'accept', title: 'Fictional summary', scope: 'Only R1', reason: 'explicit' })
    const subject = decision.ticketId!, ticket = (await store.transaction(scope, tx => tx.get<import('../../src/core/index.ts').Ticket>('ticket', subject)))!.value
    const lease = (await store.transaction(scope, tx => tx.leases.acquire('session-fixture', 'fixture-backend', 60_000)))!
    const writer = { assignmentId: ticket.assignments.at(-1)!.id, lease, controlRevision: 0 }
    const publish = (overrides: Partial<ArtifactPublish> = {}) => artifacts.publish(identity(), { subject, body: 'Fictional R1 report', expectedVersion: 0, author: 'agent', writer, ...overrides })
    return { folder, scope, store, open, blobs, access, artifacts, runtime, product, identity, subject, writer, trigger, publish }
  }
  it('stores immutable scoped bytes, rejects symlinks and corruption, and refuses arbitrary object paths', async () => {
    const f = await fixture(), ref = await f.blobs.put(f.scope, Buffer.from('bytes'))
    expect(await f.blobs.put(f.scope, Buffer.from('bytes'))).toEqual(ref)
    await expect(f.blobs.read({ ...f.scope, spaceId: 'other' }, ref)).rejects.toThrow()
    await expect(f.blobs.head(f.scope, '../secret')).rejects.toThrow('digest')
    const target = join(f.folder, 'objects', hash(f.scope), ref.sha256)
    await writeFile(target, 'wrong'); await expect(f.blobs.read(f.scope, ref)).rejects.toThrow('integrity')
    await expect(f.blobs.put(f.scope, Buffer.from('bytes'))).rejects.toThrow('integrity')
    const unrelated = join(f.folder, 'unrelated-file'); await writeFile(unrelated, 'unchanged')
    await rm(target); await symlink(unrelated, target)
    await expect(f.blobs.read(f.scope, ref)).rejects.toThrow()
    expect(await readFile(unrelated, 'utf8')).toBe('unchanged')
  })
  it('authorizes recovery inspection and exposes the concrete held-job reason without accepting client death claims', async () => {
    const f = await fixture(); let inspected = 0
    f.product.options.recover = async id => { expect(id).toBe(f.subject); inspected++ }
    await expect(f.product.handle('intruder', 'POST', ['tasks', f.subject, 'recovery'], {}, {}, randomUUID())).rejects.toBeInstanceOf(AccessDenied)
    await expect(f.product.handle('ou_owner', 'POST', ['tasks', f.subject, 'recovery'], {}, { force: true }, randomUUID())).rejects.toThrow()
    expect(inspected).toBe(0)
    await f.store.transaction(f.scope, async tx => {
      await tx.put('grant', `native-recovery-status/${f.subject}`, { state: 'unverifiable', epoch: 1, at: await tx.now() }, 0)
      const claim = await tx.jobs.claim('held-fixture', 10000, ['domain.launch'])
      if (claim) await tx.jobs.hold(claim, 'Native stop proof missing')
    })
    const progress = await f.product.handle('ou_owner', 'POST', ['tasks', f.subject, 'recovery'], {}, {}, randomUUID())
    expect(inspected).toBe(1); expect(progress).toMatchObject({ phase: 'blocked', unavailable: expect.stringContaining('无法核验') })
  })
  it('publishes a real Word file and retained body, reauthorizes historical downloads and survives adapter replacement', async () => {
    const f = await fixture(), bytes = await renderDocx('Fictional', '# R1\n\nOnly a test'), sha256 = bytesHash(bytes)
    validateDocx(bytes)
    const manifest = await f.publish({ document: { bytes, metadata: { format: 'docx', filename: 'report.docx', mediaType: DOCX_MIME, sha256, byteLength: bytes.length } } })
    expect(manifest.version).toBe(1)
    expect((await f.artifacts.read('ou_owner', f.subject, 1, true)).bytes).toEqual(bytes)
    await f.runtime.stop(); await f.store.close()
    const next = await f.open(), artifacts = new DurableArtifacts({ store: next, scope: f.scope, blobs: f.blobs, authorize: (tx, actor, subject, op, version) => f.access.artifact(tx, actor, subject, op, version) })
    expect((await artifacts.read('ou_owner', f.subject, 1)).bytes.toString()).toBe('Fictional R1 report')
    await next.transaction(f.scope, async tx => {
      const row = (await tx.get<SettingsRecord>('settings', 'current'))!
      row.value.settings.policy.sources.feishu!.allowed = []
      await tx.put('settings', row.id, row.value, row.revision)
    })
    await expect(artifacts.read('ou_owner', f.subject, 1)).rejects.toBeInstanceOf(AccessDenied)
  })
  it('preserves human v2, rejects late worker publications and resolves concurrent edit requests with CAS', async () => {
    const f = await fixture(); await f.publish()
    await f.runtime.app.changeControl(f.identity(), f.subject, 0, 'takeover')
    await f.store.transaction(f.scope, tx => confirmDrained(tx, f.subject, 1))
    const results = await Promise.allSettled([f.publish({ author: 'human', expectedVersion: 1, body: 'Human v2' }), f.publish({ author: 'human', expectedVersion: 1, body: 'Other edit' })])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect((await f.artifacts.manifest('ou_owner', f.subject))?.version).toBe(2)
    expect((await f.artifacts.read('ou_owner', f.subject, 1)).bytes.toString()).toBe('Fictional R1 report')
    await expect(f.publish({ expectedVersion: 1 })).rejects.toBeInstanceOf(StateConflict)
  })
  it('requires the persisted native Session binding, rather than accepting another task’s valid lease', async () => {
    const f = await fixture(), artifacts = new DurableArtifacts({ ...f, requireWorkerBindings: true, authorize: (...args) => f.access.artifact(...args) })
    const input: ArtifactPublish = { subject: f.subject, expectedVersion: 0, body: 'Bound native publication', author: 'agent', writer: f.writer }
    await expect(artifacts.publish(f.identity(), input)).rejects.toThrow('Session binding')
    await f.store.transaction(f.scope, tx => tx.put('grant', `worker-binding/${f.subject}/${f.writer.assignmentId}`, { ...f.writer.lease, userId: 'ou_owner' }, 0))
    expect((await artifacts.publish(f.identity(), input)).version).toBe(1)
  })
  it('never publishes a missing object; failed metadata commits leave recoverable catalogued orphans', async () => {
    const f = await fixture(); let deny = false
    const artifacts = new DurableArtifacts({ ...f, authorize: async (tx, actor, subject, op, version) => {
      await f.access.artifact(tx, actor, subject, op, version)
      if (version) { deny = true; throw new AccessDenied('Source revoked during generation') }
    } })
    await expect(artifacts.publish(f.identity(), { subject: f.subject, expectedVersion: 0, body: 'Orphan test', author: 'agent', writer: f.writer })).rejects.toThrow('revoked')
    expect(deny).toBe(true); expect(await f.artifacts.manifest('ou_owner', f.subject)).toBeUndefined()
    await f.store.transaction(f.scope, async tx => {
      for (const row of await tx.scan<BlobCatalog>('blob')) await tx.put('blob', row.id, { ...row.value, updatedAt: await tx.now() - 120_000 }, row.revision, { active: true })
    })
    expect((await f.artifacts.collect('ou_owner', 60_000)).deleted).toHaveLength(1)
    expect(await f.blobs.list(f.scope)).toEqual([])
  })
  it('shows the explicit backend hold and queries do not create work or expose another identity', async () => {
    const f = await fixture(); await f.runtime.consumer.idle()
    const before = await f.store.transaction(f.scope, tx => tx.jobs.list())
    const snapshot = await f.product.snapshot('ou_owner')
    expect(snapshot.tasks[0]).toMatchObject({ id: f.subject, executionState: 'waiting', status: 'blocked', description: 'Only R1' })
    expect((await f.product.progress('ou_owner', f.subject)).phase).toBe('blocked')
    await expect(f.product.snapshot('ou_other')).rejects.toBeInstanceOf(AccessDenied)
    expect(await f.store.transaction(f.scope, tx => tx.jobs.list())).toEqual(before)
    expect(JSON.stringify(snapshot)).not.toContain('state.sqlite')
  })
  it('rejects invalid installed source configuration instead of silently disabling the Feishu connection', async () => {
    const f = await fixture()
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get<SettingsRecord>('settings', 'current'))!; row.value.settings.sources.feishu!.config.unrecognizedIdentityField = 'fixture'; await tx.put('settings', row.id, row.value, row.revision) })
    await expect(f.product.snapshot('ou_owner')).rejects.toThrow()
  })
  it('requires one-use browser-bound login and current owner/tenant authority; tokens survive server recreation', async () => {
    const f = await fixture()
    const provider = { authorizeUrl: (state: string) => `https://login.example/?state=${state}`, exchange: async () => ({ openId: 'ou_owner', tenantKey: 'test-tenant', expiresIn: 3600 }) }
    const sessions = new ProductSessions(f.store, f.scope, f.access, provider), login = await sessions.begin(), state = new URL(login.location).searchParams.get('state')!
    await expect(sessions.callback(state, 'wrong-browser', 'code')).rejects.toBeInstanceOf(AccessDenied)
    const granted = await sessions.callback(state, login.browser, 'code')
    await expect(sessions.callback(state, login.browser, 'code')).rejects.toBeInstanceOf(AccessDenied)
    const next = new ProductSessions(f.store, f.scope, f.access, provider)
    expect((await next.authenticate(granted.token)).actor).toBe('ou_owner')
    await expect(next.authenticate(granted.token, 'wrong-csrf')).rejects.toBeInstanceOf(AccessDenied)
    await next.revoke(granted.token); await expect(sessions.authenticate(granted.token)).rejects.toBeInstanceOf(AccessDenied)
    const wrong = new ProductSessions(f.store, f.scope, f.access, { ...provider, exchange: async () => ({ openId: 'ou_owner', tenantKey: 'other-company', expiresIn: 3600 }) })
    const pending = await wrong.begin(); await expect(wrong.callback(new URL(pending.location).searchParams.get('state')!, pending.browser, 'code')).rejects.toBeInstanceOf(AccessDenied)
  })
  it('keeps multiple login tabs bound to a current server-issued browser nonce without adopting forged or expired values', async () => {
    const f = await fixture(), provider = { authorizeUrl: (state: string) => `https://login.example/?state=${state}`, exchange: async () => ({ openId: 'ou_owner', tenantKey: 'test-tenant', expiresIn: 3600 }) }
    const sessions = new ProductSessions(f.store, f.scope, f.access, provider), first = await sessions.begin()
    const second = await sessions.begin(first.browser)
    expect(second.browser).toBe(first.browser); expect(second.location).not.toBe(first.location)
    const state = new URL(first.location).searchParams.get('state')!
    await expect(sessions.callback(state, second.browser, 'fixture')).resolves.toHaveProperty('token')
    const forged = 'X'.repeat(43); expect((await sessions.begin(forged)).browser).not.toBe(forged)
    await f.store.transaction(f.scope, async tx => {
      const pending = await tx.scan<any>('auth-session', { relation: 'pending-login', limit: 500 })
      for (const row of pending) await tx.put('auth-session', row.id, { ...row.value, until: 0 }, row.revision, { relation: 'pending-login' })
    })
    expect((await sessions.begin(first.browser)).browser).not.toBe(first.browser)
  })
  it('serves the authenticated product API, rejects forged actors/CSRF and returns a persisted control change', async () => {
    const f = await fixture(), sessions = new ProductSessions(f.store, f.scope, f.access, { authorizeUrl: state => `https://login.example/?state=${state}`, exchange: async () => ({ openId: 'ou_owner', tenantKey: 'test-tenant', expiresIn: 3600 }) })
    let handler!: ReturnType<typeof productHttp>
    const server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    stops.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    handler = productHttp({ product: f.product, sessions, origin, assets: f.folder, development: true })
    expect((await fetch(`${origin}/orchestrator/api/loom`, { headers: { 'x-user-id': 'ou_owner' } })).status).toBe(401)
    const login = await fetch(`${origin}/auth/login`, { redirect: 'manual' }), state = new URL(login.headers.get('location')!).searchParams.get('state')!
    const browserCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
    const callback = await fetch(`${origin}/auth/callback?state=${state}&code=fixture`, { redirect: 'manual', headers: { cookie: browserCookie } })
    const sessionCookie = callback.headers.getSetCookie()[0]!.split(';')[0]!
    const session = await (await fetch(`${origin}/auth/session`, { headers: { cookie: sessionCookie } })).json() as { csrf: string }
    const command = { method: 'POST', headers: { cookie: sessionCookie, origin, 'content-type': 'application/json', 'idempotency-key': 'pause-request' }, body: JSON.stringify({ revision: 0, action: 'pause' }) }
    const endpoint = `${origin}/orchestrator/api/loom/tasks/${f.subject}/control`
    expect((await fetch(endpoint, command)).status).toBe(403)
    const response = await fetch(endpoint, { ...command, headers: { ...command.headers, 'x-loom-csrf': session.csrf } })
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ mode: 'pausing', revision: 1 })
    expect((await fetch(endpoint, { ...command, headers: { ...command.headers, 'x-loom-csrf': session.csrf } })).status).toBe(200)
  })
  it('uses explicit loopback-only operator login, one-use codes and browser-bound POST without weakening API authorization', async () => {
    const f = await fixture()
    for (const origin of ['http://192.168.0.158:3085', 'http://localhost:3085', 'https://example.com']) expect(() => requireConsoleOrigin(origin)).toThrow()
    let handler!: ReturnType<typeof productHttp>
    const server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    stops.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, provider = new OperatorLogin(f.store, f.scope, f.access, origin)
    const sessions = new ProductSessions(f.store, f.scope, f.access, provider)
    handler = productHttp({ product: f.product, sessions, origin, assets: f.folder, operatorLogin: true })
    const forged = await new Promise<number | undefined>((resolve, reject) => { httpGet(`${origin}/auth/login`, { headers: { host: 'attacker.example' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)) }).once('error', reject) })
    expect(forged).toBe(403)
    expect((await fetch(`${origin}/orchestrator/api/loom`)).status).toBe(401)
    const code = await issueOperatorCode(f.store, f.scope, f.access), login = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!, browser = login.headers.getSetCookie()[0]!.split(';')[0]!
    const form = { method: 'POST', redirect: 'manual' as const, headers: { origin, cookie: browser, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, code }).toString() }
    const loginPage = await fetch(`${origin}/auth/operator?state=${state}`)
    expect(loginPage.status).toBe(200); expect(loginPage.headers.get('referrer-policy')).toBe('same-origin')
    const foreignOrigin = await fetch(`${origin}/auth/operator`, { ...form, headers: { ...form.headers, origin: 'https://evil.example' } })
    expect(foreignOrigin.status).toBe(403); expect(await foreignOrigin.text()).toContain('login_origin')
    const nullOrigin = await fetch(`${origin}/auth/operator`, { ...form, headers: { ...form.headers, origin: 'null' } })
    expect(nullOrigin.status).toBe(403); expect(await nullOrigin.text()).toContain('login_origin')
    const missingBrowser = await fetch(`${origin}/auth/operator`, { ...form, headers: { ...form.headers, cookie: '' } })
    expect(missingBrowser.status).toBe(403); expect(await missingBrowser.text()).toContain('login_browser_missing')
    const logged = await fetch(`${origin}/auth/operator`, form)
    expect(logged.status).toBe(303)
    const cookie = logged.headers.getSetCookie()[0]!.split(';')[0]!
    expect(await (await fetch(`${origin}/auth/session`, { headers: { cookie } })).json()).toMatchObject({ actor: 'ou_owner' })
    const reused = await fetch(`${origin}/auth/operator`, form)
    expect(reused.status).toBe(403); expect(await reused.text()).toContain('重新打开登录页')
    await expect(provider.exchange(code)).rejects.toBeInstanceOf(AccessDenied)
    expect((await fetch(`${origin}/orchestrator/api/loom/tasks/${f.subject}/control`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    const expired = await issueOperatorCode(f.store, f.scope, f.access)
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get<any>('auth-session', `operator-code/${hash(expired)}`))!; await tx.put('auth-session', row.id, { ...row.value, until: 0 }, row.revision) })
    await expect(provider.exchange(expired)).rejects.toBeInstanceOf(AccessDenied)
    const revoked = await issueOperatorCode(f.store, f.scope, f.access)
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get<any>('installation', 'installed'))!; await tx.put('installation', row.id, { ...row.value, enabled: false }, row.revision) })
    await expect(provider.exchange(revoked)).rejects.toBeInstanceOf(AccessDenied)
    await expect(sessions.authenticate(cookie.split('=')[1])).rejects.toBeInstanceOf(AccessDenied)
  })
  it('opens an explicitly selected local console without login or cookies, retaining host, CSRF and resource authorization', async () => {
    const f = await fixture(), bytes = 'Only fictional R1 report'; await f.publish({ body: bytes })
    await writeFile(join(f.folder, 'index.html'), '<html><head></head><body>Local console</body></html>')
    const provider = { authorizeUrl: () => { throw Error('Login is not used') }, exchange: async () => { throw Error('Login is not used') } }
    const sessions = new ProductSessions(f.store, f.scope, f.access, provider)
    let handler!: ReturnType<typeof productHttp>
    const server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); stops.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    handler = productHttp({ product: f.product, sessions, origin, assets: f.folder, localOperator: true })
    expect(() => productHttp({ product: f.product, sessions, origin: 'https://public.example', assets: f.folder, localOperator: true })).toThrow()
    const page = await fetch(origin + '/orchestrator/loom/')
    expect(page.status).toBe(200); expect(page.headers.has('set-cookie')).toBe(false)
    expect(await page.text()).toContain('Local console')
    expect((await fetch(origin + '/orchestrator/api/loom', { headers: { cookie: 'loom_session=invalid', 'x-user-id': 'ou_intruder' } })).status).toBe(200)
    const entry = await fetch(origin + '/auth/login', { redirect: 'manual' }); expect(entry.status).toBe(302); expect(entry.headers.get('location')).toBe('/orchestrator/loom/')
    expect((await fetch(origin + '/auth/operator', { method: 'POST', body: 'code=obsolete' })).status).toBe(404)
    const session = await (await fetch(origin + '/auth/session')).json() as { actor: string; csrf: string; until: null }
    expect(session.actor).toBe('ou_owner'); expect(session.until).toBeNull()
    const restored = new ProductSessions(f.store, f.scope, f.access, provider)
    expect((await restored.localOperator()).csrf).toBe(session.csrf)
    const write = { method: 'PUT', headers: { origin, 'content-type': 'application/json', 'idempotency-key': 'local-pause-request' }, body: JSON.stringify({ revision: 1, paused: true }) }
    expect((await fetch(origin + '/orchestrator/api/loom/pause', write)).status).toBe(403)
    expect((await fetch(origin + '/orchestrator/api/loom/pause', { ...write, headers: { ...write.headers, 'x-loom-csrf': 'X'.repeat(43) } })).status).toBe(403)
    expect((await fetch(origin + '/orchestrator/api/loom/pause', { ...write, headers: { ...write.headers, origin: 'https://evil.example', 'x-loom-csrf': session.csrf } })).status).toBe(403)
    expect((await fetch(origin + '/orchestrator/api/loom', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })).status).toBe(403)
    const forgedHost = await new Promise<number | undefined>((resolve, reject) => httpGet(origin + '/auth/session', { headers: { host: 'attacker.example' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)) }).once('error', reject))
    expect(forgedHost).toBe(403)
    expect((await fetch(origin + '/orchestrator/api/loom/artifacts/' + f.subject + '/download')).status).toBe(200)
    expect((await fetch(origin + '/orchestrator/api/loom/artifacts/foreign-task/download')).status).toBe(403)
    expect((await fetch(origin + '/orchestrator/api/loom/pause', { ...write, headers: { ...write.headers, 'x-loom-csrf': session.csrf } })).status).toBe(200)
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get<any>('installation', 'installed'))!; await tx.put('installation', row.id, { ...row.value, enabled: false }, row.revision) })
    expect((await fetch(origin + '/auth/session')).status).toBe(403)
  })
})
