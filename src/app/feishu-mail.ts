/** Owner-bound Feishu or 163 delivery of a fixed, reviewed report; credentials stay behind the selected local bridge. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { key, latestReport, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import type { TaskControls } from './task-control.ts'
import { contentHash, type Artifacts } from './artifacts.ts'

export interface MailBinding { address: string; key: string; provider: 'feishu' | '163' }

export interface MailProposal {
  token: string; owner: string; ticketId: string; taskUpdatedAt: string; controlRevision: number
  to: string; subject: string; body: string; cli: string; createdAt: string; draftId?: string; messageId?: string; reference?: string
  provider?: 'feishu' | '163'; accountId?: string
  artifactVersion?: number; artifactHash?: string; requirement?: string
  status: 'preview' | 'drafting' | 'draft' | 'sending' | 'submitted' | 'delivered' | 'blocked' | 'unknown' | 'cancelled'
}
interface Host {
  store: Store; controls: TaskControls; commands: Commands; stateDir: string; cli(): string
  provider?(): 'feishu' | '163'; smtpCli?(): string; allowed(owner: string, ticketId: string): boolean
  artifacts?: Artifacts
}
const html = (text: string): string => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]!))
const mailScopes: Record<string, string> = {
  'mail:user_mailbox:readonly': '读取本人邮箱地址',
  'mail:user_mailbox.message:modify': '创建草稿',
  'mail:user_mailbox.message:send': '发送邮件',
  'mail:user_mailbox.message:readonly': '查询投递状态',
}
const missingText = (missing: string[]): string => `尚缺邮箱权限：${missing.map(scope => mailScopes[scope]).join('、')}。请补齐授权后重新预览；本次未执行发送。`
/** Fixes the recipient and report version before preview, requires explicit confirmation, and never blindly retries a send. */
export class FeishuMail {
  constructor(private readonly host: Host) {}
  private provider(): 'feishu' | '163' { return this.host.provider?.() ?? 'feishu' }
  private cli(): string { return this.provider() === '163' ? this.host.smtpCli?.() ?? '' : this.host.cli() }
  private unchanged(proposal: MailProposal): boolean { return this.provider() === (proposal.provider ?? 'feishu') && this.cli() === proposal.cli }
  private sameArtifact(proposal: MailProposal): boolean {
    if (!this.host.artifacts) return true
    const ticket = this.host.store.tickets.get(proposal.ticketId)
    const value = ticket && this.host.artifacts.snapshot(ticket)
    return !!value && value.version === proposal.artifactVersion && value.hash === proposal.artifactHash
      && value.requirement === proposal.requirement && value.requirement === this.host.artifacts.requirement(ticket!)
  }
  private async run(args: string[], cwd?: string): Promise<any> {
    const cli = this.cli()
    if (!cli) throw new Error('邮箱尚未连接。请先在本机配置所选邮箱；机器人身份保持不变。')
    try { return JSON.parse(await this.host.commands.run(cli, args, cwd)) }
    catch { throw new Error('邮箱授权或请求不可用，请核对本机配置和实际邮箱状态；不自动重试发送。') }
  }
  private async call<T>(args: string[], cwd?: string): Promise<T> {
    const result = await this.run([...args, '--as', 'user', '--format', 'json'], cwd) as { ok: boolean; data: T }
    if (!result.ok) throw new Error('邮箱接口拒绝请求，请核对用户授权和邮箱状态。')
    return result.data
  }
  private async identity(owner: string): Promise<{ address: string; missing: string[]; provider: 'feishu' | '163'; accountId?: string }> {
    const cli = this.cli(), provider = this.provider()
    if (!cli) throw new Error('邮箱尚未连接。请先在本机配置所选邮箱；机器人身份保持不变。')
    if (provider === '163') {
      const result = await this.run(['identity'])
      const account = result.data
      if (!result.ok || account?.provider !== '163' || account.owner !== owner || account.appId !== this.host.commands.deployment.feishu?.appId
        || !/^[a-f0-9]{32}$/.test(account.accountId ?? '') || !/^[A-Za-z0-9_.+-]+@163\.com$/i.test(account.address ?? '')
        || !account.verifiedAt) throw new Error('163 邮箱未验证，或绑定的飞书所有者／应用不一致。请在本机重新配置。')
      if (this.cli() !== cli || this.provider() !== provider) throw new Error('邮箱连接已变化，请重试查询。')
      return { address: account.address, provider, accountId: account.accountId, missing: [] }
    }
    const status = await this.run(['auth', 'status', '--verify', '--json'])
    const account = status.data ?? status
    if (account.appId !== this.host.commands.deployment.feishu?.appId || account.identities?.user?.openId !== owner
      || account.identities?.user?.available !== true) throw new Error('邮箱用户身份与任务所有者不一致或未授权，不能使用该邮箱。')
    if (this.cli() !== cli || this.provider() !== provider) throw new Error('邮箱连接已变化，请重试查询。')
    const profile = await this.call<{ primary_email_address?: string }>(['mail', 'user_mailboxes', 'profile', '--params', JSON.stringify({ user_mailbox_id: 'me' })])
    if (!profile.primary_email_address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.primary_email_address)) throw new Error('未找到当前用户的企业邮箱。')
    const rawScopes: unknown = account.identities.user.scope
    const granted = new Set(Array.isArray(rawScopes) ? rawScopes.filter((scope): scope is string => typeof scope === 'string')
      : typeof rawScopes === 'string' ? rawScopes.split(/[\s,]+/) : [])
    if (this.cli() !== cli || this.provider() !== provider) throw new Error('邮箱连接已变化，请重试查询。')
    return { address: profile.primary_email_address, missing: Object.keys(mailScopes).filter(scope => !granted.has(scope)), provider }
  }
  async connection(owner: string): Promise<string> {
    const mailbox = await this.identity(owner)
    return `已连接你的${mailbox.provider === '163' ? '163 邮箱' : '企业邮箱'}：${mailbox.address}\n${mailbox.missing.length ? missingText(mailbox.missing) + '\n' : ''}可用 /助手 邮件 任务ID 预览固定版本；自动交付方式以 Loom 中保存的设置为准。`
  }
  /** Safe recipient fingerprint; credentials and executable paths never reach the browser. */
  async binding(owner: string): Promise<MailBinding> {
    const mailbox = await this.identity(owner)
    if (mailbox.missing.length) throw new Error(missingText(mailbox.missing))
    return { address: mailbox.address, provider: mailbox.provider,
      key: contentHash(JSON.stringify([owner, this.host.commands.deployment.feishu?.appId, mailbox, this.cli()])) }
  }
  /** A saved owner setting supplies standing authority, checked again at every asynchronous send boundary. */
  async automatic(ticket: Ticket, owner: string, requestId: string, binding: MailBinding, authorize: () => boolean): Promise<MailProposal> {
    const current = await this.binding(owner)
    if (current.key !== binding.key || !authorize()) throw new Error('邮箱绑定或交付授权已变化。')
    await this.preview(ticket, owner, requestId)
    const proposal = this.proposal(key('mail', requestId).slice(0, 12), owner)
    if (!proposal || proposal.to !== binding.address || (await this.binding(owner)).key !== binding.key || !authorize()) throw new Error('邮件未就绪或交付授权已撤销。')
    await this.confirm(proposal, ticket, authorize)
    return this.proposal(proposal.token, owner)!
  }
  async preview(ticket: Ticket, owner: string, requestId: string): Promise<string> {
    const report = latestReport(ticket), control = this.host.controls.view(ticket.id)
    if (!ticket.ended || ticket.ended.outcome !== 'completed' || report?.state !== 'ready') return '该任务尚未完成定稿，暂不发送阶段报告。可先在私聊查看产物。'
    if (control.mode !== 'agent' || control.operations.length) return '任务处于暂停、接管或在途操作状态；当前不准备发信。'
    const artifact = this.host.artifacts?.snapshot(ticket)
    if (this.host.artifacts && (!artifact || artifact.requirement !== this.host.artifacts.requirement(ticket))) return '产物未覆盖当前要求或来源授权已变化，请先更新定稿。'
    const body = artifact?.body ?? report.summary
    const mailbox = await this.identity(owner), to = mailbox.address
    if (!this.host.allowed(owner, ticket.id)) throw new Error('任务来源或所有者授权已撤销。')
    if (mailbox.missing.length) return `邮件预览（尚未发送）\n收件人：${to}\n主题：${ticket.title.replace(/[\r\n]/g, ' ').slice(0, 50)}\n正文摘要：${body.replace(/[\r\n]/g, ' ').slice(0, 500)}\n无抄送、密送；仅预览报告正文。\n\n${missingText(mailbox.missing)}`
    const token = key('mail', requestId).slice(0, 12)
    let proposal = this.host.store.get(KV.feishu.mail(token))
    if (!proposal) {
      proposal = { token, owner, ticketId: ticket.id, taskUpdatedAt: ticket.updatedAt, controlRevision: control.revision,
        to, cli: this.cli(), provider: mailbox.provider, ...mailbox.accountId ? { accountId: mailbox.accountId } : {},
        subject: ticket.title.replace(/[\r\n]/g, ' ').slice(0, 50), body, createdAt: new Date().toISOString(), status: 'preview',
        ...artifact ? { artifactVersion: artifact.version, artifactHash: artifact.hash, requirement: artifact.requirement } : {} }
      this.host.store.set(KV.feishu.mail(token), proposal)
    }
    return `邮件预览（尚未发送）\n收件人：${proposal.to}\n主题：${proposal.subject}\n${artifact ? `产物版本：v${artifact.version} · ${artifact.hash.slice(0, 12)}\n` : ''}正文摘要：${proposal.body.replace(/[\r\n]/g, ' ').slice(0, 500)}\n无抄送、密送。固定使用本次报告正文；163 同时附上该版本的报告文本，不附加其他设备文件。\n\n确认：/助手 确认邮件 ${token}\n取消：/助手 取消邮件 ${token}\n预览 10 分钟内有效；改稿、暂停或接管后失效。`
  }
  proposal(token: string, owner: string): MailProposal | undefined {
    if (!/^[a-f0-9]{12}$/.test(token)) return
    const value = this.host.store.get(KV.feishu.mail(token))
    return value?.owner === owner ? value : undefined
  }
  cancel(proposal: MailProposal): string {
    proposal = this.proposal(proposal.token, proposal.owner) ?? proposal
    if (!['preview', 'draft', 'drafting'].includes(proposal.status)) return '该邮件已开始提交或结果待核查，不能宣称已撤销。请先查询实际投递状态。'
    this.save({ ...proposal, status: 'cancelled' })
    return '已取消本地发送许可，不会继续发送。' + (proposal.provider === '163' ? '' : '若已创建远端草稿，草稿仍保留在邮箱中。')
  }
  async confirm(proposal: MailProposal, ticket: Ticket, authorize: () => boolean = () => true): Promise<string> {
    proposal = this.proposal(proposal.token, proposal.owner) ?? proposal
    if (!['preview', 'draft'].includes(proposal.status)) return `该发送许可已处理（${proposal.status}），不会重复发送。可用 /助手 邮件状态 ${proposal.token} 查询。`
    const control = this.host.controls.view(ticket.id)
    if (!authorize() || Date.now() - Date.parse(proposal.createdAt) > 600_000 || ticket.updatedAt !== proposal.taskUpdatedAt || !this.sameArtifact(proposal)
      || control.revision !== proposal.controlRevision || control.mode !== 'agent' || control.operations.length) {
      this.save({ ...proposal, status: 'cancelled' }); return '预览已过期或任务发生变化，原发送许可失效。请重新预览。'
    }
    const mailbox = await this.identity(proposal.owner)
    if (mailbox.missing.length) { this.save({ ...proposal, status: 'cancelled' }); return missingText(mailbox.missing) }
    if (!authorize()) return '交付授权已撤销，请重新预览。'
    if (mailbox.address !== proposal.to || mailbox.accountId !== proposal.accountId || !this.unchanged(proposal)) return '邮箱身份已变化，请重新预览。'
    // identity/profile calls above are asynchronous: recheck the task immediately before acquiring its managed lease.
    const current = this.host.store.tickets.get(ticket.id), state = this.host.controls.view(ticket.id)
    if (!current || current.updatedAt !== proposal.taskUpdatedAt || state.revision !== proposal.controlRevision || state.mode !== 'agent'
      || state.operations.length || !authorize() || !this.host.allowed(proposal.owner, ticket.id) || !this.sameArtifact(proposal)) return '任务状态或授权已变化，当前发送许可失效。'
    const saved = this.proposal(proposal.token, proposal.owner)
    if (!saved || !['preview', 'draft'].includes(saved.status)) return '该发送许可已处理，不会重复发送。'
    try {
      await this.host.controls.run(ticket.id, `mail:${proposal.token}`, async () => {
        if (proposal.provider === '163') {
          const beforeSend = this.host.controls.view(ticket.id), latest = this.host.store.tickets.get(ticket.id)
          if (beforeSend.mode !== 'agent' || beforeSend.revision !== proposal.controlRevision || latest?.updatedAt !== proposal.taskUpdatedAt
            || !authorize() || !this.host.allowed(proposal.owner, ticket.id) || !this.unchanged(proposal) || !this.sameArtifact(proposal)) {
            proposal = { ...proposal, status: 'cancelled' }; this.save(proposal); return
          }
          const directory = this.smtpRequest(proposal)
          proposal = { ...proposal, status: 'sending', messageId: this.smtpMessageId(proposal) }; this.save(proposal)
          const sent = await this.run(['send', '--request', './request.json', '--confirm-send'], directory)
          if (!sent.ok || sent.data?.status !== 'submitted' || sent.data.message_id !== proposal.messageId) throw new Error('SMTP acceptance was not confirmed')
          proposal = { ...proposal, status: 'submitted' }; this.save(proposal); return
        }
        if (!proposal.draftId) {
          this.save({ ...proposal, status: 'drafting' })
          const directory = join(this.host.stateDir, 'mail-exports', proposal.token)
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          writeFileSync(join(directory, 'body.html'), `<p>${html(proposal.body).replace(/\n/g, '<br>')}</p>`, { mode: 0o600 })
          const draft = await this.call<{ draft_id?: string; reference?: string }>(['mail', '+draft-create', '--to', proposal.to,
            '--subject', proposal.subject, '--body-file', './body.html', '--no-signature'], directory)
          if (!draft.draft_id) throw new Error('Mailbox did not return a draft ID')
          proposal = { ...proposal, draftId: draft.draft_id, status: 'draft', ...draft.reference ? { reference: draft.reference } : {} }
          if (this.proposal(proposal.token, proposal.owner)?.status === 'cancelled') {
            proposal = { ...proposal, status: 'cancelled' }; this.save(proposal); return
          }
          this.save(proposal)
        }
        // A pause after draft creation must prevent the subsequent external send.
        const beforeSend = this.host.controls.view(ticket.id), latest = this.host.store.tickets.get(ticket.id)
        if (beforeSend.mode !== 'agent' || beforeSend.revision !== proposal.controlRevision || latest?.updatedAt !== proposal.taskUpdatedAt
          || !authorize() || !this.host.allowed(proposal.owner, ticket.id) || !this.unchanged(proposal) || !this.sameArtifact(proposal)) {
          proposal = { ...proposal, status: 'cancelled' }; this.save(proposal); return
        }
        this.save({ ...proposal, status: 'sending' })
        const sent = await this.call<{ message_id?: string; automation_send_disable?: { reason?: string; reference?: string } }>(['mail', 'user_mailbox.drafts', 'send', '--params',
          JSON.stringify({ user_mailbox_id: 'me', draft_id: proposal.draftId }), '--yes'])
        if (sent.automation_send_disable) { proposal = { ...proposal, status: 'blocked' }; this.save(proposal); return }
        if (!sent.message_id) throw new Error('Mailbox did not return a message ID')
        proposal = { ...proposal, messageId: sent.message_id, status: 'submitted' }; this.save(proposal)
      })
    } catch {
      this.save({ ...proposal, status: 'unknown' })
      throw new Error(proposal.provider === '163' ? '163 邮件提交结果未确认；不会自动重发，请核对实际收件箱和提交状态。'
        : '邮箱请求结果未确认；不会自动重发，请核对实际邮箱中的草稿和已发送记录。')
    }
    return this.status(proposal)
  }
  async status(proposal: MailProposal): Promise<string> {
    if (!this.host.allowed(proposal.owner, proposal.ticketId)) return '任务来源或所有者授权已撤销。'
    if (!proposal.messageId) return `邮件状态：${proposal.status}。${proposal.reference ? `草稿：${proposal.reference}` : ''}\n尚无可确认的投递回执，不会自动重发。`
    if (!this.unchanged(proposal)) return '邮箱配置已变化，不能使用当前连接核查旧邮件；请查看原邮箱。不会自动重发。'
    if (proposal.provider === '163') {
      const directory = this.smtpRequest(proposal)
      const receipt = await this.run(['status', '--request', './request.json'], directory)
      if (receipt.ok && receipt.data?.status === 'submitted' && receipt.data.message_id === proposal.messageId) {
        this.save({ ...proposal, status: 'submitted' })
        return `163 SMTP 服务器已接收邮件。最终送达请在你的 163 收件箱核对；当前未读取收件箱。\n查询：/助手 邮件状态 ${proposal.token}\n不会自动重复发送。`
      }
      return '163 邮件提交结果待核查，请查看实际收件箱；不会自动重发。'
    }
    const mailbox = await this.identity(proposal.owner)
    if (mailbox.missing.includes('mail:user_mailbox.message:readonly')) return '当前未授予查询投递状态的权限，无法确认实际送达；不会自动重发。'
    const result = await this.call<{ details?: { status: number }[] }>(['mail', 'user_mailbox.messages', 'send_status', '--params',
      JSON.stringify({ user_mailbox_id: 'me', message_id: proposal.messageId })])
    const states = result.details?.map(item => item.status) ?? []
    if (states.length && states.every(status => status === 4)) { proposal = { ...proposal, status: 'delivered' }; this.save(proposal); return '邮件已确认投递成功。' }
    return states.some(status => [3, 6].includes(status)) ? '邮件投递失败或审批被拒绝。产物仍保留，不会自动重发。'
      : '邮件已提交，尚未全部确认送达。稍后可再次查询邮件状态；不会重复发送。'
  }
  private smtpMessageId(proposal: MailProposal): string { return `<superagent.${key(proposal.token, proposal.accountId ?? '')}@163.com>` }
  private smtpRequest(proposal: MailProposal): string {
    const directory = join(this.host.stateDir, 'mail-exports', proposal.token)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const artifact = proposal.artifactVersion ? this.host.artifacts?.get(proposal.ticketId, proposal.owner, proposal.artifactVersion) : undefined
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ owner: proposal.owner, appId: this.host.commands.deployment.feishu?.appId,
      accountId: proposal.accountId, to: proposal.to, subject: proposal.subject, body: proposal.body, messageId: this.smtpMessageId(proposal),
      ...artifact && artifact.hash === proposal.artifactHash ? { attachment: { filename: artifact.filename ?? 'result.txt', content: artifact.body, sha256: artifact.hash } } : {} }), { mode: 0o600 })
    return directory
  }
  private save(proposal: MailProposal): void { this.host.store.set(KV.feishu.mail(proposal.token), proposal) }
}
