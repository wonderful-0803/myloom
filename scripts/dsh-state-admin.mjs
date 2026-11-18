#!/usr/bin/env node
/** Native offline administration. Explicit frozen roots only; no personal profile discovery, inference or channels. */
import { readFile, lstat, realpath, readdir, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { sealNativeArchive, nativeArchiveReport, importNativeArchive, RecoveryContractSchema } from '../lib/dsh-metadata.js'
import { attachmentIO } from './native-attachment-io.mjs'
import { nativeAttachmentReferences } from '../lib/dsh-metadata.js'
import { PostgresStateStore } from '../lib/state.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, source: { type: 'string' }, archive: { type: 'string' }, actor: { type: 'string' }, evidence: { type: 'string' },
  'expected-sha256': { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean' }
} })
const sha = value => createHash('sha256').update(value).digest('hex')
async function privateRead(path, max = 160_000, json = true) {
  if (!path || !isAbsolute(path)) throw new Error('Private absolute file required')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > max || await realpath(path) !== resolve(path)) throw new Error('Unsafe private input file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const text = await file.readFile('utf8'); if (Buffer.byteLength(text) > max) throw new Error('Private file exceeds budget'); return json ? JSON.parse(text) : text } finally { await file.close() }
}
/** Fingerprint before and after; only private copies are ever mounted by the upstream readers. */
async function frozenTree(root, target, only, internalLinks = false) {
  if (!isAbsolute(root) || await realpath(root) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('Explicit canonical frozen directory required')
  const files = [], links = new Map(); let total = 0, count = 0
  async function visit(relative = '') {
    for (const item of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && only && !only.includes(item.name)) continue
      // POSIX JSONL leaves an ordinary session.lock inode after flock release; its mere presence is not an active lock.
      if (++count > 20_000 || item.isDirectory() && item.name.endsWith('.lock') || item.name === '.git') throw new Error('Source is locked or exceeds frozen snapshot budget')
      const key = relative ? `${relative}/${item.name}` : item.name, path = join(root, key), before = await lstat(path)
      if (before.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('Frozen source must not contain symlinks')
      if (before.isDirectory()) { if (target) await mkdir(join(target, key), { recursive: true, mode: 0o700 }); await visit(key); continue }
      if (!before.isFile() || !internalLinks && before.nlink !== 1 || (total += before.size) > 200_000_000) throw new Error('Unsafe or oversized frozen source')
      if (internalLinks) { const id = `${before.dev}/${before.ino}`, value = links.get(id) ?? { count: 0, expected: before.nlink }; value.count++; if (value.expected !== before.nlink) throw new Error('Frozen hardlink set changed'); links.set(id, value) }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes
      try { bytes = await handle.readFile(); const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('Frozen source changed while reading') }
      finally { await handle.close() }
      files.push([key, sha(bytes)])
      if (target) { const dest = await open(join(target, key), 'wx', 0o600); try { await dest.writeFile(bytes) } finally { await dest.close() } }
    }
  }
  if (target) await mkdir(target, { recursive: true, mode: 0o700 })
  await visit(); if ([...links.values()].some(value => value.count !== value.expected)) throw new Error('Attachment hardlink escapes the selected frozen tree'); return sha(JSON.stringify(files))
}
async function exportFrozen(config, source, evidence) {
  if (Object.keys(source).some(key => !['harnessRoot', 'sessionRoot', 'metadataRoot', 'attachmentHome', 'compression', 'contract'].includes(key))) throw new Error('Unexpected source mapping field')
  const contract = RecoveryContractSchema.parse(source.contract), root = source.harnessRoot
  if (!root || !isAbsolute(root)) throw new Error('Explicit installed Harness root required')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.1-rc.3') throw new Error('Native exporter is pinned to Harness rc.3')
  const actual = createRequire(join(root, 'package.json')), load = name => import(pathToFileURL(actual.resolve(`@deepseek-ai/${name}`)).href)
  const [{ Context }, jsonl, json] = await Promise.all([load('cordis'), load('dsh-session-persistence-jsonl'), load('dsh-storage-json')])
  const folder = await mkdtemp(join(tmpdir(), 'loom-native-frozen-')), sessionCopy = join(folder, 'sessions'), metadataCopy = join(folder, 'metadata')
  let ctx, backend, attached
  try {
    const sessionsHash = await frozenTree(source.sessionRoot, sessionCopy), units = []
    const attachmentHash = source.attachmentHome ? await frozenTree(source.attachmentHome, join(folder, 'attachment-home'), ['attachments'], true) : null
    const metadataHash = source.metadataRoot ? await frozenTree(source.metadataRoot, metadataCopy, ['workspace.json']) : null
    if (source.metadataRoot && !(await readdir(metadataCopy)).includes('workspace.json')) throw new Error('Frozen workspace snapshot is absent')
    ctx = new Context(); await jsonl.apply(ctx, { root: sessionCopy, compression: source.compression ?? 'zstd' })
    const sessions = []
    for (const snapshot of await ctx.sessionPersistence.list()) {
      if (snapshot.formatStatus !== 'current') throw new Error('Migrate legacy Session formats with upstream tools before freezing')
      const handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
      try {
        const events = []
        for (;;) { const part = await handle.read(events.length, 512); events.push(...part.events); if (!part.events.length) break }
        sessions.push({ header: handle.header, inheritedEventCount: handle.inheritedEventCount, events })
      } finally { await handle.close() }
    }
    if (source.metadataRoot) {
      backend = new json.JsonStorageBackend(metadataCopy)
      const descriptor = { name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true, layout: 'single' }
      const unit = await backend.kv.open(descriptor)
      try { units.push({ descriptor, snapshot: await unit.loadAll() }) } finally { await unit.close() }
    }
    const attachments = [], refs = nativeAttachmentReferences(sessions.map(entry => entry.events))
    if (refs.length) {
      if (!source.attachmentHome) throw new Error('Selected history references attachments; map the explicit frozen attachmentHome')
      attached = await attachmentIO(root, join(folder, 'attachment-home'))
      for (const ref of refs) attachments.push({ ...ref, data: (await attached.read(ref)).toString('base64') })
    }
    const afterAttachments = source.attachmentHome ? await frozenTree(source.attachmentHome, undefined, ['attachments'], true) : null
    const afterSessions = await frozenTree(source.sessionRoot), afterMetadata = source.metadataRoot ? await frozenTree(source.metadataRoot, undefined, ['workspace.json']) : null
    if (sessionsHash !== afterSessions || metadataHash !== afterMetadata || attachmentHash !== afterAttachments) throw new Error('Frozen source changed; export rejected')
    // Evidence is kept by the operator, never mixed into the conversation log or turned into an execution grant.
    if (evidence.trim().length < 20) throw new Error('Concrete stopped-source evidence required')
    return sealNativeArchive({ format: attachments.length ? 'loom-dsh-archive-v2' : 'loom-dsh-archive-v1', ...(attachments.length ? { attachments } : {}), scope: { tenantId: config.tenantId, spaceId: config.spaceId },
      sourceFingerprint: sha(JSON.stringify([sessionsHash, metadataHash, attachmentHash])), contract, sessions, units })
  } finally { await attached?.close(); await backend?.close(); await ctx?.fiber.dispose(); await rm(folder, { recursive: true, force: true }) }
}
async function main() {
  const action = positionals[0] ?? 'dry-run'
  if (values.help) { console.log('Build first. Commands: export, dry-run, import\n--config /private/company.json --archive /private/native.json\nexport additionally needs --source /private/frozen-source.json --evidence /private/freeze.txt\nimport additionally needs --apply --expected-sha256 HASH --actor ID --evidence /private/freeze.txt\nOnly explicitly mapped frozen sources are read. Referenced native file/image bytes are included and verified by the pinned codec. No model calls, listeners, credentials or workspace-directory migration.'); return }
  if (!['export', 'dry-run', 'import'].includes(action)) throw new Error('Unknown native administration command')
  const config = await privateRead(values.config)
  if (action === 'export') {
    if (!values.archive || !isAbsolute(values.archive) || await realpath(dirname(values.archive)) !== resolve(dirname(values.archive)) || (await lstat(dirname(values.archive))).mode & 0o077) throw new Error('Private canonical output directory required')
    const archive = await exportFrozen(config, await privateRead(values.source), await privateRead(values.evidence, 160_000, false))
    const file = await open(values.archive, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(archive)); await file.sync() } finally { await file.close() }
    const folder = await open(dirname(values.archive), 'r'); try { await folder.sync() } finally { await folder.close() }
    console.log(JSON.stringify(nativeArchiveReport(archive), null, 2)); return
  }
  const archive = await privateRead(values.archive, 100_000_000), report = nativeArchiveReport(archive)
  if (report.scope.tenantId !== config.tenantId || report.scope.spaceId !== config.spaceId) throw new Error('Native target scope mismatch')
  if (action === 'dry-run' || !values.apply) {
    if (archive.attachments?.length) {
      const stage = await mkdtemp(join(tmpdir(), 'loom-native-dry-run-')); let attached
      try { attached = await attachmentIO(config.harnessRoot, stage); for (const entry of archive.attachments) await attached.io.validate(entry) }
      finally { await attached?.close(); await rm(stage, { recursive: true, force: true }) }
    }
    console.log(JSON.stringify({ action: 'dry-run', ...report }, null, 2)); return }
  if (!/^LOOM_[A-Z0-9_]+$/.test(config.databaseUrlEnv) || !process.env[config.databaseUrlEnv]) throw new Error('Explicit native database environment required')
  const evidence = await privateRead(values.evidence, 160_000, false)
  if (values['expected-sha256'] !== report.sha256 || !values.actor?.trim() || evidence.trim().length < 20) throw new Error('Explicit reviewed import digest, operator and stopped-source evidence required')
  let attached
  if (archive.attachments?.length) attached = await attachmentIO(config.harnessRoot, config.attachmentHome)
  const store = await PostgresStateStore.open({ connectionString: process.env[config.databaseUrlEnv] })
  try { console.log(JSON.stringify(await importNativeArchive(store, report.scope, archive, { expectedSha256: values['expected-sha256'], actor: values.actor,
    evidence, ...(attached ? { attachments: attached.io } : {}) }), null, 2)) } finally { await store.close(); await attached?.close() }
}
await main().catch(error => { console.error('Native state operation failed. Check the frozen copy, private paths, pinned contract, archive digest, paused destination and source evidence. No compute or channel operation was started.'); process.exitCode = 1 })
