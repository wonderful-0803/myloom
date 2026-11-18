/** Synthetic frozen schema-11 database with real domain records, human revisions and OOXML bytes; no platform I/O. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Store } from '../../../src/app/store.ts'
import { Engine } from '../../../src/core/index.ts'
import { SettingsSchema } from '../../../src/policy.ts'
import { SourceRegistry } from '../../../src/sources/registry.ts'
import { feishuKind, feishuTrigger } from '../../../src/sources/feishu.ts'
import { Artifacts } from '../../../src/app/artifacts.ts'
import { TaskControls } from '../../../src/app/task-control.ts'
import { KV } from '../../../src/kv.ts'
import { renderDocx } from '../../../src/document-render.ts'
import { DOCX_MIME } from '../../../src/document-format.ts'
import { bytesHash } from '../../../src/state/blobs.ts'

export async function frozenLegacy(folder: string, word = true) {
  const path = join(folder, 'frozen.sqlite'), store = new Store(path)
  const settings = SettingsSchema.parse({ sources: { github: { enabled: false }, feishu: { enabled: true, config: { ownerOnly: true, chats: [{ chatId: 'oc_test', listen: 'all' }] } } },
    policy: { sources: { feishu: { allowed: [{ id: 'ou_owner' }] } } }, eval: { mode: 'auto' } })
  store.saveSettings(settings)
  const registry = new SourceRegistry(() => store.settings()); registry.register(feishuKind)
  const engine = new Engine({ repo: store, now: () => '2026-11-11T00:00:00.000Z', scope: registry,
    policy: () => ({ version: 'fixture', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention', sender: 'ou_owner' } }), revalidate: () => true, admitsInferred: () => true }),
    assessor: { request() {} }, executor: { start() {}, deliver() {}, stop() {} }, emit() {},
    outbox: { send: message => { store.db.prepare('INSERT OR IGNORE INTO outbox(id,value) VALUES(?,?)').run(message.id, JSON.stringify({ ...message, status: 'pending' })) }, status: id => store.replyStatus(id),
      withdraw: id => { store.db.prepare('DELETE FROM outbox WHERE id=?').run(id) } } })
  const trigger = feishuTrigger({ message_id: 'om_test', chat_id: 'oc_test', chat_type: 'group', sender_id: 'ou_owner', sender_type: 'user', content: 'Summarize fictional R1 only',
    create_time: String(Date.parse('2026-11-11T00:00:00Z')), mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_test')!
  engine.receive(trigger)
  const ticketId = engine.decide(trigger.id, { kind: 'accept', title: 'Fictional report', scope: 'R1 only', reason: 'test', acknowledgement: 'Accepted' }).ticketId!
  engine.assignmentStarted(ticketId, store.tickets.get(ticketId)!.assignments[0]!.id)
  engine.report(ticketId, { state: 'ready', summary: 'R1 finished' })
  const controls = new TaskControls({ store, quiesce: async () => {}, resume() {} }), artifacts = new Artifacts({ store, sources: registry, controls })
  const body = '# R1\n\nFictional record only', bytes = word ? await renderDocx('R1', body) : undefined
  artifacts.report(store.tickets.get(ticketId)!, body, 0, undefined, bytes ? { bytes, metadata: { format: 'docx', filename: 'report.docx', mediaType: DOCX_MIME, sha256: bytesHash(bytes), byteLength: bytes.length }, sourceHash: bytesHash(Buffer.from(body)) } : undefined)
  store.set(KV.controls.task(ticketId), { mode: 'human', revision: 2, drained: true, operations: [], history: [{ at: '2026-11-11T00:01:00Z', action: 'takeover' }] })
  artifacts.edit(ticketId, 'ou_owner', 1, 'Human v2 keeps R1', undefined, 'loom')
  store.db.prepare('INSERT INTO effect(kind,key,value,seq,generation,attempts,error,due,since) VALUES(?,?,?,?,?,?,?,?,?)').run('delivery', ticketId, JSON.stringify({ ticketId }), 1, 3, 0, '', 0, '2026-11-11T00:00:00Z')
  store.close()
  return { path, ticketId, trigger, body, bytes, sha256: bytesHash(await readFile(path)) }
}
