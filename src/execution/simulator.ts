/** In-memory C1 simulator only. No device registration, network listener, filesystem or production receipt ledger. */
import { ExecutionUnavailable } from './port.ts'
import { RunnerOffline } from './router.ts'
import type { RemoteTransport } from './router.ts'
import { checkedRequest, checkedReceipt, CancelSchema, QuerySchema, intentHash, terminal } from './protocol.ts'
import type { RemoteRequest, RemoteReceipt, RemoteQuery, RemoteCancel } from './protocol.ts'
import { hash } from '../state/hash.ts'
interface Entry { request: RemoteRequest; receipt: RemoteReceipt; controller: AbortController; done: Promise<void> }
/** Simulates accepted/running/terminal receipts and cancellation without claiming production persistence. */
export class RunnerSimulator implements RemoteTransport {
  online = true
  private entries = new Map<string, Entry>()
  constructor(private verify: (request: RemoteRequest) => void, private execute: (request: RemoteRequest, signal: AbortSignal) => Promise<NonNullable<RemoteReceipt['result']>>) {}
  async dispatch(raw: RemoteRequest, signal: AbortSignal): Promise<RemoteReceipt> {
    if (!this.online) throw new RunnerOffline('Runner is offline; environment wait is required')
    signal.throwIfAborted()
    const request = checkedRequest(raw); this.verify(request)
    if (Date.parse(request.expiresAt) <= Date.now()) throw new ExecutionUnavailable('Runner permit expired')
    const old = this.entries.get(request.requestId)
    if (old) { if (intentHash(old.request) !== intentHash(request)) throw new ExecutionUnavailable('Same requestId changed intent'); return structuredClone(old.receipt) }
    const entry: Entry = { request, receipt: { protocolVersion: 1, requestId: request.requestId, intentHash: intentHash(request), sequence: 1, status: 'accepted' }, controller: new AbortController(), done: Promise.resolve() }
    this.entries.set(request.requestId, entry)
    entry.done = Promise.resolve().then(async () => {
      entry.receipt = { ...entry.receipt, sequence: 2, status: 'running' }
      try {
        const result = await this.execute(request, entry.controller.signal)
        entry.receipt = checkedReceipt({ ...entry.receipt, sequence: 3, status: 'succeeded', result, resultHash: hash(result) }, request)
      } catch { entry.receipt = { ...entry.receipt, sequence: 3, status: entry.controller.signal.aborted ? 'cancelled' : 'failed', error: entry.controller.signal.aborted ? 'cancelled' : 'internal' } }
    })
    return structuredClone(entry.receipt)
  }
  private get(raw: RemoteQuery): Entry {
    if (!this.online) throw new RunnerOffline('Runner is offline')
    const query = QuerySchema.parse(raw), entry = this.entries.get(query.requestId)
    if (!entry || intentHash(entry.request) !== query.intentHash) throw new ExecutionUnavailable('Execution receipt is not available for this intent')
    return entry
  }
  async query(raw: RemoteQuery, signal: AbortSignal) { signal.throwIfAborted(); return structuredClone(this.get(raw).receipt) }
  async cancel(raw: RemoteCancel, signal: AbortSignal) {
    signal.throwIfAborted(); const value = CancelSchema.parse(raw), { reason: _reason, ...query } = value, entry = this.get(query)
    if (!terminal(entry.receipt)) entry.controller.abort()
    return structuredClone(entry.receipt) // Abort alone never fabricates a terminal receipt.
  }
  async idle() { await Promise.all([...this.entries.values()].map(entry => entry.done)) }
}
