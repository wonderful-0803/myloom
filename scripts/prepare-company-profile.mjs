#!/usr/bin/env node
/** Offline, explicit profile conversion. Never discovers credentials, starts services or changes a running profile. */
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { readFile, lstat, realpath, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { profileModules, verifyProfileImports } from './company-profile-modules.mjs'

const { values } = parseArgs({ options: { config: { type: 'string' }, effective: { type: 'string' }, output: { type: 'string' }, contract: { type: 'string' }, help: { type: 'boolean' } } })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function input(path) {
  if (!isAbsolute(path ?? '')) throw Error('Explicit absolute paths required')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 2_000_000 || await realpath(path) !== resolve(path)) throw Error('Private canonical input required')
  return readFile(path, 'utf8')
}
async function destination(path) {
  if (!isAbsolute(path ?? '')) throw Error('Explicit absolute output paths required')
  const parent = await lstat(dirname(path))
  if (!parent.isDirectory() || parent.mode & 0o077 || await realpath(dirname(path)) !== resolve(dirname(path))) throw Error('Private canonical output directory required')
  try { await lstat(path); throw Error('Output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function save(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
}
async function main() {
  if (values.help) { console.log('prepare-company-profile --config /private/company.json --effective /private/rc3-effective.yml --contract /private/environment.json --output /private/company-profile.json\nBuild first. Converts one reviewed rc.3 effective profile; outputs private files only. Existing outputs are never overwritten. No database writes, listeners or credentials are created.'); return }
  const config = JSON.parse(await input(values.config)), original = await input(values.effective)
  await destination(values.output); await destination(values.contract)
  if (values.output === values.contract || config.nativeState !== 'external' || !isAbsolute(config.harnessRoot ?? '') || !isAbsolute(config.attachmentHome ?? '') || !isAbsolute(config.scratch ?? '')) throw Error('External native state and explicit persistent attachment/scratch/Harness paths required')
  const rel = relative(config.scratch, config.attachmentHome)
  if (rel === '' || !rel.startsWith('../')) throw Error('Persistent attachments cannot live in scratch')
  const manifest = JSON.parse(await readFile(join(config.harnessRoot, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.1-rc.3') throw Error('Pinned Harness rc.3 required')
  const require = createRequire(join(config.harnessRoot, 'package.json'))
  const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href)
  const yaml = require('js-yaml'), rows = yaml.load(original, { schema: entryListSchema })
  if (!Array.isArray(rows) || new Set(rows.map(row => row.id).filter(Boolean)).size !== rows.filter(row => row.id).length) throw Error('Expected unique effective profile entries')
  const get = id => { const row = rows.find(row => row.id === id); if (!row) throw Error('Required profile entry absent'); row.config ??= {}; return row }
  for (const id of ['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu', 'session-persistence-jsonl', 'session-title-llm']) get(id).disabled = true
  get('webserver').disabled = false; get('webserver').config = { host: '127.0.0.1', port: 0 }
  get('web-runtime').config = { ...get('web-runtime').config, printUrl: false }
  get('storage-json').config.root = join(config.scratch, 'unrelated-cache')
  get('storage-domain').config = { ...get('storage-domain').config, backend: 'json', routes: { ...get('storage-domain').config.routes, workspace: 'loom-sql' } }
  get('attachment-local').config = { dshHome: config.attachmentHome }
  get('agent-loop').config.agents = []
  const presets = {}
  for (const row of rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset' && !row.disabled)) {
    if (!row.config?.id || !Array.isArray(row.config.plugins)) throw Error('Unsupported preset declaration')
    presets[row.config.id] = digest(yaml.dump(row.config.plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 }))
  }
  if (!presets['dsh-superagent-worker'] || !presets['dsh-superagent-router']) throw Error('Company roles must exist')
  const models = Object.entries(get('llm-pi-ai').config.providers ?? {}).flatMap(([provider, value]) => (value.models ?? []).map(model => ({ provider, model: model.id })))
  if (!models.length || models.length > 100 || models.some(model => typeof model.model !== 'string')) throw Error('Explicit bounded model catalogue required')
  const environment = { harnessVersion: manifest.version, profileRevision: digest(original), presets, models }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (const id of ['loom-native-state', 'loom-native-metadata', 'loom-company-entry']) if (rows.some(row => row.id === id)) throw Error('Profile already converted')
  rows.push({ id: 'loom-native-state', name: join(root, 'lib/dsh-state.js'), config: { tenantId: config.tenantId, spaceId: config.spaceId, databaseUrlEnv: config.databaseUrlEnv } },
    { id: 'loom-native-metadata', name: join(root, 'lib/dsh-metadata.js'), config: { contractFile: values.contract, units: ['workspace'] } },
    { id: 'loom-company-entry', name: join(root, 'lib/company.js'), config: { configFile: values.config } })
  // rc.3's root import override does not cover the children of Agent presets.
  // Keep private profiles outside the release while pinning their nested imports to it.
  await profileModules(values.output, root, true)
  await verifyProfileImports(rows, values.output, config.harnessRoot)
  // The profile refers to its separately pinned contract. A partial preparation cannot start a fallback service.
  await save(values.contract, environment); await save(values.output, rows)
  console.log(JSON.stringify({ prepared: true, harnessVersion: manifest.version, presets: Object.keys(presets).length, models: models.length, nativeState: 'external', servicesStarted: false, credentialsCopied: false }))
}
await main().catch(() => { console.error('Company profile preparation failed. Check explicit private paths, pinned version, effective entry IDs and unused outputs. No service was changed.'); process.exitCode = 1 })
