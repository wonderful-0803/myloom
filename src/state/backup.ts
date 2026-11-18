import { nativeAttachmentReferences, checkedArchiveAttachments } from '../dsh-state/attachments.ts'
import type { ArchiveAttachment, NativeAttachmentIO, NativeAttachmentReference } from '../dsh-state/attachments.ts'
import { KV } from '../kv.ts'
/** Portable scoped rollback snapshots. All record revisions, unknown outcomes and queued request sequences are retained. */
import { mkdir, readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from './blobs.ts'
import { LocalBlobStore, bytesHash } from './blobs.ts'
import type { BlobCatalog } from './artifacts.ts'
import { ProductAccess } from './access.ts'
import { families, StateConflict } from './ports.ts'
import type { Family, Job, RecordIndex, StateRecord, StateScope, StateStore } from './ports.ts'
import { hash } from './hash.ts'
import { unitLeaseId } from '../dsh-state/metadata.ts'
import { assertNativeReady } from '../dsh-state/catalog.ts'
interface SavedRecord extends StateRecord<unknown> { family: Family; index?: RecordIndex }
export interface NativeBackupIO extends NativeAttachmentIO { read(entry: NativeAttachmentReference): Promise<Buffer> }
interface Snapshot { nativeAttachments?: ArchiveAttachment[]; format: 'loom-external-state-v1'; scope: StateScope; installationId: string; records: SavedRecord[]; jobs: Job[]; sha256: string; at: string }
function index(record: SavedRecord): RecordIndex {
  if (record.index) return record.index
  const value = record.value as Record<string, any>
  if (record.family === 'ticket') return { relation: value.mandate.actor.id, active: value.undelivered.length > 0 || ['pending', 'running'].includes(value.assignments.at(-1)?.state) }
  if (record.family === 'thread') return { active: !!value.evaluating || !!value.pending.length }
  if (record.family === 'decision') return { relation: value.threadKey }
  if (record.family === 'artifact-version') return { relation: value.subject }
  if (record.family === 'outbox') return { relation: value.message.ticketId, active: ['pending', 'sending', 'unknown'].includes(value.status) }
  if (record.family === 'blob') return { active: value.refs === 0 }
  if (record.family === 'delegation') return { relation: value.delegation.owner, active: value.enabled }
  if (record.family === 'kv') {
    if (record.id.startsWith(KV.results.receipt.prefix)) return { relation: 'results.receipt', active: ['queued', 'sending', 'unknown'].includes(value.status) }
    if (record.id.startsWith(KV.results.setting.prefix)) return { relation: 'results.setting' }
  }
  return record.index ?? {}
}
/** Requires stopped consumers. The private archive is data, not a runnable copy of the compute directory. */
export async function exportExternalState(store: StateStore, scope: StateScope, blobs: BlobStore, directory: string, installationId: string, actor: string, native?: NativeBackupIO): Promise<{ records: number; blobs: number; sha256: string }> {
  await mkdir(directory, { mode: 0o700 })
  const payload = await store.transaction(scope, async tx => {
    await new ProductAccess(installationId).user(tx, actor, true)
    await assertNativeReady(tx)
    const leases = await Promise.all(['source', 'subscription'].map(kind => tx.leases.current(`${kind}/${installationId}`)))
    const now = await tx.now()
    if (await tx.jobs.hasClaims() || leases.some(lease => lease && lease.until > now)) throw new StateConflict('Stop the source and all consumers before exporting rollback state')
    const jobs = await tx.jobs.list(1000)
    if (jobs.length === 1000) throw new StateConflict('Partition the job queue before exporting; refusing a truncated backup')
    const records: SavedRecord[] = []
    for (const family of families.filter(value => value !== 'auth-session')) {
      let after: string | undefined
      do {
        const page = await tx.scan(family, { after, limit: 100, includeIndex: true, includeDeleted: true })
        if (family === 'native-session') for (const record of page) {
          const writer = await tx.leases.current(record.id)
          if (writer && writer.until > await tx.now()) throw new StateConflict('Close all native Session writers before exporting rollback state')
        }
        if (family === 'native-unit') for (const record of page) {
          const writer = await tx.leases.current(unitLeaseId(record.id))
          if (writer && writer.until > await tx.now()) throw new StateConflict('Close all native metadata owners before exporting rollback state')
        }
        for (const record of page) records.push({ ...record, family })
        after = page.length === 100 ? page.at(-1)!.id : undefined
      } while (after)
    }
    return { format: 'loom-external-state-v1' as const, scope, installationId, records, jobs, at: new Date(await tx.now()).toISOString() }
  })
  const nativeAttachments: ArchiveAttachment[] = [], nativeEvents = payload.records.filter(record => record.family === 'native-event').map(record => JSON.parse((record.value as { eventJSON: string }).eventJSON))
  const references = nativeAttachmentReferences(nativeEvents)
  if (references.length && !native) throw new StateConflict('Native attachments require an explicit persistent-store backup adapter')
  for (const entry of references) nativeAttachments.push({ ...entry, data: (await native!.read(entry)).toString('base64') })
  checkedArchiveAttachments(nativeEvents, nativeAttachments)
  const completePayload = { ...payload, ...(nativeAttachments.length ? { nativeAttachments } : {}) }
  if (Buffer.byteLength(JSON.stringify(completePayload)) > 100_000_000) throw new StateConflict('Backup exceeds restore budget; partition the state before exporting')
  const target = await LocalBlobStore.open(join(directory, 'objects')); let copied = 0
  for (const record of payload.records.filter(value => value.family === 'blob')) {
    const catalog = record.value as BlobCatalog
    if (catalog.refs) { await target.put(scope, await blobs.read(scope, catalog.ref)); copied++ }
  }
  const sha256 = hash(completePayload), snapshot: Snapshot = { ...completePayload, sha256 }
  const file = await open(join(directory, 'state.json'), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(snapshot)); await file.sync() } finally { await file.close() }
  const folder = await open(directory, 'r'); try { await folder.sync() } finally { await folder.close() }
  return { records: payload.records.length, blobs: copied, sha256 }
}
export async function restoreExternalState(store: StateStore, scope: StateScope, blobs: BlobStore, directory: string, native?: NativeBackupIO): Promise<void> {
  const raw = await readFile(join(directory, 'state.json'))
  if (raw.length > 100_000_000) throw new Error('Backup exceeds restore budget')
  const { sha256, ...payload } = JSON.parse(raw.toString('utf8')) as Snapshot
  if (payload.format !== 'loom-external-state-v1' || hash(payload) !== sha256 || hash(payload.scope) !== hash(scope)) throw new StateConflict('Backup digest or explicit target scope mismatch')
  const nativeEvents = payload.records.filter(record => record.family === 'native-event').map(record => JSON.parse((record.value as { eventJSON: string }).eventJSON))
  checkedArchiveAttachments(nativeEvents, payload.nativeAttachments)
  if (payload.nativeAttachments?.length && !native) throw new StateConflict('Native attachment restore adapter is required')
  for (const entry of payload.nativeAttachments ?? []) await native!.validate(entry)
  const snapshotBlobs = await LocalBlobStore.open(join(directory, 'objects'))
  for (const record of payload.records.filter(value => value.family === 'blob')) {
    const catalog = record.value as BlobCatalog
    if (catalog.refs) {
      const bytes = await snapshotBlobs.read(scope, catalog.ref)
      if (bytesHash(bytes) !== catalog.ref.sha256) throw new StateConflict('Backup blob digest mismatch')
      await blobs.put(scope, bytes)
    }
  }
  await store.transaction(scope, async tx => {
    for (const family of families) if ((await tx.scan(family, { limit: 1, includeDeleted: true })).length) throw new StateConflict('Restore requires an empty destination')
    if ((await tx.jobs.list(1)).length || await tx.jobs.hasClaims()) throw new StateConflict('Restore destination has queued work')
    await tx.put('migration', 'status', { status: 'staging', executionEnabled: false, snapshot: sha256 }, 0)
  })
  for (const entry of payload.nativeAttachments ?? []) { await native!.put(entry); await native!.verify(entry) }
  for (let offset = 0; offset < payload.records.length; offset += 100) await store.transaction(scope, async tx => {
    for (const record of payload.records.slice(offset, offset + 100)) {
      if (record.family === 'migration' && record.id === 'status') { await tx.restore('legacy', `previous-migration-status/${sha256}`, record.value, record.revision); continue }
      if (!families.includes(record.family) || record.family === 'auth-session') throw new StateConflict('Unexpected backup record family')
      await tx.restore(record.family, record.id, record.value, record.revision, index(record), record.deleted)
    }
  })
  await store.transaction(scope, async tx => {
    for (const job of payload.jobs) await tx.jobs.restore(job)
    const marker = (await tx.get('migration', 'status'))!
    await tx.put('migration', 'status', { status: 'ready', executionEnabled: false, snapshot: sha256, authSessionsExpired: true }, marker.revision)
  })
}
