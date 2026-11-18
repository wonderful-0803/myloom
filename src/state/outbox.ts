/** External delivery is an intent + receipt, never a database transaction around network I/O. */
import { randomUUID } from 'node:crypto'
import type { OutboundMessage } from '../core/index.ts'
import { control, requireAgent, settleHeld } from './controls.ts'
import { hash } from './hash.ts'
import { StateConflict, validateScope } from './ports.ts'
import type { StateScope, StateStore, StateTransaction } from './ports.ts'

export interface DeliveryIntent {
  message: OutboundMessage
  parameterHash: string
  controlRevision: number
  status: 'pending' | 'sending' | 'sent' | 'unknown' | 'dropped'
  token?: string
  attemptUntil?: number
  receipt?: string
  /** Scope sequence; legacy intents without it require explicit migration before sending. */
  order?: number
}
/** A known unsent attempt waits for a predecessor or a still-running provider call. Safe to poll, never to resubmit. */
export class DeliveryPending extends StateConflict {}
export async function enqueueDelivery(tx: StateTransaction, message: OutboundMessage): Promise<DeliveryIntent> {
  message = structuredClone(message)
  if (!message.ticketId) throw new StateConflict('Persistent delivery requires an explicit authorized ticket')
  const digest = hash(message), existing = await tx.get<DeliveryIntent>('outbox', message.id)
  if (existing) {
    // The core deliberately keeps the first acknowledgement. Other callers must use a fresh immutable intent ID.
    if (message.kind !== 'acknowledgement' && existing.value.parameterHash !== digest) throw new StateConflict('Delivery ID reused with different parameters')
    return existing.value
  }
  const fence = await control(tx, message.ticketId)
  const job = await tx.jobs.enqueue('outbox.send', message.id, { id: message.id })
  const value: DeliveryIntent = { message, parameterHash: digest, controlRevision: fence.value.revision, status: 'pending', order: job.sequence }
  await tx.put('outbox', message.id, value, 0, { relation: message.ticketId, active: true })
  return value
}
async function finish(tx: StateTransaction, id: string, token: string, status: 'sent' | 'unknown', receipt?: string): Promise<void> {
  const row = await tx.get<DeliveryIntent>('outbox', id)
  if (!row || row.value.status !== 'sending' || row.value.token !== token) throw new StateConflict('Delivery attempt changed')
  row.value.status = status; row.value.receipt = receipt
  const ticketId = row.value.message.ticketId!, fence = await control(tx, ticketId)
  const operationId = `outbox:${id}:${token}`
  if (status === 'sent') fence.value.operations = fence.value.operations.filter(op => op.id !== operationId)
  else {
    const operation = fence.value.operations.find(op => op.id === operationId)
    if (operation) operation.status = 'unknown'
    if (fence.value.mode === 'agent') {
      fence.value.mode = 'pausing'; fence.value.revision++; fence.value.drained = false
      fence.value.history.push({ revision: fence.value.revision, action: 'delivery-unknown', actor: 'system', at: await tx.now() })
      await tx.jobs.enqueue('control.stop', ticketId, { ticketId, revision: fence.value.revision })
    }
  }
  settleHeld(fence.value)
  await tx.put('control', ticketId, fence.value, fence.revision)
  await tx.put('outbox', id, row.value, row.revision, { relation: ticketId, active: status === 'unknown' })
}
export interface DeliveryTransport {
  /** Must recheck the channel's current resource grant. No credentials or arbitrary destinations from model arguments. */
  authorize(tx: StateTransaction, intent: DeliveryIntent): Promise<void>
  /** Return the provider's stable receipt, or throw. A timeout may have sent the message. */
  send(message: OutboundMessage): Promise<string>
}
/** Sends a committed, currently authorized intent and retains ambiguous attempts for explicit reconciliation. */
export class DurableOutbox {
  constructor(private store: StateStore, private scope: StateScope, private transport: DeliveryTransport, private attemptMs = 30_000) {
    this.scope = validateScope(scope)
    if (!Number.isSafeInteger(attemptMs) || attemptMs < 1 || attemptMs > 86_400_000) throw new Error('Invalid delivery attempt duration')
  }
  async deliver(id: string): Promise<'sent' | 'unknown' | 'dropped'> {
    const prepared = await this.store.transaction(this.scope, async tx => {
      const row = await tx.get<DeliveryIntent>('outbox', id)
      if (!row) throw new StateConflict('Unknown delivery intent')
      if (hash(row.value.message) !== row.value.parameterHash) throw new StateConflict('Delivery intent integrity check failed')
      await this.transport.authorize(tx, structuredClone(row.value))
      if (row.value.status === 'sending') {
        if ((row.value.attemptUntil ?? 0) > await tx.now()) throw new DeliveryPending('Delivery is still in flight; wait for its receipt')
        // A previous process may have sent it. Never resubmit based only on losing the local callback.
        await finish(tx, id, row.value.token!, 'unknown')
        return { status: 'unknown' as const }
      }
      if (row.value.status !== 'pending') return { status: row.value.status }
      if (!Number.isSafeInteger(row.value.order)) throw new StateConflict('Delivery ordering metadata missing; repair before sending')
      const pending = await tx.scan<DeliveryIntent>('outbox', { active: true, limit: 1000 })
      if (pending.length >= 1000) throw new StateConflict('Pending delivery queue requires pagination before sending')
      if (pending.some(({ id: otherId, value }) => otherId !== id && ['pending', 'sending', 'unknown'].includes(value.status)
        && value.message.channel.source === row.value.message.channel.source && value.message.channel.thread === row.value.message.channel.thread
        && (value.order === undefined || value.order < row.value.order!))) throw new DeliveryPending('Earlier delivery in this conversation is unresolved')
      const ticketId = row.value.message.ticketId!, fence = await requireAgent(tx, ticketId, row.value.controlRevision)
      const token = randomUUID()
      row.value.status = 'sending'; row.value.token = token; row.value.attemptUntil = await tx.now() + this.attemptMs
      fence.value.operations.push({ id: `outbox:${id}:${token}`, status: 'running', at: await tx.now() }); fence.value.drained = false
      await tx.put('control', ticketId, fence.value, fence.revision)
      await tx.put('outbox', id, row.value, row.revision, { relation: ticketId, active: true })
      return { status: 'sending' as const, token, message: row.value.message }
    })
    if (prepared.status !== 'sending') return prepared.status
    let receipt: string
    try {
      receipt = await this.transport.send(prepared.message)
      if (typeof receipt !== 'string' || !receipt.trim()) throw new Error('Provider did not return a delivery receipt')
    }
    catch {
      await this.store.transaction(this.scope, tx => finish(tx, id, prepared.token, 'unknown'))
      return 'unknown'
    }
    // If COMMIT fails here, the persisted 'sending' state still blocks automatic resend on recovery.
    await this.store.transaction(this.scope, tx => finish(tx, id, prepared.token, 'sent', receipt))
    return 'sent'
  }
  async reconcile(id: string, actor: string, note: string, status: 'sent' | 'dropped', receipt?: string): Promise<void> {
    if (!actor.trim() || note.trim().length < 10) throw new Error('Delivery reconciliation needs an actor and concrete evidence')
    await this.store.transaction(this.scope, async tx => {
      const row = await tx.get<DeliveryIntent>('outbox', id)
      if (!row || row.value.status !== 'unknown') throw new StateConflict('Only unknown delivery can be reconciled')
      await this.transport.authorize(tx, row.value)
      const ticketId = row.value.message.ticketId!, fence = await control(tx, ticketId)
      fence.value.operations = fence.value.operations.filter(op => op.id !== `outbox:${id}:${row.value.token}`)
      fence.value.history.push({ revision: fence.value.revision, action: `reconcile-delivery:${id}`, actor, note, at: await tx.now() })
      settleHeld(fence.value)
      await tx.put('control', ticketId, fence.value, fence.revision)
      await tx.put('outbox', id, { ...row.value, status, receipt }, row.revision, { relation: ticketId })
      await tx.jobs.cancel('outbox.send', id)
    })
  }
}
