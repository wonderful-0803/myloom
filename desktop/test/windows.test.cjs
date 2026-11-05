'use strict'
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { randomBytes } = require('node:crypto')
const { promisify } = require('node:util')
const { execFile } = require('node:child_process')
const { NativeWindowsControl, pipeRequest, alive } = require('../native-windows.cjs')
const { commandSpec, executable } = require('../commands.cjs')
const roots = [], controls = []
const native = { skip: process.platform !== 'win32' }
afterEach(async () => {
  for (const control of controls.splice(0)) await control.invoke('stop', true).catch(() => {})
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-native-windows-')); roots.push(root); return root }
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value }

test('native CLI arguments preserve quotes, Unicode and shell metacharacters without a command shell', native, async () => {
  const root = temporary(), entry = path.join(root, 'a CLI with spaces.cjs')
  fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const values = ['退款金额', 'a & b', '$env:PATH', '"quoted"', '%USERPROFILE%', ';Write-Output should-not-run']
  const spec = commandSpec(entry, values)
  assert.equal(spec.program, executable('node')); assert.deepEqual(spec.args, [entry, ...values])
  const result = await promisify(execFile)(spec.program, spec.args, { encoding: 'utf8', windowsHide: true })
  assert.deepEqual(JSON.parse(result.stdout), values)
  assert.throws(() => commandSpec('something.cmd', []), /原生可执行/)
})

test('native service owns one Windows process, survives client objects and stops gracefully only after explicit action', native, async () => {
  const root = temporary(), url = 'http://127.0.0.1:' + await port(), entry = path.join(root, 'test harness.cjs'), marker = path.join(root, 'graceful.txt')
  fs.writeFileSync(entry, `exports.runCli=()=>{const http=require('node:http'),fs=require('node:fs');const server=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({health:{runtime:{state:'ready'}},setup:{}}));});process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(marker)},'graceful');server.close();});server.listen(${new URL(url).port},'127.0.0.1');};`)
  let launches = 0
  const config = { backendRoot: root, runtimeHome: path.join(root, 'private'), profile: 'loom-123456789abc', serviceURL: url }
  const command = () => { launches++; return { program: executable('node'), args: [entry] } }
  const control = new NativeWindowsControl(config, { command, timeout: 8000 }); controls.push(control)
  await control.invoke('start', true)
  const first = await control.status(); assert.equal(first.pids.length, 1); assert.ok(alive(first.pids[0])); assert.equal(first.health.runtime, 'ready')
  await control.invoke('start', true); assert.equal(launches, 1)
  const reopened = new NativeWindowsControl(config, { command, timeout: 8000 })
  assert.deepEqual((await reopened.status()).pids, first.pids)
  await reopened.invoke('stop', false); assert.ok(alive(first.pids[0]))
  const record = JSON.parse(fs.readFileSync(control.recordFile, 'utf8'))
  await assert.rejects(pipeRequest({ ...record, token: '0'.repeat(64) }, 'stop', 500))
  assert.ok(alive(first.pids[0]))
  await reopened.invoke('stop', true)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'graceful'); assert.equal(alive(first.pids[0]), false)
  assert.equal((await reopened.status()).manually_stopped, true)
  await reopened.invoke('start', false); assert.equal(launches, 1)
  await reopened.invoke('start', true); assert.equal(launches, 2)
})

test('a Windows port answered by an unowned service cannot be reused or stopped', native, async () => {
  const root = temporary(), server = net.createServer(socket => socket.destroy()), value = await port()
  await new Promise(resolve => server.listen(value, '127.0.0.1', resolve))
  let launched = false
  const control = new NativeWindowsControl({ backendRoot: root, runtimeHome: path.join(root, 'private'), serviceURL: 'http://127.0.0.1:' + value },
    { command: () => { launched = true; throw new Error('must not run') } })
  try { await assert.rejects(control.invoke('start', true), /归属/); await assert.rejects(control.invoke('stop', true), /归属/); assert.equal(launched, false) }
  finally { await new Promise(resolve => server.close(resolve)) }
})

test('a reused PID without a matching private control pipe is never trusted', native, async () => {
  const root = temporary(), home = path.join(root, 'private'), control = new NativeWindowsControl({ backendRoot: root, runtimeHome: home }, { request: async () => undefined })
  fs.mkdirSync(control.directory, { recursive: true })
  fs.writeFileSync(control.recordFile, JSON.stringify({ pid: process.pid, cwd: root, url: control.base, profile: control.profile,
    pipe: '\\\\.\\pipe\\loom-' + randomBytes(20).toString('hex'), token: randomBytes(32).toString('hex') }))
  assert.equal((await control.status()).cwd, '')
  await assert.rejects(control.invoke('start', true), /归属/)
})
