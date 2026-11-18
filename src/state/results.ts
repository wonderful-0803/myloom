import { KV } from '../kv.ts'
/** Fixed-version result attachments with current authorization and committed attempt receipts. */
import type { Ticket, Trigger, WorkerReport } from '../core/index.ts'
import type { DeliverySetting, ResultReceipt } from '../app/result-delivery.ts'
import type { MailBinding } from '../app/feishu-mail.ts'
import type { LoomDeliverySetting } from '../app/loom-types.ts'
import type { ProductAccess } from './access.ts'
import type { ArtifactManifest, DurableArtifacts } from './artifacts.ts'
import type { FeishuWire } from './feishu.ts'
import type { StateScope, StateStore, StateTransaction } from './ports.ts'
import type { JobContext, JobResult } from './consumer.ts'
import { control, requireAgent, settleHeld } from './controls.ts'
import { hash } from './hash.ts'
import { StateConflict } from './ports.ts'
import type { DeliveryIntent } from './outbox.ts'

interface ResultIntent extends ResultReceipt { target: { messageId?: string; userId?: string; threaded: boolean } }
export interface ResultOptions {
  store: StateStore; scope: StateScope; access: ProductAccess; artifacts: DurableArtifacts; wire: FeishuWire
  /** Trusted owner mailbox bridge. Must verify the exact saved binding again, with no arbitrary recipients. */
  mail?: { binding(actor: string): Promise<MailBinding>; send(intent: ResultReceipt, bytes: Buffer, signal: AbortSignal): Promise<string> }
}
/** Reuses existing delivery settings/receipt shapes while moving their authority and CAS to external state. */
export class DurableResults {
  constructor(private options: ResultOptions) {}
  private async effective(tx: StateTransaction, owner: string, ticketId?: string) {
    const config = await this.options.access.user(tx, owner)
    const global = (await tx.get<DeliverySetting>('kv', KV.results.setting(owner, 'default')))?.value ?? { owner, mode: 'feishu' as const, revision: 0 }
    const local = ticketId ? (await tx.get<DeliverySetting>('kv', KV.results.setting(owner, ticketId)))?.value ?? { owner, mode: 'default' as const, revision: 0 } : global
    const setting = config.group ? { owner, mode: 'feishu' as const, revision: 0 } : local
    const effective = setting.mode === 'default' ? global : setting
    return { setting, mode: effective.mode as 'feishu' | 'none' | 'mail', binding: effective.binding,
      authority: hash(config.group ? [config.group, ticketId ?? null] : [global, local]) }
  }
  async view(actor: string, ticketId?: string): Promise<{ setting: LoomDeliverySetting; receipts: ResultReceipt[] }> {
    return this.options.store.transaction(this.options.scope, tx => this.viewIn(tx, actor, ticketId))
  }
  async viewIn(tx: StateTransaction, actor: string, ticketId?: string): Promise<{ setting: LoomDeliverySetting; receipts: ResultReceipt[] }> {
      if (ticketId) await this.options.access.ticket(tx, actor, ticketId)
      const current = await this.effective(tx, actor, ticketId)
      const receipts = (await tx.scan<ResultReceipt>('kv', { relation: 'results.receipt', limit: 100 })).map(row => row.value).filter(value => value.owner === actor && (!ticketId || value.ticketId === ticketId))
      return { setting: { mode: current.setting.mode, effectiveMode: current.mode, revision: current.setting.revision, ...(current.binding ? { address: current.binding.address } : {}) }, receipts }
  }
  async save(actor: string, input: { mode: 'default' | 'feishu' | 'none' | 'mail'; revision: number; mailboxKey?: string }, ticketId?: string) {
    const binding = input.mode === 'mail' ? await this.options.mail?.binding(actor) : undefined
    if (input.mode === 'mail' && (!binding || binding.key !== input.mailboxKey)) throw new StateConflict('Verify the bound owner mailbox before authorizing delivery')
    await this.options.store.transaction(this.options.scope, async tx => {
      const config = await this.options.access.user(tx, actor)
      if (config.group || !ticketId && input.mode === 'default') throw new StateConflict('Shared mode delivers to its original group')
      if (ticketId) await this.options.access.ticket(tx, actor, ticketId)
      const current = await this.effective(tx, actor, ticketId)
      if (current.setting.revision !== input.revision) throw new StateConflict('Delivery preference changed')
      const id = KV.results.setting(actor, ticketId ?? 'default'), row = await tx.get('kv', id)
      await tx.put('kv', id, { owner: actor, mode: input.mode, revision: input.revision + 1, at: new Date(await tx.now()).toISOString(), ...(binding ? { binding } : {}) }, row?.revision ?? 0, { relation: 'results.setting' })
    })
    return (await this.view(actor, ticketId)).setting
  }
  reported = async (tx: StateTransaction, ticket: Ticket, report: WorkerReport): Promise<void> => {
    if (report.state !== 'ready' || ticket.ended?.outcome !== 'completed') return
    const actor = ticket.mandate.actor.id, version = (await tx.get<number>('artifact-head', ticket.id))?.value
    if (!version) throw new StateConflict('Final report has no immutable artifact')
    const manifest = (await tx.get<ArtifactManifest>('artifact-version', `${ticket.id}/${String(version).padStart(12, '0')}`))!.value
    if (manifest.requirement !== hash({ origin: ticket.origin, inputs: ticket.inputs })) throw new StateConflict('Artifact does not cover the current task requirements')
    await this.options.access.artifact(tx, actor, ticket.id, 'read', manifest)
    const current = await this.effective(tx, actor, ticket.id), fence = (await control(tx, ticket.id)).value
    const origin = (await tx.get<Trigger>('trigger', ticket.origin.triggerId))!.value
    let sameChat = true
    for (const source of manifest.sources) if ((await tx.get<Trigger>('trigger', source.triggerId))?.value.meta.chatId !== origin.meta.chatId) sameChat = false
    const target = sameChat ? { messageId: String(origin.meta.messageId), threaded: origin.meta.direct !== true } : { userId: actor, threaded: false }
    const id = hash({ ticketId: ticket.id, version, mode: current.mode, target: current.mode === 'mail' ? current.binding?.key : target })
    if (await tx.get('kv', KV.results.receipt(id))) return
    const at = new Date(await tx.now()).toISOString()
    const receipt: ResultIntent = { id, owner: actor, ticketId: ticket.id, version, hash: manifest.body.sha256, mode: current.mode,
      status: current.mode === 'none' ? 'local' : current.mode === 'mail' && (!this.options.mail || manifest.file || !current.binding) || current.mode === 'feishu' && !this.options.wire.file ? 'blocked' : 'queued',
      at, updatedAt: at, destination: current.mode === 'none' ? '仅保存在 Loom' : current.mode === 'mail' ? current.binding?.address ?? '尚未绑定邮箱' : sameChat ? '飞书原线程' : '本人私聊',
      taskUpdatedAt: ticket.updatedAt, controlRevision: fence.revision, authority: current.authority, target, ...(current.binding ? { binding: current.binding } : {}),
      ...(manifest.file ? { fileHash: manifest.file.sha256, filename: manifest.filename } : {}) }
    await tx.put('kv', KV.results.receipt(id), receipt, 0, { relation: 'results.receipt', active: receipt.status === 'queued' })
    if (receipt.status === 'queued') await tx.jobs.enqueue('product.result', id, { id })
  }
  async deliver(job: JobContext): Promise<JobResult> {
    const { store, scope, artifacts, access, wire } = this.options, id = KV.results.receipt(job.claim.key), operation = `result:${job.claim.key}`
    await job.assertCurrent()
    const prepared = await store.transaction(scope, async tx => {
      const row = await tx.get<ResultIntent>('kv', id)
      if (!row) throw new StateConflict('Unknown result intent')
      const value = row.value
      if (value.status === 'sending') {
        value.status = 'unknown'
        const fence = await control(tx, value.ticketId), op = fence.value.operations.find(value => value.id === operation)
        if (op) op.status = 'unknown'
        if (fence.value.mode === 'agent') { fence.value.mode = 'pausing'; fence.value.revision++; fence.value.drained = false; await tx.jobs.enqueue('control.stop', value.ticketId, { ticketId: value.ticketId, revision: fence.value.revision }) }
        await tx.put('control', value.ticketId, fence.value, fence.revision)
        await tx.put('kv', id, value, row.revision, { relation: 'results.receipt', active: true }); return undefined
      }
      if (value.status !== 'queued') return undefined
      const preceding = await tx.scan<DeliveryIntent>('outbox', { relation: value.ticketId, limit: 1000 })
      if (preceding.length === 1000) throw new StateConflict('Result delivery requires paginated outbox reconciliation')
      if (preceding.some(row => ['pending', 'sending', 'unknown'].includes(row.value.status))) return { wait: true as const }
      const ticket = await access.ticket(tx, value.owner, value.ticketId), effective = await this.effective(tx, value.owner, value.ticketId)
      const head = (await tx.get<number>('artifact-head', ticket.id))?.value
      if (ticket.updatedAt !== value.taskUpdatedAt || ticket.ended?.outcome !== 'completed' || head !== value.version || effective.authority !== value.authority) {
        await tx.put('kv', id, { ...value, status: 'cancelled', detail: '任务、版本或授权已变化。' }, row.revision, { relation: 'results.receipt' }); return undefined
      }
      const fence = await requireAgent(tx, ticket.id, value.controlRevision)
      if (fence.value.operations.length) return { wait: true as const }
      return { value }
    })
    if (!prepared) return { state: 'done' }
    if ('wait' in prepared) return { state: 'retry', delayMs: 1000 }
    const { value } = prepared, fixed = await artifacts.read(value.owner, value.ticketId, value.version, true)
    if (value.mode === 'mail' && (await this.options.mail!.binding(value.owner)).key !== value.binding?.key) return { state: 'hold', reason: 'Mailbox binding changed' }
    await job.assertCurrent()
    await store.transaction(scope, async tx => {
      await access.artifact(tx, value.owner, value.ticketId, 'read', fixed.manifest)
      const fence = await requireAgent(tx, value.ticketId, value.controlRevision), row = (await tx.get<ResultIntent>('kv', id))!, effective = await this.effective(tx, value.owner, value.ticketId)
      if (row.value.status !== 'queued' || fence.value.operations.length || effective.authority !== value.authority
        || (await tx.get<number>('artifact-head', value.ticketId))?.value !== value.version) throw new StateConflict('Result authorization changed before dispatch')
      fence.value.operations.push({ id: operation, status: 'running', at: await tx.now() }); fence.value.drained = false
      await tx.put('control', value.ticketId, fence.value, fence.revision)
      await tx.put('kv', id, { ...value, status: 'sending' }, row.revision, { relation: 'results.receipt', active: true })
    })
    let receipt: string | undefined
    try {
      receipt = value.mode === 'mail' ? await this.options.mail!.send(value, fixed.bytes, job.signal)
        : await wire.file!(value.target, fixed.manifest.filename ?? 'result.txt', fixed.bytes, job.claim.key.slice(0, 32), job.signal)
      if (!receipt?.trim()) throw new Error('Missing provider receipt')
    } catch { /* Submission may have happened. Persist unknown, never blindly resend. */ }
    await store.transaction(scope, async tx => {
      const row = (await tx.get<ResultIntent>('kv', id))!, fence = await control(tx, value.ticketId)
      if (receipt) fence.value.operations = fence.value.operations.filter(value => value.id !== operation)
      else {
        const op = fence.value.operations.find(value => value.id === operation); if (op) op.status = 'unknown'
        if (fence.value.mode === 'agent') { fence.value.mode = 'pausing'; fence.value.revision++; fence.value.drained = false; await tx.jobs.enqueue('control.stop', value.ticketId, { ticketId: value.ticketId, revision: fence.value.revision }) }
      }
      settleHeld(fence.value); await tx.put('control', value.ticketId, fence.value, fence.revision)
      await tx.put('kv', id, { ...row.value, status: receipt ? value.mode === 'mail' ? 'submitted' : 'sent' : 'unknown', ...(receipt ? { messageId: receipt } : {}), updatedAt: new Date(await tx.now()).toISOString() }, row.revision, { relation: 'results.receipt', active: !receipt })
    })
    return receipt ? { state: 'done' } : { state: 'hold', reason: 'Result delivery unknown; inspect provider before reconciliation' }
  }
}
