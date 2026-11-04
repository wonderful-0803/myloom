/** Owner-selected delivery of a fixed report revision, separate from the model-written completion notice. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, latestReport, type Ticket } from '../core/index.ts'
import { settingsPolicy } from '../policy.ts'
import { KV } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { contentHash, type Artifacts, type ArtifactVersion } from './artifacts.ts'
import { Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'
import type { TaskControls } from './task-control.ts'
import type { FeishuMail, MailBinding } from './feishu-mail.ts'

export type DeliveryMode = 'feishu' | 'none' | 'mail'
export interface DeliverySetting {
  owner: string; mode: DeliveryMode | 'default'; revision: number; at?: string; binding?: MailBinding
}
export interface ResultReceipt {
  id: string; owner: string; ticketId: string; version: number; hash: string; mode: DeliveryMode
  status: 'queued' | 'sending' | 'sent' | 'submitted' | 'unknown' | 'cancelled' | 'blocked' | 'local'
  at: string; updatedAt: string; destination: string; messageId?: string; mailToken?: string
  taskUpdatedAt: string; controlRevision: number; authority: string; binding?: MailBinding; detail?: string
}
interface Host {
  store: Store; sources: SourceRegistry; controls: TaskControls; artifacts: Artifacts; effects: Effects
  commands: Commands; mail: FeishuMail; stateDir: string; paused(): boolean
}
const modes = z.enum(['feishu', 'none', 'mail', 'default'])
/** Persists versioned preferences and at-most-once publication receipts; never scans files or wakes a Worker. */
export class ResultDelivery {
  constructor(private readonly host: Host) {
    host.effects.handle('result', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1 })
  }
  private personal(owner: string): boolean {
    const { store, sources } = this.host, allowed = sources.policyPart('feishu')?.allowed ?? []
    return store.settings().sources.github?.enabled === false && sources.instance('feishu')?.enabled === true
      && feishuSettings(sources).ownerOnly && allowed.length === 1 && allowed[0]?.id === owner
  }
  setting(owner: string, ticketId?: string): DeliverySetting {
    const ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
    const origin = ticket && this.host.store.triggers.get(ticket.origin.triggerId)
    const initial = origin?.source === 'codex-daily' && ['none', 'feishu', 'default'].includes(String(origin.meta.delivery)) ? origin.meta.delivery as 'none' | 'feishu' | 'default' : 'default'
    return this.host.store.get(KV.results.setting(owner, ticketId ?? 'default')) ?? { owner, mode: ticketId ? initial : 'feishu', revision: 0 }
  }
  private effective(owner: string, ticketId: string): { mode: DeliveryMode; binding?: MailBinding; authority: string } {
    const global = this.setting(owner), task = this.setting(owner, ticketId), value = task.mode === 'default' ? global : task
    return { mode: value.mode as DeliveryMode, binding: value.binding, authority: contentHash(JSON.stringify(task.mode === 'default' ? [global, task] : [task])) }
  }
  async save(owner: string, body: unknown, ticketId?: string): Promise<DeliverySetting> {
    const input = z.object({ mode: modes, revision: z.number().int().nonnegative(), mailboxKey: z.string().optional() }).strict().parse(body)
    if (!this.personal(owner) || !ticketId && input.mode === 'default') throw new Error('交付方式需要单人助手授权。')
    const ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
    if (ticketId && (!ticket || !this.host.artifacts.canReadContext(ticket, owner))) throw new Error('任务授权已撤销。')
    const binding = input.mode === 'mail' ? await this.host.mail.binding(owner) : undefined
    if (binding && binding.key !== input.mailboxKey) throw new Error('请先核对当前绑定邮箱，再保存邮件交付授权。')
    return this.host.store.atomic(() => {
      if (!this.personal(owner) || ticket && !this.host.artifacts.canReadContext(ticket, owner)) throw new Error('所有者或任务授权已变化。')
      const before = this.setting(owner, ticketId)
      if (before.revision !== input.revision) throw new Error('交付设置已变化，请刷新后重试。')
      if (before.mode === input.mode && before.binding?.key === binding?.key) return before
      const value: DeliverySetting = { owner, mode: input.mode, revision: input.revision + 1, at: new Date().toISOString(), ...binding ? { binding } : {} }
      this.host.store.set(KV.results.setting(owner, ticketId ?? 'default'), value)
      for (const name of this.host.store.keys(KV.results.receipt)) {
        const receipt = this.host.store.get(name)!
        if (receipt.owner === owner && (!ticketId || receipt.ticketId === ticketId) && receipt.status === 'queued'
          && this.effective(owner, receipt.ticketId).authority !== receipt.authority) this.cancel(receipt, '交付设置已变更，原排队投递已取消。')
      }
      return value
    })
  }
  list(owner: string, ticketId?: string): ResultReceipt[] {
    return this.host.store.keys(KV.results.receipt).flatMap(name => {
      const value = this.host.store.get(name)!, ticket = this.host.store.tickets.get(value.ticketId)
      return value.owner === owner && (!ticketId || value.ticketId === ticketId) && ticket && this.host.artifacts.canReadContext(ticket, owner) ? [value] : []
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100)
  }
  /** Holds queued publication on pause or takeover; completed/unknown external writes are never claimed undone. */
  hold(ticketId: string): void {
    for (const name of this.host.store.keys(KV.results.receipt)) {
      const receipt = this.host.store.get(name)!
      if (receipt.ticketId === ticketId && receipt.status === 'queued') this.cancel(receipt, '任务已暂停或接管，原排队投递已取消。')
    }
  }
  enqueue(ticket: Ticket, artifact: ArtifactVersion): ResultReceipt | undefined {
    const owner = ticket.mandate.actor.id, { store, artifacts, controls } = this.host
    if (!this.personal(owner)) return
    if (ticket.mandate.actor.source === 'codex-daily' && !settingsPolicy(store.settings(), this.host.sources).revalidate(ticket.mandate)) throw new Error('Codex 日报委托已撤销或变化。')
    if (ticket.ended?.outcome !== 'completed' || latestReport(ticket)?.state !== 'ready' || artifact.kind !== 'task'
      || artifact.subject !== ticket.id || artifacts.get(ticket.id, owner)?.version !== artifact.version
      || artifact.requirement !== artifacts.requirement(ticket) || !artifacts.canReadContext(ticket, owner)) throw new Error('仅交付当前任务已完成的最新定稿。')
    const control = controls.view(ticket.id)
    if (control.mode !== 'agent' || control.operations.some(op => op.name !== 'orchestrator_report')) throw new Error('任务暂停、接管或有在途操作，暂不投递。')
    const value = this.effective(owner, ticket.id), destination = this.destination(ticket, artifact)
    const target = value.mode === 'mail' ? value.binding?.key : value.mode === 'feishu' ? destination.key : 'local'
    if (value.mode === 'mail' && !value.binding) throw new Error('请先核对并保存本人邮箱。')
    const id = key('report-delivery', ticket.id, String(artifact.version), value.mode, target ?? '')
    return store.atomic(() => {
      const previous = store.get(KV.results.receipt(id))
      if (previous && previous.status !== 'cancelled') return previous
      const at = new Date().toISOString(), receipt: ResultReceipt = { id, owner, ticketId: ticket.id, version: artifact.version, hash: artifact.hash,
        mode: value.mode, status: value.mode === 'none' ? 'local' : 'queued', at, updatedAt: at, destination: value.mode === 'mail' ? value.binding!.address : value.mode === 'none' ? '仅保存在 Loom' : destination.label,
        taskUpdatedAt: ticket.updatedAt, controlRevision: control.revision, authority: value.authority, ...value.binding ? { binding: value.binding } : {} }
      store.set(KV.results.receipt(id), receipt)
      if (receipt.status === 'queued') this.host.effects.enqueue('result', id, {})
      return receipt
    })
  }
  private destination(ticket: Ticket, artifact: ArtifactVersion): { key: string; label: string; reply?: string; threaded?: boolean } {
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    // A private follow-up is not implicitly published back to the original group.
    const sameChat = origin && artifact.sources.every(source => this.host.store.triggers.get(source.triggerId)?.meta.chatId === origin.meta.chatId)
    return origin && sameChat && typeof origin.meta.messageId === 'string'
      ? { key: origin.meta.messageId, label: origin.meta.direct === true ? '机器人私聊' : '飞书原线程', reply: origin.meta.messageId, threaded: origin.meta.direct !== true }
      : { key: ticket.mandate.actor.id, label: '机器人私聊（包含跨会话资料）' }
  }
  private valid(receipt: ResultReceipt): boolean {
    const { store, artifacts, controls } = this.host, ticket = store.tickets.get(receipt.ticketId)
    const artifact = artifacts.get(receipt.ticketId, receipt.owner), control = controls.view(receipt.ticketId)
    return this.personal(receipt.owner) && !!ticket
      && (ticket.mandate.actor.source !== 'codex-daily' || settingsPolicy(store.settings(), this.host.sources).revalidate(ticket.mandate)) && ticket.ended?.outcome === 'completed' && latestReport(ticket)?.state === 'ready'
      && ticket.updatedAt === receipt.taskUpdatedAt && artifacts.canReadContext(ticket, receipt.owner)
      && artifact?.version === receipt.version && artifact.hash === receipt.hash && artifact.requirement === artifacts.requirement(ticket)
      && control.mode === 'agent' && control.revision === receipt.controlRevision && this.effective(receipt.owner, ticket.id).authority === receipt.authority
  }
  private persist(value: ResultReceipt): void { this.host.store.set(KV.results.receipt(value.id), { ...value, updatedAt: new Date().toISOString() }) }
  private cancel(value: ResultReceipt, detail: string): void { this.persist({ ...value, status: 'cancelled', detail }); this.host.effects.cancel('result', value.id) }
  private async deliver(id: string): Promise<void> {
    const { store, artifacts, commands, controls } = this.host
    let receipt = store.get(KV.results.receipt(id))
    if (!receipt) return
    if (receipt.status === 'sending') { this.persist({ ...receipt, status: 'unknown', detail: '进程中断，投递结果待核查；不会自动重发。' }); return }
    if (receipt.status !== 'queued') return
    if (!this.valid(receipt)) { this.cancel(receipt, '任务、来源、产物版本或交付授权已变化。'); return }
    if (controls.view(receipt.ticketId).operations.length) throw new Later('Waiting for managed task operations to settle')
    const fixed = receipt, ticket = store.tickets.get(receipt.ticketId)!, artifact = artifacts.get(receipt.ticketId, receipt.owner, receipt.version)!
    if (receipt.mode === 'mail') {
      // The mail service keeps a second durable send receipt and rechecks owner identity before SMTP submission.
      try {
        receipt = { ...receipt, status: 'sending' }; this.persist(receipt)
        const proposal = await this.host.mail.automatic(ticket, receipt.owner, id, receipt.binding!, () => this.valid(fixed))
        this.persist({ ...receipt, mailToken: proposal.token, status: ['submitted', 'delivered'].includes(proposal.status) ? 'submitted' : ['unknown', 'sending', 'drafting'].includes(proposal.status) ? 'unknown' : 'cancelled',
          detail: ['submitted', 'delivered'].includes(proposal.status) ? '邮箱服务器已接收；最终送达以收件箱为准。' : '邮件未提交，请核对邮箱与任务状态。' })
      } catch {
        const proposal = this.host.mail.proposal(key('mail', id).slice(0, 12), receipt.owner)
        const submitted = proposal && ['submitted', 'delivered'].includes(proposal.status)
        this.persist({ ...receipt, ...proposal ? { mailToken: proposal.token } : {}, status: submitted ? 'submitted' : proposal && ['sending', 'unknown', 'drafting'].includes(proposal.status) ? 'unknown' : 'blocked',
          detail: submitted ? '已记录邮件提交成功；后续状态查询未完成，请核对收件箱。' : '邮箱投递未确认；请核对绑定、授权和实际收件箱，不会自动重发。' })
      }
      return
    }
    const destination = this.destination(ticket, artifact), directory = join(this.host.stateDir, 'result-exports', id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = artifact.filename ?? 'result.txt'
    writeFileSync(join(directory, filename), artifact.body, { mode: 0o600 })
    const args = destination.reply ? ['im', '+messages-reply', '--message-id', destination.reply] : ['im', '+messages-send', '--user-id', receipt.owner]
    if (destination.threaded) args.push('--reply-in-thread')
    args.push('--file', './' + filename, '--idempotency-key', key('report-file', id))
    try {
      await controls.run(ticket.id, `result:${id}`, async signal => {
        if (!this.valid(fixed)) { this.cancel(fixed, '投递授权已变化。'); return }
        receipt = { ...fixed, status: 'sending' }; this.persist(receipt)
        const sent = await commands.withSignal(signal).lark<{ message_id?: string }>(args, directory)
        if (!sent.message_id) throw new Error('Missing delivery receipt')
        this.persist({ ...receipt, status: 'sent', messageId: sent.message_id })
        store.set(KV.feishu.assistantThread(sent.message_id), ticket.id)
      })
    } catch {
      const current = store.get(KV.results.receipt(id)) ?? receipt
      this.persist({ ...current, status: current.status === 'sending' ? 'unknown' : 'cancelled', detail: '文件投递未确认，请核对飞书；不会自动重复发送。' })
    }
  }
}
