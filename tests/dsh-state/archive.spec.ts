import { createHash } from 'node:crypto'
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { StateStore } from '../../src/state/ports.ts'
import { hash } from '../../src/state/hash.ts'
import { SqlSessionPersistence } from '../../src/dsh-state/provider.ts'
import { sealNativeArchive, validateNativeArchive, nativeArchiveReport, importNativeArchive } from '../../src/dsh-state/archive.ts'
import { metadataFixture, testURL, contract, descriptor } from './fixtures/metadata.ts'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
function archive(scope: { tenantId: string; spaceId: string }, count = 1) {
  const parentId = SessionId('worker-parent'), parent = Session.create(parentId, [], { ...Session.create(parentId).header, cwd: '/tmp/native-archive-scratch', agentPreset: 'fixture' })
  for (let i = 0; i < count; i++) parent.append('model/selection', { provider: 'fixture', model: 'synthetic' })
  const events = [...parent.snapshotEvents()], childId = SessionId('worker-child'), child = Session.create(childId, events,
    { ...Session.create(childId).header, cwd: '/tmp/native-archive-scratch', isSeeded: true, parentSession: parent.id, agentPreset: 'fixture' }, SessionLogOffset(events.length))
  return sealNativeArchive({ format: 'loom-dsh-archive-v1', scope, sourceFingerprint: hash('frozen-synthetic-source'), contract,
    sessions: [{ header: parent.header, inheritedEventCount: 0, events }, { header: child.header, inheritedEventCount: events.length, events: [...child.snapshotEvents()] }],
    units: [{ descriptor, snapshot: { tables: { workspaces: { ws: { path: '/tmp/native-archive-scratch', title: 'Synthetic workspace', sessionIds: [parent.id, child.id], createdAt: '2026-11-12', updatedAt: '2026-11-12' } } },
      global: { initialized: true, workspaceIds: ['ws'], archivedSessionIds: [child.id], pinnedSessionIds: [parent.id] } } }] })
}
const options = (sha256: string) => ({ expectedSha256: sha256, actor: 'explicit-operator', evidence: 'Synthetic source has stopped and the source is a frozen private copy.' })
for (const dialect of ['sqlite', 'postgres'] as const) (dialect === 'postgres' && !testURL ? describe.skip : describe)(`native archive: ${dialect}`, () => {
  it('preserves exact Session ids, headers, events, fork prefix, workspace order and archive/pins without starting work', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const data = archive(f.scope), before = JSON.stringify(data)
    const report = await importNativeArchive(f.store, f.scope, data, options(data.sha256))
    expect(report).toMatchObject({ sessions: 2, forks: 1, executionEnabled: false, credentialConfigurationImported: false }); expect(JSON.stringify(data)).toBe(before)
    const ctx = new Context(), provider = new SqlSessionPersistence(ctx, f); closes.push(async () => { await provider.dispose(); await ctx.fiber.dispose() })
    for (const entry of data.sessions) {
      const handle = await provider.open(entry.header.id, 'read')
      expect(handle.header).toEqual(entry.header); expect(handle.inheritedEventCount).toBe(entry.inheritedEventCount)
      expect((await handle.read()).events).toEqual(entry.events)
    }
    const unit = await f.backend.kv.open(descriptor), view = await unit.loadAll()
    expect(view).toEqual(data.units[0]!.snapshot)
    expect(await f.store.transaction(f.scope, tx => tx.jobs.list())).toEqual([])
  })
  it('dry-run validates without database writes and rejects tampering, scope ambiguity, duplicate ids, bad forks and unknown environment bindings', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const original = archive(f.scope)
    expect(nativeArchiveReport(original).events).toBeGreaterThan(1)
    expect(await f.store.transaction(f.scope, tx => tx.scan('migration'))).toEqual([])
    const tampered = structuredClone(original); tampered.sessions[0]!.inheritedEventCount = 10
    expect(() => validateNativeArchive(tampered)).toThrow('digest')
    const reseal = (edit: (data: ReturnType<typeof archive>) => void) => { const data = structuredClone(original); edit(data); const { sha256, ...payload } = data; return { ...payload, sha256: hash(payload) } }
    expect(() => validateNativeArchive(reseal(data => data.sessions.push(data.sessions[0]!)))).toThrow('duplicate')
    expect(() => validateNativeArchive(reseal(data => { data.sessions[1]!.events[0] = { ...data.sessions[1]!.events[0]!, time: 2 } }))).toThrow('prefix differs')
    expect(() => validateNativeArchive(reseal(data => { data.contract.presets = {} }))).toThrow('preset')
    expect(() => validateNativeArchive(reseal(data => { data.contract.models = [] }))).toThrow('model')
    await expect(importNativeArchive(f.store, { ...f.scope, spaceId: 'another' }, original, options(original.sha256))).rejects.toThrow('Explicit')
    await expect(importNativeArchive(f.store, f.scope, original, options('0'.repeat(64)))).rejects.toThrow('Explicit')
    expect(await f.store.transaction(f.scope, tx => tx.scan('native-session'))).toEqual([])
  })
  it('keeps interrupted imports inaccessible and resumes only the same verified archive', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const data = archive(f.scope, 230); let transactions = 0
    const interrupted: StateStore = { dialect: f.store.dialect, close: async () => {}, transaction: (scope, work) => {
      if (++transactions === 3) return Promise.reject(new Error('Synthetic import interruption'))
      return f.store.transaction(scope, work)
    } }
    await expect(importNativeArchive(interrupted, f.scope, data, options(data.sha256))).rejects.toThrow('interruption')
    const ctx = new Context(), provider = new SqlSessionPersistence(ctx, f); closes.push(async () => { await provider.dispose(); await ctx.fiber.dispose() })
    await expect(provider.list()).rejects.toThrow('incomplete')
    await expect(provider.open(data.sessions[0]!.header.id, 'read')).rejects.toThrow('incomplete')
    await expect(provider.create(Session.create(SessionId('new')).header)).rejects.toThrow('incomplete')
    await expect(f.backend.kv.open(descriptor)).rejects.toThrow('incomplete')
    const different = archive(f.scope)
    await expect(importNativeArchive(f.store, f.scope, different, options(different.sha256))).rejects.toThrow('different')
    await importNativeArchive(f.store, f.scope, data, options(data.sha256))
    expect((await provider.list()).length).toBe(2)
    expect((await (await provider.open(data.sessions[0]!.header.id, 'read')).read()).events).toEqual(data.sessions[0]!.events)
    await importNativeArchive(f.store, f.scope, data, options(data.sha256))
    expect(await f.store.transaction(f.scope, tx => tx.scan('audit'))).toHaveLength(1)
  })
  it('imports referenced file bytes only after validation and keeps a failed attachment copy staged until the same archive resumes', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const bytes = Buffer.from('Synthetic attachment R1'), ref = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length, name: 'synthetic.txt' }
    const session = Session.create(SessionId('native-with-file'))
    session.append('user/message', { id: 'native-file-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] } as never, { surfaceOp: 'append' })
    const data = sealNativeArchive({ format: 'loom-dsh-archive-v2', scope: f.scope, sourceFingerprint: hash('file-source'), contract,
      sessions: [{ header: session.header, inheritedEventCount: 0, events: [...session.snapshotEvents()] }], units: [], attachments: [{ kind: 'file', ref, data: bytes.toString('base64') }] } as never)
    const reseal = (change: (value: any) => void) => { const raw = structuredClone(data); change(raw); const { sha256, ...body } = raw; return { ...body, sha256: hash(body) } }
    expect(() => validateNativeArchive(reseal(value => { value.attachments = [] }))).toThrow('missing')
    expect(() => validateNativeArchive(reseal(value => { value.attachments[0].data = 'aA==' }))).toThrow('digest')
    expect(() => validateNativeArchive(reseal(value => { value.attachments[0].ref.name = '../secret' }))).toThrow()
    await expect(importNativeArchive(f.store, f.scope, data, options(data.sha256))).rejects.toThrow('destination')
    expect(await f.store.transaction(f.scope, tx => tx.scan('migration'))).toEqual([])
    let failed = false, written = false
    const attachments = { validate: async () => {}, put: async () => { if (!failed) { failed = true; throw new Error('Synthetic attachment interruption') }; written = true }, verify: async () => { expect(written).toBe(true) } }
    await expect(importNativeArchive(f.store, f.scope, data, { ...options(data.sha256), attachments })).rejects.toThrow('interruption')
    expect((await f.store.transaction(f.scope, tx => tx.get<any>('migration', 'native-import')))?.value.status).toBe('staging')
    expect((await importNativeArchive(f.store, f.scope, data, { ...options(data.sha256), attachments })).attachments).toBe(1)
    expect((await f.store.transaction(f.scope, tx => tx.get<any>('migration', 'native-import')))?.value.status).toBe('ready')
    expect(await f.store.transaction(f.scope, tx => tx.scan('native-event'))).toHaveLength(1)
  })
  it('rejects unsafe workspace lineage, pending registry mutations and an already populated or unpaused destination', async () => {
    const f = await metadataFixture(dialect); closes.push(f.close)
    const data = archive(f.scope), { sha256: _, ...raw } = structuredClone(data)
    ;(raw.units[0]!.snapshot.global as any).pendingMutation = { operation: 'create', workspaceId: 'interrupted' }
    expect(() => sealNativeArchive(raw)).toThrow()
    await f.store.transaction(f.scope, tx => tx.put('settings', 'current', { settings: { paused: false } }, 0))
    await expect(importNativeArchive(f.store, f.scope, data, options(data.sha256))).rejects.toThrow('Pause')
    await f.store.transaction(f.scope, async tx => { const row = (await tx.get('settings', 'current'))!; await tx.put('settings', 'current', { settings: { paused: true } }, row.revision); await tx.put('native-session', 'existing', {}, 0) })
    await expect(importNativeArchive(f.store, f.scope, data, options(data.sha256))).rejects.toThrow('empty native')
  })
})
