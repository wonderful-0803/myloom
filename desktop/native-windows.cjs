'use strict'
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { randomBytes, createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { executable, commandSpec } = require('./commands.cjs')
const { privateDirectory } = require('./private-files.cjs')
const { dataHome } = require('./platform.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function alive(pid) { try { if (!Number.isSafeInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true } catch { return false } }
function read(file) { try { if (!fs.lstatSync(file).isFile()) return; return JSON.parse(fs.readFileSync(file, 'utf8')) } catch {} }
function atomic(file, value) { const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp'; fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file) }
async function pipeRequest(record, action, timeout = 1500) {
  if (!record || !/^\\\\\.\\pipe\\loom-[a-f0-9]{40}$/.test(record.pipe || '') || !/^[a-f0-9]{64}$/.test(record.token || '')) throw new Error('本机进程归属记录无效。')
  return new Promise((resolve, reject) => {
    const client = net.connect(record.pipe); let text = ''
    const timer = setTimeout(() => client.destroy(new Error('本机控制连接超时。')), timeout)
    client.on('connect', () => client.write(JSON.stringify({ token: record.token, action }) + '\n'))
    client.on('data', chunk => {
      text += chunk.toString('utf8')
      if (text.length > 8192) { client.destroy(new Error('本机控制响应超过限制。')); return }
      if (!text.includes('\n')) return
      try { const result = JSON.parse(text.slice(0, text.indexOf('\n'))); if (!result.ok) throw new Error('本机进程尚未确认操作。'); resolve(result) }
      catch { reject(new Error('本机进程尚未确认操作。')) }
      client.destroy()
    })
    client.on('error', () => reject(new Error('无法核验本机助手进程。')))
    client.on('close', () => { clearTimeout(timer); reject(new Error('本机控制连接已关闭。')) })
  })
}
class NativeWindowsControl {
  constructor(config, dependencies = {}) {
    this.root = config.backendRoot; this.base = config.serviceURL || 'http://127.0.0.1:3082'; this.profile = config.profile || 'superagent'
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(this.profile)) throw new Error('本机助手配置名称无效。')
    this.home = config.runtimeHome || process.env.DSH_PERSONAL_HOME || path.join(dataHome(), 'superagent', 'dsh')
    this.directory = path.join(this.home, 'desktop-control', this.profile)
    this.recordFile = path.join(this.directory, 'service.json'); this.stopFile = path.join(this.directory, 'manually-stopped')
    this.launch = dependencies.spawn || spawn; this.request = dependencies.request || this.fetchState
    this.command = dependencies.command || (() => { const file = executable('dsh', process.env, this.root); if (!file) throw new Error('缺少 Windows 原生 DeepSeek Harness。'); return commandSpec(file, ['--profile', this.profile, '--no-open'], this.root) })
    this.timeout = dependencies.timeout || 45000
  }
  async fetchState() {
    try {
      const response = await fetch(this.base + '/orchestrator/api/state', { headers: { 'x-orchestrator-request': '1' }, redirect: 'error', signal: AbortSignal.timeout(2000) })
      if (!response.ok) return
      const text = await response.text(); if (text.length > 1024 * 1024) return
      const value = JSON.parse(text)
      return { health: Object.fromEntries(Object.entries(value.health || {}).map(([key, value]) => [key, value?.state])), setup: value.setup?.problem || null }
    } catch {}
  }
  async owned() {
    const record = read(this.recordFile)
    if (!record) return undefined
    try {
      const proof = await pipeRequest(record, 'status')
      if (proof.cwd !== record.cwd || proof.profile !== record.profile || proof.url !== record.url || !alive(proof.pid)) throw new Error('Owner mismatch')
      return { ...record, pid: proof.pid }
    } catch {
      if (alive(record.pid)) return { ...record, uncertain: true }
      return undefined
    }
  }
  async status() {
    const record = await this.owned(), current = await this.request()
    const occupied = !record && (current || await this.portOccupied())
    return { pids: record ? [record.pid] : [], cwd: record?.uncertain || occupied ? '' : record?.cwd || this.root,
      url: record?.url || this.base, manually_stopped: fs.existsSync(this.stopFile), health: current?.health || null, setup: current?.setup || null }
  }
  async portOccupied() {
    const address = new URL(this.base)
    return new Promise(resolve => {
      const socket = net.connect({ host: address.hostname, port: Number(address.port) || 80 })
      socket.setTimeout(500)
      const finish = occupied => { socket.destroy(); resolve(occupied) }
      socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false))
    })
  }
  async lock() {
    const name = createHash('sha256').update(path.resolve(this.home) + '\0' + this.profile).digest('hex').slice(0, 40)
    const server = net.createServer(client => client.destroy())
    await new Promise((resolve, reject) => { server.once('error', () => reject(new Error('本机助手正在执行另一项启停操作。'))); server.listen('\\\\.\\pipe\\loom-control-' + name, resolve) })
    return () => new Promise(resolve => server.close(resolve))
  }
  async invoke(action, explicit = false) {
    if (!['status', 'start', 'stop'].includes(action)) throw new Error('不支持此本机操作。')
    if (action === 'status') return { code: 0, stdout: JSON.stringify(await this.status()) }
    privateDirectory(this.directory)
    const release = await this.lock()
    try {
      let status = await this.status()
      if (status.cwd !== this.root || status.url !== this.base) throw new Error('进程或端口归属未确认，未启动或停止其他程序。')
      if (action === 'stop') {
        if (!explicit) return { code: 0, stdout: JSON.stringify(status) }
        atomic(this.stopFile, new Date().toISOString())
        const record = await this.owned()
        if (record) {
          await pipeRequest(record, 'stop')
          const deadline = Date.now() + this.timeout
          while (alive(record.pid)) { if (Date.now() >= deadline) throw new Error('尚未确认助手安全停止，没有发送强制结束指令。'); await delay(200) }
        }
      } else {
        if (status.pids.length || status.manually_stopped && !explicit) return { code: 0, stdout: JSON.stringify(status) }
        const spec = this.command(), record = { version: 1, cwd: this.root, url: this.base, profile: this.profile,
          pipe: '\\\\.\\pipe\\loom-' + randomBytes(20).toString('hex'), token: randomBytes(32).toString('hex'), pid: 0 }
        atomic(this.recordFile, JSON.stringify(record))
        const logFile = path.join(this.directory, 'service.log'), log = fs.openSync(logFile, 'a', 0o600)
        let child
        try {
          const node = executable('node', process.env, this.root)
          if (!node) throw new Error('缺少 Windows 原生 Node.js。')
          child = this.launch(node, [path.join(__dirname, 'windows-service.cjs')], { cwd: this.root, detached: true, windowsHide: true,
            env: { ...process.env, DSH_HOME: this.home, DSH_PERSONAL_HOME: this.home, DSH_AGENTS_HOME: path.join(path.dirname(this.home), 'agents') }, stdio: ['pipe', log, log] })
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
          record.pid = child.pid; atomic(this.recordFile, JSON.stringify(record))
          child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ ...record, program: spec.program, argv: spec.args }))
          child.unref()
        } finally { fs.closeSync(log) }
        fs.rmSync(this.stopFile, { force: true })
        const deadline = Date.now() + this.timeout
        do {
          status = await this.status()
          if (status.pids.length && (['ready', 'paused'].includes(status.health?.runtime) || status.setup)) break
          if (Date.now() >= deadline) throw new Error('助手进程已启动，但尚未确认就绪，请查看连接状态。')
          await delay(250)
        } while (true)
      }
      return { code: 0, stdout: JSON.stringify(await this.status()) }
    } finally { await release() }
  }
}
module.exports = { NativeWindowsControl, pipeRequest, alive }
