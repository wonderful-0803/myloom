/** Actual rc.3 JSONL/JSON → SQL archive migration and a fresh WorkspaceRegistry process. No models or user history. */
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domains } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonStorage } from '@deepseek-ai/dsh-storage-json'
import { apply as jsonl } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionStore, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { apply as nativeState } from './lib/dsh-state.js'
import { apply as nativeMetadata } from './lib/dsh-metadata.js'
const [phase, tenantId] = process.argv.slice(2), folder = process.env.LOOM_NATIVE_SMOKE_ROOT, workspacePath = join(folder, 'rebuildable-workspace')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const withAttachments = process.env.LOOM_DSH_METADATA_ATTACHMENTS === '1', attachmentHome = join(folder, 'durable-native-home')
const compression = process.env.LOOM_DSH_METADATA_COMPRESSION ?? 'none'
const contract = { harnessVersion: '0.2.1-rc.3', profileRevision: digest('synthetic-profile'), presets: { fixture: digest('synthetic-preset') }, models: [{ provider: 'fixture', model: 'synthetic' }] }
const privateJSON = async (file, value) => writeFile(join(folder, file), JSON.stringify(value), { mode: 0o600 })
await mkdir(workspacePath, { recursive: true, mode: 0o700 })
const parentId = SessionId('native-jsonl-parent'), childId = SessionId('native-jsonl-child'), archivePath = join(folder, 'archive.json')
let ctx
async function mountWorkspace(root) {
  await root.plugin(WorkspaceRegistry)
  await root.inject(['workspaceRegistry', 'sessionPersistence', 'sessions'], child => { ctx = child })
}
if (phase === 'seed') {
  const source = new Context()
  try {
    await source.plugin(SessionStore); await jsonl(source, { root: join(folder, 'old-sessions'), compression })
    await source.plugin(Storage); await source.inject(['storage'], child => { jsonStorage(child, { root: join(folder, 'old-metadata') }); domains(child, { backend: 'json' }) })
    await mountWorkspace(source)
    const workspace = await ctx.workspaceRegistry.create(workspacePath, 'Synthetic migration workspace')
    const session = ctx.sessions.prepare(parentId, { meta: { cwd: workspacePath, agentPreset: 'fixture' } })
    const writer = await ctx.sessionPersistence.create(session.header), detach = ctx.sessions.enter(session); ctx.sessions.announce(session)
    session.append('model/selection', { provider: 'fixture', model: 'synthetic' })
    const attachments = []
    if (withAttachments) {
      const store = new LocalAttachmentStore(source, { dshHome: join(folder, 'old-attachment-home') })
      const file = Buffer.from('Synthetic native attachment R1\n'), image = await createRequire(join(process.env.LOOM_NATIVE_SMOKE_HARNESS, 'package.json'))('sharp')({ create: { width: 3, height: 2, channels: 4, background: { r: 30, g: 100, b: 80, alpha: 1 } } }).png().toBuffer()
      attachments.push({ type: 'file', attachment: await store.saveFile({ data: file, name: 'synthetic.txt' }) }, { type: 'image', attachment: await store.saveImage({ data: image, mediaType: 'image/png', name: 'synthetic.png' }) })
      await privateJSON('attachments-expected.json', attachments)
    }
    session.append('user/message', { id: 'stable-source-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic frozen migration history' }, ...attachments] }, { surfaceOp: 'append' })
    await ctx.sessions.flush(session); const saved = await writer.read(); detach(); await writer.close()
    const child = ctx.sessions.prepare(childId, { seed: [...saved.events], inheritedEventCount: SessionLogOffset(saved.events.length), meta: { cwd: workspacePath, agentPreset: 'fixture', isSeeded: true, parentSession: parentId } })
    const childWriter = await ctx.sessionPersistence.create(child.header, { inheritedEventCount: child.inheritedEventCount }); await childWriter.append(child.snapshotEvents()); await childWriter.close()
    await workspace.attachSession(parentId); await workspace.attachSession(childId)
    await ctx.workspaceRegistry.pinSession(parentId); await ctx.workspaceRegistry.archiveSession(childId)
    const persisted = await ctx.sessionPersistence.open(parentId, 'read')
    await privateJSON('source-expected.json', { header: persisted.header, workspaceId: workspace.id, sessionIds: [...workspace.sessionIds], inherited: child.inheritedEventCount, events: saved.events })
    await persisted.close()
  } finally { await source.fiber.dispose() }
  await privateJSON('source.json', { harnessRoot: process.env.LOOM_NATIVE_SMOKE_HARNESS, sessionRoot: join(folder, 'old-sessions'), metadataRoot: join(folder, 'old-metadata'), ...(withAttachments ? { attachmentHome: join(folder, 'old-attachment-home') } : {}), compression, contract })
  await privateJSON('company.json', { tenantId, spaceId: 'metadata-rc3-smoke', databaseUrlEnv: 'LOOM_DSH_B1_DATABASE_URL', harnessRoot: process.env.LOOM_NATIVE_SMOKE_HARNESS, attachmentHome })
  await writeFile(join(folder, 'freeze.txt'), 'Synthetic source is closed. Only this isolated frozen source can be imported.', { mode: 0o600 })
  const admin = (...args) => {
    const result = spawnSync(process.execPath, [join(folder, 'scripts', 'dsh-state-admin.mjs'), ...args], { env: process.env, encoding: 'utf8', timeout: 15_000 })
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout)
  }
  const common = ['--config', join(folder, 'company.json'), '--archive', archivePath]
  const exported = admin('export', ...common, '--source', join(folder, 'source.json'), '--evidence', join(folder, 'freeze.txt'))
  assert.equal(exported.attachments, withAttachments ? 2 : 0); assert.equal(exported.sessions, 2); assert.equal(exported.forks, 1)
  const dryRun = admin('dry-run', ...common); assert.equal(dryRun.sha256, exported.sha256)
  const imported = admin('import', ...common, '--apply', '--expected-sha256', exported.sha256, '--actor', 'synthetic-operator', '--evidence', join(folder, 'freeze.txt'))
  assert.equal(imported.executionEnabled, false)
} else {
  // Directory bytes are not the state authority; recreate only the same absolute scratch path.
  if (withAttachments) await rm(join(folder, 'old-attachment-home'), { recursive: true, force: true })
  await rm(workspacePath, { force: true, recursive: true }); await mkdir(workspacePath, { mode: 0o700 })
}
const root = new Context()
try {
  await nativeState(root, { tenantId, spaceId: 'metadata-rc3-smoke', databaseUrlEnv: 'LOOM_DSH_B1_DATABASE_URL' })
  await root.plugin(SessionStore); await root.plugin(Storage); await privateJSON('contract.json', contract)
  await root.inject(['storage', 'sessionPersistence'], async child => { await nativeMetadata(child, { contractFile: join(folder, 'contract.json'), units: ['workspace'] }); domains(child, { backend: 'loom-sql' }) })
  await mountWorkspace(root)
  const expected = JSON.parse(await readFile(join(folder, 'source-expected.json'), 'utf8')), workspaces = ctx.workspaceRegistry.list()
  assert.equal(workspaces.length, 1); assert.equal(workspaces[0].id, expected.workspaceId)
  assert.equal(workspaces[0].title, 'Synthetic migration workspace')
  assert.deepEqual([...workspaces[0].sessionIds], expected.sessionIds); assert.deepEqual([...ctx.workspaceRegistry.pinnedSessionIds], [parentId]); assert.deepEqual([...ctx.workspaceRegistry.archivedSessionIds], [childId])
  const handle = await ctx.sessionPersistence.open(parentId, 'read'), child = await ctx.sessionPersistence.open(childId, 'read')
  assert.deepEqual(handle.header, expected.header); assert.deepEqual((await handle.read()).events, expected.events); assert.equal(child.inheritedEventCount, expected.inherited)
  await handle.close(); await child.close()
  if (withAttachments) {
    const attached = new LocalAttachmentStore(root, { dshHome: attachmentHome }), refs = JSON.parse(await readFile(join(folder, 'attachments-expected.json'), 'utf8'))
    for (const entry of refs) {
      if (entry.type === 'image') assert.equal((await attached.readImage(entry.attachment)).data.byteLength, entry.attachment.bytes)
      else { const chunks = []; for await (const chunk of attached.readFileStream(entry.attachment)) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'Synthetic native attachment R1\n') }
    }
  }
  console.log(JSON.stringify({ phase, header: expected.header, workspaceId: workspaces[0].id, actualWorkspaceRegistry: true, exactForkCut: true,
    sourceExportedOnPrivateCopy: true, nativeAttachmentsVerified: withAttachments ? 2 : 0, compiledAdminDryRunAndImport: true, originalInputCount: expected.events.filter(event => event.type === 'user/message').length, modelCalls: 0 }))
} finally {
  // The native provider coordinates its metadata drain before its database can close.
  await root.fiber.dispose()
}
