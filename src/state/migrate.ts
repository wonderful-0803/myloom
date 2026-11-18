import { KV } from '../kv.ts'
/** Offline schema-11 importer. Frozen input is read-only; incomplete destinations cannot serve product traffic. */
import { DatabaseSync } from 'node:sqlite'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import type { Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../core/index.ts'
import type { ArtifactVersion } from '../app/artifacts.ts'
import type { TaskControlState } from '../app/task-control.ts'
import type { Receipt } from '../app/store.ts'
import { groupWorkspace } from '../group-mode.ts'
import { feishuKind } from '../sources/feishu.ts'
import { SettingsSchema } from '../policy.ts'
import { InstallationSchema } from './access.ts'
import type { Installation, SettingsRecord } from './access.ts'
import { artifactVersionId } from './artifacts.ts'
import type { ArtifactManifest, BlobCatalog } from './artifacts.ts'
import { bytesHash } from './blobs.ts'
import type { BlobRef, BlobStore } from './blobs.ts'
import type { DurableControl } from './controls.ts'
import { validateDocx } from './docx.ts'
import { hash } from './hash.ts'
import { kvOwner } from './kv.ts'
import { families, StateConflict, validateScope } from './ports.ts'
import type { Family, RecordIndex, StateScope, StateStore } from './ports.ts'
import type { DeliveryIntent } from './outbox.ts'

export interface MigrationMapping { scope: StateScope; installation: Installation; frozenSha256: string }
interface Entry { family: Family; id: string; value: unknown; index?: RecordIndex }
interface Prepared { report: MigrationReport; entries: Entry[]; bytes: Map<string, Buffer> }
export interface MigrationReport {
  format: 'loom-offline-migration-v1'; sourceSha256: string; mappingHash: string; datasetHash: string
  records: number; counts: Record<string, number>; blobs: number; blobBytes: number; heldEffects: number; unknownDeliveries: number
  ready: boolean; blockers: string[]
}
function validateMapping(mapping: MigrationMapping) {
  if (!/^[a-f0-9]{64}$/.test(mapping.frozenSha256)) throw new Error('Frozen backup SHA256 required')
  return { scope: validateScope(mapping.scope), installation: InstallationSchema.parse(mapping.installation), frozenSha256: mapping.frozenSha256 }
}
async function prepare(path: string, mapping: MigrationMapping): Promise<Prepared> {
  mapping = validateMapping(mapping)
  if ((await stat(path)).size > 100_000_000) throw new Error('Offline migration input exceeds 100 MB; partition it explicitly')
  for (const sidecar of ['-wal', '-shm']) {
    try { await stat(path + sidecar); throw new Error('Use a checkpointed frozen backup without WAL/SHM sidecars') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const sourceSha256 = bytesHash(await readFile(path))
  if (sourceSha256 !== mapping.frozenSha256) throw new StateConflict('Frozen backup digest changed')
  const uri = pathToFileURL(resolve(path)); uri.searchParams.set('immutable', '1')
  const db = new DatabaseSync(uri.href, { readOnly: true }), entries: Entry[] = [], bytes = new Map<string, Buffer>(), blockers: string[] = []
  const add = (family: Family, id: string, value: unknown, index?: RecordIndex) => entries.push({ family, id, value, ...(index ? { index } : {}) })
  let heldEffects = 0, unknownDeliveries = 0
  try {
    db.exec('BEGIN')
    const kv = new Map<string, unknown>(db.prepare('SELECT key,value FROM kv ORDER BY key').all().map(row => [String(row.key), JSON.parse(String(row.value)) as unknown]))
    if (kv.get('schema') !== 11) throw new Error('Importer requires legacy Loom schema 11')
    const settingsRevision = z.number().int().positive().parse(kv.get(KV.settings.revision))
    const currentSettings = kv.get(KV.settings.version(settingsRevision)) as { settings?: unknown; savedAt?: string }
    const settings = SettingsSchema.parse(currentSettings?.settings), group = groupWorkspace(settings)
    if (!feishuKind.schema.safeParse(settings.sources.feishu?.config ?? {}).success) blockers.push('Feishu source configuration must be valid before migration')
    if (group ? group.spaceId !== mapping.scope.spaceId || group.operator !== mapping.installation.operator
      : settings.policy.sources.feishu?.allowed.length !== 1 || settings.policy.sources.feishu.allowed[0]?.id !== mapping.installation.operator) blockers.push('Current workspace/owner does not match explicit target mapping')
    const read = <T>(table: string, id: string) => db.prepare(`SELECT ${id} AS id,value FROM ${table} ORDER BY ${id}`).all().map(row => ({ id: String(row.id), value: JSON.parse(String(row.value)) as T }))
    const triggers = read<Trigger>('trigger', 'id'), tickets = read<Ticket>('ticket', 'id'), threads = read<Thread>('thread', 'key'), decisions = read<Decision>('decision', 'id')
    const sourceIds = new Set(triggers.map(row => row.id)), ticketIds = new Set(tickets.map(row => row.id)), decisionIds = new Set(decisions.map(row => row.id))
    const triggerMap = new Map(triggers.map(row => [row.id, row.value]))
    if (triggers.some(({ value }) => group ? value.meta.loomSpace !== group.spaceId : !!value.meta.loomSpace)) blockers.push('Mixed personal/group history requires separate scoped migration plans')
    if (tickets.some(({ value }) => group ? value.mandate.basis.scope?.loomSpace !== group.spaceId : value.mandate.actor.id !== mapping.installation.operator || !!value.mandate.basis.scope?.loomSpace)) blockers.push('Task ownership is outside the mapped workspace')
    for (const row of triggers) add('trigger', row.id, row.value)
    for (const row of read<TriggerDisposition>('disposition', 'id')) {
      if (!sourceIds.has(row.id) || row.value.fanout.some(id => !ticketIds.has(id)) || row.value.decisionId && !decisionIds.has(row.value.decisionId)) blockers.push('A disposition references missing records')
      add('disposition', row.id, row.value)
    }
    for (const row of threads) {
      if ([...row.value.pending, ...row.value.evaluating?.triggerIds ?? []].some(id => !sourceIds.has(id)) || row.value.subscriptions.some(id => !ticketIds.has(id))) blockers.push('A thread references missing records')
      add('thread', row.id, row.value, { active: !!row.value.evaluating || !!row.value.pending.length })
    }
    const controls = new Map<string, DurableControl>()
    for (const row of tickets) {
      if (!sourceIds.has(row.value.origin.triggerId) || !decisionIds.has(row.value.decisionId)
        || row.value.inputs.some(input => input.kind === 'trigger' && !sourceIds.has(input.triggerId))) blockers.push('A task references missing records')
      const old = kv.get(KV.controls.task(row.id)) as TaskControlState | undefined
      const control: DurableControl = { mode: old?.mode ?? 'agent', revision: old?.revision ?? 0, drained: old?.drained ?? true,
        operations: (old?.operations ?? []).map(op => ({ id: `legacy-op/${op.id}`, status: 'unknown', at: Date.parse(op.startedAt) })),
        history: (old?.history ?? []).map(value => ({ revision: old?.revision ?? 0, actor: 'legacy-operator', action: value.action, at: Date.parse(value.at), ...(value.note ? { note: value.note } : {}) })) }
      if (control.operations.length || row.value.assignments.some(value => value.state === 'running')) {
        if (control.mode === 'agent') { control.mode = 'pausing'; control.revision++ }
        control.drained = false
      }
      controls.set(row.id, control)
      add('ticket', row.id, row.value, { relation: row.value.mandate.actor.id, active: row.value.undelivered.length > 0 || ['pending', 'running'].includes(row.value.assignments.at(-1)?.state ?? '') })
    }
    for (const row of decisions) {
      if (row.value.triggerIds.some(id => !sourceIds.has(id)) || row.value.ticketId && !ticketIds.has(row.value.ticketId)) blockers.push('A decision references missing records')
      add('decision', row.id, row.value, { relation: row.value.threadKey })
    }
    const catalogs = new Map<string, BlobCatalog>()
    const blob = (buffer: Buffer): BlobRef => {
      const ref = { sha256: bytesHash(buffer), byteLength: buffer.length }
      if (buffer.length > 2_000_000) throw new Error('Legacy artifact exceeds blob limit')
      bytes.set(ref.sha256, buffer)
      const catalog = catalogs.get(ref.sha256) ?? { ref, refs: 0, status: 'live' as const, updatedAt: Date.parse(mapping.installation.since), writers: [] }
      catalog.refs++; catalogs.set(ref.sha256, catalog); return ref
    }
    const versions = new Map<string, Set<number>>()
    for (const [name, value] of kv) {
      const owner = kvOwner(name)
      if (!owner) { blockers.push('Unmapped KV family requires explicit ownership registration'); continue }
      if (group && /^(codexHistory|codexDaily|drafts|feishu\.(mail|assistantFocus))\./.test(`${owner}.`)) blockers.push('Private KV records cannot be imported into a group workspace')
      if (group && owner.startsWith('results.') && (value as { binding?: unknown })?.binding) blockers.push('Private mailbox bindings cannot be imported into a group workspace')
      if (name.startsWith(KV.artifacts.version.prefix)) {
        const old = value as ArtifactVersion
        if (!old || bytesHash(Buffer.from(old.body)) !== old.hash || !old.sources.length || old.sources.some(ref => !sourceIds.has(ref.triggerId) || bytesHash(Buffer.from(triggerMap.get(ref.triggerId)!.text)) !== ref.hash)) { blockers.push('Artifact body/source digest mismatch'); continue }
        const manifest: ArtifactManifest = { subject: old.subject, kind: old.kind, title: old.title, version: old.version, author: old.author,
          at: old.at, body: blob(Buffer.from(old.body)), sources: old.sources, requirement: old.requirement, sourceHash: 'text-v1', ...(old.recording ? { recording: old.recording } : {}), ...(old.editedBy ? { editedBy: old.editedBy } : {}), ...(old.filename ? { filename: old.filename } : {}) }
        if (old.file) {
          const encoded = kv.get(KV.artifacts.file(old.file.sha256))
          if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) { blockers.push('Artifact binary is missing'); continue }
          const buffer = Buffer.from(encoded, 'base64')
          if (bytesHash(buffer) !== old.file.sha256 || buffer.length !== old.file.byteLength) { blockers.push('Artifact binary digest/length mismatch'); continue }
          validateDocx(buffer); manifest.file = old.file; manifest.fileBlob = blob(buffer); manifest.filename = old.file.filename
        }
        add('artifact-version', artifactVersionId(old.subject, old.version), manifest, { relation: old.subject })
        const set = versions.get(old.subject) ?? new Set<number>(); set.add(old.version); versions.set(old.subject, set)
        add('legacy', name, { ...old, body: undefined, movedBody: manifest.body }); continue
      }
      if (name.startsWith(KV.artifacts.file.prefix)) continue
      if (name.startsWith(KV.artifacts.head.prefix)) { add('artifact-head', name.slice(KV.artifacts.head.prefix.length), z.number().int().positive().parse(value)); continue }
      if (name.startsWith(KV.controls.task.prefix) || name.startsWith('settings-') || name === 'schema' || name.startsWith(KV.cards.grant.prefix)) { add('legacy', name, value); continue }
      if (owner === 'meetings.record' && typeof (value as { transcript?: unknown })?.transcript === 'string') {
        const old = value as { transcript: string; transcriptHash?: string }
        const buffer = Buffer.from(old.transcript)
        if (old.transcriptHash !== bytesHash(buffer)) blockers.push('Recording transcript digest mismatch')
        add('kv', name, { ...old, transcript: undefined, transcriptBlob: blob(buffer) }, { relation: owner }); continue
      }
      if (value && typeof value === 'object' && ['sending', 'drafting'].includes(String((value as { status?: unknown }).status))) {
        add('kv', name, { ...value, status: 'unknown', migrationReview: true }, { relation: owner }); continue
      }
      add('kv', name, value, { relation: owner })
    }
    for (const [subject, set] of versions) {
      const head = kv.get(KV.artifacts.head(subject))
      if (head !== set.size || [...set].some(version => version < 1 || version > set.size)) blockers.push('Artifact version chain is incomplete')
    }
    let order = 0
    for (const row of read<Receipt>('outbox', 'id')) {
      const { status, dropped, ...message } = row.value, token = `migration-${hash(row.id)}`
      const intent: DeliveryIntent = { message, parameterHash: hash(message), status: status === 'pending' ? 'unknown' : status, controlRevision: message.ticketId ? controls.get(message.ticketId)?.revision ?? 0 : 0, order: ++order,
        ...(status === 'pending' ? { token } : {}) }
      if (status === 'pending') {
        unknownDeliveries++
        const current = message.ticketId && controls.get(message.ticketId)
        if (current) {
          if (current.mode === 'agent') { current.mode = 'pausing'; current.revision++ }; current.drained = false
          current.operations.push({ id: `outbox:${row.id}:${token}`, status: 'unknown', at: Date.parse(mapping.installation.since) })
          intent.controlRevision = current.revision
        }
      }
      add('outbox', row.id, intent, { relation: message.ticketId, active: intent.status === 'unknown' })
      add('legacy', `outbox/${row.id}`, row.value)
    }
    for (const [id, value] of controls) add('control', id, value)
    for (const [id, value] of catalogs) add('blob', id, value)
    for (const row of db.prepare('SELECT * FROM effect ORDER BY seq,kind,key').all()) {
      add('legacy', `effect/${hash([row.kind, row.key])}`, JSON.parse(JSON.stringify(row))); heldEffects++
    }
    const record: SettingsRecord = { revision: settingsRevision, settings, actor: mapping.installation.operator, at: currentSettings.savedAt ?? mapping.installation.since }
    add('settings', 'current', record)
    for (const [name, value] of kv) if (/^settings-version:\d+$/.test(name)) {
      const old = value as { settings: unknown; savedAt?: string; at?: string }, revision = Number(name.split(':')[1])
      const history: SettingsRecord = { revision, settings: SettingsSchema.parse(old.settings), actor: mapping.installation.operator, at: old.savedAt ?? old.at ?? mapping.installation.since }
      add('settings', `version/${String(revision).padStart(12, '0')}`, history)
    }
    add('installation', mapping.installation.id, mapping.installation)
    for (const rule of settings.policy.rules.filter(value => value.delegation)) add('delegation', rule.id, rule, { relation: rule.delegation!.owner, active: rule.enabled })
    db.exec('COMMIT')
  } finally { db.close() }
  if (bytesHash(await readFile(path)) !== sourceSha256) throw new StateConflict('Frozen backup changed during inventory')
  if (new Set(entries.map(value => `${value.family}/${value.id}`)).size !== entries.length) blockers.push('Duplicate destination record identity')
  const counts: Record<string, number> = {}; for (const entry of entries) counts[entry.family] = (counts[entry.family] ?? 0) + 1
  const report: MigrationReport = { format: 'loom-offline-migration-v1', sourceSha256, mappingHash: hash(mapping), datasetHash: hash(entries), records: entries.length,
    counts, blobs: bytes.size, blobBytes: [...bytes.values()].reduce((sum, value) => sum + value.length, 0), heldEffects, unknownDeliveries,
    ready: blockers.length === 0, blockers: [...new Set(blockers)] }
  return { report, entries, bytes }
}
export async function migrationDryRun(path: string, mapping: MigrationMapping): Promise<MigrationReport> { return (await prepare(path, mapping)).report }
/** Explicit offline action, never called by application startup. Staged records stay unavailable until hash verification succeeds. */
export async function migrateLegacy(path: string, mapping: MigrationMapping, store: StateStore, blobs: BlobStore): Promise<MigrationReport> {
  const prepared = await prepare(path, mapping), { report, entries, bytes } = prepared, scope = validateScope(mapping.scope)
  if (!report.ready) throw new StateConflict(`Migration blocked: ${report.blockers.join('; ')}`)
  await store.transaction(scope, async tx => {
    const previous = await tx.get<{ datasetHash: string; status: string; executionEnabled?: boolean }>('migration', 'status')
    if (previous?.value.executionEnabled === true) throw new StateConflict('Activated state cannot be overwritten by an offline import')
    if (previous && previous.value.datasetHash !== report.datasetHash) throw new StateConflict('Destination belongs to another migration')
    if (!previous) {
      for (const family of families) if ((await tx.scan(family, { limit: 1, includeDeleted: true })).length) throw new StateConflict('Migration requires an empty destination scope')
      if ((await tx.jobs.list(1)).length) throw new StateConflict('Destination contains queued work')
      await tx.put('migration', 'status', { status: 'staging', datasetHash: report.datasetHash, sourceSha256: report.sourceSha256 }, 0)
    }
  })
  for (const [sha256, value] of bytes) {
    const written = await blobs.put(scope, value)
    if (written.sha256 !== sha256) throw new StateConflict('Blob import digest changed')
  }
  for (let offset = 0; offset < entries.length; offset += 100) {
    await store.transaction(scope, async tx => {
      for (const entry of entries.slice(offset, offset + 100)) {
        const current = await tx.get(entry.family, entry.id)
        if (current) { if (hash(current.value) !== hash(entry.value)) throw new StateConflict('Imported record differs from frozen snapshot'); continue }
        await tx.put(entry.family, entry.id, entry.value, 0, entry.index)
      }
    })
  }
  // Verify every value and binary before allowing any product service to read this scope.
  for (const [sha256, value] of bytes) await blobs.read(scope, { sha256, byteLength: value.length })
  for (let offset = 0; offset < entries.length; offset += 100) await store.transaction(scope, async tx => {
    for (const entry of entries.slice(offset, offset + 100)) if (hash((await tx.get(entry.family, entry.id))?.value) !== hash(entry.value)) throw new StateConflict('Post-import verification failed')
  })
  await store.transaction(scope, async tx => {
    const marker = (await tx.get('migration', 'status'))!
    await tx.put('migration', 'status', { status: 'ready', executionEnabled: false, datasetHash: report.datasetHash, sourceSha256: report.sourceSha256, report,
      heldEffects: true, note: 'Legacy effects are quarantined; reconcile native sessions and external receipts before explicit replay' }, marker.revision)
  })
  return report
}
/** Operator-only activation after native stop/flush and provider receipt reconciliation. Never automatic on startup. */
export async function activateMigration(store: StateStore, scope: StateScope, installationId: string, actor: string, evidence: string): Promise<void> {
  if (evidence.trim().length < 20) throw new Error('Concrete native-session and provider reconciliation evidence required')
  await store.transaction(scope, async tx => {
    const installation = InstallationSchema.parse((await tx.get('installation', installationId))?.value)
    if (installation.operator !== actor || !installation.enabled) throw new StateConflict('Migration operator mismatch')
    const marker = await tx.get<{ status: string; executionEnabled?: boolean }>('migration', 'status')
    if (!marker || marker.value.status !== 'ready') throw new StateConflict('Migration verification has not completed')
    for (const family of ['control', 'outbox', 'kv', 'source-state'] as const) {
      let after: string | undefined
      do {
        const rows = await tx.scan<DurableControl | DeliveryIntent>(family, { after, limit: 100 })
        if (rows.some(({ value }) => family === 'control' ? (value as DurableControl).operations.length > 0 || !(value as DurableControl).drained
          : ['sending', 'drafting', 'unknown'].includes((value as DeliveryIntent).status))) throw new StateConflict('Unresolved execution or delivery outcomes prevent activation')
        after = rows.length === 100 ? rows.at(-1)!.id : undefined
      } while (after)
    }
    await tx.put('migration', marker.id, { ...marker.value, executionEnabled: true, activation: { actor, evidence, at: new Date(await tx.now()).toISOString() } }, marker.revision)
  })
}
