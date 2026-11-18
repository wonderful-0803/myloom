/** Bounded OOXML validation for imported/generated files, without extracting paths or following XML references. */
import { inflateRawSync } from 'node:zlib'

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
  return (crc ^ 0xffffffff) >>> 0
}
export function validateDocx(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.length > 2_000_000) throw new Error('Invalid Word file size')
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
  if (end < Math.max(0, bytes.length - 65557) || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw new Error('Invalid Word ZIP directory')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16)
  if (!count || count > 512 || offset + size !== end) throw new Error('Invalid Word ZIP directory size')
  const names = new Set<string>(), xml = new Map<string, string>(); let cursor = offset, expanded = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid Word ZIP entry')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), expectedCrc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28)
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42)
    if (next > end || local + 30 > offset || flags & 1 || ![0, 8].includes(method) || (expanded += length) > 8_000_000) throw new Error('Unsafe Word ZIP entry')
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || names.has(name) || /vbaProject|\.exe$/i.test(name)) throw new Error('Unsafe Word ZIP name')
    names.add(name)
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid Word local entry')
    const localNameLength = bytes.readUInt16LE(local + 26), start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28)
    if (start + compressed > offset || bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) throw new Error('Invalid Word ZIP range')
    const raw = bytes.subarray(start, start + compressed), data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, length) })
    if (data.length !== length || crc32(data) !== expectedCrc) throw new Error('Word entry integrity check failed')
    if (['[Content_Types].xml', '_rels/.rels', 'word/document.xml'].includes(name)) xml.set(name, data.toString('utf8'))
    cursor = next
  }
  if (cursor !== end || !xml.get('[Content_Types].xml')?.includes('wordprocessingml.document.main+xml')
    || !xml.get('_rels/.rels')?.includes('officeDocument') || !/<w:document\b/.test(xml.get('word/document.xml') ?? '')) throw new Error('ZIP is not a Word document')
}
