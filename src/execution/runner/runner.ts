/** C2 local engine. The caller must authenticate the peer before obtaining a transport; no network is exposed here. */
import { setImmediate as immediate } from 'node:timers/promises'
import { resolve } from 'node:path'
import { checkedRequest, checkedReceipt, QuerySchema, CancelSchema, intentHash, terminal } from '../protocol.ts'
import type { RemoteRequest, RemoteReceipt, RemoteQuery, RemoteCancel } from '../protocol.ts'
import type { RemoteTransport } from '../router.ts'
import { loadRunner, samePeer, verifyPermit } from './config.ts'
import type { RunnerPeer } from './config.ts'
import { GrantInputSchema, describeRoot, SafeTextFiles, FileDenied } from './files.ts'
import type { LocalGrant } from './files.ts'
import { RunnerLedger } from './ledger.ts'
import { hash } from '../../state/hash.ts'
/** Executes only reviewed read capabilities with local grants, durable dedupe and a single device process owner. */
export class LinuxRunner {
  private queue: RemoteRequest[] = []
  private active?: { request: RemoteRequest; controller: AbortController }
  private pumping?: Promise<void>
  private closing = false
  private faulted = false
  private constructor(readonly home: string, private ledger: RunnerLedger) {}
  static async open(home: string) { const config = await loadRunner(home); return new LinuxRunner(home, await RunnerLedger.open(home, config)) }
  /** Only a trusted OS-local or authenticated C3 adapter supplies this binding. A public deviceId is not authentication. */
  transport(peer: RunnerPeer): RemoteTransport {
    const binding = structuredClone(peer)
    if (!samePeer(binding, this.ledger.config.binding)) throw Error('Runner peer denied')
    return { dispatch: (request, signal) => this.dispatch(binding, request, signal), query: (request, signal) => this.query(binding, request, signal), cancel: (request, signal) => this.cancel(binding, request, signal) }
  }
  async grant(raw: unknown, expectedRevision = 0): Promise<LocalGrant> {
    this.assert(); const input = GrantInputSchema.parse(raw)
    if (input.root !== resolve(input.root) || Date.parse(input.expiresAt) <= Date.now()) throw Error('Local grant path/expiry denied')
    const root = await describeRoot(input.root, this.home); this.assert()
    const grant: LocalGrant = { ...input, ...root, enabled: true, revision: expectedRevision + 1 }
    this.ledger.putGrant(grant, expectedRevision); this.abortGrant(grant.id); return grant
  }
  revoke(id: string, revision: number) {
    this.assert(); const grant = this.ledger.grant(id); if (!grant) throw Error('Local grant unavailable')
    this.ledger.putGrant({ ...grant, revision: revision + 1, enabled: false }, revision); this.abortGrant(id)
    return { id, revision: revision + 1, enabled: false }
  }
  grants() { this.assert(); return this.ledger.grants().map(({ root: _root, device: _dev, inode: _ino, ...grant }) => grant) }
  private abortGrant(id: string) { if (this.active?.request.resourceGrantId === id) this.active.controller.abort() }
  private assert() { if (this.closing || this.faulted) throw Error('Runner is closing or requires receipt reconciliation') }
  private allowed(peer: RunnerPeer, request: RemoteRequest, execute: boolean) {
    this.assert()
    if (!samePeer(peer, this.ledger.config.binding) || !samePeer(request, peer)) throw Error('Runner peer denied')
    const grant = this.ledger.grant(request.resourceGrantId)
    if (!grant?.enabled || grant.revision !== request.grantRevision || grant.workspaceId !== request.workspaceId || !grant.capabilities.includes(request.toolId)
      || Date.parse(grant.expiresAt) <= Date.now()) throw new FileDenied('denied')
    if (execute) {
      try { this.ledger.current(request) } catch { throw new FileDenied('denied') }
      const remaining = Date.parse(request.expiresAt) - Date.now()
      if (remaining <= 0 || remaining > 60_000) throw new FileDenied('denied')
    }
    return grant
  }
  private async dispatch(peer: RunnerPeer, raw: RemoteRequest, signal: AbortSignal): Promise<RemoteReceipt> {
    signal.throwIfAborted(); this.assert(); this.ledger.prune()
    const request = checkedRequest(structuredClone(raw)); verifyPermit(this.ledger.config, request); this.allowed(peer, request, true)
    const old = this.ledger.get(request.requestId, intentHash(request)); if (old) return structuredClone(old.receipt)
    if (this.queue.length >= 32) throw Error('Runner queue is full before acceptance')
    const receipt = this.ledger.accept(request); this.queue.push(request); this.start()
    return structuredClone(receipt)
  }
  private entry(peer: RunnerPeer, raw: RemoteQuery) {
    this.assert(); this.ledger.prune(); const query = QuerySchema.parse(raw), entry = this.ledger.get(query.requestId, query.intentHash)
    if (!entry || !samePeer(peer, this.ledger.config.binding) || !samePeer(entry.request, peer)) throw Error('Execution receipt unavailable')
    return entry
  }
  private async query(peer: RunnerPeer, raw: RemoteQuery, signal: AbortSignal) {
    signal.throwIfAborted(); const entry = this.entry(peer, raw); this.allowed(peer, entry.request, false); return structuredClone(entry.receipt)
  }
  private async cancel(peer: RunnerPeer, raw: RemoteCancel, signal: AbortSignal) {
    signal.throwIfAborted(); const value = CancelSchema.parse(raw), { reason: _reason, ...query } = value, entry = this.entry(peer, query)
    if (!terminal(entry.receipt)) {
      if (this.active?.request.requestId === entry.request.requestId) this.active.controller.abort()
      else {
        this.queue = this.queue.filter(value => value.requestId !== entry.request.requestId)
        this.ledger.finish(entry.request, 'cancelled', undefined, 'cancelled')
      }
    }
    const current = this.ledger.get(entry.request.requestId, intentHash(entry.request))!
    // A revoked grant cannot be used as a backdoor to retrieve an old successful payload.
    if (current.receipt.result) this.allowed(peer, entry.request, false)
    return structuredClone(current.receipt)
  }
  private start() {
    if (this.pumping) return
    this.pumping = this.pump().catch(() => { this.faulted = true; this.active?.controller.abort() }).finally(() => { this.pumping = undefined })
  }
  private async pump() {
    await immediate()
    while (this.queue.length && !this.closing) {
      const request = this.queue.shift()!, controller = new AbortController(); this.active = { request, controller }
      try {
        const current = () => { controller.signal.throwIfAborted(); this.allowed(this.ledger.config.binding, request, true) }
        const grant = this.allowed(this.ledger.config.binding, request, true); this.ledger.running(request)
        const result = await new SafeTextFiles(grant, controller.signal, current).execute(request)
        current(); checkedReceipt({ protocolVersion: 1, requestId: request.requestId, intentHash: intentHash(request), sequence: 3, status: 'succeeded', result, resultHash: hash(result) }, request)
        this.ledger.finish(request, 'succeeded', result)
      } catch (error) {
        const cancelled = controller.signal.aborted || this.closing
        this.ledger.finish(request, cancelled ? 'cancelled' : 'failed', undefined, cancelled ? 'cancelled' : error instanceof FileDenied ? error.reason : 'internal')
      } finally { this.active = undefined }
    }
  }
  async idle() { await this.pumping; if (this.faulted) throw Error('Runner persistence fault requires restart/reconciliation') }
  async close() {
    if (this.closing) return this.pumping
    this.closing = true; this.active?.controller.abort(); await this.pumping
    try { for (const entry of this.ledger.active()) this.ledger.finish(entry.request, 'cancelled', undefined, 'cancelled') } finally { this.ledger.close() }
  }
}
