/** Native DSH records share A's scoped transactions and lease authority, never its product progress projection. */
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { assertContiguous, assertStoredId, assertVersion, materializeCreateHeader, SessionPersistenceCorruptionError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { hash } from '../state/hash.ts'
import type { StateRecord, StateTransaction } from '../state/ports.ts'
import { assertNativeReady } from './catalog.ts'

const SessionKey = z.string().min(1).max(2000).refine(value => !!value.trim() && value.isWellFormed() && !value.includes('\0'))
const Header = z.object({ version: z.number().int(), id: SessionKey, createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cwd: z.string().refine(value => isAbsolute(value) || win32.isAbsolute(value)).optional(), parentSession: z.string().optional(), isSeeded: z.boolean(),
  origin: z.literal('subagent').optional(), delegationDepth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), agentPreset: z.string().optional() }).strict()
const Envelope = z.object({ type: z.string(), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), time: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  data: z.unknown().refine(value => value !== undefined), ignorable: z.literal(true).optional(), surfaceOp: z.unknown().optional(), sourceEventSeqs: z.array(z.number()).optional() }).strict()
/** The public vocabulary/data validator does not validate the fixed envelope; validate both, as the JSONL decoder does. */
export function checkedEvents(header: SessionHeader, events: SessionEvent[]): SessionEvent[] {
  try { for (const event of events) Envelope.parse(event) }
  catch (error) { throw corruption(header.id, error) }
  return validateStoredEvents(header, events)
}
export interface NativeLog {
  format: 'loom-dsh-session-v1'; header: SessionHeader; inheritedEventCount: number; eventCount: number; headerHash: string
}
interface StoredLog extends Omit<NativeLog, 'header'> { headerJSON: string }
export interface NativeEvent { sessionId: SessionId; eventJSON: string; sha256: string }
/** JSON text inside the envelope preserves JSON strings (NUL / unpaired UTF-16) that PostgreSQL JSONB cannot represent directly. */
export function storedLog(log: NativeLog): StoredLog {
  const { header, ...metadata } = log
  return { ...metadata, headerJSON: JSON.stringify(header) }
}
export function corruption(id: string, cause: unknown): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(`Native Session ${id}: invalid committed log`, { cause })
}
export function headerSnapshot(header: SessionHeader): SessionHeader {
  const snapshot = materializeCreateHeader(header)
  assertVersion(snapshot)
  Header.parse(snapshot)
  return Object.freeze(snapshot)
}
export function cut(header: SessionHeader, count?: number): number {
  if (header.isSeeded && count === undefined) throw new TypeError('Seeded Session requires inheritedEventCount')
  const value = SessionLogOffset(count ?? 0)
  if (!header.isSeeded && value !== 0) throw new TypeError('Unseeded Session inheritedEventCount must be zero')
  return value
}
export function eventKey(id: SessionId, seq: number): string { return `${hash(id)}/${String(seq).padStart(16, '0')}` }
export async function logRecord(tx: StateTransaction, id: SessionId, importing = false): Promise<StateRecord<NativeLog> | undefined> {
  if (!importing) await assertNativeReady(tx)
  SessionKey.parse(id)
  const record = await tx.get<StoredLog>('native-session', id)
  if (!record) return
  let value: NativeLog
  try {
    const { headerJSON, ...metadata } = record.value
    value = { ...metadata, header: JSON.parse(headerJSON) as SessionHeader }
  } catch (error) { throw corruption(id, error) }
  // Version refusals must stay distinct from damaged current-format records.
  if (value.header) assertVersion(value.header)
  try {
    if (value.format !== 'loom-dsh-session-v1') throw new Error('Unsupported native storage format')
    headerSnapshot(value.header); assertStoredId(id, value.header); cut(value.header, value.inheritedEventCount)
    if (!Number.isSafeInteger(value.eventCount) || value.eventCount < 0 || hash(value.header) !== value.headerHash) throw new Error('Invalid native metadata')
  } catch (error) { throw corruption(id, error) }
  return { ...record, value }
}
/** Read exactly the committed prefix inside one transaction, including missing-row, seq and digest checks. */
export async function logEvents(tx: StateTransaction, log: NativeLog, offset = 0, length = Number.MAX_SAFE_INTEGER): Promise<SessionEvent[]> {
  const id = log.header.id, end = Math.min(log.eventCount, offset + Math.min(length, Number.MAX_SAFE_INTEGER - offset))
  const events: SessionEvent[] = []
  let cursor = offset
  while (cursor < end) {
    const page = await tx.scan<NativeEvent>('native-event', { relation: hash(id), after: cursor ? eventKey(id, cursor - 1) : `${hash(id)}/`, limit: Math.min(1000, end - cursor) })
    if (!page.length) throw corruption(id, new Error('Committed event missing'))
    for (const row of page) {
      const value = row.value
      let event: SessionEvent
      try {
        event = JSON.parse(value.eventJSON) as SessionEvent
        if (row.id !== eventKey(id, cursor) || value.sessionId !== id || event?.seq !== cursor || value.sha256 !== hash(event)) throw new Error('Event identity or digest mismatch')
      } catch (error) { throw corruption(id, error) }
      events.push(event); cursor++
    }
  }
  if (offset === 0 && end === log.eventCount) {
    const extra = await tx.scan('native-event', { relation: hash(id), after: log.eventCount ? eventKey(id, log.eventCount - 1) : `${hash(id)}/`, limit: 1 })
    if (extra.length) throw corruption(id, new Error('Unexpected committed events beyond metadata prefix'))
  }
  assertContiguous(id, events, offset)
  return checkedEvents(log.header, events)
}
