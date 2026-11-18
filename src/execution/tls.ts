/**
 * C3 active TLS transport.
 *
 * The Runner opens the outbound connection. The server never dials into a
 * personal computer. TLS protects the stream; the post-TLS Ed25519 challenge
 * binds the stream to the device record already authorized by DeviceGateway.
 */
import { randomUUID } from 'node:crypto'
import { createServer, connect, type Server, type TLSSocket } from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionOutcomeUnknown, ExecutionUnavailable } from './port.ts'
import type { RemoteCancel, RemoteRequest, RemoteQuery } from './protocol.ts'
import type { RemoteTransport } from './router.ts'
import { RunnerOffline } from './router.ts'
import { DeviceGateway, signConnectionChallenge } from './gateway.ts'
import { LinuxRunner } from './runner/index.ts'
import { loadRunner } from './runner/config.ts'
import type { RunnerConfig } from './runner/config.ts'

type Frame = Record<string, unknown>
type RpcOperation = 'dispatch' | 'query' | 'cancel'
const MAX_FRAME_BYTES = 256 * 1024
const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new ExecutionUnavailable(`${label} is invalid`)
  return value
}
const frame = (value: Frame): string => `${JSON.stringify(value)}\n`

function receiveFrames(socket: TLSSocket, handle: (value: Frame) => Promise<void>, fail: (error: unknown) => void): void {
  let buffer = '', queue = Promise.resolve()
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString()
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { fail(new ExecutionUnavailable('TLS frame exceeds the gateway budget')); socket.destroy(); return }
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      if (!raw.trim()) continue
      let value: unknown
      try { value = JSON.parse(raw) } catch (error) { fail(error); socket.destroy(); return }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(new ExecutionUnavailable('TLS frame must be an object')); socket.destroy(); return }
      queue = queue.then(() => handle(value as Frame)).catch(error => { fail(error); socket.destroy() })
    }
  })
}

function errorValue(error: unknown): { name: string; message: string } {
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
}
function remoteError(value: unknown): Error {
  if (!value || typeof value !== 'object') return new ExecutionUnavailable('TLS Runner request failed')
  const name = typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : 'Error'
  const message = typeof (value as { message?: unknown }).message === 'string' ? (value as { message: string }).message : 'TLS Runner request failed'
  if (name === 'RunnerOffline') return new RunnerOffline(message)
  if (name === 'ExecutionOutcomeUnknown') return new ExecutionOutcomeUnknown(message)
  return new ExecutionUnavailable(message)
}

interface PendingRpc { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }

/** Authenticated TLS session that binds one Runner connection to the Gateway transport. */
class GatewayTlsSession {
  private stage: 'hello' | 'proof' | 'connected' | 'closed' = 'hello'
  private deviceId?: string
  private epoch?: number
  private readonly pending = new Map<string, PendingRpc>()
  private readonly transportImpl: RemoteTransport
  private closed = false

  constructor(private readonly socket: TLSSocket, private readonly gateway: DeviceGateway, private readonly timeoutMs: number,
    private readonly onClosed: () => void) {
    this.transportImpl = { dispatch: (request, signal) => this.call('dispatch', request, signal), query: (request, signal) => this.call('query', request, signal), cancel: (request, signal) => this.call('cancel', request, signal) }
    receiveFrames(socket, value => this.handle(value), error => this.fail(error))
    socket.once('close', () => this.close())
    socket.once('error', error => this.fail(error))
  }

  private send(value: Frame): void { if (this.closed || this.socket.destroyed) throw new RunnerOffline('Runner TLS connection is closed'); this.socket.write(frame(value)) }

  private async handle(value: Frame): Promise<void> {
    const type = value.type
    if (type === 'hello') return this.hello(value)
    if (type === 'proof') return this.proof(value)
    if (type === 'heartbeat') return this.heartbeat(value)
    if (type === 'rpc-result') return this.rpcResult(value)
    throw new ExecutionUnavailable('Unexpected TLS Runner frame')
  }

  private async hello(value: Frame): Promise<void> {
    if (this.stage !== 'hello') throw new ExecutionUnavailable('TLS Runner hello already received')
    this.deviceId = string(value.deviceId, 'Device ID')
    const challenge = await this.gateway.issueConnectionChallenge(this.deviceId)
    this.stage = 'proof'; this.send({ type: 'challenge', ...challenge })
  }

  private async proof(value: Frame): Promise<void> {
    if (this.stage !== 'proof' || !this.deviceId) throw new ExecutionUnavailable('TLS Runner proof is out of order')
    const signature = string(value.signature, 'Device signature')
    const device = await this.gateway.connect(this.deviceId, string(value.nonce, 'Challenge nonce'), signature, this.transportImpl)
    this.epoch = device.connectionEpoch; this.stage = 'connected'; this.send({ type: 'connected', deviceId: device.deviceId, epoch: this.epoch })
  }

  private async heartbeat(value: Frame): Promise<void> {
    if (this.stage !== 'connected' || !this.deviceId || this.epoch === undefined || value.deviceId !== this.deviceId || value.epoch !== this.epoch)
      throw new ExecutionUnavailable('TLS Runner heartbeat is not current')
    await this.gateway.heartbeat(this.deviceId, this.epoch); this.send({ type: 'heartbeat-ok', epoch: this.epoch })
  }

  private rpcResult(value: Frame): void {
    const id = string(value.id, 'RPC ID'), pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id); clearTimeout(pending.timer)
    if (value.ok === true) pending.resolve(value.value)
    else pending.reject(remoteError(value.error))
  }

  private call(operation: RpcOperation, payload: RemoteRequest | RemoteQuery | RemoteCancel, signal: AbortSignal): Promise<unknown> {
    if (this.stage !== 'connected') return Promise.reject(new RunnerOffline('Runner TLS connection is not ready'))
    signal.throwIfAborted()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ExecutionOutcomeUnknown('TLS Runner RPC receipt timed out')) }, this.timeoutMs)
      const abort = () => { this.pending.delete(id); clearTimeout(timer); reject(new ExecutionOutcomeUnknown('TLS Runner RPC was interrupted before receipt')) }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve: value => { signal.removeEventListener('abort', abort); resolve(value) }, reject: error => { signal.removeEventListener('abort', abort); reject(error) }, timer })
      try { this.send({ type: 'rpc', id, operation, payload }) } catch (error) { this.pending.delete(id); clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) }
    })
  }

  private fail(_error: unknown): void { this.socket.destroy() }

  private close(): void {
    if (this.closed) return
    this.closed = true; this.stage = 'closed'
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RunnerOffline('Runner TLS connection closed')) }
    this.pending.clear()
    if (this.deviceId && this.epoch !== undefined) void this.gateway.disconnect(this.deviceId, this.epoch).catch(() => {})
    this.onClosed()
  }

  destroy(): void { this.socket.destroy() }
}

export interface TlsGatewayServerOptions {
  gateway: DeviceGateway
  key: string | Buffer
  cert: string | Buffer
  host?: string
  port?: number
  requestCert?: boolean
  ca?: string | Buffer
  rejectUnauthorized?: boolean
  rpcTimeoutMs?: number
}

/** TLS listener hosted on the AI box. It accepts only the Runner protocol, not arbitrary HTTP. */
export class TlsGatewayServer {
  private server?: Server
  private readonly sessions = new Set<GatewayTlsSession>()
  constructor(private readonly options: TlsGatewayServerOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('TLS Gateway is already running')
    const server = createServer({ key: this.options.key, cert: this.options.cert, ca: this.options.ca, requestCert: this.options.requestCert ?? false,
      rejectUnauthorized: this.options.rejectUnauthorized ?? false, minVersion: 'TLSv1.3' }, socket => {
      let session: GatewayTlsSession
      session = new GatewayTlsSession(socket, this.options.gateway, this.options.rpcTimeoutMs ?? 30_000, () => this.sessions.delete(session))
      this.sessions.add(session)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => { const onError = (error: Error) => { server.off('listening', onListening); reject(error) }, onListening = () => { server.off('error', onError); resolve() }; server.once('error', onError); server.once('listening', onListening); server.listen(this.options.port ?? 0, this.options.host ?? '0.0.0.0') })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TLS Gateway did not expose a TCP address')
    return { host: address.address, port: address.port }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) session.destroy()
    this.sessions.clear()
    const server = this.server; this.server = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export interface TlsRunnerClientOptions {
  host: string
  port: number
  ca: string | Buffer
  servername?: string
  reconnectMs?: number
  maxReconnectMs?: number
  heartbeatMs?: number
  connectTimeoutMs?: number
  rpcTimeoutMs?: number
}

/** Active Runner connection. It reconnects outbound and services RPCs using LinuxRunner. */
export class TlsRunnerClient {
  status: 'stopped' | 'connecting' | 'connected' = 'stopped'
  get deviceId(): string { return this.config.deviceId }
  private socket?: TLSSocket
  private stopping = false
  private loop?: Promise<void>
  private epoch?: number
  private readonly waiters = new Set<{ resolve(): void; reject(error: unknown): void }>()
  private heartbeat?: ReturnType<typeof setInterval>
  constructor(private readonly config: RunnerConfig, private readonly runner: RemoteTransport, private readonly options: TlsRunnerClientOptions,
    private readonly closeRunner?: () => Promise<void>) {}

  static async open(home: string, options: TlsRunnerClientOptions): Promise<TlsRunnerClient> {
    const config = await loadRunner(home), runner = await LinuxRunner.open(home)
    return new TlsRunnerClient(config, runner.transport(config.binding), options, () => runner.close())
  }

  async start(): Promise<void> {
    if (this.loop) return
    this.stopping = false; this.loop = this.run()
    await Promise.resolve()
  }

  async waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.status === 'connected') return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(waiter); reject(new RunnerOffline('Runner did not connect to the TLS Gateway')) }, timeoutMs)
      const waiter = { resolve: () => { clearTimeout(timer); this.waiters.delete(waiter); resolve() }, reject: (error: unknown) => { clearTimeout(timer); this.waiters.delete(waiter); reject(error) } }
      this.waiters.add(waiter)
    })
  }

  async stop(): Promise<void> {
    this.stopping = true; this.socket?.destroy()
    await this.loop; this.loop = undefined; this.status = 'stopped'
    await this.closeRunner?.()
  }

  private async run(): Promise<void> {
    let backoff = this.options.reconnectMs ?? 250, firstError: unknown
    while (!this.stopping) {
      this.status = 'connecting'
      try { await this.connectOnce(); backoff = this.options.reconnectMs ?? 250 }
      catch (error) { firstError ??= error; if (this.stopping) break }
      if (!this.stopping) { await delay(backoff); backoff = Math.min(this.options.maxReconnectMs ?? 10_000, Math.max(backoff * 2, 250)) }
    }
    for (const waiter of this.waiters) waiter.reject(firstError ?? new RunnerOffline('Runner stopped before connecting'))
    this.waiters.clear()
  }

  private async connectOnce(): Promise<void> {
    const socket = connect({ host: this.options.host, port: this.options.port, ca: this.options.ca, servername: this.options.servername ?? this.options.host,
      rejectUnauthorized: true, minVersion: 'TLSv1.3' })
    this.socket = socket
    let connectedResolve!: () => void, connectedReject!: (error: unknown) => void, closedResolve!: () => void
    const connected = new Promise<void>((resolve, reject) => { connectedResolve = resolve; connectedReject = reject }), closed = new Promise<void>(resolve => { closedResolve = resolve })
    let handshake = false, buffer = '', queue = Promise.resolve(), heartbeatAck: ReturnType<typeof setTimeout> | undefined
    const send = (value: Frame) => { if (socket.destroyed) throw new RunnerOffline('Runner TLS socket is closed'); socket.write(frame(value)) }
    const heartbeat = () => {
      if (this.status !== 'connected' || this.epoch === undefined) return
      try {
        send({ type: 'heartbeat', deviceId: this.config.deviceId, epoch: this.epoch })
        clearTimeout(heartbeatAck); heartbeatAck = setTimeout(() => socket.destroy(), Math.max((this.options.heartbeatMs ?? 30_000) * 2, 1_000))
      } catch { socket.destroy() }
    }
    const handle = async (value: Frame): Promise<void> => {
      if (value.type === 'challenge') {
        if (string(value.deviceId, 'Device ID') !== this.config.deviceId) throw new ExecutionUnavailable('TLS challenge targets another device')
        send({ type: 'proof', nonce: string(value.nonce, 'Challenge nonce'), signature: signConnectionChallenge(this.config.deviceId, string(value.nonce, 'Challenge nonce'), this.config.devicePrivateKey) }); return
      }
      if (value.type === 'connected') {
        if (string(value.deviceId, 'Device ID') !== this.config.deviceId || !Number.isInteger(value.epoch)) throw new ExecutionUnavailable('TLS connection identity is invalid')
        this.epoch = Number(value.epoch); this.status = 'connected'; handshake = true; connectedResolve(); this.waiters.forEach(waiter => waiter.resolve()); return
      }
      if (value.type === 'heartbeat-ok') { clearTimeout(heartbeatAck); heartbeatAck = undefined; return }
      if (value.type === 'rpc') {
        const id = string(value.id, 'RPC ID'), operation = value.operation, payload = value.payload
        try {
          let result: unknown
          if (operation === 'dispatch') result = await this.runner.dispatch(payload as RemoteRequest, AbortSignal.timeout(this.options.rpcTimeoutMs ?? 30_000))
          else if (operation === 'query') result = await this.runner.query(payload as RemoteQuery, AbortSignal.timeout(this.options.rpcTimeoutMs ?? 30_000))
          else if (operation === 'cancel') result = await this.runner.cancel(payload as RemoteCancel, AbortSignal.timeout(this.options.rpcTimeoutMs ?? 30_000))
          else throw new ExecutionUnavailable('TLS Runner operation is unsupported')
          send({ type: 'rpc-result', id, ok: true, value: result })
        } catch (error) { send({ type: 'rpc-result', id, ok: false, error: errorValue(error) }) }
        return
      }
      throw new ExecutionUnavailable('Unexpected TLS Gateway frame')
    }
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString()
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { connectedReject(new ExecutionUnavailable('TLS frame exceeds the Runner budget')); socket.destroy(); return }
      for (;;) {
        const index = buffer.indexOf('\n'); if (index < 0) break
        const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!raw.trim()) continue
        let value: unknown; try { value = JSON.parse(raw) } catch (error) { connectedReject(error); socket.destroy(); return }
        queue = queue.then(() => handle(value as Frame)).catch(error => { if (!handshake) connectedReject(error); socket.destroy(error instanceof Error ? error : undefined) })
      }
    })
    socket.once('secureConnect', () => { try { send({ type: 'hello', deviceId: this.config.deviceId }) } catch (error) { connectedReject(error); socket.destroy() } })
    socket.once('error', error => { if (!handshake) connectedReject(error) })
    socket.once('close', () => { if (!handshake) connectedReject(new RunnerOffline('TLS Gateway connection closed during handshake')); clearInterval(this.heartbeat); this.heartbeat = undefined; clearTimeout(heartbeatAck); heartbeatAck = undefined; this.status = 'connecting'; this.socket = undefined; closedResolve() })
    const timeout = setTimeout(() => { connectedReject(new RunnerOffline('TLS Gateway handshake timed out')); socket.destroy() }, this.options.connectTimeoutMs ?? 10_000)
    try { await connected } finally { clearTimeout(timeout) }
    this.heartbeat = setInterval(heartbeat, this.options.heartbeatMs ?? 30_000); await closed
  }
}
