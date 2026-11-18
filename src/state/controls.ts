/** Persistent control fence shared by Loom commands, Session writers and future device dispatch. */
import type { Ticket } from '../core/index.ts'
import { hash } from './hash.ts'
import { StateConflict } from './ports.ts'
import type { SessionLease, StateRecord, StateTransaction } from './ports.ts'

export interface DurableControl {
  mode: 'agent' | 'pausing' | 'paused' | 'taking_over' | 'human'
  revision: number
  drained: boolean
  operations: { id: string; status: 'running' | 'unknown'; at: number }[]
  history: { revision: number; action: string; actor: string; at: number; note?: string }[]
}
export interface ExecutionIntent {
  requestId: string; ticketId: string; assignmentId: string; userId: string
  lease: SessionLease; controlRevision: number; grantId: string; grantRevision: number; parameters: unknown
}
/** A server-issued authorization binding. Device-local resource grants must ALSO be verified by the Runner. */
export interface ExecutionGrant { enabled: boolean; ticketId: string; assignmentId: string; sessionId: string; userId: string }
export interface ExecutionEntry extends ExecutionIntent {
  parameterHash: string; status: 'registered' | 'succeeded' | 'failed' | 'unknown'; result?: unknown
}
export interface ExecutionRegistration { created: boolean; entry: ExecutionEntry }
export async function ensureControl(tx: StateTransaction, ticketId: string): Promise<void> {
  if (!await tx.get('control', ticketId)) await tx.put<DurableControl>('control', ticketId,
    { mode: 'agent', revision: 0, drained: true, operations: [], history: [] }, 0)
}
export async function control(tx: StateTransaction, ticketId: string): Promise<StateRecord<DurableControl>> {
  const row = await tx.get<DurableControl>('control', ticketId)
  if (!row) throw new StateConflict('Task control is missing; dispatch refused')
  return row
}
export async function requireAgent(tx: StateTransaction, ticketId: string, revision: number): Promise<StateRecord<DurableControl>> {
  const settings = await tx.get<{ settings?: { paused?: boolean } }>('settings', 'current')
  if (settings?.value.settings?.paused) throw new StateConflict('Runtime is paused')
  const row = await control(tx, ticketId)
  if (row.value.mode !== 'agent' || row.value.revision !== revision) throw new StateConflict('Task is held or control revision changed')
  return row
}
export async function changeControl(tx: StateTransaction, ticketId: string, expectedRevision: number,
  action: 'pause' | 'takeover' | 'resume' | 'return', actor: string): Promise<DurableControl> {
  if (!['pause', 'takeover', 'resume', 'return'].includes(action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('Explicit control action and revision are required')
  if (!actor.trim()) throw new Error('Control actor is required')
  const row = await control(tx, ticketId), value = row.value
  if (value.revision !== expectedRevision) throw new StateConflict('Control revision changed')
  if (action === 'resume' || action === 'return') {
    if (value.mode !== (action === 'resume' ? 'paused' : 'human') || !value.drained || value.operations.length)
      throw new StateConflict('Cannot resume until execution is confirmed stopped and every unknown outcome is resolved')
    value.mode = 'agent'
  } else {
    if (value.mode !== 'agent') throw new StateConflict('Task is already held')
    value.mode = action === 'pause' ? 'pausing' : 'taking_over'; value.drained = false
    await tx.jobs.enqueue('control.stop', ticketId, { ticketId, revision: value.revision + 1 })
  }
  value.revision++
  value.history.push({ revision: value.revision, action, actor, at: await tx.now() })
  await tx.put('control', ticketId, value, row.revision)
  return value
}
/** Only a verified executor stop/drain receipt may call this. An AbortSignal is not such a receipt. */
export async function confirmDrained(tx: StateTransaction, ticketId: string, expectedRevision: number): Promise<DurableControl> {
  const row = await control(tx, ticketId), value = row.value
  if (value.revision !== expectedRevision || !['pausing', 'taking_over'].includes(value.mode)) throw new StateConflict('Stale stop confirmation')
  value.drained = true
  settleHeld(value)
  await tx.put('control', ticketId, value, row.revision)
  return value
}
export function settleHeld(value: DurableControl): void {
  if (!value.drained || value.operations.length) return
  if (value.mode === 'pausing') value.mode = 'paused'
  if (value.mode === 'taking_over') value.mode = 'human'
}
export async function registerExecution(tx: StateTransaction, intent: ExecutionIntent): Promise<ExecutionRegistration> {
  intent = structuredClone(intent)
  const digest = hash({ ...intent, lease: { sessionId: intent.lease.sessionId, owner: intent.lease.owner, epoch: intent.lease.epoch } })
  const existing = await tx.get<ExecutionEntry>('execution', intent.requestId)
  if (existing) {
    if (existing.value.parameterHash !== digest) throw new StateConflict('requestId was reused with different execution parameters')
    // Returning a receipt is not a new authorization to execute it.
    return { created: false, entry: existing.value }
  }
  if (!Number.isSafeInteger(intent.grantRevision) || intent.grantRevision < 1) throw new StateConflict('Execution grant revision is required')
  const ticket = (await tx.get<Ticket>('ticket', intent.ticketId))?.value
  if (!ticket || ticket.ended || ticket.assignments.at(-1)?.id !== intent.assignmentId
    || ticket.mandate.actor.id !== intent.userId) throw new StateConflict('Task, assignment or execution actor changed')
  const grant = await tx.get<ExecutionGrant>('grant', intent.grantId)
  if (!grant || grant.revision !== intent.grantRevision || !grant.value.enabled || grant.value.ticketId !== intent.ticketId
    || grant.value.assignmentId !== intent.assignmentId || grant.value.sessionId !== intent.lease.sessionId || grant.value.userId !== intent.userId)
    throw new StateConflict('Execution grant was revoked or changed')
  await tx.leases.assert(intent.lease)
  const row = await requireAgent(tx, intent.ticketId, intent.controlRevision)
  const entry: ExecutionEntry = { ...intent, parameterHash: digest, status: 'registered' }
  await tx.put('execution', intent.requestId, entry, 0, { relation: intent.ticketId, active: true })
  row.value.operations.push({ id: intent.requestId, status: 'running', at: await tx.now() }); row.value.drained = false
  await tx.put('control', intent.ticketId, row.value, row.revision)
  return { created: true, entry }
}
export async function finishExecution(tx: StateTransaction, requestId: string, status: 'succeeded' | 'failed' | 'unknown', result: unknown): Promise<void> {
  result = result === undefined ? null : result
  const entry = await tx.get<ExecutionEntry>('execution', requestId)
  if (!entry) throw new StateConflict('Unknown execution request')
  if (entry.value.status !== 'registered') {
    if (entry.value.status === status && hash(entry.value.result ?? null) === hash(result)) return
    throw new StateConflict('Execution already has an outcome; reconcile explicitly')
  }
  const row = await control(tx, entry.value.ticketId)
  if (status === 'unknown') {
    const operation = row.value.operations.find(item => item.id === requestId)
    if (!operation) throw new StateConflict('Execution operation is missing')
    operation.status = 'unknown'
    if (row.value.mode === 'agent') {
      row.value.mode = 'pausing'; row.value.revision++; row.value.drained = false
      row.value.history.push({ revision: row.value.revision, action: 'unknown-outcome', actor: 'system', at: await tx.now() })
      await tx.jobs.enqueue('control.stop', entry.value.ticketId, { ticketId: entry.value.ticketId, revision: row.value.revision })
    }
  } else row.value.operations = row.value.operations.filter(item => item.id !== requestId)
  settleHeld(row.value)
  await tx.put('control', entry.value.ticketId, row.value, row.revision)
  await tx.put('execution', requestId, { ...entry.value, status, result }, entry.revision, { relation: entry.value.ticketId, active: status === 'unknown' })
}
export async function reconcileExecution(tx: StateTransaction, requestId: string, actor: string, note: string, outcome: 'succeeded' | 'failed'): Promise<void> {
  if (!actor.trim() || note.trim().length < 10) throw new Error('Actor and a concrete reconciliation note are required')
  const entry = await tx.get<ExecutionEntry>('execution', requestId)
  if (!entry || entry.value.status !== 'unknown') throw new StateConflict('Only unknown execution outcomes can be reconciled')
  const row = await control(tx, entry.value.ticketId)
  row.value.operations = row.value.operations.filter(item => item.id !== requestId)
  row.value.history.push({ revision: row.value.revision, action: `reconcile:${requestId}`, actor, note, at: await tx.now() })
  settleHeld(row.value)
  await tx.put('control', entry.value.ticketId, row.value, row.revision)
  await tx.put('execution', requestId, { ...entry.value, status: outcome, result: { reconciliation: note } }, entry.revision, { relation: entry.value.ticketId })
}
