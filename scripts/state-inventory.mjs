#!/usr/bin/env node
/** Read-only inventory of a frozen legacy database. Intentionally has no import/apply mode. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { kvOwner } from '../src/state/kv.ts'
export function inventory(path) {
  const uri = pathToFileURL(resolve(path)); uri.searchParams.set('immutable', '1')
  const db = new DatabaseSync(uri.href, { readOnly: true })
  try {
    db.exec('BEGIN')
    const schema = db.prepare("SELECT value FROM kv WHERE key='schema'").get()
    if (!schema || JSON.parse(String(schema.value)) !== 11) throw new Error('Inventory requires a frozen legacy Loom schema-11 database')
    const tables = {}, kv = {}
    for (const [table, id] of Object.entries({ trigger: 'id', disposition: 'id', thread: 'key', ticket: 'id', decision: 'id', outbox: 'id', effect: 'kind,key', trigger_thread: 'thread,id' })) {
      const digest = createHash('sha256'); let count = 0, bytes = 0
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${id}`).iterate()) {
        const encoded = JSON.stringify(row); digest.update(encoded + '\n'); count++; bytes += Buffer.byteLength(encoded)
      }
      tables[table] = { count, bytes, sha256: digest.digest('hex') }
    }
    for (const row of db.prepare('SELECT key,value FROM kv ORDER BY key').iterate()) {
      const key = String(row.key), group = kvOwner(key) ?? '(unmapped)'
      const target = kv[group] ??= { count: 0, bytes: 0 }
      target.count++; target.bytes += Buffer.byteLength(String(row.value))
    }
    const pendingDeliveries = Number(db.prepare("SELECT count(*) AS n FROM outbox WHERE json_extract(value,'$.status')='pending'").get().n)
    db.exec('COMMIT')
    return { format: 'loom-state-inventory-v1', mode: 'read-only', sourceSchema: 11, tables, kv,
      pendingDeliveries, unmappedKeys: kv['(unmapped)']?.count ?? 0,
      migrationReady: false, blockers: ['Explicit tenant/space/owner mapping and offline importer still required',
        'Control operations, DSH flush, pending deliveries and artifact bytes must be reconciled before migration'] }
  } finally { db.close() }
}
async function main() {
  const args = process.argv.slice(2), options = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1]
    if (!['--source', '--out'].includes(flag) || !value || options[flag]) throw new Error('Usage: state-inventory.mjs --source FROZEN_COPY.sqlite --out NEW_REPORT.json (read-only)')
    options[flag] = value
  }
  if (!options['--source'] || !options['--out'] || resolve(options['--source']) === resolve(options['--out'])) throw new Error('Separate source and new report paths are required')
  const result = inventory(options['--source'])
  await writeFile(options['--out'], JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  process.stdout.write('Read-only inventory saved; no data imported.\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(error instanceof Error ? error.message + '\n' : 'Inventory failed\n'); process.exitCode = 1 })
}
