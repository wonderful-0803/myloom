#!/usr/bin/env node
/** Explicit offline operations for the opt-in company service. Never loads a user desktop configuration. */
import { attachmentIO } from './native-attachment-io.mjs'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PostgresStateStore, LocalBlobStore, ProductAccess, StateConflict, initializeCompany, migrationDryRun, migrateLegacy,
  activateMigration, exportExternalState, restoreExternalState, families, DurableOutbox } from '../lib/state.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, source: { type: 'string' }, mapping: { type: 'string' }, initial: { type: 'string' }, directory: { type: 'string' },
  actor: { type: 'string' }, evidence: { type: 'string' }, id: { type: 'string' }, outcome: { type: 'string' }, receipt: { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean' }
} })
async function privateFile(path, json = true) {
  if (!path || !isAbsolute(path)) throw new Error('Private absolute file path required')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 160_000 || await realpath(path) !== resolve(path)) throw new Error('Expected private regular configuration file')
  const value = await readFile(path, 'utf8'); return json ? JSON.parse(value) : value
}
async function main() {
  const action = positionals[0] ?? 'dry-run'
  if (values.help) {
    console.log('Loom company state administration (build first)\n--config /private/company.json COMMAND [options]\nCommands: dry-run, import, init, check, export, restore, activate, reconcile-outbox, queue-stops\nOffline writes require --apply. import/dry-run require --source and --mapping. init requires --initial. export/restore require --directory. Online authority changes require --actor and --evidence /private/note.txt. No command starts listeners or sends messages.')
    return
  }
  const config = await privateFile(values.config), scope = { tenantId: config.tenantId, spaceId: config.spaceId }
  if (['dry-run', 'import'].includes(action)) {
    const mapping = await privateFile(values.mapping)
    if (mapping.scope.tenantId !== scope.tenantId || mapping.scope.spaceId !== scope.spaceId || mapping.installation.id !== config.installationId) throw new StateConflict('Explicit mapping differs from configured destination')
    if (!values.source || !isAbsolute(values.source)) throw new Error('Frozen source path required')
    const report = await migrationDryRun(values.source, mapping)
    if (action === 'dry-run' || !values.apply) { console.log(JSON.stringify({ action: 'dry-run', ...report }, null, 2)); return }
  }
  if (!['import', 'init', 'check', 'export', 'restore', 'activate', 'reconcile-outbox', 'queue-stops'].includes(action)) throw new Error('Unknown administrative action')
  if (['import', 'init', 'restore', 'activate', 'reconcile-outbox', 'queue-stops'].includes(action) && !values.apply) throw new Error('Explicit --apply required')
  if (!/^LOOM_[A-Z0-9_]+$/.test(config.databaseUrlEnv) || !process.env[config.databaseUrlEnv]) throw new Error('Missing named company database environment')
  let attached
  const store = await PostgresStateStore.open({ connectionString: process.env[config.databaseUrlEnv] })
  try {
    if (['export', 'restore'].includes(action) && config.attachmentHome) attached = await attachmentIO(config.harnessRoot, config.attachmentHome)
    const native = attached ? { ...attached.io, read: attached.read } : undefined
    const blobs = await LocalBlobStore.open(config.blobRoot), access = new ProductAccess(config.installationId)
    if (action === 'init') {
      const initial = await privateFile(values.initial)
      if (initial.installation.id !== config.installationId) throw new Error('Installation mapping mismatch')
      await initializeCompany(store, scope, initial.installation, initial.settings)
    } else if (action === 'import') console.log(JSON.stringify(await migrateLegacy(values.source, await privateFile(values.mapping), store, blobs), null, 2))
    else if (action === 'restore') {
      if (!values.directory || !isAbsolute(values.directory)) throw new Error('Explicit backup directory required')
      await restoreExternalState(store, scope, blobs, values.directory, native)
    } else {
      if (!values.actor) throw new Error('Explicit operator identity required')
      await store.transaction(scope, tx => access.user(tx, values.actor, true))
      if (action === 'check') {
        const result = await store.transaction(scope, async tx => {
          const counts = {}, unresolved = { controls: 0, outbox: 0, sends: 0 }
          for (const family of families) {
            let after; counts[family] = 0
            do {
              const rows = await tx.scan(family, { after, limit: 100 }); counts[family] += rows.length
              for (const { value } of rows) {
                if (family === 'control' && (!value.drained || value.operations.length)) unresolved.controls++
                if (family === 'outbox' && ['sending', 'unknown'].includes(value.status)) unresolved.outbox++
                if (['kv', 'source-state'].includes(family) && ['sending', 'drafting', 'unknown'].includes(value?.status)) unresolved.sends++
              }
              after = rows.length === 100 ? rows.at(-1).id : undefined
            } while (after)
          }
          const jobs = await tx.jobs.list(1000), marker = await tx.get('migration', 'status')
          return { counts, unresolved, jobs: { shown: jobs.length, held: jobs.filter(job => job.held).length, truncated: jobs.length === 1000 }, migration: marker?.value ?? 'fresh-instance' }
        })
        console.log(JSON.stringify(result, null, 2)); return
      }
      if (action === 'export') {
        if (!values.directory || !isAbsolute(values.directory)) throw new Error('Explicit private backup directory required')
        console.log(JSON.stringify(await exportExternalState(store, scope, blobs, values.directory, config.installationId, values.actor, native))); return
      }
      const evidence = await privateFile(values.evidence, false)
      if (evidence.trim().length < 20) throw new Error('Concrete native-session/provider verification evidence required')
      if (action === 'activate') await activateMigration(store, scope, config.installationId, values.actor, evidence)
      else if (action === 'reconcile-outbox') {
        if (!values.id || !['sent', 'dropped'].includes(values.outcome) || values.outcome === 'sent' && !values.receipt) throw new Error('Outbox ID, verified outcome and sent receipt required')
        const outbox = new DurableOutbox(store, scope, { authorize: async (tx, intent) => { await access.user(tx, values.actor, true); await access.ticket(tx, values.actor, intent.message.ticketId) }, send: async () => { throw new Error('Administrative commands cannot send') } })
        await outbox.reconcile(values.id, values.actor, evidence, values.outcome, values.receipt)
      } else if (action === 'queue-stops') {
        await store.transaction(scope, async tx => {
          await access.user(tx, values.actor, true)
          let after
          do {
            const rows = await tx.scan('control', { after, limit: 100 })
            for (const row of rows) if (['pausing', 'taking_over'].includes(row.value.mode)) await tx.jobs.enqueue('control.stop', row.id, { ticketId: row.id, revision: row.value.revision })
            after = rows.length === 100 ? rows.at(-1).id : undefined
          } while (after)
          await tx.put('audit', `offline-stops/${Date.now()}`, { actor: values.actor, evidence, at: new Date(await tx.now()).toISOString() }, 0)
        })
      }
    }
    console.log(JSON.stringify({ action, completed: true, listenersStarted: false, messagesSent: false }))
  } finally { await attached?.close(); await store.close() }
}
await main().catch(error => { console.error(error instanceof StateConflict ? error.message : 'Loom state operation failed. Check private configuration, explicit mapping, paused sources and verification evidence.'); process.exitCode = 1 })
