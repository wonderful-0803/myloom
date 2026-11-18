#!/usr/bin/env node
/** Actual compiled CLI/SQLite/text-file smoke. Disposable identities and fictional records; no network. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, sign } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { permitPayload } from '../lib/runner.js'
import { intentHash } from '../lib/execution.js'
const exec = promisify(execFile), script = fileURLToPath(new URL('./runner-local.mjs', import.meta.url))
if (process.platform !== 'linux' || !process.getuid?.()) throw Error('Linux non-root smoke only')
const folder = await mkdtemp(join(tmpdir(), 'loom-c2-compiled-')), home = join(folder, 'state'), root = join(folder, 'records'), env = { PATH: process.env.PATH, HOME: folder }
const children = []
async function cli(args) { const r = await exec(process.execPath, [script, ...args], { cwd: folder, env, timeout: 10000 }); return JSON.parse(r.stdout) }
async function server() {
  const child = spawn(process.execPath, [script, 'stdio', '--home', home], { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
  let buffer = '', failure = '', wait; const messages = []
  child.stderr.on('data', b => { failure += b; if (failure.length > 10000) child.kill('SIGKILL') })
  child.stdout.on('data', b => { buffer += b; let end; while ((end = buffer.indexOf('\n')) >= 0) { const item = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (wait) { const done = wait; wait = undefined; done(item) } else messages.push(item) } })
  const exited = new Promise(resolve => child.once('close', resolve))
  return { async call(op, request) {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wait = undefined; reject(Error('Compiled Runner response timeout')) }, 5000)
      const done = value => { clearTimeout(timer); resolve(value) }
      if (messages.length) done(messages.shift()); else wait = done
    })
    child.stdin.write(JSON.stringify({ op, request }) + '\n'); return response
  }, async stop() { child.stdin.end(); assert.equal(await exited, 0, 'Compiled Runner must close cleanly') } }
}
try {
  await mkdir(root, { mode: 0o700 }); await writeFile(join(root, 'daily.txt'), 'R1：完成资料整理。\nR2：明天复核汇总。', { mode: 0o600 })
  const binding = { tenantId: 'synthetic-tenant', spaceId: 'synthetic-personal-space', userId: 'synthetic-owner', environmentId: 'synthetic-linux' }, keys = generateKeyPairSync('ed25519')
  await writeFile(join(folder, 'binding.json'), JSON.stringify(binding), { mode: 0o600 }); await writeFile(join(folder, 'gateway.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  await cli(['init', '--home', home, '--binding', join(folder, 'binding.json'), '--gateway-key', join(folder, 'gateway.pub')])
  await writeFile(join(folder, 'grant.json'), JSON.stringify({ id: 'records', workspaceId: 'daily', scope: 'personal', root, capabilities: ['fs.read', 'fs.glob', 'fs.grep'], extensions: ['.txt'], expiresAt: new Date(Date.now() + 3600000).toISOString() }), { mode: 0o600 })
  assert.equal((await cli(['grant', '--home', home, '--grant', join(folder, 'grant.json')])).revision, 1)
  const args = { path: 'daily.txt', offset: 0, limit: 10 }, { createHash } = await import('node:crypto')
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value)
  const request = { protocolVersion: 1, requestId: 'compiled-stable-read', ...binding, ticketId: 'task', assignmentId: 'assignment', sessionId: 'session', workspaceId: 'daily', toolId: 'fs.read', toolVersion: 1, effect: 'read',
    resourceGrantId: 'records', grantRevision: 1, controlRevision: 0, sessionEpoch: 1, expiresAt: new Date(Date.now() + 30000).toISOString(), argsHash: createHash('sha256').update(canonical(args)).digest('hex'), args, permit: '' }
  request.permit = sign(null, permitPayload(request), keys.privateKey).toString('base64url')
  const query = { protocolVersion: 1, requestId: request.requestId, intentHash: intentHash(request) }, first = await server()
  assert.equal((await first.call('dispatch', request)).receipt.status, 'accepted')
  let receipt
  for (let i = 0; i < 100; i++) { const result = await first.call('query', query); assert.equal(result.ok, true); receipt = result.receipt; if (!['running', 'accepted'].includes(receipt.status)) break; await delay(10) }
  assert.equal(receipt.status, 'succeeded'); assert.ok(receipt.result.text.includes('R1')); assert.ok(receipt.result.text.includes('R2'))
  assert.equal((await first.call('dispatch', { ...request, toolId: 'bash' })).ok, false)
  await first.stop(); await writeFile(join(root, 'daily.txt'), 'Changed after the first completion')
  const replacement = await server(); assert.deepEqual((await replacement.call('query', query)).receipt, receipt); assert.deepEqual((await replacement.call('dispatch', request)).receipt, receipt); await replacement.stop()
  assert.equal((await stat(join(home, 'receipts.sqlite'))).mode & 0o777, 0o600)
  await cli(['revoke', '--home', home, '--id', 'records', '--revision', '1'])
  const revoked = await server(); assert.equal((await revoked.call('query', query)).ok, false); await revoked.stop()
  console.log(JSON.stringify({ compiledCli: true, realLocalTextRead: true, receiptSurvivedProcessRestart: true, sameIdNotReexecuted: true, shellDenied: true, revokedCacheDenied: true, privatePermissions: true, fileResultHash: receipt.resultHash, networkCalls: 0, personalDirectoriesRead: false }))
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(done => child.once('close', done)); child.kill('SIGKILL'); await exit }
  await rm(folder, { recursive: true, force: true })
}
