import { KV } from '../kv.ts'
/** Async immutable artifacts. Bytes live in BlobStore; authority, versions and references live in StateStore. */
import { randomUUID } from 'node:crypto'
import type { Ticket, Trigger } from '../core/index.ts'
import type { ArtifactFile } from '../document-format.ts'
import type { ArtifactVersion } from '../app/artifacts.ts'
import { DOCX_MIME, DocumentOutputSchema } from '../document-format.ts'
import { control, requireAgent } from './controls.ts'
import type { CommandIdentity } from './application.ts'
import type { BlobRef, BlobStore } from './blobs.ts'
import { bytesHash } from './blobs.ts'
import { validateDocx } from './docx.ts'
import { hash } from './hash.ts'
import { StateConflict, validateScope } from './ports.ts'
import type { SessionLease, StateScope, StateStore, StateTransaction } from './ports.ts'
import { ticketSourceIds } from './access.ts'

export interface ArtifactManifest {
  subject: string; kind: 'task' | 'draft'; title: string; version: number; author: 'agent' | 'human'; editedBy?: string
  at: string; body: BlobRef; sources: { triggerId: string; hash: string }[]; requirement: string
  sourceHash?: 'json-v1' | 'text-v1'
  filename?: string; file?: ArtifactFile; fileBlob?: BlobRef
  recording?: ArtifactVersion['recording']
}
export interface BlobCatalog {
  ref: BlobRef; refs: number; status: 'live' | 'deleting' | 'deleted'; updatedAt: number
  writers: { token: string; until: number }[]; deletion?: string
}
export interface ArtifactPublish {
  subject: string; expectedVersion: number; body: string; author: 'human' | 'agent'; filename?: string
  document?: { metadata: ArtifactFile; bytes: Uint8Array }
  writer?: { assignmentId: string; lease: SessionLease; controlRevision: number }
}
export interface ArtifactOptions {
  store: StateStore; scope: StateScope; blobs: BlobStore
  /** Must check all source references and the actual actor, including on historical downloads. */
  authorize(tx: StateTransaction, actor: string, subject: string, operation: 'read' | 'publish' | 'gc', version?: ArtifactManifest): Promise<void>
  checkSource?(actor: string, subject: string): Promise<void>
  evidence?(tx: StateTransaction, actor: string, subject: string): Promise<ArtifactVersion['recording']>
  requireWorkerBindings?: boolean
}
export const artifactVersionId = (subject: string, version: number) => `${subject}/${String(version).padStart(12, '0')}`
/** Publishes CAS versions only after immutable bytes exist, and fences garbage collection against in-flight publishers. */
export class DurableArtifacts {
  private readonly options: ArtifactOptions
  constructor(options: ArtifactOptions) { this.options = { ...options, scope: validateScope(options.scope) } }
  async publish(identity: CommandIdentity, input: ArtifactPublish): Promise<ArtifactManifest> {
    input = structuredClone(input)
    if (!identity.id.trim() || !identity.userId.trim() || !input.body.trim() || input.body.length > 100_000
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !['agent', 'human'].includes(input.author)) throw new Error('Invalid artifact publication')
    const body = Buffer.from(input.body), bodyRef = { sha256: bytesHash(body), byteLength: body.length }
    if (input.filename && !/^[\p{L}\p{N}][\p{L}\p{N} _().-]{0,95}\.(md|txt)$/iu.test(input.filename)) throw new Error('Invalid text filename')
    if (input.document) {
      const { metadata, bytes } = input.document
      DocumentOutputSchema.parse({ format: metadata.format, filename: metadata.filename })
      if (metadata.mediaType !== DOCX_MIME || metadata.sha256 !== bytesHash(bytes) || metadata.byteLength !== bytes.length) throw new Error('Word metadata mismatch')
      validateDocx(Buffer.from(bytes))
    }
    const refs = new Map<string, BlobRef>([[bodyRef.sha256, bodyRef]])
    if (input.document) refs.set(input.document.metadata.sha256, { sha256: input.document.metadata.sha256, byteLength: input.document.bytes.length })
    const { store, scope, blobs } = this.options, token = randomUUID(), commandId = `artifact/${hash(identity)}`
    const parameters = hash({ ...input, document: input.document?.metadata, writer: input.writer && { ...input.writer, lease: { ...input.writer.lease, until: 0 } } })
    const replay = await store.transaction(scope, async tx => {
      await this.options.authorize(tx, identity.userId, input.subject, 'publish')
      const previous = await tx.get<{ parameters: string; manifest: ArtifactManifest }>('command', commandId)
      if (previous) {
        if (previous.value.parameters !== parameters) throw new StateConflict('Artifact command reused with changed content')
        await this.options.authorize(tx, identity.userId, input.subject, 'read', previous.value.manifest)
        return previous.value.manifest
      }
      await this.checkWriter(tx, input)
      const head = await tx.get<number>('artifact-head', input.subject)
      if ((head?.value ?? 0) !== input.expectedVersion) throw new StateConflict('Artifact version changed')
      for (const ref of refs.values()) {
        const row = await tx.get<BlobCatalog>('blob', ref.sha256)
        if (row?.value.status === 'deleting') throw new StateConflict('Blob collection in progress; retry publication')
        const value: BlobCatalog = row?.value ?? { ref, refs: 0, status: 'live', updatedAt: await tx.now(), writers: [] }
        if (value.ref.byteLength !== ref.byteLength) throw new StateConflict('Blob size changed')
        value.status = 'live'; value.updatedAt = await tx.now(); value.writers.push({ token, until: value.updatedAt + 600_000 })
        await tx.put('blob', ref.sha256, value, row?.revision ?? 0, { active: value.refs === 0 })
      }
      return undefined
    })
    if (replay) return replay
    try {
      await blobs.put(scope, body)
      if (input.document) await blobs.put(scope, input.document.bytes)
      return await store.transaction(scope, async tx => {
        await this.options.authorize(tx, identity.userId, input.subject, 'publish')
        const previousCommand = await tx.get<{ parameters: string; manifest: ArtifactManifest }>('command', commandId)
        if (previousCommand) {
          if (previousCommand.value.parameters !== parameters) throw new StateConflict('Artifact command reused with changed content')
          await this.options.authorize(tx, identity.userId, input.subject, 'read', previousCommand.value.manifest)
          return previousCommand.value.manifest
        }
        await this.checkWriter(tx, input)
        const head = await tx.get<number>('artifact-head', input.subject)
        if ((head?.value ?? 0) !== input.expectedVersion) throw new StateConflict('Artifact version changed')
        const ticket = (await tx.get<Ticket>('ticket', input.subject))?.value
        if (!ticket) throw new StateConflict('Unknown artifact task')
        const previous = head ? (await tx.get<ArtifactManifest>('artifact-version', artifactVersionId(input.subject, head.value)))?.value : undefined
        const sourceIds = [...new Set([...ticketSourceIds(ticket),
          ...(await tx.get<string[]>('kv', KV.group.reads(ticket.id)))?.value ?? [], ...previous?.sources.map(value => value.triggerId) ?? []])]
        const sources: ArtifactManifest['sources'] = []
        for (const triggerId of sourceIds) {
          const trigger = (await tx.get<Trigger>('trigger', triggerId))?.value
          if (!trigger) throw new StateConflict('Artifact source is missing')
          sources.push({ triggerId, hash: hash(trigger) })
        }
        const manifest: ArtifactManifest = { subject: input.subject, kind: 'task', title: ticket.title, version: input.expectedVersion + 1,
          author: input.author, ...(input.author === 'human' ? { editedBy: identity.userId } : {}), at: new Date(await tx.now()).toISOString(), body: bodyRef, sources,
          requirement: hash({ origin: ticket.origin, inputs: ticket.inputs }), sourceHash: 'json-v1',
          ...input.document ? { filename: input.document.metadata.filename, file: input.document.metadata,
            fileBlob: { sha256: input.document.metadata.sha256, byteLength: input.document.bytes.length } } : input.filename ? { filename: input.filename } : {} }
        const evidence = await this.options.evidence?.(tx, identity.userId, input.subject)
        if (evidence) manifest.recording = evidence
        await this.options.authorize(tx, identity.userId, input.subject, 'publish', manifest)
        const awaitNow = await tx.now()
        for (const ref of refs.values()) {
          const row = await tx.get<BlobCatalog>('blob', ref.sha256)
          if (!row || row.value.status !== 'live' || !row.value.writers.some(value => value.token === token && value.until > awaitNow)) throw new StateConflict('Blob reservation expired')
          row.value.refs++; row.value.writers = row.value.writers.filter(value => value.token !== token); row.value.updatedAt = await tx.now()
          await tx.put('blob', ref.sha256, row.value, row.revision, { active: false })
        }
        await tx.put('artifact-version', artifactVersionId(input.subject, manifest.version), manifest, 0, { relation: input.subject })
        await tx.put('artifact-head', input.subject, manifest.version, head?.revision ?? 0)
        await tx.put('command', commandId, { parameters, manifest }, 0)
        return manifest
      })
    } finally {
      await store.transaction(scope, async tx => {
        for (const ref of refs.values()) {
          const row = await tx.get<BlobCatalog>('blob', ref.sha256)
          if (row?.value.writers.some(value => value.token === token)) {
            row.value.writers = row.value.writers.filter(value => value.token !== token)
            await tx.put('blob', ref.sha256, row.value, row.revision, { active: row.value.refs === 0 })
          }
        }
      }).catch(() => { /* Reservation expiry prevents a late publish; orphan collection can recover the bytes. */ })
    }
  }
  private async checkWriter(tx: StateTransaction, input: ArtifactPublish): Promise<void> {
    const state = (await control(tx, input.subject)).value
    if (input.author === 'human') {
      if (state.mode !== 'human' || !state.drained || state.operations.length) throw new StateConflict('Take over and drain before editing')
    } else {
      if (!input.writer) throw new StateConflict('Worker publication requires a Session binding')
      await requireAgent(tx, input.subject, input.writer.controlRevision); await tx.leases.assert(input.writer.lease)
      const ticket = (await tx.get<Ticket>('ticket', input.subject))?.value
      if (!ticket || ticket.ended || ticket.assignments.at(-1)?.id !== input.writer.assignmentId || ticket.assignments.at(-1)?.state === 'ended') throw new StateConflict('Stale artifact writer')
      if (this.options.requireWorkerBindings) {
        const binding = (await tx.get<{ sessionId: string; owner: string; epoch: number; userId: string }>('grant', `worker-binding/${input.subject}/${input.writer.assignmentId}`))?.value
        if (!binding || binding.sessionId !== input.writer.lease.sessionId || binding.owner !== input.writer.lease.owner || binding.epoch !== input.writer.lease.epoch || binding.userId !== ticket.mandate.actor.id) throw new StateConflict('Artifact Session binding changed')
      }
    }
  }
  async manifest(actor: string, subject: string, version?: number): Promise<ArtifactManifest | undefined> {
    return this.options.store.transaction(this.options.scope, async tx => {
      await this.options.authorize(tx, actor, subject, 'read')
      const number = version ?? (await tx.get<number>('artifact-head', subject))?.value
      if (number === undefined) return undefined
      const value = (await tx.get<ArtifactManifest>('artifact-version', artifactVersionId(subject, number)))?.value
      if (value) await this.options.authorize(tx, actor, subject, 'read', value)
      return value
    })
  }
  async read(actor: string, subject: string, version?: number, file = false): Promise<{ manifest: ArtifactManifest; bytes: Buffer }> {
    await this.options.checkSource?.(actor, subject)
    const manifest = await this.manifest(actor, subject, version)
    if (!manifest) throw new StateConflict('Unknown artifact version')
    const bytes = await this.options.blobs.read(this.options.scope, file ? manifest.fileBlob ?? manifest.body : manifest.body)
    await this.options.store.transaction(this.options.scope, tx => this.options.authorize(tx, actor, subject, 'read', manifest))
    return { manifest, bytes }
  }
  /** Collect only catalogued unreferenced objects. Marking deleting is serialized against publication reservations. */
  async collect(actor: string, graceMs = 3_600_000, after?: string): Promise<{ deleted: string[]; after?: string }> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 60_000) throw new Error('Collection requires a grace period of at least one minute')
    const { store, scope, blobs } = this.options
    const rows = await store.transaction(scope, async tx => {
      await this.options.authorize(tx, actor, '', 'gc')
      return tx.scan<BlobCatalog>('blob', { active: true, after, limit: 100 })
    }), deleted: string[] = []
    for (const item of rows) {
      const token = randomUUID()
      const eligible = await store.transaction(scope, async tx => {
        await this.options.authorize(tx, actor, '', 'gc')
        const row = await tx.get<BlobCatalog>('blob', item.id), now = await tx.now()
        if (!row || row.value.status === 'deleting' || row.value.refs || row.value.updatedAt + graceMs > now || row.value.writers.some(writer => writer.until > now)) return false
        await tx.put('blob', row.id, { ...row.value, status: 'deleting', deletion: token }, row.revision, { active: true }); return true
      })
      if (!eligible) continue
      await blobs.delete(scope, item.id)
      await store.transaction(scope, async tx => {
        const row = await tx.get<BlobCatalog>('blob', item.id)
        if (!row || row.value.deletion !== token || row.value.refs) throw new StateConflict('Blob collection ownership changed')
        await tx.put('blob', row.id, { ...row.value, status: 'deleted', writers: [] }, row.revision, { active: false })
      }); deleted.push(item.id)
    }
    return { deleted, ...(rows.length === 100 ? { after: rows.at(-1)!.id } : {}) }
  }
}
