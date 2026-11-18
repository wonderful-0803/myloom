/** Opt-in C1 boundary. A/B admission and network transport are injected by the trusted host, never by a model. */
import { setTimeout as delay } from 'node:timers/promises'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ExecutionPort, ExecutionRequest, ExecutionOptions, ExecutionOperations, ExecutionOperation } from './port.ts'
import { ExecutionUnavailable, ExecutionOutcomeUnknown, LocalExecutionPort } from './port.ts'
import { capability, checkedRequest, ReceiptCursor, intentHash, terminal } from './protocol.ts'
import type { Capability, RemoteRequest, RemoteQuery, RemoteCancel } from './protocol.ts'
import { hash } from '../state/hash.ts'
/** An environment is unavailable before acceptance; the caller may persist an environment wait. */
export class RunnerOffline extends ExecutionUnavailable {}
export interface RemoteTransport {
  dispatch(request: RemoteRequest, signal: AbortSignal): Promise<unknown>
  query(request: RemoteQuery, signal: AbortSignal): Promise<unknown>
  cancel(request: RemoteCancel, signal: AbortSignal): Promise<unknown>
}
export interface RemoteAuthority {
  /** Must persist admission, register in-flight work and validate current A/B authority in C3. */
  prepare(request: ExecutionRequest<'tool'>, tool: Capability): Promise<RemoteRequest>
  /** Recheck the current lease/control/resource grant. No model-supplied authority. */
  check(request: RemoteRequest): Promise<void>
}
/** Keeps local execution unchanged and sends only admitted read capabilities through an explicit remote backend. */
export class ExecutionRouter implements ExecutionPort {
  private local = new LocalExecutionPort()
  constructor(private authority: RemoteAuthority, private transport: RemoteTransport, private options: { pollMs?: number; responseMs?: number } = {}) {}
  async run<K extends ExecutionOperation>(raw: ExecutionRequest<K>, options: ExecutionOptions, local: (signal: AbortSignal) => Promise<ExecutionOperations[K]['output']>): Promise<ExecutionOperations[K]['output']> {
    if (raw.binding.target.kind === 'local') return this.local.run(raw, options, local)
    options.signal.throwIfAborted(); options.authorize()
    if (raw.version !== 1 || raw.binding.target.kind !== 'runner' || raw.operation !== 'tool') throw new ExecutionUnavailable('Remote lifecycle/compute coordination is not installed; local fallback is forbidden')
    const request = structuredClone(raw) as ExecutionRequest<'tool'>, tool = capability(request.input.name)
    tool.input.parse(request.input.arguments)
    const remote = checkedRequest(await this.authority.prepare(request, tool)), binding = request.binding, target = binding.target
    if (target.kind !== 'runner' || !binding.spaceId || remote.spaceId !== binding.spaceId || remote.requestId !== request.requestId || remote.ticketId !== binding.ticketId
      || remote.assignmentId !== binding.assignmentId || remote.sessionId !== binding.sessionId || remote.userId !== binding.actor.id || remote.environmentId !== target.environmentId
      || remote.workspaceId !== target.workspaceId || remote.controlRevision !== binding.controlRevision || remote.toolId !== tool.id
      || remote.argsHash !== hash(request.input.arguments) || binding.sessionEpoch !== undefined && remote.sessionEpoch !== binding.sessionEpoch)
      throw new ExecutionUnavailable('Trusted remote admission changed the execution binding')
    await this.authority.check(remote); options.signal.throwIfAborted(); options.authorize()
    if (Date.parse(remote.expiresAt) <= Date.now()) throw new ExecutionUnavailable('Remote execution permit expired')
    const query: RemoteQuery = { protocolVersion: 1, requestId: remote.requestId, intentHash: intentHash(remote) }, cursor = new ReceiptCursor(remote)
    const timeout = this.options.responseMs ?? 10000, poll = this.options.pollMs ?? 100
    const bounded = async (action: (signal: AbortSignal) => Promise<unknown>) => {
      const signal = AbortSignal.timeout(timeout)
      return Promise.race([action(signal), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ExecutionOutcomeUnknown('Remote receipt timed out; actual execution requires reconciliation')), { once: true }))])
    }
    let receipt
    try { receipt = cursor.accept(await bounded(signal => this.transport.dispatch(remote, signal))) }
    catch (error) { if (error instanceof RunnerOffline) throw error; throw new ExecutionOutcomeUnknown('Remote dispatch outcome cannot be confirmed; local fallback is forbidden') }
    let cancelling = false
    const end = Math.min(Date.parse(remote.expiresAt), Date.now() + timeout)
    while (!terminal(receipt)) {
      let revoked = false
      if (!cancelling) { try { options.authorize(); await this.authority.check(remote) } catch { revoked = true } }
      if ((options.signal.aborted || revoked) && !cancelling) {
        cancelling = true
        try { receipt = cursor.accept(await bounded(signal => this.transport.cancel({ ...query, reason: revoked ? 'revoke' : 'pause' }, signal))) }
        catch { throw new ExecutionOutcomeUnknown('Remote cancellation is not confirmed') }
        if (terminal(receipt)) break
      }
      if (Date.now() >= end) throw new ExecutionOutcomeUnknown('Remote operation remains in flight; cancellation is not a stop receipt')
      await delay(poll)
      try { receipt = cursor.accept(await bounded(signal => this.transport.query(query, signal))) }
      catch { throw new ExecutionOutcomeUnknown('Remote result is unavailable; execution must be reconciled') }
    }
    if (receipt.status === 'unknown') throw new ExecutionOutcomeUnknown('Runner reported an unknown execution outcome')
    // Even a valid old result cannot advance a paused or reassigned Agent.
    options.signal.throwIfAborted(); options.authorize(); await this.authority.check(remote)
    const result: ToolExecutionResult = receipt.status === 'succeeded'
      ? { isError: false, value: receipt.result!, content: [{ type: 'text', text: JSON.stringify(receipt.result) }] }
      : { isError: true, error: { message: `Remote operation ${receipt.status}: ${receipt.error ?? 'no result'}` }, content: [{ type: 'text', text: `Remote operation ${receipt.status}` }] }
    return result as ExecutionOperations[K]['output']
  }
}
