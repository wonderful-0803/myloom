import { KV } from '../kv.ts'
/** Explicit operator reconciliation. Records evidence and known outcomes; never resends or resumes a task. */
import { z } from 'zod'
import type { ProductAccess } from './access.ts'
import type { StateTransaction } from './ports.ts'
import { StateConflict } from './ports.ts'
import { control, reconcileExecution, settleHeld } from './controls.ts'
export const Reconciliation = z.object({ kind: z.enum(['result', 'assistant', 'execution', 'legacy-operation']), id: z.string().min(1).max(2048),
  revision: z.number().int().nonnegative(), evidence: z.string().min(20).max(4000), outcome: z.enum(['succeeded', 'failed']), receipt: z.string().min(1).max(200).optional() }).strict()
export async function reconcileOutcome(tx: StateTransaction, access: ProductAccess, actor: string, ticketId: string, input: z.infer<typeof Reconciliation>) {
  input = Reconciliation.parse(input); await access.user(tx, actor, true)
  const fence = await control(tx, ticketId)
  if (fence.value.mode === 'agent' || fence.value.revision !== input.revision) throw new StateConflict('Hold the task and use the current control revision before reconciliation')
  let operation: string
  if (input.kind === 'execution') {
    const entry = await tx.get<{ ticketId: string }>('execution', input.id)
    if (entry?.value.ticketId !== ticketId) throw new StateConflict('Execution does not belong to this task')
    await reconcileExecution(tx, input.id, actor, input.evidence, input.outcome); return
  } else if (input.kind === 'result') {
    const row = await tx.get<{ ticketId: string; status: string; mode: string }>('kv', KV.results.receipt(input.id))
    if (!row || row.value.ticketId !== ticketId || row.value.status !== 'unknown' || input.outcome === 'succeeded' && !input.receipt) throw new StateConflict('Unknown result and concrete success receipt required')
    operation = `result:${input.id}`
    await tx.put('kv', row.id, { ...row.value, status: input.outcome === 'succeeded' ? row.value.mode === 'mail' ? 'submitted' : 'sent' : 'cancelled', messageId: input.receipt, detail: input.evidence }, row.revision, { relation: 'results.receipt' })
    await tx.jobs.cancel('product.result', input.id)
  } else if (input.kind === 'assistant') {
    const row = await tx.get<{ status: string; file?: { subject: string }; request?: { ticketId?: string }; trigger?: unknown }>('source-state', `response/${input.id}`)
    if (!row || row.value.status !== 'unknown' || (row.value.file?.subject ?? row.value.request?.ticketId) !== ticketId || input.outcome === 'succeeded' && !input.receipt) throw new StateConflict('Unknown task response and concrete receipt required')
    operation = `assistant:${input.id}`
    await tx.put('source-state', row.id, { ...row.value, status: input.outcome === 'succeeded' ? 'sent' : 'cancelled', providerReceipt: input.receipt, evidence: input.evidence }, row.revision)
    await tx.jobs.cancel('product.assistant', input.id)
  } else {
    operation = input.id
    if (!operation.startsWith('legacy-op/') || !fence.value.operations.some(op => op.id === operation && op.status === 'unknown')) throw new StateConflict('Only quarantined legacy operations accept manual evidence')
  }
  fence.value.operations = fence.value.operations.filter(op => op.id !== operation)
  fence.value.history.push({ revision: fence.value.revision, action: `reconcile-${input.kind}:${input.id}`, actor, at: await tx.now(), note: input.evidence })
  settleHeld(fence.value); await tx.put('control', ticketId, fence.value, fence.revision)
  await tx.put('audit', `reconciliation/${input.kind}/${input.id}`, { actor, ticketId, ...input, at: new Date(await tx.now()).toISOString() }, 0)
}
