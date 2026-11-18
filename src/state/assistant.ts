/** Explicit Feishu query/control commands. Read operations never fall through to model/task creation. */
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import type { Thread, Trigger } from '../core/index.ts'
import type { ProductOptions, StateProduct } from './product.ts'
import type { FeishuWire } from './feishu.ts'
import type { SessionLease, StateTransaction } from './ports.ts'
import type { JobContext, JobResult } from './consumer.ts'
import type { ArtifactManifest } from './artifacts.ts'
import { control, settleHeld } from './controls.ts'
import { hash } from './hash.ts'
import { AccessDenied } from './access.ts'
import { StateConflict } from './ports.ts'

interface Response {
  trigger: Trigger; request: { action: string; ticketId?: string; revision?: number }
  text?: string; file?: { subject: string; version: number }; status: 'preparing' | 'queued' | 'sending' | 'sent' | 'unknown'
  providerReceipt?: string; fingerprint: string; relation?: string
}
export interface AssistantOptions extends Omit<ProductOptions, 'runtime' | 'results'> {
  product(): StateProduct; wire: FeishuWire; botName: string
}
/** Persists command parameters before execution and response attempts before sending, with source and actor revalidation. */
export class DurableAssistant {
  constructor(private options: AssistantOptions) {}
  /** Trusted connector response; the transaction commits the message and queued delivery together. */
  async queue(tx: StateTransaction, trigger: Trigger, text: string, key: string, relation?: string) {
    await this.options.access.source(tx, trigger.actor.id, trigger)
    const id = `response/${key}`
    if (await tx.get('source-state', id)) return
    await tx.put<Response>('source-state', id, { trigger, request: { action: 'connector' }, text, status: 'queued', fingerprint: hash(trigger), ...(relation ? { relation } : {}) }, 0, { relation })
    await tx.jobs.enqueue('product.assistant', key, { id })
  }
  async receive(trigger: Trigger, lease: SessionLease): Promise<boolean> {
    try { return await this.receiveCommand(trigger, lease) }
    catch (error) {
      if (!(error instanceof AccessDenied || error instanceof StateConflict)) throw error
      await this.options.store.transaction(this.options.scope, async tx => {
        await tx.leases.assert(lease)
        await this.queue(tx, trigger, '当前任务、版本或授权不可用。请重新查看任务列表／状态后再操作；本次未扩大授权。', `command-error/${trigger.id}`)
      })
      this.options.product().options.runtime.consumer.kick(); return true
    }
  }
  private async receiveCommand(trigger: Trigger, lease: SessionLease): Promise<boolean> {
    const text = trigger.text.replaceAll(`@${this.options.botName}`, '').replace(/@_user_\d+/g, '').trim()
    const match = /^(?:\/助手\s*)?(我的任务|任务|产物|导出|状态|暂停|接管|继续|交还)(?:\s+([a-zA-Z0-9_-]+))?(?:\s+(\d+))?$/.exec(text)
    if (!match || trigger.meta.direct !== true && trigger.addressed !== 'mention' && !text.startsWith('/助手')) return false
    const { store, scope, access } = this.options, id = `response/${trigger.id}`
    let response = await store.transaction(scope, async tx => {
      await tx.leases.assert(lease); await access.source(tx, trigger.actor.id, trigger)
      const prior = await tx.get<Response>('source-state', id)
      if (prior) { if (prior.value.fingerprint !== hash(trigger)) throw new StateConflict('Command event changed'); return prior.value }
      let ticketId = match[2]
      if (!ticketId && !['我的任务', '任务'].includes(match[1]!)) {
        const thread = (await tx.get<Thread>('thread', threadKey(trigger.threads[0]!)))?.value
        if (thread?.subscriptions.length === 1) ticketId = thread.subscriptions[0]
        if (!ticketId && trigger.meta.direct === true) {
          const focus = (await tx.get<{ ticketId: string; until: number }>('source-state', `focus/${trigger.actor.id}/${trigger.meta.chatId}`))?.value
          if (focus && focus.until > await tx.now()) ticketId = focus.ticketId
        }
      }
      const value: Response = { trigger, request: { action: match[1]!, ...(ticketId ? { ticketId } : {}), ...(match[3] ? { revision: Number(match[3]) } : {}) }, status: 'preparing', fingerprint: hash(trigger) }
      if (ticketId) {
        await access.ticket(tx, trigger.actor.id, ticketId)
        if (['暂停', '接管'].includes(value.request.action)) value.request.revision = (await control(tx, ticketId)).value.revision
        if (trigger.meta.direct === true) {
          const key = `focus/${trigger.actor.id}/${trigger.meta.chatId}`, row = await tx.get('source-state', key)
          await tx.put('source-state', key, { ticketId, until: await tx.now() + 600_000 }, row?.revision ?? 0)
        }
      }
      await tx.put('source-state', id, value, 0)
      return value
    })
    if (response.status !== 'preparing') return true
    const actor = trigger.actor.id, request = response.request, product = this.options.product()
    if (['我的任务', '任务'].includes(request.action)) {
      const config = await store.transaction(scope, tx => access.user(tx, actor))
      response.text = !config.group && trigger.meta.direct !== true ? '请在机器人私聊中查看个人任务。' : (await product.snapshot(actor)).tasks.slice(0, 20).map(task => `${task.id} · ${task.title} · ${task.control.mode === 'agent' ? task.executionState ?? task.status : task.control.mode}`).join('\n') || '暂无任务。'
    } else if (!request.ticketId) response.text = '未能唯一确定任务，请附上任务 ID，或在任务原线程中操作。'
    else {
      const taskId = request.ticketId
      if (['产物', '导出'].includes(request.action)) {
        const value = await this.options.artifacts.read(actor, taskId)
        await store.transaction(scope, async tx => {
          if (trigger.meta.direct !== true) for (const source of value.manifest.sources) {
            if ((await tx.get<Trigger>('trigger', source.triggerId))?.value.meta.chatId !== trigger.meta.chatId) throw new AccessDenied('Use a private chat for cross-conversation artifacts')
          }
        })
        if (request.action === '导出') response.file = { subject: taskId, version: value.manifest.version }
        else response.text = `${value.manifest.title} · v${value.manifest.version}\n\n${value.bytes.toString('utf8').slice(0, 12_000)}`
      } else if (request.action === '状态') {
        const value = await product.progress(actor, taskId)
        const revision = await store.transaction(scope, async tx => (await control(tx, taskId)).value.revision)
        response.text = `${taskId}\n${value.label}\n控制版本：${revision}\n继续：/助手 继续 ${taskId} ${revision}`
      } else {
        const action = ({ 暂停: 'pause', 接管: 'takeover', 继续: 'resume', 交还: 'return' } as const)[request.action as '暂停' | '接管' | '继续' | '交还']
        if (request.revision === undefined) response.text = '请先查询状态，再发送包含任务 ID 和控制版本的完整继续／交还指令。'
        else {
          const value = await product.options.runtime.app.changeControl({ id: trigger.id, userId: actor }, taskId, request.revision, action)
          response.text = `${taskId}\n${({ pausing: '正在暂停，等待实际停止回执。', taking_over: '正在移交，等待实际停止回执。', agent: '已交还助手。', paused: '已暂停。', human: '已接管。' })[value.mode]}`
        }
      }
    }
    await store.transaction(scope, async tx => {
      await tx.leases.assert(lease); await access.source(tx, actor, trigger)
      const row = (await tx.get<Response>('source-state', id))!
      if (row.value.status !== 'preparing') return
      response = { ...response, status: 'queued' }
      await tx.put('source-state', id, response, row.revision)
      await tx.jobs.enqueue('product.assistant', trigger.id, { id })
    })
    product.options.runtime.consumer.kick(); return true
  }
  async deliver(job: JobContext): Promise<JobResult> {
    const { store, scope, access, artifacts, wire } = this.options, id = `response/${job.claim.key}`, operation = `assistant:${job.claim.key}`
    await job.assertCurrent()
    const saved = await store.transaction(scope, async tx => {
      const row = await tx.get<Response>('source-state', id)
      if (!row) throw new StateConflict('Missing assistant response')
      await access.source(tx, row.value.trigger.actor.id, row.value.trigger)
      if (row.value.status === 'sending') {
        if (row.value.file) { const fence = await control(tx, row.value.file.subject), op = fence.value.operations.find(op => op.id === operation); if (op) op.status = 'unknown'; await tx.put('control', row.value.file.subject, fence.value, fence.revision) }
        await tx.put('source-state', id, { ...row.value, status: 'unknown' }, row.revision, { relation: row.value.relation }); return undefined
      }
      return row.value.status === 'queued' ? row.value : undefined
    })
    if (!saved) return { state: 'done' }
    const file = saved.file ? await artifacts.read(saved.trigger.actor.id, saved.file.subject, saved.file.version, true) : undefined
    await job.assertCurrent()
    await store.transaction(scope, async tx => {
      await access.source(tx, saved.trigger.actor.id, saved.trigger)
      if (file) await access.artifact(tx, saved.trigger.actor.id, file.manifest.subject, 'read', file.manifest)
      const row = (await tx.get<Response>('source-state', id))!
      if (row.value.status !== 'queued') throw new StateConflict('Assistant response changed')
      if (file) { const fence = await control(tx, file.manifest.subject); fence.value.operations.push({ id: operation, status: 'running', at: await tx.now() }); await tx.put('control', file.manifest.subject, fence.value, fence.revision) }
      await tx.put('source-state', id, { ...saved, status: 'sending' }, row.revision, { relation: saved.relation })
    })
    let receipt: string | undefined
    try {
      if (file) receipt = await wire.file!({ messageId: String(saved.trigger.meta.messageId), threaded: saved.trigger.meta.direct !== true }, file.manifest.filename ?? 'result.txt', file.bytes, job.claim.key.slice(0, 32), job.signal)
      else {
        const result = await wire.lark<unknown>(['im', '+messages-reply', '--message-id', String(saved.trigger.meta.messageId), '--markdown', saved.text!,
          ...saved.trigger.meta.direct === true ? [] : ['--reply-in-thread'], '--idempotency-key', job.claim.key], job.signal)
        receipt = z.object({ message_id: z.string().min(1) }).parse(result).message_id
      }
    } catch { /* Unknown sends remain held. */ }
    await store.transaction(scope, async tx => {
      const row = (await tx.get<Response>('source-state', id))!
      if (file) {
        const fence = await control(tx, file.manifest.subject)
        if (receipt) fence.value.operations = fence.value.operations.filter(op => op.id !== operation)
        else { const op = fence.value.operations.find(op => op.id === operation); if (op) op.status = 'unknown' }
        settleHeld(fence.value); await tx.put('control', file.manifest.subject, fence.value, fence.revision)
      }
      await tx.put('source-state', id, { ...row.value, status: receipt ? 'sent' : 'unknown', ...(receipt ? { providerReceipt: receipt } : {}) }, row.revision, { relation: row.value.relation })
    })
    return receipt ? { state: 'done' } : { state: 'hold', reason: 'Assistant reply result unknown; reconcile provider before retrying' }
  }
}
