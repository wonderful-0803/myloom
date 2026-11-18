#!/usr/bin/env node
/** Built-provider smoke against an explicitly selected installed Harness. Synthetic history and disposable DB only. */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const managed = args.includes('--managed'); if (managed) args.splice(args.indexOf('--managed'), 1)
const metadata = args.includes('--metadata'); if (metadata) args.splice(args.indexOf('--metadata'), 1)
if (metadata && managed) throw new Error('Choose one smoke mode')
const compression = process.env.LOOM_DSH_METADATA_COMPRESSION ?? 'none'
if (!['none', 'zstd'].includes(compression)) throw new Error('Unknown metadata smoke compression')
const harness = args.length === 2 && args[0] === '--harness-root' && isAbsolute(args[1]) ? args[1] : undefined
if (!harness) throw new Error('Usage: node scripts/smoke-dsh-state.mjs --harness-root /absolute/path/to/@deepseek-ai/dsh [--managed]')
const url = process.env.LOOM_DSH_B1_DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Set LOOM_DSH_B1_DATABASE_URL to an explicitly disposable _test PostgreSQL database')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const manifest = await readJson(join(harness, 'package.json'))
if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.1-rc.3') throw new Error('B1 live contract is pinned to Harness 0.2.1-rc.3')
const harnessRequire = createRequire(join(harness, 'package.json')), projectRequire = createRequire(join(root, 'package.json'))
const folder = await mkdtemp(join(tmpdir(), 'loom-dsh-rc3-'))
try {
  await cp(join(root, 'lib'), join(folder, 'lib'), { recursive: true })
  await mkdir(join(folder, 'node_modules', '@deepseek-ai'), { recursive: true })
  // Link the selected Harness's actual dependency graph. Do not accidentally resolve alpha.2 from the checkout.
  for (const name of ['cordis', 'schemastery', 'dsh-session', 'dsh-session-persistence', 'dsh-scope',
    ...(managed ? ['dsh-agent', 'dsh-agent-loop', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools'] : []),
    // state backup now understands metadata too; the storage API is an explicit peer.
    'dsh-storage', ...(metadata ? ['dsh-storage-domain', 'dsh-storage-json', 'dsh-workspace', 'dsh-session-persistence-jsonl', 'dsh-attachment', 'dsh-attachment-local'] : [])]) {
    const packageRoot = dirname(harnessRequire.resolve(`@deepseek-ai/${name}/package.json`))
    await symlink(packageRoot, join(folder, 'node_modules', '@deepseek-ai', name), 'dir')
  }
  for (const name of ['pg', 'zod', 'proper-lockfile']) await symlink(dirname(projectRequire.resolve(`${name}/package.json`)), join(folder, 'node_modules', name), 'dir')
  await writeFile(join(folder, 'package.json'), JSON.stringify({ type: 'module' }))
  if (metadata) { await mkdir(join(folder, 'scripts')); await cp(new URL('./dsh-state-admin.mjs', import.meta.url), join(folder, 'scripts', 'dsh-state-admin.mjs')); await cp(new URL('./native-attachment-io.mjs', import.meta.url), join(folder, 'scripts', 'native-attachment-io.mjs')) }
  const probe = metadata ? await readFile(new URL('./fixtures/dsh-metadata.mjs', import.meta.url), 'utf8') : managed ? await readFile(new URL('./fixtures/dsh-managed.mjs', import.meta.url), 'utf8') : `
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import { apply } from './lib/dsh-state.js'
const [phase, tenantId] = process.argv.slice(2)
const ctx = new Context()
await apply(ctx, { tenantId, spaceId: 'native-rc3-smoke', databaseUrlEnv: 'LOOM_DSH_B1_DATABASE_URL' })
await ctx.plugin(SessionStore)
const provider = ctx.sessionPersistence, id = SessionId('worker-rc3-stable')
try {
  if (phase === 'seed') {
    const session = ctx.sessions.prepare(id, { meta: { agentPreset: 'b1-fixture', cwd: '/tmp/loom-b1-rebuildable-scratch' } })
    const writer = await provider.create(session.header)
    const detach = ctx.sessions.enter(session); ctx.sessions.announce(session)
    session.append('model/selection', { provider: 'fixture', model: 'synthetic' })
    session.append('user/message', { id: 'b1-stable-input', role: 'user', source: { kind: 'b1-fixture' }, content: [{ type: 'text', text: 'Synthetic B1 history; no external task.' }] }, { surfaceOp: 'append' })
    assert.equal(await ctx.sessions.flush(session), true)
    const saved = await writer.read(); assert.equal(saved.events.length, 2)
    const fork = ctx.sessions.prepare(SessionId('worker-rc3-fork'), { seed: saved.events, inheritedEventCount: SessionLogOffset(2), meta: { isSeeded: true, parentSession: id, agentPreset: 'b1-fixture' } })
    const child = await provider.create(fork.header, { inheritedEventCount: fork.inheritedEventCount })
    await child.append(fork.snapshotEvents()); await child.flush(); await child.close()
    detach(); await writer.close()
    console.log(JSON.stringify({ phase, id, count: saved.events.length, header: writer.header, forkCount: fork.seq }))
  } else {
    const writer = await provider.open(id, 'write'), saved = await writer.read()
    assert.equal(saved.events.length, 2); assert.equal(saved.events[1].data.id, 'b1-stable-input')
    const session = Session.fromRestore(id, saved.events, writer.header, writer.inheritedEventCount, saved.eventState)
    // Constructor-only restore markers precede publication and must be persisted explicitly by the agent factory.
    await writer.append(session.snapshotEvents(SessionLogOffset(saved.events.length)))
    const detach = ctx.sessions.enter(session); ctx.sessions.announce(session)
    session.append('model/selection', { provider: 'fixture', model: 'continued' })
    await ctx.sessions.flush(session)
    const after = await writer.read(); assert.equal(after.events.length, 4)
    assert.equal(after.events.filter(e => e.type === 'user/message' && e.data.id === 'b1-stable-input').length, 1)
    const child = await provider.open(SessionId('worker-rc3-fork'), 'read')
    assert.equal(child.inheritedEventCount, 2); assert.equal(child.header.parentSession, id)
    const read = await child.read(); assert.equal(read.events[1].data.id, 'b1-stable-input')
    detach(); await writer.close(); await child.close()
    console.log(JSON.stringify({ phase, id, before: 2, after: after.events.length, header: writer.header, inputOccurrences: 1, forkCut: 2 }))
  }
} finally { await provider.dispose(); await ctx.fiber.dispose() }
`
  await writeFile(join(folder, 'probe.mjs'), probe)
  const tenantId = `b1-smoke-${randomUUID()}`, phases = []
  for (const phase of ['seed', 'recover']) {
    const cwd = await mkdtemp(join(folder, 'compute-'))
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(folder, 'probe.mjs'), phase, tenantId], { cwd,
        env: { PATH: process.env.PATH, LOOM_DSH_B1_DATABASE_URL: url, LOOM_NATIVE_SMOKE_ROOT: folder, LOOM_NATIVE_SMOKE_HARNESS: harness, LOOM_DSH_METADATA_COMPRESSION: compression, LOOM_DSH_METADATA_ATTACHMENTS: process.env.LOOM_DSH_METADATA_ATTACHMENTS ?? '', LOOM_NATIVE_TEST_DIAGNOSTIC: process.env.LOOM_NATIVE_TEST_DIAGNOSTIC ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Isolated rc.3 smoke timed out')) }, 20_000)
      child.once('error', () => { clearTimeout(timeout); reject(new Error('Cannot launch rc.3 smoke subprocess')) })
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? done(stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1))
        : reject(new Error(`rc.3 ${phase} failed (${code}): ${stderr.replaceAll(url, '[database]')}`)) })
    })
    phases.push(result)
  }
  assert.deepEqual(phases[1].header, phases[0].header, 'Replacement changed the immutable native header')
  const contract = {}
  for (const file of ['index', 'handle', 'storage-contract', 'errors', 'revision']) {
    const actual = await readFile(join(dirname(harnessRequire.resolve('@deepseek-ai/dsh-session-persistence/package.json')), 'lib', 'types', `${file}.d.ts`))
    const development = await readFile(join(dirname(projectRequire.resolve('@deepseek-ai/dsh-session-persistence/package.json')), 'lib', 'types', `${file}.d.ts`))
    contract[file] = { sha256: createHash('sha256').update(actual).digest('hex'), identicalToDevelopment: actual.equals(development) }
  }
  if (metadata) for (const file of ['backend', 'error', 'index', 'registry']) {
    const actual = await readFile(join(dirname(harnessRequire.resolve('@deepseek-ai/dsh-storage/package.json')), 'lib', 'types', `${file}.d.ts`))
    const development = await readFile(join(dirname(projectRequire.resolve('@deepseek-ai/dsh-storage/package.json')), 'lib', 'types', `${file}.d.ts`))
    contract[`storage/${file}`] = { sha256: createHash('sha256').update(actual).digest('hex'), identicalToDevelopment: actual.equals(development) }
  }
  console.log(JSON.stringify({ harness: manifest.version, nativeFormat: 4, scope: 'synthetic-only', ...(metadata ? { compression } : {}), mode: metadata ? 'native-jsonl-import-workspace-recovery' : managed ? 'managed-idle-agent-lifecycle' : 'native-session-store', phases, contract }, null, 2))
} finally { await rm(folder, { recursive: true, force: true }) }
