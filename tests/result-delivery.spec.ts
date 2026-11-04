/** Exercises real task completion, immutable files, source checks and durable delivery; external sends are fakes. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime, feishu, MEMBER, type Host } from './fixtures/host.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime(undefined, { github: false })
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, ownerOnly: true } } } })
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ message_id: 'om_saved_report' })
})
afterEach(async () => { await h.stop() })
async function flush() {
  await h.runtime.idle()
  h.runtime.store.db.prepare('UPDATE effect SET due = 0 WHERE kind = ?').run('result')
  await h.runtime.effects.idle('result')
}
async function ready(id = 'publication', file?: string) {
  const work = await h.acceptedTicket(feishu(id, '按本群材料总结工作，完整报告'))
  const ticket = h.runtime.store.tickets.get(work.ticket.id)!
  if (file) { mkdirSync(ticket.execution!.directory, { recursive: true }); writeFileSync(join(ticket.execution!.directory, file), '# 完整报告\n\n已完成工作。[R1]\n', 'utf8') }
  await h.runTool(work.sessionId, 'orchestrator_report', { state: 'ready', summary: '工作总结完成。', ...file ? { artifact_file: file } : {} })
  return { ...work, ticket: h.runtime.store.tickets.get(ticket.id)! }
}
const files = () => vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('--file'))
function smtp() {
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, mailProvider: '163', smtpCli: '/fake/163' } } } })
  return vi.mocked(Commands.prototype.run).mockImplementation(async (_program, args, cwd) => {
    if (args[0] === 'identity') return JSON.stringify({ ok: true, data: { provider: '163', owner: MEMBER, appId: 'cli_bot', accountId: 'a'.repeat(32), address: 'owner@163.com', verifiedAt: '2026-11-01T00:00:00Z' } })
    const request = JSON.parse(readFileSync(join(cwd!, 'request.json'), 'utf8'))
    return JSON.stringify({ ok: true, data: { status: 'submitted', message_id: request.messageId } })
  })
}

it('defaults to a real report file in the original thread, fixes its bytes, records its receipt and never reruns the Worker', async () => {
  const { ticket } = await ready('publishFile', 'final.md')
  await flush()
  const artifact = h.runtime.artifacts.get(ticket.id, MEMBER)!
  expect(artifact).toMatchObject({ body: '# 完整报告\n\n已完成工作。[R1]\n', filename: 'final.md', version: 1 })
  expect(h.runtime.artifacts.snapshot(ticket)).toEqual(artifact)
  expect(files()).toHaveLength(1)
  const [args, cwd] = files()[0]!
  expect(args).toEqual(expect.arrayContaining(['+messages-reply', '--reply-in-thread', '--message-id', 'om_publishFile', '--file', './final.md']))
  expect(readFileSync(join(cwd!, 'final.md'), 'utf8')).toBe(artifact.body)
  expect(h.runtime.resultDelivery.list(MEMBER)).toEqual([expect.objectContaining({ status: 'sent', version: 1, hash: artifact.hash, destination: '飞书原线程' })])
  writeFileSync(join(ticket.execution!.directory, 'final.md'), '改了磁盘文件')
  const before = h.runtime.store.tickets.list()
  expect(await h.api('POST', `loom/tasks/${ticket.id}/delivery`, { version: 1 })).toMatchObject({ status: 200 })
  await flush()
  expect(files()).toHaveLength(1)
  expect(h.runtime.store.tickets.list()).toEqual(before)
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)?.body).toBe(artifact.body)
})

it('saves all three preferences with revision checks, preserves default opt-out and does not replay completed tasks', async () => {
  const { ticket } = await ready(); await flush()
  expect(await h.api('PUT', 'loom/delivery', { mode: 'none', revision: 0, to: 'intruder@163.com' })).toMatchObject({ status: 400 })
  expect(await h.api('PUT', 'loom/delivery', { mode: 'none', revision: 0 })).toMatchObject({ status: 200, body: { mode: 'none', revision: 1 } })
  expect(await h.api('PUT', 'loom/delivery', { mode: 'mail', revision: 0 })).toMatchObject({ status: 409 })
  const second = await ready('localOnly'); await flush()
  expect(h.runtime.resultDelivery.list(MEMBER, second.ticket.id)[0]).toMatchObject({ status: 'local' })
  const sentBefore = files().length
  expect(await h.api('PUT', 'loom/delivery', { mode: 'feishu', revision: 1 })).toMatchObject({ status: 200 })
  await flush()
  expect(files()).toHaveLength(sentBefore)
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
})

it('supports a task override, rejects stale versions and refuses automatic publication outside personal mode', async () => {
  await h.api('PUT', 'loom/delivery', { mode: 'none', revision: 0 })
  const work = await h.acceptedTicket(feishu('override', '整理总结'))
  expect(await h.api('PUT', `loom/tasks/${work.ticket.id}/delivery`, { mode: 'feishu', revision: 0 })).toMatchObject({ status: 200, body: { setting: { mode: 'feishu', effectiveMode: 'feishu' } } })
  await h.runTool(work.sessionId, 'orchestrator_report', { state: 'ready', summary: '定稿' }); await flush()
  expect(files()).toHaveLength(1)
  expect(await h.api('POST', `loom/tasks/${work.ticket.id}/delivery`, { version: 2 })).toMatchObject({ status: 409 })
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, ownerOnly: false } } } })
  expect(await h.api('PUT', 'loom/delivery', { mode: 'mail', revision: 1 })).toMatchObject({ status: 503 })
})

it.each(['settings','source','takeover','newVersion'] as const)('cancels stale queued publication after %s', async reason => {
  const work = await h.acceptedTicket(feishu('stale', '整理总结'))
  const s = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...s, paused: true })
  await h.runTool(work.sessionId, 'orchestrator_report', { state: 'ready', summary: '旧定稿' })
  if (reason === 'settings') await h.api('PUT', 'loom/delivery', { mode: 'none', revision: 0 })
  if (reason === 'source') {
    const source = s.sources.feishu!
    h.runtime.store.saveSettings({ ...s, paused: true, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, chats: [], otherChats: 'none' } } } })
  }
  if (reason === 'takeover' || reason === 'newVersion') {
    h.runtime.controls.change(work.ticket.id, 'takeover', 0)
    await vi.waitFor(() => expect(h.runtime.controls.view(work.ticket.id).mode).toBe('human'))
    if (reason === 'newVersion') {
      h.runtime.artifacts.edit(work.ticket.id, MEMBER, 1, '本人改稿')
      h.runtime.controls.change(work.ticket.id, 'return', 1)
    }
  }
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false }); await flush()
  expect(files()).toHaveLength(0)
  const value = h.runtime.store.get(h.runtime.store.keys(KV.results.receipt)[0]!)!
  expect(value.status).toBe('cancelled')
  if (reason === 'source') expect((await h.api('GET', 'loom')).body.resultDeliveries).toEqual([])
})

it('routes a report containing a private follow-up to the owner rather than publishing private context back to a group', async () => {
  const work = await h.acceptedTicket(feishu('mixed', '整理总结'))
  const extra = feishu('privateInput', '私聊补充资料', { chat_type: 'p2p', chat_id: 'oc_private' })
  h.runtime.store.triggers.save(extra)
  // Persist the real derived-source chain without allowing a private instruction to select a delivery target.
  const ticket = h.runtime.store.tickets.get(work.ticket.id)!
  ticket.inputs.push({ id: 'private-followup', kind: 'trigger', triggerId: extra.id, at: extra.at } as never)
  h.runtime.store.tickets.save(ticket)
  await h.runTool(work.sessionId, 'orchestrator_report', { state: 'ready', summary: '含私聊资料的定稿' }); await flush()
  expect(files()).toHaveLength(1)
  expect(files()[0]![0]).toEqual(expect.arrayContaining(['+messages-send', '--user-id', MEMBER]))
  expect(files()[0]![0]).not.toContain('--reply-in-thread')
})

it('keeps a lost Feishu response unknown across a queue recovery and repeated requests', async () => {
  const work = await h.acceptedTicket(feishu('lostFile', '整理总结'))
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('lost response'))
  await h.runTool(work.sessionId, 'orchestrator_report', { state: 'ready', summary: '定稿' }); await flush()
  const value = h.runtime.resultDelivery.list(MEMBER)[0]!
  expect(value.status).toBe('unknown'); expect(files()).toHaveLength(1)
  await h.api('POST', `loom/tasks/${work.ticket.id}/delivery`, { version: 1 }); await flush()
  expect(files()).toHaveLength(1)
  h.runtime.store.set(KV.results.receipt(value.id), { ...value, status: 'sending' })
  h.runtime.effects.enqueue('result', value.id, {}); await flush()
  expect(h.runtime.resultDelivery.list(MEMBER)[0]?.status).toBe('unknown'); expect(files()).toHaveLength(1)
})

it('binds a reviewed owner mailbox, automatically submits the same fixed report once, and attaches no arbitrary files', async () => {
  const run = smtp()
  const binding = await h.api('POST', 'loom/delivery/mailbox', {})
  expect(binding).toMatchObject({ status: 200, body: { address: 'owner@163.com' } })
  expect(await h.api('PUT', 'loom/delivery', { mode: 'mail', revision: 0, mailboxKey: 'wrong' })).toMatchObject({ status: 409 })
  expect(await h.api('PUT', 'loom/delivery', { mode: 'mail', revision: 0, mailboxKey: binding.body.key })).toMatchObject({ status: 200 })
  const { ticket } = await ready('mailAuto', 'final.md'); await flush()
  expect(files()).toHaveLength(0)
  expect(h.runtime.resultDelivery.list(MEMBER)[0]).toMatchObject({ status: 'submitted', destination: 'owner@163.com' })
  const sends = run.mock.calls.filter(([, args]) => args[0] === 'send')
  expect(sends).toHaveLength(1)
  const request = JSON.parse(readFileSync(join(sends[0]![2]!, 'request.json'), 'utf8'))
  expect(request).toMatchObject({ to: 'owner@163.com', body: '# 完整报告\n\n已完成工作。[R1]\n', attachment: { filename: 'final.md', content: '# 完整报告\n\n已完成工作。[R1]\n' } })
  await h.api('POST', `loom/tasks/${ticket.id}/delivery`, { version: 1 }); await flush()
  expect(run.mock.calls.filter(([, args]) => args[0] === 'send')).toHaveLength(1)
  const view = JSON.stringify((await h.api('GET', 'loom')).body)
  expect(view).not.toMatch(/accountId|smtpCli|\/fake\/163|authority|mailboxKey/)
})

it('rechecks a standing mail authorization after async identity queries and sends nothing if it was withdrawn', async () => {
  const run = smtp(), binding = await h.api('POST', 'loom/delivery/mailbox', {})
  await h.api('PUT', 'loom/delivery', { mode: 'mail', revision: 0, mailboxKey: binding.body.key })
  const original = run.getMockImplementation()!, gate = Promise.withResolvers<void>()
  let checking = false
  run.mockImplementation(async (...args) => { if (args[1][0] === 'identity') { checking = true; await gate.promise } return original(...args) })
  await ready('withdrawMail')
  const flushing = flush()
  await vi.waitFor(() => expect(checking).toBe(true))
  await h.api('PUT', 'loom/delivery', { mode: 'none', revision: 1 }); gate.resolve(); await flushing
  expect(run.mock.calls.filter(([, args]) => args[0] === 'send')).toHaveLength(0)
  expect(h.runtime.resultDelivery.list(MEMBER)[0]?.status).toBe('blocked')
})

it('preserves confirmed SMTP submission even if the subsequent status query fails', async () => {
  const run = smtp(), binding = await h.api('POST', 'loom/delivery/mailbox', {})
  await h.api('PUT', 'loom/delivery', { mode: 'mail', revision: 0, mailboxKey: binding.body.key })
  const original = run.getMockImplementation()!
  run.mockImplementation(async (...args) => { if (args[1][0] === 'status') throw new Error('status unavailable'); return original(...args) })
  await ready('mailStatusFailure'); await flush()
  expect(h.runtime.resultDelivery.list(MEMBER)[0]).toMatchObject({ status: 'submitted', detail: expect.stringContaining('提交成功') })
  expect(run.mock.calls.filter(([, args]) => args[0] === 'send')).toHaveLength(1)
})

it('snapshots only an explicit task-local UTF-8 report, rejects escapes, links, binary and oversized files before completion', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('fileBoundary', '整理总结'))
  const directory = ticket.execution!.directory
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'valid.md'), '完整报告')
  writeFileSync(join(h.directory, 'outside.md'), '其他任务资料')
  symlinkSync(join(h.directory, 'outside.md'), join(directory, 'link.md'))
  linkSync(join(h.directory, 'outside.md'), join(directory, 'hard.md'))
  mkdirSync(join(directory, 'linked')); symlinkSync(join(directory, 'linked'), join(directory, 'alias'))
  writeFileSync(join(directory, 'linked', 'child.md'), '链接内容')
  writeFileSync(join(directory, 'huge.md'), 'x'.repeat(40_001))
  writeFileSync(join(directory, 'binary.txt'), Buffer.from([0xff, 0, 0x80]))
  for (const artifact_file of ['../outside.md', '/etc/passwd', 'link.md', 'hard.md', 'alias/child.md', 'huge.md', 'binary.txt', '.env.md']) {
    await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '不能发布', artifact_file })).rejects.toThrow()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  }
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '阶段', artifact_file: 'valid.md' })).rejects.toThrow('ready')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '完成', artifact_file: 'valid.md' }); await flush()
  expect(h.runtime.artifacts.get(ticket.id, MEMBER)?.body).toBe('完整报告')
})

it('registers a legacy completed report as a new immutable version without posting it or losing the summary', async () => {
  await h.api('PUT', 'loom/delivery', { mode: 'none', revision: 0 })
  const { ticket } = await ready('legacyReport'); await flush()
  writeFileSync(join(ticket.execution!.directory, 'full.md'), '# 完整报告\n详细结果')
  expect(await h.api('POST', `loom/tasks/${ticket.id}/report-file`, { filename: 'full.md', version: 1 })).toMatchObject({ status: 200, body: { version: 2, filename: 'full.md' } })
  expect(await h.api('POST', `loom/tasks/${ticket.id}/report-file`, { filename: 'full.md', version: 1 })).toMatchObject({ status: 409 })
  expect(h.runtime.artifacts.get(ticket.id, MEMBER, 1)?.body).toBe('工作总结完成。')
  expect(h.runtime.artifacts.snapshot(h.runtime.store.tickets.get(ticket.id)!)?.body).toBe('# 完整报告\n详细结果')
  expect(files()).toHaveLength(0)
})
