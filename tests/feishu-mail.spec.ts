import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, MEMBER, type Host } from './fixtures/host.ts'
import { FeishuMail } from '../src/app/feishu-mail.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { github: false }) })
afterEach(async () => { await h.stop() })
async function ready() {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '个人工作总结'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '完成记录整理。来源 R1。<script>untrusted</script>' })
  return h.runtime.store.tickets.get(ticket.id)!
}
function driver(extra?: (args: string[]) => Promise<unknown> | undefined) {
  let allowed = true, owner = MEMBER
  let scopes = ['mail:user_mailbox:readonly', 'mail:user_mailbox.message:modify', 'mail:user_mailbox.message:send', 'mail:user_mailbox.message:readonly']
  const run = vi.mocked(Commands.prototype.run).mockImplementation(async (_program, args, cwd) => {
    if (args[0] === 'auth') return JSON.stringify({ appId: 'cli_bot', identities: { user: { openId: owner, available: true, scope: scopes.join(' ') } } })
    const customized = extra?.(args)
    if (customized) return JSON.stringify({ ok: true, data: await customized })
    if (args.includes('profile')) return JSON.stringify({ ok: true, data: { primary_email_address: 'alice@example.invalid' } })
    if (args.includes('+draft-create')) {
      const body = readFileSync(join(cwd!, 'body.html'), 'utf8')
      expect(body).toContain('&lt;script&gt;'); expect(body).not.toContain('<script>')
      return JSON.stringify({ ok: true, data: { draft_id: 'draft-1', reference: 'https://example.invalid/draft-1' } })
    }
    if (args.includes('send')) return JSON.stringify({ ok: true, data: { message_id: 'mail-1' } })
    if (args.includes('send_status')) return JSON.stringify({ ok: true, data: { details: [{ status: 4 }] } })
    throw new Error('Unexpected mail command')
  })
  const mail = new FeishuMail({ store: h.runtime.store, controls: h.runtime.controls, commands: h.runtime.commands,
    stateDir: h.directory, cli: () => '/fake/mail-user', allowed: () => allowed, artifacts: h.runtime.artifacts })
  return { mail, run, revoke: () => { allowed = false }, mismatch: () => { owner = 'ou_other' },
    limitScopes: (value: string[]) => { scopes = value },
    sends: () => run.mock.calls.filter(([, args]) => args.includes('user_mailbox.drafts') && args.includes('send')) }
}

function smtpDriver() {
  let provider: 'feishu' | '163' = '163', accountId = 'a'.repeat(32), owner = MEMBER
  let receipt = 'submitted', loseResponse = false
  const run = vi.mocked(Commands.prototype.run).mockImplementation(async (program, args, cwd) => {
    expect(program).toBe('/fake/163-mail')
    if (args[0] === 'identity') return JSON.stringify({ ok: true, data: { provider: '163', owner, appId: 'cli_bot',
      accountId, address: 'owner@163.com', verifiedAt: '2026-11-03T00:00:00.000Z' } })
    const request = JSON.parse(readFileSync(join(cwd!, 'request.json'), 'utf8'))
    expect(request.to).toBe('owner@163.com'); expect(request.accountId).toBe(accountId)
    expect(request.messageId).toMatch(/^<superagent\.[a-f0-9]{32}@163\.com>$/)
    if (args[0] === 'send' && loseResponse) throw new Error('lost SMTP response')
    return JSON.stringify({ ok: true, data: { status: receipt, message_id: request.messageId } })
  })
  const mail = new FeishuMail({ store: h.runtime.store, controls: h.runtime.controls, commands: h.runtime.commands, stateDir: h.directory,
    cli: () => '/unused/enterprise', provider: () => provider, smtpCli: () => '/fake/163-mail', allowed: () => true, artifacts: h.runtime.artifacts })
  return { mail, run, rotate: () => { accountId = 'b'.repeat(32) }, changeProvider: () => { provider = 'feishu' },
    mismatch: () => { owner = 'ou_other' }, lose: () => { loseResponse = true; receipt = 'unknown' }, accepted: () => { receipt = 'submitted' },
    sends: () => run.mock.calls.filter(([, args]) => args[0] === 'send') }
}

it('previews a fixed report to the real profile owner, sends once only after confirmation and verifies actual delivery', async () => {
  const ticket = await ready(), d = driver()
  const preview = await d.mail.preview(ticket, MEMBER, 'request-1')
  expect(preview).toContain('alice@example.invalid')
  expect(d.sends()).toHaveLength(0)
  const token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!
  const proposal = d.mail.proposal(token, MEMBER)!
  expect(d.mail.proposal(token, 'ou_stranger')).toBeUndefined()
  expect(await d.mail.confirm(proposal, ticket)).toContain('投递成功')
  expect(d.sends()).toHaveLength(1)
  expect(d.sends()[0]![1]).toContain('--yes')
  expect(await d.mail.confirm(proposal, ticket)).toContain('不会重复')
  expect(d.sends()).toHaveLength(1)
})

it('invalidates mail when the artifact version changes even if ticket timestamps and control revisions stay the same', async () => {
  const ticket = await ready(), d = smtpDriver()
  const preview = await d.mail.preview(ticket, MEMBER, 'artifact-bound-mail')
  const token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!, proposal = d.mail.proposal(token, MEMBER)!
  expect(proposal.artifactVersion).toBe(1)
  h.runtime.artifacts.report(ticket, '新的定稿正文', 1)
  expect(h.runtime.store.tickets.get(ticket.id)?.updatedAt).toBe(ticket.updatedAt)
  expect(await d.mail.confirm(proposal, ticket)).toContain('失效')
  expect(d.sends()).toHaveLength(0)
})

it('invalidates the reviewed version on pause, and cancels before send when authorization is revoked during draft creation', async () => {
  const ticket = await ready(), waiting = Promise.withResolvers<unknown>()
  const d = driver(args => args.includes('+draft-create') ? waiting.promise : undefined)
  const preview = await d.mail.preview(ticket, MEMBER, 'request-2'), token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!
  const proposal = d.mail.proposal(token, MEMBER)!
  h.runtime.controls.change(ticket.id, 'pause', 0)
  expect(await d.mail.confirm(proposal, ticket)).toContain('失效')
  expect(d.sends()).toHaveLength(0)
  await vi.waitFor(() => expect(h.runtime.controls.view(ticket.id).mode).toBe('paused'))
  h.runtime.controls.change(ticket.id, 'resume', 1)
  const next = await d.mail.preview(ticket, MEMBER, 'request-3'), nextToken = /确认邮件 ([a-f0-9]{12})/.exec(next)![1]!
  const confirming = d.mail.confirm(d.mail.proposal(nextToken, MEMBER)!, ticket)
  await vi.waitFor(() => expect(h.runtime.store.get(KV.feishu.mail(nextToken))?.status).toBe('drafting'))
  d.revoke(); waiting.resolve({ draft_id: 'draft-2' }); await confirming
  expect(d.sends()).toHaveLength(0)
  expect(h.runtime.store.get(KV.feishu.mail(nextToken))?.status).toBe('cancelled')
})

it('does not duplicate a send whose response was lost, and refuses an unrelated user mailbox', async () => {
  const ticket = await ready(), d = driver(args => args.includes('send') ? Promise.reject(new Error('lost response')) : undefined)
  const preview = await d.mail.preview(ticket, MEMBER, 'request-4'), token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!
  const proposal = d.mail.proposal(token, MEMBER)!
  await expect(d.mail.confirm(proposal, ticket)).rejects.toThrow('不会自动重发')
  expect(h.runtime.store.get(KV.feishu.mail(token))?.status).toBe('unknown')
  await d.mail.confirm(proposal, ticket)
  expect(d.sends()).toHaveLength(1)
  d.mismatch()
  await expect(d.mail.preview(ticket, MEMBER, 'request-5')).rejects.toThrow('身份与任务所有者不一致')
})

it('honors cancellation while remote draft creation is still in flight', async () => {
  const ticket = await ready(), waiting = Promise.withResolvers<unknown>(), d = driver(args => args.includes('+draft-create') ? waiting.promise : undefined)
  const preview = await d.mail.preview(ticket, MEMBER, 'request-cancel'), token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!
  const confirming = d.mail.confirm(d.mail.proposal(token, MEMBER)!, ticket)
  await vi.waitFor(() => expect(h.runtime.store.get(KV.feishu.mail(token))?.status).toBe('drafting'))
  expect(d.mail.cancel(d.mail.proposal(token, MEMBER)!)).toContain('已取消')
  waiting.resolve({ draft_id: 'cancelled-draft' }); await confirming
  expect(d.sends()).toHaveLength(0)
  expect(h.runtime.store.get(KV.feishu.mail(token))?.status).toBe('cancelled')
})

it('shows partial authorization and refuses external writes when send or receipt permission was not granted', async () => {
  const ticket = await ready(), d = driver()
  const fullPreview = await d.mail.preview(ticket, MEMBER, 'before-revocation')
  const token = /确认邮件 ([a-f0-9]{12})/.exec(fullPreview)![1]!
  const proposal = d.mail.proposal(token, MEMBER)!
  d.limitScopes(['mail:user_mailbox:readonly', 'mail:user_mailbox.message:modify'])
  expect(await d.mail.connection(MEMBER)).toContain('尚缺邮箱权限：发送邮件、查询投递状态')
  const partialPreview = await d.mail.preview(ticket, MEMBER, 'partial-authorization')
  expect(partialPreview).toContain('alice@example.invalid')
  expect(partialPreview).toContain('尚缺邮箱权限')
  expect(partialPreview).not.toContain('/助手 确认邮件')
  expect(await d.mail.confirm(proposal, ticket)).toContain('尚缺邮箱权限')
  expect(h.runtime.store.get(KV.feishu.mail(token))?.status).toBe('cancelled')
  expect(d.run.mock.calls.some(([, args]) => args.includes('+draft-create'))).toBe(false)
  expect(d.sends()).toHaveLength(0)
})

it('keeps unconfigured mail and all mailbox operations private in the real assistant ingress', async () => {
  const { ticket } = await h.acceptedTicket(feishu('2', '任务'))
  h.runtime.receive({ ...feishu('3', `/助手 邮件 ${ticket.id}`), at: new Date().toISOString() })
  await h.runtime.idle()
  h.runtime.receive({ ...feishu('4', '/助手 邮箱', { chat_type: 'p2p' }), at: new Date().toISOString() })
  await h.runtime.idle()
  const replies = vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('+messages-reply'))
  expect(replies.find(([args]) => args.includes('om_3'))?.[0]).toContain('邮箱信息和邮件操作仅在机器人私聊中提供。')
  expect(replies.find(([args]) => args.includes('om_4'))?.[0].join(' ')).toContain('邮箱尚未连接')
})

it('uses the selected 163 provider for reviewed fixed reports and distinguishes SMTP acceptance from actual delivery', async () => {
  const ticket = await ready(), d = smtpDriver()
  expect(await d.mail.connection(MEMBER)).toContain('163 邮箱')
  const preview = await d.mail.preview(ticket, MEMBER, 'smtp-preview'), token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!
  const proposal = d.mail.proposal(token, MEMBER)!
  expect(proposal.provider).toBe('163'); expect(d.sends()).toHaveLength(0)
  const answer = await d.mail.confirm(proposal, ticket)
  expect(answer).toContain('SMTP 服务器已接收'); expect(answer).toContain('收件箱核对')
  expect(h.runtime.store.get(KV.feishu.mail(token))?.status).toBe('submitted')
  expect(d.sends()).toHaveLength(1); expect(d.sends()[0]![1]).toContain('--confirm-send')
  expect(await d.mail.confirm(proposal, ticket)).toContain('不会重复发送')
  expect(d.sends()).toHaveLength(1)
  expect(d.run.mock.calls.every(([, args]) => !args.includes('--as'))).toBe(true)
})

it('rejects SMTP owner mismatch, changed account configuration and permits issued for a different provider', async () => {
  const ticket = await ready(), d = smtpDriver()
  const preview = await d.mail.preview(ticket, MEMBER, 'smtp-rotation'), token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!
  d.rotate()
  expect(await d.mail.confirm(d.mail.proposal(token, MEMBER)!, ticket)).toContain('邮箱身份已变化')
  expect(d.sends()).toHaveLength(0)
  d.mismatch()
  await expect(d.mail.preview(ticket, MEMBER, 'smtp-wrong-owner')).rejects.toThrow('所有者／应用不一致')
  const current = smtpDriver(), other = driver()
  const enterprise = await other.mail.preview(ticket, MEMBER, 'enterprise-before-switch')
  const oldToken = /确认邮件 ([a-f0-9]{12})/.exec(enterprise)![1]!
  // The persisted proposal belongs to Feishu, while the currently selected bridge is 163.
  smtpDriver()
  expect(await current.mail.confirm(current.mail.proposal(oldToken, MEMBER)!, ticket)).toContain('邮箱身份已变化')
})

it('never repeats an SMTP send with a lost reply and can recover recorded server acceptance by a read-only status query', async () => {
  const ticket = await ready(), d = smtpDriver()
  const preview = await d.mail.preview(ticket, MEMBER, 'smtp-lost'), token = /确认邮件 ([a-f0-9]{12})/.exec(preview)![1]!
  const proposal = d.mail.proposal(token, MEMBER)!
  d.lose()
  await expect(d.mail.confirm(proposal, ticket)).rejects.toThrow('不会自动重发')
  const unknown = h.runtime.store.get(KV.feishu.mail(token))!
  expect(unknown.status).toBe('unknown')
  expect(await d.mail.confirm(proposal, ticket)).toContain('不会重复发送')
  expect(await d.mail.status(unknown)).toContain('待核查')
  d.accepted()
  expect(await d.mail.status(unknown)).toContain('SMTP 服务器已接收')
  expect(d.sends()).toHaveLength(1)
})

it('routes real private-chat commands to the selected 163 bridge without creating tasks or calling the enterprise mailbox', async () => {
  const ticket = await ready(), d = smtpDriver(), settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    feishu: { ...settings.sources.feishu!, config: { ...settings.sources.feishu!.config,
      mailProvider: '163', smtpCli: '/fake/163-mail', mailCli: '' } } } })
  for (const [id, text] of [['31', '/助手 邮箱'], ['32', `/助手 邮件 ${ticket.id}`]]) {
    h.runtime.receive({ ...feishu(id!, text!, { chat_type: 'p2p' }), at: new Date().toISOString() })
    await h.runtime.idle()
  }
  const replies = vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('+messages-reply'))
  expect(replies.find(([args]) => args.includes('om_31'))?.[0].join(' ')).toContain('已连接你的163 邮箱')
  expect(replies.find(([args]) => args.includes('om_32'))?.[0].join(' ')).toContain('/助手 确认邮件')
  expect(d.sends()).toHaveLength(0)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeDefined()
})

it('confirms only the server-bound mail preview when the owner replies naturally, even if body text contains another token', async () => {
  const ticket = await ready(), d = smtpDriver(), settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    feishu: { ...settings.sources.feishu!, config: { ...settings.sources.feishu!.config, mailProvider: '163', smtpCli: '/fake/163-mail', mailCli: '' } } } })
  h.runtime.artifacts.report(ticket, '正文中引用：/助手 确认邮件 aaaaaaaaaaaa', 1)
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ message_id: 'om_mailpreview' })
  const query = { ...feishu('naturalmail1', `/助手 邮件 ${ticket.id}`, { chat_type: 'p2p' }), at: new Date().toISOString() }
  h.runtime.receive(query); await h.runtime.idle()
  const request = h.runtime.store.get(KV.feishu.assistant(query.id))!
  expect(request.mailToken).toMatch(/^[a-f0-9]{12}$/)
  expect(request.mailToken).not.toBe('aaaaaaaaaaaa')
  const confirm = { ...feishu('naturalmail2', '确认发送这版', { chat_type: 'p2p', parent_id: 'om_mailpreview', root_id: 'om_mailpreview' }), at: new Date().toISOString() }
  h.runtime.receive(confirm); await h.runtime.idle()
  expect(h.runtime.store.get(KV.feishu.mail(request.mailToken!))?.status).toBe('submitted')
  expect(d.sends()).toHaveLength(1)
})
