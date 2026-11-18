/** Explicit company service composition. No legacy Runtime, SQLite mirror or Harness administration routes are mounted. */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { isAbsolute, join, relative, sep } from 'node:path'
import { feishuSettings } from '../sources/feishu.ts'
import { SettingsSchema } from '../policy.ts'
import { AccessDenied, InstallationSchema, ProductAccess } from './access.ts'
import type { Installation, SettingsRecord } from './access.ts'
import { DurableArtifacts } from './artifacts.ts'
import { FeishuLogin, ProductSessions } from './auth.ts'
import { OperatorLogin, requireConsoleOrigin } from './operator-login.ts'
import type { LoginProvider } from './auth.ts'
import { LocalBlobStore } from './blobs.ts'
import { CliFeishuWire, feishuDelivery } from './feishu-cli.ts'
import { DurableFeishuSource } from './feishu.ts'
import type { FeishuWire } from './feishu.ts'
import { productHttp } from './http.ts'
import { PostgresStateStore } from './postgres.ts'
import { StateProduct } from './product.ts'
import { DurableResults } from './results.ts'
import { AsyncTaskRuntime } from './runtime.ts'
import type { AsyncRuntimeOptions } from './runtime.ts'
import type { NativeOptions } from './native.ts'
import { DurableAssistant } from './assistant.ts'
import { DurableMeetings } from './meetings.ts'
import { families } from './ports.ts'
import type { StateStore, StateScope } from './ports.ts'
import { validateScope, StateConflict } from './ports.ts'
import { z } from 'zod'
import { DeviceGateway, GatewayRequestLedger, MultiScopeGatewayDirectory, MultiScopeGatewayLedgerBackend, StateGatewayDirectory, StateGatewayLedgerBackend } from '../execution/gateway.ts'
import { TlsGatewayServer } from '../execution/tls.ts'
import { loadGatewayTlsMaterial, loadOrCreateGatewayIdentity } from '../execution/gateway-config.ts'
import { CompanyRemoteExecution, type RemoteExecutionProfile } from '../execution/company.ts'
import { WorkbenchBotService } from './workbench.ts'
import type { WorkbenchHttpControl } from './workbench.ts'

export interface CompanyBackend extends Pick<AsyncRuntimeOptions, 'assess' | 'work' | 'stop'> { close(): Promise<void>; recover?(ticketId?: string): Promise<void> }
export interface CompanyGatewayOptions { host: string; port: number; tlsKey: string; tlsCert: string; identityKey: string; requestCert?: boolean; ca?: string }
/** One TLS listener and one Gateway identity shared by every group in a company host. */
export class CompanyGatewayHost {
  private readonly tlsGateway: TlsGatewayServer
  private started?: Promise<void>
  private stopped = false
  private constructor(private readonly options: CompanyGatewayOptions, private readonly directory: MultiScopeGatewayDirectory,
    private readonly ledger: MultiScopeGatewayLedgerBackend, readonly gateway: DeviceGateway, tlsGateway: TlsGatewayServer) { this.tlsGateway = tlsGateway }
  static async open(options: CompanyGatewayOptions, store: StateStore): Promise<CompanyGatewayHost> {
    const directory = new MultiScopeGatewayDirectory(store), ledger = new MultiScopeGatewayLedgerBackend(store)
    const identity = await loadOrCreateGatewayIdentity(options.identityKey), material = await loadGatewayTlsMaterial(options.tlsKey, options.tlsCert)
    const gateway = new DeviceGateway({ keyPair: identity, directory, ledger: new GatewayRequestLedger(ledger) }), tls = new TlsGatewayServer({ gateway, key: material.key, cert: material.cert, host: options.host, port: options.port,
      requestCert: options.requestCert ?? false, rejectUnauthorized: options.requestCert ?? false })
    return new CompanyGatewayHost(options, directory, ledger, gateway, tls)
  }
  registerScope(scope: StateScope): void { this.directory.register(scope); this.ledger.register(scope) }
  start(): Promise<void> { return this.started ??= this.tlsGateway.start().then(() => undefined) }
  async stop(): Promise<void> { if (this.stopped) return; this.stopped = true; await this.tlsGateway.stop() }
  get address() { return { host: this.options.host, port: this.options.port } }
}
export interface CompanyServerOptions {
  scope: StateScope; installationId: string; databaseUrl?: string; store?: StateStore; blobRoot: string; scratch: string; assets: string
  origin: string; port: number; cli: string; appSecret?: () => Promise<string>
  backend(services: Omit<NativeOptions, 'context'>): Promise<CompanyBackend>
  wire?: FeishuWire; login?: LoginProvider; development?: boolean; loginMode?: 'feishu' | 'feishu-workbench' | 'ssh-operator' | 'local-operator'
  /** Private directory for bot secrets collected by the Workbench binding wizard. */
  botSecretRoot?: string
  gateway?: CompanyGatewayOptions
  gatewayHost?: CompanyGatewayHost
  /** Explicit opt-in profile for routing accepted company tasks to one paired read-only Runner. */
  remoteExecution?: RemoteExecutionProfile
  /** Embedded only in the authenticated multi-group host; no per-group HTTP listener or real bot connection. */
  embedded?: boolean
}
function within(parent: string, child: string) { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
/** Runs product HTTP, native execution and one installed Feishu source against the same persistent stores. */
export class CompanyServer {
  readonly runtime: AsyncTaskRuntime
  readonly product: StateProduct
  readonly artifacts: DurableArtifacts
  readonly results: DurableResults
  readonly sessions: ProductSessions
  readonly workbench: WorkbenchHttpControl
  readonly gateway?: DeviceGateway
  private http?: Server
  private sourceRun?: Promise<void>
  private readonly lifetime = new AbortController()
  private stopped?: Promise<void>
  private started = false
  private sourceState: 'starting' | 'ready' | 'error' | 'paused' = 'starting'
  private sourceDetail = ''
  get sourceHealth() { return this.sourceState }
  get sourceHealthDetail() { return this.sourceDetail }
  get scope() { return this.options.scope }
  get installationId() { return this.options.installationId }
  private constructor(private options: CompanyServerOptions, readonly store: StateStore, readonly access: ProductAccess,
    artifacts: DurableArtifacts, results: DurableResults, runtime: AsyncTaskRuntime, product: StateProduct, sessions: ProductSessions,
    private source: DurableFeishuSource, private backend: CompanyBackend, gateway: DeviceGateway | undefined, workbench: WorkbenchHttpControl,
    private tlsGateway?: TlsGatewayServer, private gatewayHost?: CompanyGatewayHost) {
    this.artifacts = artifacts; this.results = results; this.runtime = runtime; this.product = product; this.sessions = sessions; this.gateway = gateway; this.workbench = workbench
  }
  static async open(input: CompanyServerOptions): Promise<CompanyServer> {
    const options = { ...input, scope: validateScope(input.scope) }
    if (options.embedded && !options.wire) throw new Error('Embedded groups require the shared host source adapter')
    const consoleMode = options.loginMode === 'ssh-operator' || options.loginMode === 'local-operator'
    if (consoleMode) { requireConsoleOrigin(options.origin); if (options.login) throw new Error('Operator mode cannot override its login authority') }
    if (![options.blobRoot, options.scratch, options.assets].every(isAbsolute) || within(options.scratch, options.blobRoot) || within(options.blobRoot, options.scratch)) throw new Error('Persistent blobs and replaceable scratch must be separate absolute directories')
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid product port')
    const store = options.store ?? await PostgresStateStore.open({ connectionString: options.databaseUrl })
    let backend: CompanyBackend | undefined, runtime: AsyncTaskRuntime | undefined, gateway: DeviceGateway | undefined, tlsGateway: TlsGatewayServer | undefined, remoteExecution: CompanyRemoteExecution | undefined
    try {
      const access = new ProductAccess(options.installationId), config = await store.transaction(options.scope, tx => access.configuration(tx))
      if (feishuSettings(config.registry).cardsEnabled) throw new AccessDenied('Company entry currently uses explicit text controls and workbench; disable legacy card callbacks before cutover')
      if (!config.group) throw new AccessDenied('Company entry requires the existing explicitly authorized single-group workspace; personal desktop Runtime remains separate')
      let meetings: DurableMeetings
      const blobs = await LocalBlobStore.open(options.blobRoot), artifacts = new DurableArtifacts({ store, scope: options.scope, blobs, requireWorkerBindings: true, authorize: (tx, actor, subject, op, version) => access.artifact(tx, actor, subject, op, version), checkSource: (actor, subject) => meetings.checkSource(actor, subject), evidence: (tx, actor, subject) => meetings.evidence(tx, actor, subject) })
      const bot = { cli: options.cli, appId: config.installation.appId, botId: config.installation.botId, name: config.installation.name, brand: 'feishu' as const }
      const wire = options.wire ?? new CliFeishuWire(bot)
      if (!options.embedded) await wire.verify?.(AbortSignal.timeout(60_000))
      if (options.gatewayHost) {
        options.gatewayHost.registerScope(options.scope)
        gateway = options.gatewayHost.gateway
      } else if (options.gateway) {
        if (!Number.isInteger(options.gateway.port) || options.gateway.port < 1 || options.gateway.port > 65535) throw new Error('Invalid Gateway TLS port')
        if (options.gateway.requestCert) throw new Error('Gateway client-certificate TLS is not enabled yet; use the paired Ed25519 device handshake')
        const identity = await loadOrCreateGatewayIdentity(options.gateway.identityKey), material = await loadGatewayTlsMaterial(options.gateway.tlsKey, options.gateway.tlsCert)
        gateway = new DeviceGateway({ keyPair: identity, directory: new StateGatewayDirectory(store, options.scope), ledger: new GatewayRequestLedger(new StateGatewayLedgerBackend(store, options.scope)) })
        tlsGateway = new TlsGatewayServer({ gateway, key: material.key, cert: material.cert, host: options.gateway.host, port: options.gateway.port,
          ...(options.gateway.ca ? { ca: await (await import('node:fs/promises')).readFile(options.gateway.ca) } : {}), requestCert: options.gateway.requestCert ?? false,
          rejectUnauthorized: options.gateway.requestCert ?? false })
      }
      if (options.remoteExecution) {
        if (!gateway) throw new Error('Remote execution requires the TLS Gateway')
        remoteExecution = new CompanyRemoteExecution({ gateway, store, scope: options.scope, access, profile: options.remoteExecution })
      }
      let service: CompanyServer
      const results = new DurableResults({ store, scope: options.scope, access, artifacts, wire })
      let product: StateProduct
      const assistant = new DurableAssistant({ store, scope: options.scope, access, artifacts, wire, botName: bot.name, product: () => product })
      const prepareTicket = remoteExecution ? (ticket: import('../core/index.ts').Ticket, outcome: Extract<import('../core/index.ts').AssessmentOutcome, { kind: 'accept' }>) => ({
        ...ticket,
        execution: {
          name: outcome.name ?? `remote-${ticket.id.slice(0, 12)}`,
          directory: `${options.scratch}/remote/${ticket.id}`,
          assignment: outcome.note ?? '',
          target: { kind: 'runner' as const, environmentId: options.remoteExecution!.environmentId, workspaceId: options.remoteExecution!.workspaceId },
        },
      }) : undefined
      runtime = new AsyncTaskRuntime({ store, scope: options.scope, actorId: config.installation.operator,
        authorize: async (tx, command) => ({ ...await access.authorize(tx, command), ...(prepareTicket ? { prepareTicket } : {}) }),
        requireWorkerBindings: true, reported: results.reported, deciding: (...args) => meetings.deciding(...args), decided: (...args) => meetings.decided(...args), concurrency: config.settings.executor.maxWorkers,
        assess: (...args) => backend!.assess(...args), work: (...args) => backend!.work(...args), stop: (...args) => backend!.stop(...args), delivery: feishuDelivery(access, wire),
        lanes: [{ kinds: ['product.result'], concurrency: 1, pool: { name: 'result-delivery', limit: 1 }, handle: context => results.deliver(context) },
          { kinds: ['product.assistant'], concurrency: 1, pool: { name: 'assistant-delivery', limit: 1 }, handle: context => assistant.deliver(context) },
          { kinds: ['meeting.discover', 'meeting.start'], concurrency: 1, pool: { name: 'recordings', limit: 1 }, handle: context => context.claim.kind === 'meeting.start' ? meetings.start(context) : meetings.discover(context) }] })
      meetings = new DurableMeetings({ store, scope: options.scope, access, wire, blobs, assistant, scratch: options.scratch, runtime: () => runtime! })
      access.taskGuard = (tx, actor, ticket) => meetings.authorize(tx, actor, ticket)
      backend = await options.backend({ store, scope: options.scope, access, app: runtime.app, artifacts, scratch: options.scratch, meetings,
        ...(remoteExecution ? { execution: remoteExecution.router, remoteExecution: options.remoteExecution } : {}) })
      product = new StateProduct({ store, scope: options.scope, access, artifacts, results, runtime, meetings, wire, health: () => [{ id: 'feishu', state: service.sourceState }], recover: id => backend!.recover?.(id) ?? Promise.resolve() })
      const login = options.login ?? (consoleMode ? new OperatorLogin(store, options.scope, access, options.origin) : new FeishuLogin({ appId: config.installation.appId,
        appSecret: options.appSecret ?? (async () => { throw new AccessDenied('Feishu login secret reference not configured') }), redirectUri: `${options.origin}/auth/callback` }))
      const sessions = new ProductSessions(store, options.scope, access, login, undefined, options.loginMode === 'feishu' || options.loginMode === 'feishu-workbench')
      const source = new DurableFeishuSource({ store, scope: options.scope, access, runtime, bot, wire, ...(options.embedded ? { leaseId: `subscription/${options.installationId}` } : {}), command: async (trigger, lease) => await meetings.receive(trigger, lease) || await assistant.receive(trigger, lease), health: (state, detail) => {
        service.sourceState = state; service.sourceDetail = detail
        if (state === 'error') console.error(`Loom Feishu source error (${options.scope.spaceId}): ${detail}`)
      } })
      const workbench = new WorkbenchBotService({ store, scope: options.scope, access, installationId: options.installationId,
        secretRoot: options.botSecretRoot ?? join(options.blobRoot, '..', 'bot-secrets') })
      service = new CompanyServer(options, store, access, artifacts, results, runtime, product, sessions, source, backend, gateway, workbench, tlsGateway, options.gatewayHost)
      return service
    } catch (error) { await tlsGateway?.stop().catch(() => {}); await runtime?.stop(); await backend?.close(); if (!options.store) await store.close(); throw error }
  }
  async start(): Promise<{ host: '127.0.0.1'; port: number }> {
    if (this.started || this.stopped) throw new Error('Company service already started or stopping')
    this.started = true
    try {
      await this.backend.recover?.()
      if (this.gatewayHost) await this.gatewayHost.start()
      else await this.tlsGateway?.start()
    } catch (error) { this.started = false; throw error }
    if (this.options.embedded) {
      this.runtime.start()
      this.sourceRun = this.source.run(this.lifetime.signal).catch(() => { if (!this.lifetime.signal.aborted) this.sourceState = 'error' })
      return { host: '127.0.0.1', port: 0 }
    }
    const handler = productHttp({ product: this.product, sessions: this.sessions, origin: this.options.origin, assets: this.options.assets, development: this.options.development,
      operatorLogin: this.options.loginMode === 'ssh-operator', localOperator: this.options.loginMode === 'local-operator', gateway: this.gateway ? this.gatewayHttp() : undefined, workbench: this.workbench })
    this.http = createServer((req, res) => {
      if (req.url === '/readyz') {
        void this.store.transaction(this.options.scope, tx => this.access.configuration(tx)).then(() => {
          const ready = ['ready', 'paused'].includes(this.sourceState)
          res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ready, source: this.sourceState }))
        }, () => { res.writeHead(503); res.end('unavailable') }); return
      }
      void handler(req, res)
    })
    this.http.requestTimeout = 30_000; this.http.headersTimeout = 10_000; this.http.maxHeadersCount = 50
    try { await new Promise<void>((resolve, reject) => { this.http!.once('error', reject); this.http!.listen(this.options.port, '127.0.0.1', resolve) }) }
    catch (error) { await this.tlsGateway?.stop().catch(() => {}); this.started = false; throw error }
    this.runtime.start()
    this.sourceRun = this.source.run(this.lifetime.signal).catch(() => { if (!this.lifetime.signal.aborted) this.sourceState = 'error' })
    return { host: '127.0.0.1', port: (this.http.address() as { port: number }).port }
  }
  stop(): Promise<void> {
    return this.stopped ??= (async () => {
      this.lifetime.abort()
      await Promise.allSettled([this.sourceRun, this.tlsGateway?.stop(), this.runtime.stop(), this.backend.close(), new Promise<void>(resolve => this.http ? this.http.close(() => resolve()) : resolve())])
      if (!this.options.store) await this.store.close()
    })()
  }

  /** Controls exposed to the shared multi-group product HTTP host. */
  gatewayHttpControl() {
    if (!this.gateway) return undefined
    return this.gatewayHttp()
  }

  /** Workbench onboarding is installation-scoped and can be mounted by a shared host once. */
  workbenchHttpControl() { return this.workbench }

  private gatewayHttp() {
    return { info: (actor: string) => this.gatewayInfo(actor), pair: (actor: string, input: unknown) => this.gatewayPair(actor, input), register: (actor: string, input: unknown) => this.gatewayRegister(actor, input),
      devices: (actor: string) => this.gatewayDevices(actor), revoke: (actor: string, deviceId: string) => this.gatewayRevoke(actor, deviceId) }
  }

  private async operator(actor: string): Promise<void> {
    await this.store.transaction(this.options.scope, tx => this.access.user(tx, actor, true).then(() => {}))
  }

  private async gatewayPair(actor: string, input: unknown) {
    if (!this.gateway) throw new AccessDenied('Remote device gateway is not configured')
    await this.operator(actor)
    const value = z.object({ environmentId: z.string().min(1).max(200), ttlMs: z.number().int().min(30_000).max(600_000).optional(), capabilities: z.array(z.string().min(1).max(200)).max(20).default([]) }).strict().parse(input)
    const challenge = await this.gateway.createPairing({ tenantId: this.options.scope.tenantId, spaceId: this.options.scope.spaceId, userId: actor, environmentId: value.environmentId }, value.ttlMs, value.capabilities)
    return challenge
  }

  private async gatewayInfo(actor: string) {
    const address = this.options.gateway ?? this.gatewayHost?.address
    if (!this.gateway || !address) throw new AccessDenied('Remote device gateway is not configured')
    await this.operator(actor)
    return { host: address.host, port: address.port, gatewayPublicKey: this.gateway.publicKey }
  }

  private async gatewayRegister(actor: string, input: unknown) {
    if (!this.gateway) throw new AccessDenied('Remote device gateway is not configured')
    await this.operator(actor)
    const value = z.object({ challengeId: z.string().min(1).max(200), code: z.string().min(20).max(200), deviceId: z.uuid(), devicePublicKey: z.string().min(1).max(2000), capabilities: z.array(z.string().min(1).max(200)).max(20).default([]) }).strict().parse(input)
    const device = await this.gateway.registerPairing(value.challengeId, value.code, value.devicePublicKey, value.capabilities, value.deviceId)
    return { ...device, devicePublicKey: undefined }
  }

  private async gatewayDevices(actor: string) {
    if (!this.gateway) throw new AccessDenied('Remote device gateway is not configured')
    await this.operator(actor)
    return (await this.gateway.devicesForOwner(this.options.scope.tenantId, this.options.scope.spaceId, actor)).map(device => ({ ...device, devicePublicKey: undefined }))
  }

  private async gatewayRevoke(actor: string, deviceId: string) {
    if (!this.gateway) throw new AccessDenied('Remote device gateway is not configured')
    await this.operator(actor)
    const device = await this.gateway.device(z.string().min(1).max(200).parse(deviceId))
    if (!device || device.tenantId !== this.options.scope.tenantId || device.spaceId !== this.options.scope.spaceId || device.userId !== actor) throw new AccessDenied('Device is outside the current owner scope')
    await this.gateway.revoke(device.deviceId)
    return { deviceId: device.deviceId, status: 'revoked' }
  }
}
/** Explicit fresh-instance setup only. Existing data uses the offline importer; never initialized on server startup. */
export async function initializeCompany(store: StateStore, scope: StateScope, installation: Installation, input: unknown): Promise<void> {
  installation = InstallationSchema.parse(installation)
  const settings = SettingsSchema.parse(input)
  await store.transaction(scope, async tx => {
    for (const family of families) if ((await tx.scan(family, { limit: 1, includeDeleted: true })).length) throw new StateConflict('Existing state requires explicit migration; initialization refused')
    if ((await tx.jobs.list(1)).length || await tx.jobs.hasClaims()) throw new StateConflict('Initialization destination has existing work')
    const record: SettingsRecord = { revision: 1, settings, actor: installation.operator, at: new Date(await tx.now()).toISOString() }
    await tx.put('installation', installation.id, installation, 0)
    await tx.put('settings', 'current', record, 0)
    await tx.put('settings', 'version/000000000001', record, 0)
    await new ProductAccess(installation.id).user(tx, installation.operator, true)
  })
}
