/** Boundary between DSH compute and an execution environment. No network transport or device authority is implied. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ActorRef, ExecutionTarget, Ticket } from '../core/index.ts'

export interface ExecutionBinding {
  ticketId: string
  assignmentId: string
  sessionId: string
  actor: ActorRef
  spaceId?: string
  target: ExecutionTarget
  /** A local path today. A future Runner must resolve workspaceId through its own resource grants. */
  directory: string
  controlRevision: number
}
type Job = { id: string; name: string }
/** Typed intents, separate from the local implementation closures. These are not yet a wire protocol. */
export interface ExecutionOperations {
  prepare: { input: { command: string; variables: Record<string, string> }; output: void }
  tool: { input: { name: string; arguments: unknown }; output: ToolExecutionResult }
  stop: { input: { reason: string; keepInbox: boolean }; output: void }
  'confirm-stopped': { input: Record<string, never>; output: void }
  'jobs-list': { input: { except: string[] }; output: Job[] }
  'job-collect': { input: { job: Job }; output: { name: string; status: string } | undefined }
  'jobs-kill': { input: { reason: string; except: string[] }; output: void }
  /** Includes DSH subagent quiescence in the current local adapter. A remote adapter must also coordinate compute children. */
  settle: { input: { except: string[] }; output: boolean }
}
export type ExecutionOperation = keyof ExecutionOperations
export interface ExecutionRequest<K extends ExecutionOperation = ExecutionOperation> {
  version: 1
  requestId: string
  binding: ExecutionBinding
  operation: K
  input: ExecutionOperations[K]['input']
}
export interface ExecutionOptions {
  signal: AbortSignal
  /** Recheck live task/control/target immediately before dispatch. Cleanup may run after the task is held or ended. */
  authorize(): void
}
/**
 * The local callback is an implementation detail: a future routing port must NEVER pass it to a remote backend or use it
 * when a Runner is unavailable. Preserve native DSH result envelopes and wait for the actual operation to settle on abort.
 */
export interface ExecutionPort {
  run<K extends ExecutionOperation>(request: ExecutionRequest<K>, options: ExecutionOptions,
    local: (signal: AbortSignal) => Promise<ExecutionOperations[K]['output']>): Promise<ExecutionOperations[K]['output']>
}
/** The target or execution adapter cannot be used; no fallback side effect is allowed. */
export class ExecutionUnavailable extends Error {}
/** A transport lost a result after possible execution. TaskControls must retain an unknown operation for reconciliation. */
export class ExecutionOutcomeUnknown extends Error {}

/** Validate persisted data too: unknown/malformed targets must not silently become local. */
export function executionTarget(ticket: Ticket): ExecutionTarget {
  const target: unknown = ticket.execution?.target
  if (target === undefined) return { kind: 'local' }
  if (target && typeof target === 'object' && 'kind' in target) {
    if (target.kind === 'local' && Object.keys(target).length === 1) return { kind: 'local' }
    if (target.kind === 'runner' && 'environmentId' in target && 'workspaceId' in target
      && typeof target.environmentId === 'string' && target.environmentId.trim()
      && typeof target.workspaceId === 'string' && target.workspaceId.trim())
      return { kind: 'runner', environmentId: target.environmentId, workspaceId: target.workspaceId }
  }
  throw new ExecutionUnavailable('Invalid execution target; local fallback is forbidden')
}
/** Build identity from a stored ticket, never from the model's tool arguments. Subagents retain their actual session ID. */
export function executionRequest<K extends ExecutionOperation>(ticket: Ticket, sessionId: string, controlRevision: number,
  operation: K, input: ExecutionOperations[K]['input'], requestId: string = randomUUID()): ExecutionRequest<K> {
  const space = ticket.mandate.basis.scope?.loomSpace
  return { version: 1, requestId, operation, input, binding: {
    ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)?.id ?? '', sessionId,
    actor: { ...ticket.mandate.actor }, spaceId: typeof space === 'string' ? space : undefined,
    target: executionTarget(ticket), directory: ticket.execution?.directory ?? '', controlRevision,
  } }
}
/** Reject a target/assignment/owner change between preparing a request and dispatching it. */
export function assertExecutionBinding(ticket: Ticket | undefined, binding: ExecutionBinding): void {
  if (!ticket) throw new ExecutionUnavailable('Execution task no longer exists')
  const current = executionRequest(ticket, binding.sessionId, binding.controlRevision, 'confirm-stopped', {}).binding
  if (JSON.stringify(current) !== JSON.stringify(binding)) throw new ExecutionUnavailable('Execution binding changed; dispatch refused')
}
/** The shipped adapter: existing native implementations, with an explicit refusal for every non-local target. */
export class LocalExecutionPort implements ExecutionPort {
  async run<K extends ExecutionOperation>(request: ExecutionRequest<K>, options: ExecutionOptions,
    local: (signal: AbortSignal) => Promise<ExecutionOperations[K]['output']>): Promise<ExecutionOperations[K]['output']> {
    options.signal.throwIfAborted()
    options.authorize()
    if (request.version !== 1 || request.binding.target.kind !== 'local')
      throw new ExecutionUnavailable('Runner execution is not configured; local fallback is forbidden')
    if ((request.operation === 'prepare' || request.operation === 'tool') && !isAbsolute(request.binding.directory))
      throw new ExecutionUnavailable('Local execution requires an absolute workspace directory')
    // No abort race: control transfers only after the callback settles and quiescence is confirmed.
    return local(options.signal)
  }
}
