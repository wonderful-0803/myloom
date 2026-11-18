#!/usr/bin/env node
/** Explicit multi-group company launcher. One bot connection, one native root per persisted workspace. */
import { parseArgs } from 'node:util'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, lstat, realpath, mkdir, open } from 'node:fs/promises'
import { dirname, resolve, join, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { profileModules, verifyProfileImports } from './company-profile-modules.mjs'
import { PostgresStateStore, ProductAccess, CliFeishuWire, GroupEventBroker, CompanyGroups, CompanyCapacity, CompanyGatewayHost, productHttp, groupCompanyConfig } from '../lib/state.js'
const { values } = parseArgs({ options: { profile: { type: 'string' }, 'harness-root': { type: 'string' }, 'groups-home': { type: 'string' }, help: { type: 'boolean' } } })
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..'), roots = [], lifetime = new AbortController()
let store, groups, http, brokerRun, gatewayHost, stopping
async function stop() {
  return stopping ??= (async () => {
    lifetime.abort(); await Promise.allSettled([brokerRun, groups?.close(), gatewayHost?.stop(), new Promise(done => http ? http.close(done) : done())])
    for (const root of roots.reverse()) { await root.get('loomCompany')?.stop().catch(() => {}); await root.fiber.dispose().catch(() => {}) }
    await store?.close()
  })()
}
async function privateInput(path) {
  if (!isAbsolute(path ?? '')) throw Error('Explicit absolute private input required')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 2000000 || await realpath(path) !== resolve(path)) throw Error('Private owned canonical input required')
  return JSON.parse(await readFile(path, 'utf8'))
}
async function directory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.() || await realpath(path) !== resolve(path)) throw Error('Private owned canonical directory required')
}
async function fixed(path, value) {
  try { const file = await open(path, 'wx', 0o600); try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() } }
  catch (error) { if (error.code !== 'EEXIST' || JSON.stringify(await privateInput(path)) !== JSON.stringify(value)) throw Error('Existing group config differs; explicit migration required') }
}
try {
  if (values.help) console.log('company-groups-server --profile /private/existing-company-profile.json --harness-root /reviewed/dsh --groups-home /private/company-groups\nBuild first. Explicitly replaces the single-group launcher; stop the old source first. Existing primary SQL scope and histories remain unchanged. New groups are registered in the authenticated workbench. No auto-discovery or auto-authorization.')
  else {
    const profile = values.profile, harness = values['harness-root'], home = values['groups-home']
    if (![profile, harness, home].every(value => isAbsolute(value ?? ''))) throw Error('Explicit reviewed paths required')
    await directory(home); const original = await privateInput(profile)
    // These roots execute Agents only. Loom's own product HTTP serves the client once.
    // rc.3's client package inventory cannot compose our multiple server entry modules in secondary roots.
    for (const id of ['modules', 'client-hmr']) { const row = original.find(row => row.id === id); if (row) row.disabled = true }
    for (const [id, file] of [['loom-native-state', 'dsh-state.js'], ['loom-native-metadata', 'dsh-metadata.js'], ['loom-company-entry', 'company.js']]) {
      const entry = original.find(row => row.id === id)
      if (!entry || entry.disabled || await realpath(entry.name) !== await realpath(join(app, 'lib', file))) throw Error('Profile must select this reviewed application release')
    }
    await profileModules(profile, app); await verifyProfileImports(original, profile, harness)
    const manifest = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.1-rc.3') throw Error('Pinned Harness rc.3 required')
    const entry = original.find(row => row.id === 'loom-company-entry'), primaryConfig = await privateInput(entry?.config?.configFile)
    if (primaryConfig.nativeState !== 'external' || !/^LOOM_[A-Z0-9_]+$/.test(primaryConfig.databaseUrlEnv)) throw Error('External native state required')
    const scope = { tenantId: primaryConfig.tenantId, spaceId: primaryConfig.spaceId }
    store = await PostgresStateStore.open({ connectionString: process.env[primaryConfig.databaseUrlEnv] })
    const access = new ProductAccess(primaryConfig.installationId), config = await store.transaction(scope, tx => access.configuration(tx))
    if (!config.group) throw Error('Existing primary group required')
    const wire = new CliFeishuWire({ cli: primaryConfig.cli, appId: config.installation.appId, botId: config.installation.botId, name: config.installation.name, brand: 'feishu' })
    await wire.verify(AbortSignal.timeout(60000))
    const broker = new GroupEventBroker(wire, { store, scope, access, appId: config.installation.appId, botId: config.installation.botId }), capacity = new CompanyCapacity(2, 1)
    // A multi-group host has one Gateway identity and one TLS listener. The
    // group servers register their StateStore scopes against it; they never
    // create or bind another listener of their own.
    if (primaryConfig.gateway) gatewayHost = await CompanyGatewayHost.open(primaryConfig.gateway, store)
    const require = createRequire(join(harness, 'package.json'))
    const [{ boot }, { provideCmdline }] = await Promise.all(['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-cmdline'].map(name => import(pathToFileURL(require.resolve(name)).href)))
    async function startGroup(record, primary = false) {
      let selected = profile
      if (primary) {
        const folder = join(home, 'primary'); await directory(folder)
        selected = join(folder, 'profile.json'); await profileModules(selected, app, true); await fixed(selected, original)
      }
      if (!primary) {
        const folder = join(home, record.spaceId); await directory(folder)
        const native = join(folder, 'native'), scratch = join(folder, 'compute'); await directory(native); await directory(scratch)
        // The host owns the single TLS Gateway and its device registry; groups never inherit either.
        const cfg = groupCompanyConfig(primaryConfig, { spaceId: record.spaceId, attachmentHome: native, scratch })
        const metadata = original.find(row => row.id === 'loom-native-metadata'), contract = await privateInput(metadata.config.contractFile)
        await fixed(join(folder, 'config.json'), cfg); await fixed(join(folder, 'environment.json'), contract)
        const rows = structuredClone(original), get = id => { const row = rows.find(row => row.id === id); if (!row) throw Error('Reviewed company profile entry missing'); return row }
        get('loom-native-state').config.spaceId = record.spaceId
        get('loom-native-metadata').config.contractFile = join(folder, 'environment.json')
        get('loom-company-entry').config.configFile = join(folder, 'config.json')
        get('storage-json').config.root = join(scratch, 'unrelated-cache')
        get('attachment-local').config.dshHome = native
        selected = join(folder, 'profile.json'); await profileModules(selected, app, true); await verifyProfileImports(rows, selected, harness); await fixed(selected, rows)
      }
      const view = broker.subscribe(record.chatId)
      let root
      try {
        root = await boot('loom-company-group', selected, [], host => { provideCmdline(host, { args: ['--no-open'], exit: () => { throw Error('Unexpected CLI exit') } }); host.provide('loomCompanyHost', { wire: view, capacity, ...(gatewayHost ? { gatewayHost } : {}) }) }, new URL('../package.json', import.meta.url).href)
        const server = root.get('loomCompany'); if (!server) throw Error('Company group entry did not activate')
        roots.push(root)
        return server
      } catch (error) { broker.forget(record.chatId); await root?.get('loomCompany')?.stop().catch(() => {}); await root?.fiber.dispose().catch(() => {}); throw error }
    }
    const primary = await startGroup({ spaceId: scope.spaceId, chatId: config.group.chatId }, true)
    groups = await CompanyGroups.open({ store, primary, wire, factory: record => startGroup(record) })
    const handler = productHttp({ product: primary.product, sessions: primary.sessions.withMembership(actor => groups.authorize(actor), { allowIdentity: true }), origin: primaryConfig.origin,
      assets: join(app, 'loom/dist/client'), operatorLogin: primaryConfig.loginMode === 'ssh-operator', localOperator: primaryConfig.loginMode === 'local-operator', workspaces: groups,
      gateway: primary.gatewayHttpControl(), workbench: primary.workbenchHttpControl() })
    http = createServer((req, res) => {
      if (req.url === '/readyz') {
        if (req.headers.host !== new URL(primaryConfig.origin).host) { res.writeHead(403); res.end(); return }
        const ready = broker.ready && ['ready', 'paused'].includes(primary.sourceHealth)
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ready, source: primary.sourceHealth, botConnected: broker.ready })); return
      }
      void handler(req, res)
    }); http.requestTimeout = 30000; http.headersTimeout = 10000; http.maxHeadersCount = 50
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(primaryConfig.port, '127.0.0.1', resolve) })
    brokerRun = broker.run(lifetime.signal)
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 }) })
    console.log('Loom multi-group host started; independent scopes, shared bot stream and bounded compute.')
  }
} catch {
  await stop().catch(() => {})
  console.error('Multi-group company startup failed. Check private configuration and service logs; no fallback listener was started.'); process.exitCode = 1
}
