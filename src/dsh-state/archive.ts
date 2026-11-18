/** Explicit offline native import. Archives are data, never configurations to execute or grants to resume work. */
import { checkedArchiveAttachments } from './attachments.ts'
import type { ArchiveAttachment, NativeAttachmentIO } from './attachments.ts'
import { randomUUID } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { assertContiguous } from '@deepseek-ai/dsh-session-persistence'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import type { Family, SessionLease, StateScope, StateStore, StateTransaction } from '../state/ports.ts'
import { StateConflict, validateScope } from '../state/ports.ts'
import { canonical, hash } from '../state/hash.ts'
import { RecoveryContractSchema, pinEnvironment } from './catalog.ts'
import type { RecoveryContract } from './catalog.ts'
import { checkedEvents, cut, eventKey, headerSnapshot, logEvents, logRecord, storedLog } from './storage.ts'
import { descriptorSnapshot, storedUnitValue, unitLeaseId, unitRecordId } from './metadata.ts'

export interface ArchiveSession { header: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }
export interface ArchiveUnit { descriptor: KvUnitDescriptor; snapshot: { tables: Record<string, Record<string, unknown>>; global: unknown } }
export interface NativeArchive {
  format: 'loom-dsh-archive-v1' | 'loom-dsh-archive-v2'; scope: StateScope; sourceFingerprint: string; contract: RecoveryContract
  sessions: ArchiveSession[]; units: ArchiveUnit[]; attachments?: ArchiveAttachment[]; sha256: string
}
const hashText = z.string().regex(/^[a-f0-9]{64}$/)
const Shape = z.object({ format: z.enum(['loom-dsh-archive-v1', 'loom-dsh-archive-v2']), scope: z.object({ tenantId: z.string(), spaceId: z.string() }).strict(),
  sourceFingerprint: hashText, contract: RecoveryContractSchema, sessions: z.array(z.object({ header: z.unknown(), inheritedEventCount: z.number().int().nonnegative(), events: z.array(z.unknown()) }).strict()).max(5000),
  units: z.array(z.object({ descriptor: z.unknown(), snapshot: z.object({ tables: z.record(z.string(), z.record(z.string(), z.unknown())), global: z.unknown() }).strict() }).strict()).max(1), attachments: z.array(z.unknown()).max(5000).optional(), sha256: hashText }).strict()
const absolute = (value: string) => isAbsolute(value) || win32.isAbsolute(value)
const WorkspaceRecord = z.object({ path: z.string().refine(absolute), title: z.string(), sessionIds: z.array(z.string()), createdAt: z.string(), updatedAt: z.string() }).strict()
const WorkspaceGlobal = z.object({ initialized: z.literal(true), defaultWorkspaceId: z.string().optional(), workspaceIds: z.array(z.string()),
  archivedSessionIds: z.array(z.string()).default([]), pinnedSessionIds: z.array(z.string()).default([]) }).strict()
/** Seal only explicit scoped data; a checksum detects accidents, it is not an authorization signature. */
export function sealNativeArchive(input: Omit<NativeArchive, 'sha256'>): NativeArchive {
  return validateNativeArchive({ ...input, sha256: hash(input) })
}
export function validateNativeArchive(input: unknown): NativeArchive {
  const serialized = canonical(input)
  if (Buffer.byteLength(serialized) > 100_000_000) throw new StateConflict('Native archive exceeds offline import budget')
  const parsed = Shape.parse(JSON.parse(serialized)), { sha256, ...payload } = parsed
  if (hash(payload) !== sha256) throw new StateConflict('Native archive digest mismatch')
  const archive = parsed as NativeArchive; validateScope(archive.scope)
  const sessions = new Map<string, ArchiveSession>()
  for (const entry of archive.sessions) {
    entry.header = headerSnapshot(entry.header); cut(entry.header, entry.inheritedEventCount)
    if (sessions.has(entry.header.id) || entry.inheritedEventCount > entry.events.length) throw new StateConflict('Native archive duplicate Session or invalid fork cut')
    assertContiguous(entry.header.id, entry.events, 0); checkedEvents(entry.header, entry.events)
    if (entry.header.agentPreset && !Object.hasOwn(archive.contract.presets, entry.header.agentPreset)) throw new StateConflict('Native archive preset is absent from recovery contract')
    for (const event of entry.events) if (event.type === 'model/selection' && !archive.contract.models.some(model => model.provider === event.data.provider && model.model === event.data.model))
      throw new StateConflict('Native archive model is absent from recovery contract')
    sessions.set(entry.header.id, entry)
  }
  if (archive.format === 'loom-dsh-archive-v1' && archive.attachments) throw new StateConflict('Native attachment migration requires archive v2')
  checkedArchiveAttachments(archive.sessions.map(entry => entry.events), archive.attachments)
  for (const entry of sessions.values()) {
    const seen = new Set<string>([entry.header.id]); let parent = entry.header.parentSession
    while (parent) { if (seen.has(parent) || !sessions.has(parent)) throw new StateConflict('Native archive lineage is cyclic or incomplete'); seen.add(parent); parent = sessions.get(parent)!.header.parentSession }
    if (entry.header.isSeeded && entry.header.parentSession) {
      const prefix = sessions.get(entry.header.parentSession)!.events.slice(0, entry.inheritedEventCount)
      if (prefix.length !== entry.inheritedEventCount || hash(prefix) !== hash(entry.events.slice(0, entry.inheritedEventCount))) throw new StateConflict('Native fork inherited prefix differs from parent')
    }
  }
  for (const unit of archive.units) {
    const descriptor = descriptorSnapshot(unit.descriptor)
    if (descriptor.name !== 'workspace' || descriptor.version !== 2 || descriptor.layout !== 'single' || !descriptor.hasGlobal || hash(descriptor.tables) !== hash(['workspaces']))
      throw new StateConflict('Only the pinned workspace v2 domain is importable; caches rebuild, schedules require a separate protocol')
    if (hash(Object.keys(unit.snapshot.tables)) !== hash(['workspaces'])) throw new StateConflict('Native archive workspace tables differ')
    const records = unit.snapshot.tables.workspaces!, global = WorkspaceGlobal.parse(unit.snapshot.global)
    if (new Set(global.workspaceIds).size !== global.workspaceIds.length || hash([...global.workspaceIds].sort()) !== hash(Object.keys(records).sort())) throw new StateConflict('Native workspace order/account mismatch')
    const owned = new Set<string>(), paths = new Set<string>()
    for (const raw of Object.values(records)) {
      const value = WorkspaceRecord.parse(raw)
      if (paths.has(value.path)) throw new StateConflict('Native workspace has duplicate canonical paths')
      paths.add(value.path)
      for (const id of value.sessionIds) {
        if (owned.has(id) || !sessions.has(id) || sessions.get(id)!.header.cwd !== value.path) throw new StateConflict('Native workspace Session ownership/cwd mismatch')
        owned.add(id)
      }
    }
    for (const ids of [global.archivedSessionIds, global.pinnedSessionIds]) if (new Set(ids).size !== ids.length || ids.some(id => !sessions.has(id))) throw new StateConflict('Native workspace session set is invalid')
    if (global.pinnedSessionIds.some(id => global.archivedSessionIds.includes(id))) throw new StateConflict('Native Session cannot be archived and pinned')
    // pendingMutation is deliberately rejected: finish/recover the old registry before freezing its snapshot.
    unit.descriptor = descriptor
  }
  // Preserve the original serialized descriptor exactly; normalizing it would silently invalidate the archive checksum.
  return Shape.parse(JSON.parse(serialized)) as NativeArchive
}
export function nativeArchiveReport(input: unknown) {
  const archive = validateNativeArchive(input)
  return { format: archive.format, scope: archive.scope, sha256: archive.sha256, sourceFingerprint: archive.sourceFingerprint,
    sessions: archive.sessions.length, events: archive.sessions.reduce((count, entry) => count + entry.events.length, 0), forks: archive.sessions.filter(entry => entry.header.isSeeded).length,
    units: archive.units.map(unit => ({ name: unit.descriptor.name, version: unit.descriptor.version, records: Object.values(unit.snapshot.tables).reduce((count, rows) => count + Object.keys(rows).length, 0) })),
    attachments: archive.attachments?.length ?? 0, attachmentBytes: (archive.attachments ?? []).reduce((count, entry) => count + entry.ref.bytes, 0),
    originalHeadersPreserved: true, directoryContentsCopied: false, credentialConfigurationImported: false, executionEnabled: false }
}
interface ImportMarker { status: 'staging' | 'ready'; sha256: string; sourceFingerprint: string; actor: string }
interface PlannedRow { family: Family; id: string; value: unknown; relation?: string }
/** Import into an empty native namespace, or resume this exact interrupted archive; never overwrite a healthy destination. */
export async function importNativeArchive(store: StateStore, scope: StateScope, input: unknown, options: { expectedSha256: string; actor: string; evidence: string; attachments?: NativeAttachmentIO }): Promise<ReturnType<typeof nativeArchiveReport>> {
  const archive = validateNativeArchive(input)
  if (hash(scope) !== hash(archive.scope) || options.expectedSha256 !== archive.sha256 || !options.actor?.trim() || options.evidence?.trim().length < 20) throw new StateConflict('Explicit native target, expected digest, operator and freeze evidence required')
  if (archive.attachments?.length && !options.attachments) throw new StateConflict('Native attachment destination and verifier are required')
  for (const entry of archive.attachments ?? []) await options.attachments!.validate(entry)
  const markerId = 'native-import', leaseId = 'native-import', owner = randomUUID()
  const paused = async (tx: StateTransaction) => {
    const settings = await tx.get<{ settings: { paused: boolean } }>('settings', 'current')
    if (settings && !settings.value.settings.paused || await tx.jobs.hasClaims()) throw new StateConflict('Pause and stop the company runtime before native migration')
  }
  const lease = await store.transaction(scope, async tx => {
    await paused(tx)
    const previous = await tx.get<ImportMarker>('migration', markerId)
    if (previous && previous.value.sha256 !== archive.sha256) throw new StateConflict('A different native archive already owns this destination')
    if (!previous) {
      for (const family of ['native-session', 'native-event', 'native-unit', 'native-record'] as const)
        if ((await tx.scan(family, { limit: 1, includeDeleted: true })).length) throw new StateConflict('Native import requires an empty native namespace')
    }
    for (const entry of archive.sessions) { const current = await tx.leases.current(entry.header.id); if (current && current.until > await tx.now()) throw new StateConflict('Native Session writer is still active') }
    for (const unit of archive.units) { const current = await tx.leases.current(unitLeaseId(unit.descriptor.name)); if (current && current.until > await tx.now()) throw new StateConflict('Native metadata owner is still active') }
    await pinEnvironment(tx, archive.contract)
    const lease = await tx.leases.acquire(leaseId, owner, 30_000)
    if (!lease) throw new StateConflict('Another native import is running')
    if (!previous) await tx.put('migration', markerId, { status: 'staging', sha256: archive.sha256, sourceFingerprint: archive.sourceFingerprint, actor: options.actor } satisfies ImportMarker, 0)
    return lease
  })
  const rows: PlannedRow[] = []
  for (const entry of archive.sessions) {
    rows.push({ family: 'native-session', id: entry.header.id, value: storedLog({ format: 'loom-dsh-session-v1', header: entry.header, headerHash: hash(entry.header), inheritedEventCount: entry.inheritedEventCount, eventCount: entry.events.length }) })
    for (const event of entry.events) rows.push({ family: 'native-event', id: eventKey(entry.header.id, event.seq), value: { sessionId: entry.header.id, eventJSON: JSON.stringify(event), sha256: hash(event) }, relation: hash(entry.header.id) })
  }
  for (const unit of archive.units) {
    const descriptor = descriptorSnapshot(unit.descriptor)
    rows.push({ family: 'native-unit', id: descriptor.name, value: { format: 'loom-dsh-kv-v1', descriptor } })
    const add = (table: string, key: string, value: unknown) => rows.push({ family: 'native-record', id: unitRecordId(descriptor.name, table, key), value: storedUnitValue(table, key, descriptor.version, value), relation: descriptor.name })
    for (const [table, records] of Object.entries(unit.snapshot.tables)) for (const [key, value] of Object.entries(records)) add(table, key, value)
    if (descriptor.hasGlobal && unit.snapshot.global !== null) add('', '', unit.snapshot.global)
  }
  const check = async (tx: StateTransaction) => {
    await paused(tx); await tx.leases.assert(lease)
    const marker = (await tx.get<ImportMarker>('migration', markerId))!
    if (marker.value.sha256 !== archive.sha256) throw new StateConflict('Native import marker changed')
    await tx.leases.renew(lease, 30_000)
  }
  try {
    for (const entry of archive.attachments ?? []) {
      await store.transaction(scope, check); await options.attachments!.put(entry); await options.attachments!.verify(entry); await store.transaction(scope, check)
    }
    for (let offset = 0; offset < rows.length; offset += 100) await store.transaction(scope, async tx => {
      await check(tx)
      for (const row of rows.slice(offset, offset + 100)) {
        const old = await tx.get(row.family, row.id)
        if (old && hash(old.value) !== hash(row.value)) throw new StateConflict('Interrupted native import contents differ; refusing overwrite')
        if (!old) await tx.put(row.family, row.id, row.value, 0, row.relation ? { relation: row.relation } : undefined)
      }
    })
    for (const unit of archive.units) await store.transaction(scope, async tx => {
      await check(tx)
      const expected = rows.filter(row => row.family === 'native-record' && row.relation === unit.descriptor.name).map(row => row.id).sort(), actual: string[] = []
      let after: string | undefined
      do {
        const page = await tx.scan('native-record', { relation: unit.descriptor.name, after, limit: 1000 }); actual.push(...page.map(row => row.id))
        after = page.length === 1000 ? page.at(-1)!.id : undefined
      } while (after)
      if (hash(actual.sort()) !== hash(expected)) throw new StateConflict('Native metadata index read-back failed')
    })
    // Validate each full committed prefix before opening the native migration gate.
    for (const entry of archive.sessions) await store.transaction(scope, async tx => {
      await check(tx)
      const saved = await logRecord(tx, entry.header.id, true)
      if (!saved || hash(await logEvents(tx, saved.value)) !== hash(entry.events)) throw new StateConflict('Native import read-back failed')
    })
    for (let offset = 0; offset < rows.length; offset += 100) await store.transaction(scope, async tx => {
      await check(tx)
      for (const row of rows.slice(offset, offset + 100)) {
        const saved = await tx.get(row.family, row.id)
        if (!saved || hash(saved.value) !== hash(row.value)) throw new StateConflict('Native import metadata read-back failed')
      }
    })
    await store.transaction(scope, async tx => {
      await check(tx)
      const marker = (await tx.get<ImportMarker>('migration', markerId))!
      await tx.put('migration', markerId, { ...marker.value, status: 'ready' }, marker.revision)
      const auditId = `native-import/${archive.sha256}`
      if (!await tx.get('audit', auditId)) await tx.put('audit', auditId, { actor: options.actor, evidence: options.evidence, sha256: archive.sha256, at: new Date(await tx.now()).toISOString(), executionEnabled: false }, 0)
      await tx.leases.release(lease)
    })
    return nativeArchiveReport(archive)
  } finally { await store.transaction(scope, tx => tx.leases.release(lease)) }
}
