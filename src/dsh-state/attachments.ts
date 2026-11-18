/** Bounded native archive references. Binary bytes stay outside compute and are verified before activation. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { hash } from '../state/hash.ts'
import { StateConflict } from '../state/ports.ts'

const name = z.string().min(1).max(255).refine(value => !/[\/\\\x00-\x1f]/.test(value) && !['.', '..'].includes(value))
const id = z.string().regex(/^sha256:[a-f0-9]{64}$/), bytes = z.number().int().min(0).max(20 * 1024 * 1024)
export const NativeAttachmentRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), ref: z.object({ attachmentId: id, name, bytes }).strict() }).strict(),
  z.object({ kind: z.literal('image'), ref: z.object({ attachmentId: id, mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes,
    width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192), name: name.optional(), originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional() }).strict() }).strict(),
])
export type NativeAttachmentReference = { kind: 'file'; ref: FileAttachmentRef } | { kind: 'image'; ref: ImageAttachmentRef }
export type ArchiveAttachment = NativeAttachmentReference & { data: string }
export interface NativeAttachmentIO {
  /** Decode/check the exact bytes and metadata in private staging before any destination mutation. */
  validate(entry: ArchiveAttachment): Promise<void>
  put(entry: ArchiveAttachment): Promise<void>
  verify(entry: ArchiveAttachment): Promise<void>
}
export const attachmentKey = (entry: NativeAttachmentReference) => hash({ kind: entry.kind, ref: entry.ref })
export function nativeAttachmentReferences(value: unknown): NativeAttachmentReference[] {
  const pending = [value], found = new Map<string, NativeAttachmentReference>()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (['image', 'file'].includes(String(record.type)) && Object.hasOwn(record, 'attachment')) {
      const entry = NativeAttachmentRef.parse({ kind: record.type, ref: record.attachment }) as NativeAttachmentReference
      found.set(attachmentKey(entry), entry)
    }
    for (const child of Object.values(record)) pending.push(child)
  }
  return [...found.values()].sort((a, b) => attachmentKey(a).localeCompare(attachmentKey(b)))
}
export function checkedArchiveAttachments(events: unknown, entries: readonly ArchiveAttachment[] = []): void {
  if (entries.length > 5000) throw new StateConflict('Native attachment count exceeds migration budget')
  const required = nativeAttachmentReferences(events), found = new Set<string>()
  for (const entry of entries) {
    const checked = NativeAttachmentRef.parse({ kind: entry.kind, ref: entry.ref }), key = attachmentKey(checked as NativeAttachmentReference)
    if (found.has(key) || Object.keys(entry).some(key => !['kind', 'ref', 'data'].includes(key))) throw new StateConflict('Duplicate or malformed native attachment')
    if (typeof entry.data !== 'string' || entry.data.length > 28_000_000) throw new StateConflict('Native attachment bytes exceed migration budget')
    const data = Buffer.from(entry.data, 'base64')
    if (data.toString('base64') !== entry.data || data.byteLength !== entry.ref.bytes || `sha256:${createHash('sha256').update(data).digest('hex')}` !== entry.ref.attachmentId)
      throw new StateConflict('Native attachment byte length or digest mismatch')
    found.add(key)
  }
  if (found.size !== required.length || required.some(entry => !found.has(attachmentKey(entry)))) throw new StateConflict('Native attachment bytes are missing or unrelated to the selected history')
}
