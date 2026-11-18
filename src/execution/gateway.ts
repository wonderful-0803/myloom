/**
 * C3 trusted gateway core.
 *
 * This module deliberately stops at an authenticated connection boundary. It
 * does not open a socket and it does not expose pairing or grant management
 * over HTTP. A server adapter may wrap these methods after it has supplied the
 * authenticated Loom owner/space and a transport with equivalent properties.
 */
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { ExecutionUnavailable } from './port.ts'
import { checkedReceipt, checkedRequest, CancelSchema, intentHash, QuerySchema, ReceiptCursor, terminal } from './protocol.ts'
import type { RemoteCancel, RemoteReceipt, RemoteRequest, RemoteQuery } from './protocol.ts'
import type { RemoteTransport } from './router.ts'
import { RunnerOffline } from './router.ts'
import type { RunnerPeer } from './runner/config.ts'
import { permitPayload, samePeer } from './runner/config.ts'
import { hash } from '../state/hash.ts'
import type { StateScope, StateStore } from '../state/ports.ts'
import { StateConflict } from '../state/ports.ts'
import { recordRunnerSignal } from '../state/signals.ts'
import { KV } from '../kv.ts'

const PAIRING_TTL_MS = 5 * 60_000
const CONNECTION_TTL_MS = 90_000
const id = (value: string, label: string): string => {
  if (!value.trim() || value.length > 200) throw new Error(`${label} is required`)
  return value
}

export interface GatewayBinding extends RunnerPeer {
  /** Server-side identity of a registered device, never supplied by a model. */
  deviceId: string
}

export interface PairingChallenge {
  id: string
  /** The raw one-time secret is returned only to the already authenticated UI. */
  code: string
  binding: RunnerPeer
  capabilities: string[]
  expiresAt: string
}

interface StoredPairing extends PairingChallenge {
  codeHash: string
  used: boolean
}

export interface DeviceRecord extends GatewayBinding {
  devicePublicKey: string
  status: 'offline' | 'online' | 'revoked'
  capabilities: string[]
  lastSeen?: string
  connectionEpoch: number
}

export interface GatewayDirectoryRecord<T> { value: T; revision: number }
export type DeviceRegistration = Pick<DeviceRecord, 'deviceId' | 'devicePublicKey' | 'status' | 'capabilities' | 'connectionEpoch'>

/** Durable directory operations used by DeviceGateway. Implementations must use CAS for changes. */
export interface GatewayDirectory {
  createPairing(value: StoredPairing): Promise<void>
  consumePairing(challengeId: string, codeHash: string, now: number, device: DeviceRegistration): Promise<DeviceRecord>
  device(deviceId: string): Promise<GatewayDirectoryRecord<DeviceRecord> | undefined>
  devices(binding: RunnerPeer): Promise<GatewayDirectoryRecord<DeviceRecord>[]>
  devicesForOwner(tenantId: string, spaceId: string, userId: string): Promise<GatewayDirectoryRecord<DeviceRecord>[]>
  updateDevice(deviceId: string, value: DeviceRecord, expectedRevision: number): Promise<void>
}

/** Volatile directory used when a server has not opted into external state. */
export class MemoryGatewayDirectory implements GatewayDirectory {
  private readonly pairings = new Map<string, GatewayDirectoryRecord<StoredPairing>>()
  private readonly devicesById = new Map<string, GatewayDirectoryRecord<DeviceRecord>>()

  async createPairing(value: StoredPairing): Promise<void> {
    if (this.pairings.has(value.id)) throw new StateConflict('Pairing challenge ID already exists')
    this.pairings.set(value.id, { value: structuredClone(value), revision: 1 })
  }

  async consumePairing(challengeId: string, codeHash: string, now: number, device: DeviceRegistration): Promise<DeviceRecord> {
    const pairing = this.pairings.get(challengeId)
    if (!pairing || pairing.value.used || Date.parse(pairing.value.expiresAt) <= now || pairing.value.codeHash !== codeHash)
      throw new ExecutionUnavailable('Pairing challenge is invalid, expired or already used')
    if (this.devicesById.has(device.deviceId)) throw new StateConflict('Device ID already exists')
    pairing.value = { ...pairing.value, used: true }; pairing.revision++
    if (JSON.stringify(pairing.value.capabilities) !== JSON.stringify(device.capabilities)) throw new ExecutionUnavailable('Pairing capabilities changed')
    const registered = { ...pairing.value.binding, ...device, capabilities: pairing.value.capabilities }
    this.devicesById.set(device.deviceId, { value: structuredClone(registered), revision: 1 })
    return structuredClone(registered)
  }

  async device(deviceId: string) {
    const value = this.devicesById.get(deviceId)
    return value && { value: structuredClone(value.value), revision: value.revision }
  }

  async devices(binding: RunnerPeer) {
    return [...this.devicesById.values()].filter(row => samePeer(row.value, binding)).map(row => ({ value: structuredClone(row.value), revision: row.revision }))
  }

  async devicesForOwner(tenantId: string, spaceId: string, userId: string) {
    return [...this.devicesById.values()].filter(row => row.value.tenantId === tenantId && row.value.spaceId === spaceId && row.value.userId === userId)
      .map(row => ({ value: structuredClone(row.value), revision: row.revision }))
  }

  async updateDevice(deviceId: string, value: DeviceRecord, expectedRevision: number): Promise<void> {
    const old = this.devicesById.get(deviceId)
    if (!old || old.revision !== expectedRevision) throw new StateConflict('Device directory revision changed')
    this.devicesById.set(deviceId, { value: structuredClone(value), revision: expectedRevision + 1 })
  }
}

/** StateStore-backed device directory. Pairing consumption and device creation share one transaction. */
export class StateGatewayDirectory implements GatewayDirectory {
  constructor(private readonly store: StateStore, private readonly scope: StateScope) {}
  private pairingKey(id: string) { return KV.gateway.pairing(id) }
  private deviceKey(id: string) { return KV.gateway.device(id) }

  async createPairing(value: StoredPairing): Promise<void> {
    await this.store.transaction(this.scope, async tx => {
      await tx.put('kv', this.pairingKey(value.id), value, 0, { relation: 'gateway.pairing', active: true })
    })
  }

  async consumePairing(challengeId: string, codeHash: string, now: number, device: DeviceRegistration): Promise<DeviceRecord> {
    return this.store.transaction(this.scope, async tx => {
      const pairingRow = await tx.get<StoredPairing>('kv', this.pairingKey(challengeId))
      if (!pairingRow || pairingRow.value.used || Date.parse(pairingRow.value.expiresAt) <= now || pairingRow.value.codeHash !== codeHash)
        throw new ExecutionUnavailable('Pairing challenge is invalid, expired or already used')
      if (await tx.get('kv', this.deviceKey(device.deviceId))) throw new StateConflict('Device ID already exists')
      if (JSON.stringify(pairingRow.value.capabilities) !== JSON.stringify(device.capabilities)) throw new ExecutionUnavailable('Pairing capabilities changed')
      const registered = { ...pairingRow.value.binding, ...device, capabilities: pairingRow.value.capabilities }
      await tx.put('kv', this.pairingKey(challengeId), { ...pairingRow.value, used: true }, pairingRow.revision, { relation: 'gateway.pairing', active: false })
      await tx.put('kv', this.deviceKey(device.deviceId), registered, 0, { relation: 'gateway.device', active: true })
      return structuredClone(registered)
    })
  }

  async device(deviceId: string) {
    return this.store.transaction(this.scope, async tx => {
      const row = await tx.get<DeviceRecord>('kv', this.deviceKey(deviceId))
      return row ? { value: structuredClone(row.value), revision: row.revision } : undefined
    })
  }

  async devices(binding: RunnerPeer) {
    return this.store.transaction(this.scope, async tx => (await tx.scan<DeviceRecord>('kv', { relation: 'gateway.device', limit: 1000 }))
      .filter(row => samePeer(row.value, binding)).map(row => ({ value: structuredClone(row.value), revision: row.revision })))
  }

  async devicesForOwner(tenantId: string, spaceId: string, userId: string) {
    return this.store.transaction(this.scope, async tx => (await tx.scan<DeviceRecord>('kv', { relation: 'gateway.device', limit: 1000 }))
      .filter(row => row.value.tenantId === tenantId && row.value.spaceId === spaceId && row.value.userId === userId)
      .map(row => ({ value: structuredClone(row.value), revision: row.revision })))
  }

  async updateDevice(deviceId: string, value: DeviceRecord, expectedRevision: number): Promise<void> {
    await this.store.transaction(this.scope, async tx => {
      const row = await tx.get<DeviceRecord>('kv', this.deviceKey(deviceId))
      if (!row) throw new StateConflict('Device is not registered')
      if (row.revision !== expectedRevision) throw new StateConflict('Device directory revision changed')
      if (!samePeer(row.value, value) || value.deviceId !== deviceId) throw new StateConflict('Device binding changed')
      await tx.put('kv', this.deviceKey(deviceId), value, row.revision, { relation: 'gateway.device', active: value.status !== 'revoked' })
      if (value.tenantId === tx.scope.tenantId && value.spaceId === tx.scope.spaceId
        && (row.value.status !== value.status || row.value.connectionEpoch !== value.connectionEpoch)) await recordRunnerSignal(tx, value)
    })
  }
}

/** StateStore device directory shared by one multi-group company host. */
export class MultiScopeGatewayDirectory implements GatewayDirectory {
  private readonly scopes = new Map<string, StateScope>()
  constructor(private readonly store: StateStore) {}
  register(scope: StateScope): void { this.scopes.set(`${scope.tenantId}/${scope.spaceId}`, scope) }
  private scope(binding: Pick<RunnerPeer, 'tenantId' | 'spaceId'>): StateScope {
    const value = this.scopes.get(`${binding.tenantId}/${binding.spaceId}`)
    if (!value) throw new ExecutionUnavailable('Gateway workspace is not registered')
    return value
  }
  private all(): StateGatewayDirectory[] { return [...this.scopes.values()].map(scope => new StateGatewayDirectory(this.store, scope)) }
  async createPairing(value: StoredPairing): Promise<void> { await new StateGatewayDirectory(this.store, this.scope(value.binding)).createPairing(value) }
  async consumePairing(challengeId: string, codeHash: string, now: number, device: DeviceRegistration): Promise<DeviceRecord> {
    let failure: unknown
    for (const directory of this.all()) {
      try { return await directory.consumePairing(challengeId, codeHash, now, device) } catch (error) { failure = error }
    }
    throw failure ?? new ExecutionUnavailable('Pairing challenge is invalid, expired or already used')
  }
  async device(deviceId: string) {
    for (const directory of this.all()) { const value = await directory.device(deviceId); if (value) return value }
    return undefined
  }
  async devices(binding: RunnerPeer) { const scope = this.scope(binding); return new StateGatewayDirectory(this.store, scope).devices(binding) }
  async devicesForOwner(tenantId: string, spaceId: string, userId: string) { return new StateGatewayDirectory(this.store, this.scope({ tenantId, spaceId })).devicesForOwner(tenantId, spaceId, userId) }
  async updateDevice(deviceId: string, value: DeviceRecord, expectedRevision: number): Promise<void> {
    const row = await this.device(deviceId)
    if (!row) throw new StateConflict('Device is not registered')
    await new StateGatewayDirectory(this.store, this.scope(row.value)).updateDevice(deviceId, value, expectedRevision)
  }
}

interface DeviceConnection {
  transport: RemoteTransport
  epoch: number
  expiresAt: number
}

interface GatewayEntry {
  request: RemoteRequest
  receipt: RemoteReceipt
  cursor: ReceiptCursor
  deviceId: string
  updatedAt: number
  revision: number
}

export interface GatewayLedgerValue {
  request: RemoteRequest
  receipt: RemoteReceipt
  deviceId: string
  updatedAt: number
}

export interface GatewayLedgerRecord extends GatewayLedgerValue { revision: number }

export interface GatewayLedgerBackend {
  get(requestId: string): Promise<GatewayLedgerRecord | undefined>
  create(value: GatewayLedgerValue): Promise<boolean>
  update(requestId: string, value: GatewayLedgerValue, expectedRevision: number): Promise<void>
  all(): Promise<GatewayLedgerRecord[]>
}

/** Volatile backend used by the protocol simulator and unit tests. */
export class MemoryGatewayLedgerBackend implements GatewayLedgerBackend {
  private readonly values = new Map<string, GatewayLedgerRecord>()
  async get(requestId: string) { const value = this.values.get(requestId); return value && structuredClone(value) }
  async create(value: GatewayLedgerValue) {
    if (this.values.has(value.request.requestId)) return false
    this.values.set(value.request.requestId, { ...structuredClone(value), revision: 1 }); return true
  }
  async update(requestId: string, value: GatewayLedgerValue, expectedRevision: number) {
    const old = this.values.get(requestId)
    if (!old || old.revision !== expectedRevision) throw new ExecutionUnavailable('Gateway ledger revision changed')
    this.values.set(requestId, { ...structuredClone(value), revision: expectedRevision + 1 })
  }
  async all() { return [...this.values.values()].map(value => structuredClone(value)) }
}

/** Durable Loom state adapter. It uses the scoped execution family and CAS revisions. */
export class StateGatewayLedgerBackend implements GatewayLedgerBackend {
  constructor(private readonly store: StateStore, private readonly scope: StateScope) {}
  private key(requestId: string) { return `gateway/request/${requestId}` }
  async get(requestId: string) {
    return this.store.transaction(this.scope, async tx => {
      const row = await tx.get<GatewayLedgerValue>('execution', this.key(requestId))
      return row ? { ...structuredClone(row.value), revision: row.revision } : undefined
    })
  }
  async create(value: GatewayLedgerValue) {
    return this.store.transaction(this.scope, async tx => {
      if (await tx.get('execution', this.key(value.request.requestId))) return false
      await tx.put('execution', this.key(value.request.requestId), value, 0, { relation: 'gateway.request', active: !terminal(value.receipt) })
      return true
    })
  }
  async update(requestId: string, value: GatewayLedgerValue, expectedRevision: number) {
    await this.store.transaction(this.scope, async tx => {
      const row = await tx.get<GatewayLedgerValue>('execution', this.key(requestId))
      if (!row) throw new StateConflict('Gateway request is not durably registered')
      if (row.revision !== expectedRevision) throw new StateConflict('Gateway request revision changed')
      await tx.put('execution', this.key(requestId), value, row.revision, { relation: 'gateway.request', active: !terminal(value.receipt) })
    })
  }
  async all() {
    return this.store.transaction(this.scope, async tx => (await tx.scan<GatewayLedgerValue>('execution', { relation: 'gateway.request', limit: 1000 }))
      .map(row => ({ ...structuredClone(row.value), revision: row.revision })))
  }
}

/** Request ledger backend for one shared Gateway serving multiple StateStore scopes. */
export class MultiScopeGatewayLedgerBackend implements GatewayLedgerBackend {
  private readonly scopes = new Map<string, StateScope>()
  constructor(private readonly store: StateStore) {}
  register(scope: StateScope): void { this.scopes.set(`${scope.tenantId}/${scope.spaceId}`, scope) }
  private scope(value: Pick<RemoteRequest, 'tenantId' | 'spaceId'>): StateScope {
    const scope = this.scopes.get(`${value.tenantId}/${value.spaceId}`)
    if (!scope) throw new ExecutionUnavailable('Gateway workspace is not registered')
    return scope
  }
  async get(requestId: string) {
    for (const scope of this.scopes.values()) { const value = await new StateGatewayLedgerBackend(this.store, scope).get(requestId); if (value) return value }
    return undefined
  }
  async create(value: GatewayLedgerValue) { return new StateGatewayLedgerBackend(this.store, this.scope(value.request)).create(value) }
  async update(requestId: string, value: GatewayLedgerValue, expectedRevision: number) { return new StateGatewayLedgerBackend(this.store, this.scope(value.request)).update(requestId, value, expectedRevision) }
  async all() {
    const rows = []
    for (const scope of this.scopes.values()) rows.push(...await new StateGatewayLedgerBackend(this.store, scope).all())
    return rows
  }
}

/**
 * A small in-process ledger used by the C3 core. Production adapters must
 * mirror these transitions into the A-state `execution` family in the same
 * transaction that registers the task operation. The gateway never silently
 * falls back to a local executor.
 */
export class GatewayRequestLedger {
  constructor(private readonly backend: GatewayLedgerBackend = new MemoryGatewayLedgerBackend()) {}

  async get(requestId: string, expectedIntent?: string): Promise<GatewayEntry | undefined> {
    const record = await this.backend.get(requestId)
    const entry = record && this.entry(record)
    if (entry && expectedIntent && intentHash(entry.request) !== expectedIntent)
      throw new ExecutionUnavailable('Gateway request identity conflict')
    return entry
  }

  private entry(record: GatewayLedgerRecord): GatewayEntry {
    const cursor = new ReceiptCursor(record.request)
    cursor.accept(record.receipt)
    return { ...record, request: structuredClone(record.request), receipt: structuredClone(record.receipt), cursor }
  }

  async accept(request: RemoteRequest, deviceId: string, receipt: unknown): Promise<RemoteReceipt> {
    const existing = await this.get(request.requestId)
    if (existing) {
      if (intentHash(existing.request) !== intentHash(request)) throw new ExecutionUnavailable('Gateway request identity conflict')
      return existing.receipt
    }
    const checked = checkedReceipt(receipt, request), cursor = new ReceiptCursor(request)
    const value = cursor.accept(checked)
    const record: GatewayLedgerValue = { request: structuredClone(request), receipt: value, deviceId, updatedAt: Date.now() }
    if (await this.backend.create(record)) return value
    const raced = await this.get(request.requestId)
    if (!raced || intentHash(raced.request) !== intentHash(request)) throw new ExecutionUnavailable('Gateway request identity conflict')
    return raced.receipt
  }

  async update(request: RemoteRequest, receipt: unknown): Promise<RemoteReceipt> {
    const entry = await this.get(request.requestId, intentHash(request))
    if (!entry) throw new ExecutionUnavailable('Gateway request was not durably accepted')
    const value = entry.cursor.accept(receipt)
    await this.backend.update(request.requestId, { request: entry.request, receipt: value, deviceId: entry.deviceId, updatedAt: Date.now() }, entry.revision)
    return value
  }

  async all(): Promise<GatewayEntry[]> { return (await this.backend.all()).map(record => this.entry(record)) }
}

export interface GatewayOptions {
  /** Keep this short in tests; production should use a persistent key. */
  keyPair?: { publicKey: KeyObject; privateKey: KeyObject }
  pairingTtlMs?: number
  connectionTtlMs?: number
  now?: () => number
  ledger?: GatewayRequestLedger
  directory?: GatewayDirectory
}

/**
 * Authenticated device registry and transport multiplexer for the company
 * server. Pairing binds a user/space/environment to the device public key;
 * connecting later requires a fresh signed challenge. Public device IDs,
 * request IDs and chat membership are never authentication credentials.
 */
export class DeviceGateway {
  readonly publicKey: string
  private readonly privateKey: KeyObject
  private readonly directory: GatewayDirectory
  private readonly connectionChallenges = new Map<string, { nonce: string; expiresAt: number }>()
  private readonly connections = new Map<string, DeviceConnection>()
  private readonly ledger: GatewayRequestLedger
  private readonly now: () => number
  private readonly pairingTtl: number
  private readonly connectionTtl: number

  constructor(options: GatewayOptions = {}) {
    const keys = options.keyPair ?? generateKeyPairSync('ed25519')
    this.privateKey = keys.privateKey
    this.publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    this.now = options.now ?? Date.now
    this.pairingTtl = options.pairingTtlMs ?? PAIRING_TTL_MS
    this.connectionTtl = options.connectionTtlMs ?? CONNECTION_TTL_MS
    this.ledger = options.ledger ?? new GatewayRequestLedger()
    this.directory = options.directory ?? new MemoryGatewayDirectory()
  }

  /** Create a one-time challenge only after the caller has been authorized by Loom. */
  async createPairing(binding: RunnerPeer, ttlMs = this.pairingTtl, capabilities: readonly string[] = []): Promise<PairingChallenge> {
    const value = { ...binding }
    const code = randomBytes(32).toString('base64url'), challengeId = randomUUID(), expiresAt = new Date(this.now() + ttlMs).toISOString()
    const allowed = [...new Set(capabilities.map(value => id(value, 'Capability')))].sort()
    const challenge: PairingChallenge = { id: challengeId, code, binding: value, capabilities: allowed, expiresAt }
    await this.directory.createPairing({ ...challenge, codeHash: hash(code), used: false })
    return structuredClone(challenge)
  }

  /** Consume the challenge once and bind a device key to the authorized owner/space. */
  async registerPairing(challengeId: string, code: string, devicePublicKey: string, capabilities: readonly string[] = [], requestedDeviceId?: string): Promise<DeviceRecord> {
    const deviceKey = createPublicKeyChecked(devicePublicKey)
    const deviceId = requestedDeviceId ?? randomUUID()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) throw new ExecutionUnavailable('Device ID is invalid')
    return this.directory.consumePairing(id(challengeId, 'Pairing challenge'), hash(code), this.now(), {
      deviceId, devicePublicKey: deviceKey,
      status: 'offline', capabilities: [...new Set(capabilities.map(value => id(value, 'Capability')))].sort(), connectionEpoch: 0 })
  }

  async device(deviceId: string): Promise<DeviceRecord | undefined> {
    const value = (await this.directory.device(id(deviceId, 'Device ID')))?.value
    return value ? this.visibleDevice(value) : undefined
  }

  async devicesFor(binding: RunnerPeer): Promise<DeviceRecord[]> {
    return (await this.directory.devices(binding)).map(row => this.visibleDevice(row.value))
  }

  async devicesForOwner(tenantId: string, spaceId: string, userId: string): Promise<DeviceRecord[]> {
    return (await this.directory.devicesForOwner(tenantId, spaceId, userId)).map(row => this.visibleDevice(row.value))
  }

  private visibleDevice(value: DeviceRecord): DeviceRecord {
    // A persisted online flag is not proof of a live process after a gateway restart.
    const connection = this.connections.get(value.deviceId)
    if (value.status === 'online' && (connection?.epoch !== value.connectionEpoch || connection.expiresAt <= this.now())) return { ...value, status: 'offline' }
    return structuredClone(value)
  }

  async revoke(deviceId: string): Promise<void> {
    const key = id(deviceId, 'Device ID'), row = await this.directory.device(key)
    if (!row) throw new ExecutionUnavailable('Device is not registered')
    const device = { ...row.value, status: 'revoked' as const, connectionEpoch: row.value.connectionEpoch + 1 }
    await this.directory.updateDevice(key, device, row.revision)
    this.connectionChallenges.delete(deviceId)
    this.connections.delete(deviceId)
  }

  async issueConnectionChallenge(deviceId: string): Promise<{ deviceId: string; nonce: string; expiresAt: string }> {
    const key = id(deviceId, 'Device ID'), device = await this.device(key)
    if (!device || device.status === 'revoked') throw new ExecutionUnavailable('Device is not available')
    const nonce = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + Math.min(this.connectionTtl, 60_000)
    this.connectionChallenges.set(deviceId, { nonce, expiresAt })
    return { deviceId, nonce, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** Attach an already authenticated transport. Network/TLS adapters call this after verifying the challenge. */
  async connect(deviceId: string, nonce: string, signature: string, transport: RemoteTransport): Promise<DeviceRecord> {
    const key = id(deviceId, 'Device ID'), row = await this.directory.device(key), device = row?.value
    if (!device || device.status === 'revoked') throw new ExecutionUnavailable('Device is not available')
    const challenge = this.connectionChallenges.get(deviceId)
    if (!challenge || challenge.nonce !== nonce || challenge.expiresAt <= this.now() || !nonce.trim() || !signature.trim()
      || !verify(null, connectionPayload(deviceId, nonce), device.devicePublicKey, Buffer.from(signature, 'base64url')))
      throw new ExecutionUnavailable('Device connection proof is invalid')
    this.connectionChallenges.delete(deviceId)
    const epoch = device.connectionEpoch + 1
    const updated = { ...device, connectionEpoch: epoch, status: 'online' as const, lastSeen: new Date(this.now()).toISOString() }
    await this.directory.updateDevice(key, updated, row!.revision)
    this.connections.set(deviceId, { transport, epoch, expiresAt: this.now() + this.connectionTtl })
    return structuredClone(updated)
  }

  async heartbeat(deviceId: string, epoch: number): Promise<DeviceRecord> {
    const key = id(deviceId, 'Device ID'), row = await this.directory.device(key), device = row?.value, connection = this.connections.get(deviceId)
    if (!device || device.status !== 'online' || device.connectionEpoch !== epoch || !connection || connection.epoch !== epoch || connection.expiresAt <= this.now()) throw new ExecutionUnavailable('Device connection is not current')
    connection.expiresAt = this.now() + this.connectionTtl
    const updated = { ...device, status: 'online' as const, lastSeen: new Date(this.now()).toISOString() }
    await this.directory.updateDevice(key, updated, row!.revision)
    return structuredClone(updated)
  }

  async disconnect(deviceId: string, epoch?: number): Promise<void> {
    const connection = this.connections.get(deviceId)
    if (!connection || epoch !== undefined && connection.epoch !== epoch) return
    this.connections.delete(deviceId)
    const row = await this.directory.device(deviceId)
    if (row?.value.status === 'online' && row.value.connectionEpoch === connection.epoch)
      await this.directory.updateDevice(deviceId, { ...row.value, status: 'offline' }, row.revision)
  }

  /** Transport for one registered device; requests cannot select another environment. */
  transport(deviceId: string): RemoteTransport {
    return {
      dispatch: (request, signal) => this.forward(deviceId, 'dispatch', request, signal),
      query: (request, signal) => this.forward(deviceId, 'query', request, signal),
      cancel: (request, signal) => this.forward(deviceId, 'cancel', request, signal),
    }
  }

  requestLedger(): GatewayRequestLedger { return this.ledger }

  /** Trusted server helper used by an A/B authority after it has persisted admission. */
  signPermit(request: Omit<RemoteRequest, 'permit'>): string {
    return sign(null, permitPayload({ ...request, permit: '' }), this.privateKey).toString('base64url')
  }

  private async connection(deviceId: string): Promise<DeviceConnection> {
    const device = await this.device(deviceId), connection = this.connections.get(deviceId)
    if (!device || device.status === 'revoked' || !connection || connection.expiresAt <= this.now()) {
      if (connection) await this.disconnect(deviceId, connection.epoch)
      throw new RunnerOffline('Runner is offline; environment wait is required')
    }
    return connection
  }

  private async forward(deviceId: string, operation: 'dispatch' | 'query' | 'cancel', raw: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const device = await this.device(deviceId), connection = await this.connection(deviceId)
    if (!device) throw new RunnerOffline('Runner is offline; environment wait is required')
    const request = operation === 'dispatch' ? checkedRequest(raw) : undefined
    if (request && (request.environmentId !== device.environmentId || request.tenantId !== device.tenantId || request.spaceId !== device.spaceId || request.userId !== device.userId))
      throw new ExecutionUnavailable('Remote request is outside the registered device binding')
    if (operation === 'dispatch') {
      const permit = Buffer.from(request!.permit, 'base64url')
      if (permit.length !== 64 || !verify(null, permitPayload(request!), this.publicKey, permit)) throw new ExecutionUnavailable('Gateway permit is invalid')
      const existing = await this.ledger.get(request!.requestId)
      if (existing) {
        if (existing.deviceId !== deviceId || intentHash(existing.request) !== intentHash(request!)) throw new ExecutionUnavailable('Gateway request identity conflict')
        return structuredClone(existing.receipt)
      }
      const receipt = await connection.transport.dispatch(request!, signal)
      return this.ledger.accept(request!, deviceId, receipt)
    }
    const query = operation === 'query' ? QuerySchema.parse(raw) : undefined
    const cancel = operation === 'cancel' ? CancelSchema.parse(raw) : undefined
    const requestId = query?.requestId ?? cancel?.requestId
    const entry = await this.ledger.get(requestId!, query?.intentHash ?? cancel?.intentHash)
    if (!entry || entry.deviceId !== deviceId) throw new ExecutionUnavailable('Gateway request is not available for this device')
    const receipt = operation === 'query' ? await connection.transport.query(query!, signal) : await connection.transport.cancel(cancel!, signal)
    return this.ledger.update(entry.request, receipt)
  }
}

/** Payload signed by a Runner during the post-pairing connection handshake. */
export const connectionPayload = (deviceId: string, nonce: string) => Buffer.from(`loom-runner-connect-v1\0${deviceId}\0${nonce}`)

function createPublicKeyChecked(value: string): string {
  const key = createPublicKey(value)
  if (key.asymmetricKeyType !== 'ed25519') throw new ExecutionUnavailable('Device requires an Ed25519 public key')
  return key.export({ type: 'spki', format: 'pem' }).toString()
}

/** Helper for a local Runner adapter; the private key never leaves the device. */
export function signConnectionChallenge(deviceId: string, nonce: string, privateKey: Parameters<typeof sign>[2]): string {
  return sign(null, connectionPayload(deviceId, nonce), privateKey).toString('base64url')
}
