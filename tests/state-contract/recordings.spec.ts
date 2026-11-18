import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AsyncTaskRuntime, DurableArtifacts, DurableAssistant, DurableFeishuSource, DurableMeetings, StateProduct } from '../../src/state/index.ts'
import type { FeishuWire, ExternalRecording, SettingsRecord } from '../../src/state/index.ts'
import { productFixture, testURL } from './fixtures/product.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !testURL ? describe.skip : describe)(`external recordings: ${dialect}`, () => {
  async function fixture() {
    const f = await productFixture(dialect, true); closes.push(f.close)
    let meeting!: DurableMeetings, product!: StateProduct, downloads = 0, calls = 0, sourceValid = true
    const replies: string[] = [], bot = { cli: 'fixture', appId: 'cli_test', botId: 'ou_bot', name: 'Fixture', brand: 'feishu' as const }
    const wire: FeishuWire = { async *events() {}, lark: async args => {
      if (args.includes('/open-apis/im/v1/messages/mget')) return { items: [{ message_id: 'om_audio', chat_id: 'oc_test', msg_type: 'audio', deleted: !sourceValid,
        sender: { id: 'ou_owner', sender_type: 'user' }, body: { content: JSON.stringify({ file_key: 'file_recording', file_name: '虚构录音.m4a' }) } }] } as any
      replies.push(args[args.indexOf('--markdown') + 1]!); return { message_id: `om_ask${replies.length}` } as any
    }, download: async (_id, _key, directory) => { downloads++; const path = join(directory, 'fixture.audio'); await writeFile(path, 'Synthetic audio bytes only'); return path } }
    const artifacts = new DurableArtifacts({ store: f.store, scope: f.scope, blobs: f.blobs, authorize: (...args) => f.access.artifact(...args), checkSource: (actor, subject) => meeting.checkSource(actor, subject), evidence: (...args) => meeting.evidence(...args) })
    const assistant = new DurableAssistant({ ...f, artifacts, wire, botName: 'Fixture', product: () => product })
    const runtime = new AsyncTaskRuntime({ store: f.store, scope: f.scope, actorId: 'ou_owner', authorize: f.access.authorize, deciding: (...args) => meeting.deciding(...args), decided: (...args) => meeting.decided(...args),
      assess: async () => { throw new Error('Bare recording must not start general Router') }, work: async () => ({ state: 'hold', reason: 'Manual recording test adapter' }), stop: async () => ({ state: 'done' }),
      delivery: { authorize: async () => {}, send: async () => 'om_ack' }, lanes: [
        { kinds: ['meeting.discover', 'meeting.start'], concurrency: 1, pool: { name: 'meeting', limit: 1 }, handle: job => job.claim.kind === 'meeting.start' ? meeting.start(job) : meeting.discover(job) },
        { kinds: ['product.assistant'], concurrency: 1, pool: { name: 'assistant', limit: 1 }, handle: job => assistant.deliver(job) }] }); closes.push(() => runtime.stop())
    meeting = new DurableMeetings({ ...f, wire, blobs: f.blobs, assistant, scratch: join(f.folder, 'scratch'), runtime: () => runtime,
      asr: { ready: () => true, transcribe: async (_file, _signal, progress, checkpoint) => { calls++; await checkpoint({ stage: 'polling', model: 'fixture', taskId: 'fixture-task-id', startedAt: new Date().toISOString() }); progress(10); return { engine: 'fixture', duration: 10, segments: [{ start: 0, end: 10, text: '决定周五验收原型。' }] } } } })
    f.access.taskGuard = (tx, actor, ticket) => meeting.authorize(tx, actor, ticket)
    product = new StateProduct({ ...f, artifacts, runtime, meetings: meeting })
    const source = new DurableFeishuSource({ ...f, runtime, bot, wire, command: (trigger, lease) => meeting.receive(trigger, lease) })
    const lease = (await f.store.transaction(f.scope, tx => tx.leases.acquire('source/installed', 'fixture', 60_000)))!
    const delegate = (mode: 'auto' | 'observe' = 'auto') => product.delegation('ou_owner', undefined, { title: '录音纪要', description: '录音先询问，确认后转写', enabled: true, mode, chatIds: ['oc_test'], keywords: [], meeting: { audio: 'confirm', provider: 'bailian' }, meetingConsent: true, requestId: randomUUID(), revision: 1 })
    const records = () => f.store.transaction(f.scope, tx => tx.scan<ExternalRecording>('kv', { relation: 'meetings.record' }))
    return { ...f, artifacts, runtime, source, lease, meeting, product, records, delegate, replies, counts: () => ({ downloads, calls }), revoke: () => { sourceValid = false } }
  }
  it('asks once, accepts another master only in the source thread, awaits provider checkpoints, and persists paginated transcript bytes', async () => {
    const f = await fixture(); await f.delegate()
    const audio = f.raw('audio', '[Audio: file_recording]', { msg_type: 'audio', mentions: [] })
    expect(await f.source.ingest(audio, f.lease)).toBe('stored'); await f.runtime.idle()
    expect(f.replies).toHaveLength(1); expect(f.counts()).toEqual({ downloads: 0, calls: 0 })
    expect((await f.product.snapshot('ou_owner')).tasks).toHaveLength(0)
    expect(await f.source.ingest(audio, f.lease)).toBe('stored'); await f.runtime.idle(); expect(f.replies).toHaveLength(1)
    await f.source.ingest(f.raw('yes', '需要', { sender_id: 'ou_second', root_id: 'om_audio', parent_id: 'om_ask1', mentions: [] }), f.lease); await f.runtime.idle()
    const record = (await f.records())[0]!.value, ticket = (await f.product.snapshot('ou_owner')).tasks[0]!
    expect(record).toMatchObject({ status: 'started', confirmedBy: 'ou_second', ticketId: ticket.id })
    await expect(f.meeting.assertReady('ou_owner', ticket.id, AbortSignal.timeout(1000))).rejects.toThrow('请先完成')
    await f.meeting.transcribe('ou_owner', ticket.id, 0, AbortSignal.timeout(3000))
    expect(f.counts()).toEqual({ downloads: 1, calls: 1 })
    expect((await f.records())[0]!.value).toMatchObject({ status: 'ready', transcriptBlob: { sha256: expect.any(String) }, vendor: { taskId: 'fixture-task-id' } })
    expect((await f.records())[0]!.value).not.toHaveProperty('transcript')
    await expect(f.meeting.assertReady('ou_owner', ticket.id, AbortSignal.timeout(1000))).rejects.toThrow('分页读完')
    let offset: number | null = 0, body = ''
    while (offset !== null) { const page = await f.meeting.transcript('ou_owner', ticket.id, offset, 30, AbortSignal.timeout(1000)); body += page.text; offset = page.next_offset }
    expect(body).toContain('决定周五验收原型')
    await f.meeting.assertReady('ou_owner', ticket.id, AbortSignal.timeout(1000))
    expect(await f.store.transaction(f.scope, tx => f.meeting.evidence(tx, 'ou_owner', ticket.id))).toMatchObject({ confirmedBy: 'ou_second', sourceMessageId: 'om_audio', audioHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    f.revoke(); await expect(f.meeting.transcript('ou_owner', ticket.id, 0, 30, AbortSignal.timeout(1000))).rejects.toThrow('unavailable')
  })
  it('keeps observe mode silent and prevents a cancelled or revoked consent from creating work', async () => {
    const f = await fixture(); await f.delegate('observe')
    await f.source.ingest(f.raw('audio', '[Audio: file_recording]', { msg_type: 'audio', mentions: [] }), f.lease); await f.runtime.idle()
    expect((await f.records())[0]!.value.status).toBe('observed'); expect(f.replies).toEqual([]); expect(f.counts()).toEqual({ downloads: 0, calls: 0 })
    expect((await f.product.snapshot('ou_owner')).tasks).toEqual([])
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get<SettingsRecord>('settings', 'current'))!; row.value.settings.policy.rules.find(rule => !!rule.delegation)!.enabled = false; await tx.put('settings', row.id, row.value, row.revision) })
    expect(await f.source.ingest(f.raw('confirm', '需要', { root_id: 'om_audio', parent_id: 'om_audio', mentions: [] }), f.lease)).toBe('stored')
    await f.runtime.idle()
    expect((await f.records())[0]!.value.status).toBe('cancelled')
    expect((await f.product.snapshot('ou_owner')).tasks).toEqual([])
  })
})
