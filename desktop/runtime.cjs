'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { serviceURL } = require('./policy.cjs')

function executable(name, environment = process.env) {
  return (environment.PATH || '').split(path.delimiter).map(folder => path.join(folder, name)).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
  })
}
function installation(directory) {
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return { valid: false, missing: ['请选择已配置的本机助手目录。'] }
    const root = fs.realpathSync(directory)
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (pkg.name !== 'dsh-superagent') return { valid: false, missing: ['请选择 Superagent 项目目录。'] }
    const required = ['scripts/personal-superagent', 'scripts/dsh-superagent', 'lib/index.js', 'loom/dist/client/index.html']
    const missing = required.filter(file => !fs.existsSync(path.join(root, file)))
    return { root, valid: !missing.length, missing: missing.length ? ['本机助手尚未完成构建，请先按项目运行说明准备。'] : [] }
  } catch { return { valid: false, missing: ['未找到已安装的个人助手，请选择现有 Superagent 项目目录。'] } }
}
function command(program, args, options) {
  return new Promise((resolve, reject) => execFile(program, args, options, (error, stdout) => {
    // Exit 2/3 means a component needs attention or setup is pending, not that the process is absent.
    if (error && ![1, 2, 3].includes(error.code)) reject(new Error('本机助手控制命令未完成，请检查连接与日志。'))
    else resolve({ code: error?.code ?? 0, stdout })
  }))
}
async function json(base, route) {
  const response = await fetch(serviceURL(base) + route, { headers: { 'x-orchestrator-request': '1' }, redirect: 'error', signal: AbortSignal.timeout(3500) })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('本机助手尚未就绪。')
  const chunks = []; let size = 0
  for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('本机响应过大。'); chunks.push(Buffer.from(chunk)) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
/** Connects to exactly one existing personal service; never opens its database or reads credential files. */
class RuntimeLink {
  constructor(config, dependencies = {}) {
    this.root = config.backendRoot || ''
    this.base = serviceURL(config.serviceURL)
    this.profile = config.profile
    this.runtimeHome = config.runtimeHome
    if (this.profile && !/^loom-[a-f0-9]{12}$/.test(this.profile)) throw new Error('无效的桌面助手环境。')
    if (this.runtimeHome && (!path.isAbsolute(this.runtimeHome) || !this.profile)) throw new Error('无效的桌面助手目录。')
    this.run = dependencies.run || command
    this.request = dependencies.request || json
    this.find = dependencies.executable || executable
    this.busy = false
    this.snapshot = undefined
    this.state = { phase: 'checking', connected: false, message: '正在识别本机个人助手…', backendRoot: this.root, serviceURL: this.base }
  }
  async invoke(action) {
    const found = installation(this.root)
    if (!found.valid) throw new Error(found.missing[0])
    return this.run(path.join(found.root, 'scripts/personal-superagent'), [action, '--url', this.base, '--timeout', '45', '--stop-timeout', '45', ...this.profile ? ['--profile', this.profile] : [], ...action === 'start' ? ['--respect-stop'] : []],
      { cwd: found.root, env: this.environment(), timeout: action === 'status' ? 9000 : 55_000, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true })
  }
  environment() { return { ...process.env, ...this.runtimeHome ? { DSH_PERSONAL_HOME: this.runtimeHome, DSH_AGENTS_HOME: path.join(path.dirname(this.runtimeHome), 'agents') } : {} } }
  async probe() {
    if (this.busy) return this.state
    if (this.probing) return this.probing
    this.probing = this.inspect()
    try { return await this.probing } finally { this.probing = undefined }
  }
  async inspect() {
    const found = installation(this.root)
    const missing = ['dsh', 'python3', 'tmux'].filter(name => !this.find(name))
    if (!found.valid || missing.length) return this.state = { phase: 'missing', connected: false, backendRoot: this.root, serviceURL: this.base,
      message: found.missing[0] || '本机运行依赖尚未准备好。', missing: [...found.missing, ...missing.map(name => `缺少运行依赖：${name}`)] }
    this.root = found.root
    let status
    try { status = JSON.parse((await this.invoke('status')).stdout) }
    catch { return this.state = { phase: 'unavailable', connected: false, backendRoot: this.root, serviceURL: this.base, message: '暂时无法检查本机助手，请重新检测。' } }
    const common = { backendRoot: this.root, serviceURL: this.base, connected: false, intentionallyStopped: status.manually_stopped === true }
    if (!Array.isArray(status.pids) || status.pids.length > 1 || status.cwd !== this.root || status.url !== this.base)
      return this.state = { ...common, phase: 'unavailable', message: '助手进程或连接归属不一致，已阻止重复启动。' }
    if (!status.pids.length) return this.state = { ...common, phase: 'stopped', message: common.intentionallyStopped ? '你已停止本机助手，点击启动后才会继续。' : '已找到现有配置，准备启动本机助手。' }
    if (status.setup) return this.state = { ...common, phase: 'setup', message: '已找到助手，还需完成飞书或模型的本机配置。' }
    try {
      const snapshot = await this.request(this.base, '/orchestrator/api/loom')
      if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.artifacts) || typeof snapshot.model !== 'string' || typeof snapshot.connection?.appId !== 'string') throw new Error('Invalid workspace')
      this.snapshot = snapshot
      return this.state = { ...common, phase: 'ready', connected: true, message: snapshot.paused ? '本机助手已连接 · 后台执行已暂停' : Object.values(status.health || {}).includes('error') ? '本机助手已连接 · 有组件需要检查' : '本机助手已连接', paused: snapshot.paused,
        model: snapshot.model.slice(0, 100), botName: String(snapshot.connection.name || '飞书助手').slice(0, 100),
        tasks: snapshot.tasks.length, active: snapshot.tasks.filter(task => !task.completed && task.status === 'open').length,
        attention: snapshot.tasks.filter(task => task.status === 'blocked').length, artifacts: snapshot.artifacts.length,
        components: Object.entries(status.health || {}).filter(([name]) => ['runtime', 'models', 'feishu', 'history', 'evals', 'result'].includes(name)).map(([name, state]) => ({ name, state })) }
    } catch { return this.state = { ...common, phase: 'unavailable', message: '服务正在运行，个人工作空间暂不可用；请检查配置，不会启动第二个服务。' } }
  }
  async action(action, explicit = false) {
    if (this.operation) return this.operation
    this.operation = this.perform(action, explicit)
    try { return await this.operation } finally { this.operation = undefined }
  }
  async perform(action, explicit) {
    if (!['start', 'stop'].includes(action)) throw new Error('不支持此操作。')
    if (action === 'stop' && !explicit) return this.state
    if (this.busy) return this.state
    const before = await this.probe()
    if (action === 'start' && before.phase !== 'stopped') return before
    if (action === 'start' && before.intentionallyStopped && !explicit) return before
    if (action === 'stop' && !before.connected) return before
    this.busy = true
    this.state = { ...this.state, phase: action === 'start' ? 'starting' : 'stopping', message: action === 'start' ? '正在启动本机助手…' : '正在安全停止助手…' }
    this.changed?.()
    try {
      if (explicit && action === 'start') {
        const found = installation(this.root)
        await this.run(path.join(found.root, 'scripts/personal-superagent'), ['start', '--url', this.base, '--timeout', '45', ...this.profile ? ['--profile', this.profile] : []],
          { cwd: found.root, env: this.environment(), timeout: 55_000, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true })
      } else await this.invoke(action)
    } catch { this.state = { ...this.state, phase: 'unavailable', connected: false, message: '助手操作未确认，请重新检测实际状态；没有强制结束进程。' } }
    finally { this.busy = false }
    return this.probe()
  }
}
module.exports = { RuntimeLink, installation, executable, command, json }
