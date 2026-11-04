'use strict'
// Native-only first-run controller. No service, message listener or paid task starts
// until the owner reviews the exact scope and explicitly presses Start.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { RuntimeLink, executable, installation } = require('./runtime.cjs')
const policy = require('./policy.cjs')
const { dataHome } = require('./platform.cjs')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('配置路径不是普通文件。')
  const temporary = file + '.' + randomUUID() + '.tmp'
  fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file)
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }
function run(program, args, options = {}, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(program, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout) => {
      if (error) reject(new Error('本机配置命令未完成。请检查网络、依赖和应用发布状态后重试。'))
      else resolve(stdout)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
async function responseJSON(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`连接未通过（HTTP ${response.status}）。请核对地址、凭证、模型或平台权限。`)
  const chunks = []; let size = 0
  for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error('校验响应超过限制。'); chunks.push(Buffer.from(chunk)) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('接口没有返回有效 JSON，请核对服务地址。') }
}
function modelInput(value) {
  if (!value || typeof value !== 'object') throw new Error('请填写模型配置。')
  let url
  try { url = new URL(value.baseURL) } catch { throw new Error('请填写模型 API 的完整地址。') }
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1') || url.username || url.password || url.search || url.hash)
    throw new Error('模型地址需为 HTTPS；本机服务可用 http://127.0.0.1。地址中不能包含密钥或查询参数。')
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!model || model.length > 200 || /[\x00-\x1f]/.test(model)) throw new Error('请填写有效的模型 ID。')
  return { baseURL: url.href.replace(/\/$/, ''), model }
}
function secret(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 8192 && !/[\s\x00]/.test(value) }
async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) })
  })
}
class Onboarding {
  constructor({ directory, projectRoot, legacy, dataRoot }, dependencies = {}) {
    this.directory = directory; this.projectRoot = projectRoot; this.legacy = legacy
    this.dataRoot = dataRoot || path.join(dataHome(), 'luxi-loom')
    this.run = dependencies.run || run; this.request = dependencies.request || responseJSON
    this.find = dependencies.executable || executable; this.port = dependencies.port || availablePort
    this.runtimeFactory = dependencies.runtime || (config => new RuntimeLink(config))
    this.config = read(path.join(directory, 'onboarding.json')) || { version: 1, id: randomUUID(), prepared: false }
    if (typeof this.config.projectRoot === 'string') this.projectRoot = this.config.projectRoot
    if (!/^[a-f0-9-]{36}$/.test(this.config.id) || this.config.version !== 1) throw new Error('首次配置记录无效，请保留现场检查。')
    this.root = path.join(this.dataRoot, 'instances', this.config.id)
    this.profile = 'loom-' + this.config.id.replaceAll('-', '').slice(0, 12)
    this.active = !this.config.completed; this.busy = false; this.message = '从这里，连接你的个人助手。'; this.error = ''; this.groups = []; this.members = []; this.conflicts = []
  }
  persist() { write(path.join(this.directory, 'onboarding.json'), JSON.stringify(this.config, null, 2)) }
  /** Called only with a directory returned by the trusted native picker; changing an initialized engine is refused. */
  selectProject(directory) {
    if (this.busy || !this.active || this.config.prepared) throw new Error('仅可在准备环境前选择办公引擎。')
    const found = installation(directory)
    if (!found.valid || !fs.existsSync(path.join(found.root, 'lib/personal-setup.js'))) throw new Error('请选择已完成构建的 Loom 办公引擎目录。')
    this.projectRoot = found.root; this.config.projectRoot = found.root; this.persist(); this.notify('办公引擎已选择，请检查本机环境。')
  }
  connection() { return { backendRoot: this.projectRoot, serviceURL: this.config.serviceURL, runtimeHome: path.join(this.root, 'dsh'), profile: this.profile } }
  environment() {
    const found = installation(this.projectRoot)
    const checks = ['node', 'dsh', 'python3', 'tmux', 'lark-cli'].map(name => ({ name, available: !!this.find(name) }))
    checks.unshift({ name: 'Loom 办公引擎', available: found.valid && fs.existsSync(path.join(this.projectRoot, 'lib/personal-setup.js')) })
    return checks
  }
  view() {
    return { active: this.active, busy: this.busy, message: this.message, error: this.error, prepared: this.config.prepared,
      model: this.config.model || null, bot: this.config.bot || null, scope: this.config.scope || null, frozen: !!this.config.frozen,
      completed: !!this.config.completed, serviceURL: this.config.serviceURL || '', environment: this.environment(),
      groups: this.groups, members: this.members, conflicts: this.conflicts,
      step: !this.config.prepared ? 0 : !this.config.model ? 1 : !this.config.bot ? 2 : !this.config.scope ? 3 : 4 }
  }
  notify(message) { if (message) this.message = message; this.changed?.() }
  ensureRoot() {
    if (fs.existsSync(this.root) && fs.lstatSync(this.root).isSymbolicLink()) throw new Error('配置目录不能是符号链接。')
    const marker = path.join(this.root, '.loom-instance')
    if (fs.existsSync(this.root) && !fs.existsSync(marker)) throw new Error('已有目录不属于本向导，未覆盖。')
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, this.config.id, { mode: 0o600, flag: 'wx' })
  }
  env() {
    return { ...process.env, DSH_HOME: path.join(this.root, 'dsh'), DSH_PERSONAL_HOME: path.join(this.root, 'dsh'),
      DSH_AGENTS_HOME: path.join(this.root, 'agents'), DSH_SUPERAGENT_PROFILE: this.profile,
      LARKSUITE_CLI_CONFIG_DIR: path.join(this.root, 'lark'), LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
  }
  async action(action, input = {}) {
    if (this.busy) throw new Error('上一步仍在进行，请稍候。')
    if (!this.active) throw new Error('此配置已完成，请在工作空间调整设置。')
    this.busy = true; this.error = ''; this.notify()
    try {
      if (action === 'environment') this.notify('环境检查已更新。')
      else if (action === 'prepare') await this.prepare()
      else if (['model', 'bot', 'scope'].includes(action) && this.config.frozen) throw new Error('运行配置已初始化；请先完成启动，再从设置中调整。')
      else if (action === 'model') await this.saveModel(input)
      else if (action === 'bot') await this.saveBot(input)
      else if (action === 'groups') { await this.listGroups(); this.notify('机器人已加入的群列表已更新。') }
      else if (action === 'members') await this.listMembers(input.chatId)
      else if (action === 'scope') this.saveScope(input)
      else if (action === 'start') await this.start(input)
      else throw new Error('不支持此配置操作。')
      return this.view()
    } catch (error) { this.error = error.message; throw error }
    finally { this.busy = false; this.notify() }
  }
  async prepare() {
    if (this.config.prepared) return
    if (this.environment().some(check => !check.available)) throw new Error('运行环境尚未齐备，请先安装列表中缺少的依赖。向导不会使用 sudo 或覆盖现有助手。')
    this.ensureRoot(); this.config.serviceURL ||= 'http://127.0.0.1:' + await this.port(); this.persist()
    const env = this.env(), profileDir = path.join(env.DSH_HOME, 'profiles', this.profile)
    this.notify('正在创建独立的本机执行环境…')
    if (!fs.existsSync(path.join(profileDir, 'package.json'))) await this.run(this.find('dsh'), ['--profile', this.profile, '--from-default-profile', 'web', '--dump-config'], { env, cwd: this.root })
    this.notify('正在加载 Loom 办公组件，首次准备可能需要下载依赖…')
    await this.run(this.find('dsh'), ['plugin', '--profile', this.profile, 'add', 'link:' + this.projectRoot], { env, cwd: this.root })
    this.config.prepared = true; this.persist(); this.notify('环境已准备好。接下来连接模型。')
  }
  async testModel(model, key) {
    this.notify('正在验证模型连接（仅发送一条固定的短测试，不含个人资料）…')
    const response = await this.request(model.baseURL + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: model.model, messages: [{ role: 'user', content: 'Reply with LOOM_OK.' }], max_tokens: 32, stream: false }) })
    if (!Array.isArray(response.choices) || !response.choices.length) throw new Error('模型接口未返回有效结果，请核对模型 ID 和接口兼容性。')
  }
  async saveModel(input) {
    if (!this.config.prepared) throw new Error('请先准备运行环境。')
    const model = modelInput(input), file = path.join(this.root, 'dsh/.credentials.yaml')
    const previous = this.config.model
    let key = input.apiKey
    if (!key && previous?.baseURL === model.baseURL && previous.model === model.model) key = read(file)?.refs?.LOOM_MODEL_API_KEY
    if (!secret(key)) throw new Error('请在本机输入有效的 API Key。')
    await this.testModel(model, key)
    write(file, JSON.stringify({ version: 1, refs: { LOOM_MODEL_API_KEY: key } }))
    this.config.model = { ...model, verifiedAt: new Date().toISOString() }; this.persist()
    this.notify('模型连接已通过，凭据只保存在本机。')
  }
  async token(bot = this.config.bot, suppliedSecret) {
    if (!bot) throw new Error('请先连接飞书机器人。')
    const appSecret = suppliedSecret || fs.readFileSync(path.join(this.root, 'lark/app-secret'), 'utf8')
    const response = await this.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: bot.appId, app_secret: appSecret }) })
    if (response.code !== 0 || typeof response.tenant_access_token !== 'string') throw new Error(`飞书凭证未通过校验（${Number(response.code) || '未知错误'}），请核对 App ID 和 Secret。`)
    return response.tenant_access_token
  }
  async api(route, token) {
    const result = await this.request('https://open.feishu.cn/open-apis/' + route, { headers: { authorization: 'Bearer ' + (token || await this.token()) } })
    if (result.code !== 0) throw new Error(`飞书读取未通过（${Number(result.code) || '未知错误'}）。请检查应用权限、发布状态和机器人是否已入群。`)
    return result
  }
  async saveBot(input) {
    if (!this.config.model) throw new Error('请先验证模型连接。')
    const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
    if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error('请填写 cli_ 开头的 App ID。')
    let key = input.appSecret
    if (!key && this.config.bot?.appId === appId) key = fs.readFileSync(path.join(this.root, 'lark/app-secret'), 'utf8')
    if (!secret(key) || key.length < 16 || new Set(key).size < 2) throw new Error('请输入真实的 App Secret，不要输入掩码。')
    this.notify('正在验证飞书应用和机器人身份…')
    const token = await this.token({ appId }, key), info = await this.api('bot/v3/info', token)
    if (!/^ou_[A-Za-z0-9]+$/.test(info.bot?.open_id)) throw new Error('应用尚未启用可用的机器人，请检查开发者后台。')
    const secretFile = path.join(this.root, 'lark/app-secret')
    // A CLI file SecretRef keeps this setup independent of the shared app-ID keychain.
    write(secretFile, key)
    write(path.join(this.root, 'lark/config.json'), JSON.stringify({ strictMode: 'bot', currentApp: appId,
      apps: [{ appId, appSecret: { source: 'file', id: secretFile }, brand: 'feishu', defaultAs: 'bot', users: [] }] }))
    const output = await this.run(this.find('lark-cli'), ['auth', 'status', '--json', '--verify'], { env: this.env(), timeout: 25000 })
    let status; try { status = JSON.parse(output) } catch { throw new Error('飞书 CLI 未能确认机器人身份。') }
    if (status.appId !== appId || status.identities?.bot?.verified !== true || status.identities?.user?.available) throw new Error('机器人身份验证失败，或配置中出现了个人登录。')
    if (this.config.bot?.appId !== appId) { delete this.config.scope; this.groups = []; this.members = [] }
    this.config.bot = { appId, name: String(info.bot.app_name || '飞书助手').slice(0, 100), botId: info.bot.open_id, verifiedAt: new Date().toISOString() }
    this.persist(); this.notify('飞书机器人已验证。接下来选择本人和消息范围。')
    try { await this.listGroups(token) } catch { this.notify('机器人已验证；群列表暂不可读，可以先配置本人私聊，或检查群权限后刷新。') }
  }
  async listGroups(token) {
    let cursor = '', groups = []
    for (let page = 0; page < 5; page++) {
      const result = await this.api('im/v1/chats?page_size=100' + (cursor ? '&page_token=' + encodeURIComponent(cursor) : ''), token)
      const data = result.data
      if (!Array.isArray(data?.items)) throw new Error('飞书群列表格式无效。')
      groups.push(...data.items.filter(chat => /^oc_[A-Za-z0-9]+$/.test(chat.chat_id)).map(chat => ({ chatId: chat.chat_id, name: String(chat.name || chat.chat_id).slice(0, 60) })))
      if (!data.has_more) break
      if (!data.page_token || data.page_token === cursor) throw new Error('群列表分页未推进。')
      cursor = data.page_token
    }
    this.groups = [...new Map(groups.map(group => [group.chatId, group])).values()]; this.notify()
  }
  async listMembers(chatId) {
    if (!this.groups.some(group => group.chatId === chatId)) throw new Error('只能查看本次列表中群的成员。')
    let cursor = '', members = []
    for (let page = 0; page < 3; page++) {
      const result = await this.api(`im/v1/chats/${chatId}/members?member_id_type=open_id&page_size=100` + (cursor ? '&page_token=' + encodeURIComponent(cursor) : ''))
      const data = result.data
      if (!Array.isArray(data?.items)) throw new Error('群成员列表无效。')
      members.push(...data.items.filter(member => /^ou_[A-Za-z0-9]+$/.test(member.member_id) && member.member_id !== this.config.bot.botId)
        .map(member => ({ id: member.member_id, name: String(member.name || member.member_id).slice(0, 100) })))
      if (!data.has_more) break
      if (!data.page_token || data.page_token === cursor) throw new Error('成员列表分页未推进。')
      cursor = data.page_token
    }
    this.members = members; this.notify('请选择你本人。所选身份只对这个应用有效。')
  }
  saveScope(input) {
    if (!this.config.bot) throw new Error('请先连接机器人。')
    if (!/^ou_[A-Za-z0-9]+$/.test(input.owner) || input.owner === this.config.bot.botId) throw new Error('请选择你本人，或填写本应用下你的飞书 Open ID。')
    if (typeof input.directMessages !== 'boolean' || !['observe', 'auto'].includes(input.mode) || !Array.isArray(input.chats) || input.chats.length > 3) throw new Error('消息范围无效。')
    const chats = input.chats.map(chat => {
      const listed = this.groups.find(item => item.chatId === chat.chatId)
      if (!listed || !['mentions', 'all'].includes(chat.listen)) throw new Error('请从当前群列表选择，并明确接收模式。')
      return { ...listed, listen: chat.listen }
    })
    if (new Set(chats.map(chat => chat.chatId)).size !== chats.length || !chats.length && !input.directMessages) throw new Error('请至少选择私聊或一个群，且群不能重复。')
    const ownerName = this.members.find(member => member.id === input.owner)?.name || '本人'
    this.config.scope = { owner: input.owner, ownerName, directMessages: input.directMessages, chats, mode: input.mode }
    this.persist(); this.notify('配置已备好。请核对授权范围，再决定启动。')
  }
  async findConflicts() {
    const candidates = []
    if (this.legacy) candidates.push(this.legacy)
    const folder = path.join(this.dataRoot, 'instances')
    if (fs.existsSync(folder)) for (const entry of fs.readdirSync(folder)) {
      if (entry === this.config.id || !/^[a-f0-9-]{36}$/.test(entry)) continue
      const connection = read(path.join(folder, entry, 'connection.json'))
      if (connection) candidates.push(connection)
    }
    const conflicts = []
    for (const candidate of candidates) {
      try {
        const base = policy.serviceURL(candidate.serviceURL)
        const snapshot = await this.request(base + '/orchestrator/api/loom', { headers: { 'x-orchestrator-request': '1' } })
        if (snapshot.connection?.appId !== this.config.bot.appId) continue
        conflicts.push({ ...candidate, serviceURL: base, name: String(snapshot.connection.name || '已有助手').slice(0, 100),
          active: snapshot.tasks.filter(task => !task.completed).length })
      } catch {
        const status = await this.runtimeFactory(candidate).probe()
        if (!['stopped', 'missing'].includes(status.phase)) throw new Error('已有助手的监听状态暂时无法核实。请先在原客户端检查并停止原监听，未启动新监听。')
      }
    }
    this.conflicts = conflicts.map(({ name, serviceURL, active }) => ({ name, serviceURL, active }))
    return conflicts
  }
  async start(input) {
    if (input.consent !== true || !this.config.prepared || !this.config.model || !this.config.bot || !this.config.scope) throw new Error('请完成并确认全部配置。')
    this.notify('正在重新核验凭证、群范围和已有机器人连接…')
    await this.testModel(this.config.model, read(path.join(this.root, 'dsh/.credentials.yaml'))?.refs?.LOOM_MODEL_API_KEY)
    await this.token()
    if (this.config.scope.chats.length) {
      await this.listGroups()
      if (this.config.scope.chats.some(chat => !this.groups.some(group => group.chatId === chat.chatId))) throw new Error('机器人已退出所选群，请重新配置范围。')
    }
    const conflicts = await this.findConflicts()
    if (conflicts.length) {
      throw new Error('这个机器人已被原助手监听。请使用不同机器人，或在原客户端明确停止助手后重试；本向导不会中断原任务。')
    }
    this.ensureRoot()
    const leaseDir = path.join(this.dataRoot, 'bot-leases'), lease = path.join(leaseDir, this.config.bot.appId + '.json')
    fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 })
    const previous = read(lease)
    if (previous && previous.id !== this.config.id) {
      if (!previous.createdAt || Date.now() - Date.parse(previous.createdAt) < 120000) throw new Error('另一个配置正在启动这个机器人，请稍后检查。')
      const check = this.runtimeFactory(previous.connection)
      const status = await check.probe()
      if (!['stopped', 'missing'].includes(status.phase)) throw new Error('另一个配置正在使用此机器人；连接状态未确认，未启动重复监听。')
      fs.unlinkSync(lease)
    }
    if (!previous || previous.id !== this.config.id) {
      try { fs.writeFileSync(lease, JSON.stringify({ id: this.config.id, createdAt: new Date().toISOString(), connection: this.connection() }), { mode: 0o600, flag: 'wx' }) }
      catch { throw new Error('这个机器人正在被另一配置占用，未启动重复监听。') }
    }
    this.notify('正在写入独立运行配置…')
    const profileDir = path.join(this.root, 'dsh/profiles', this.profile), model = this.config.model
    const patch = [{ id: 'webserver', config: { host: '127.0.0.1', port: Number(new URL(this.config.serviceURL).port) } },
      { id: 'dsh-superagent', config: { stateDir: path.join(this.root, 'state') } }, { id: 'dsh-superagent-feishu', disabled: false },
      { id: 'llm-pi-ai', config: { providers: { loom: { displayName: '我的模型', api: 'openai-completions', baseURL: model.baseURL, apiKeyEnv: 'LOOM_MODEL_API_KEY', models: [{ id: model.model, name: model.model }] } } } },
      { id: 'agent-default-model', config: { provider: 'loom', model: model.model } }]
    write(path.join(profileDir, 'cordis.patch.yml'), JSON.stringify(patch, null, 2))
    const botCli = path.join(this.root, 'lark-bot')
    write(botCli, '#!/bin/sh\nexport LARKSUITE_CLI_CONFIG_DIR=' + quote(path.join(this.root, 'lark')) + '\nexec ' + quote(this.find('lark-cli')) + ' "$@"\n')
    fs.chmodSync(botCli, 0o700)
    const settings = { stateDir: path.join(this.root, 'state'), botCli, ...this.config.scope, model: model.model }
    await this.run(this.find('node'), [path.join(this.projectRoot, 'scripts/initialize-desktop-assistant.cjs')], { cwd: this.root, env: this.env(), timeout: 15000 }, JSON.stringify(settings))
    this.config.frozen = true; this.persist()
    write(path.join(this.root, 'connection.json'), JSON.stringify(this.connection()))
    this.notify('正在启动本机助手并连接飞书…')
    if (read(lease)?.id !== this.config.id) throw new Error('机器人连接归属已变化，未启动监听。')
    const runtime = this.runtimeFactory(this.connection())
    let state = await runtime.action('start', true)
    if (!state.connected) throw new Error('独立执行环境尚未就绪。请检查连接和应用发布状态后重试；原任务库未改变。')
    const deadline = Date.now() + 20000
    while (state.components?.find(component => component.name === 'feishu')?.state !== 'ready') {
      if (state.components?.some(component => component.name === 'feishu' && component.state === 'error') || Date.now() >= deadline)
        throw new Error('本机引擎已运行，但飞书消息长连接尚未就绪。请核对事件订阅、权限和应用发布状态后重试；尚未标记配置完成。')
      await new Promise(resolve => setTimeout(resolve, 700))
      state = await runtime.probe()
      if (!state.connected) throw new Error('启动后的本机连接中断，请检查运行状态后重试。')
    }
    this.config.completed = true; this.active = false; this.persist(); this.notify('配置完成，你的个人助手已连接。')
    this.completed?.(this.connection())
  }
}
module.exports = { Onboarding, modelInput, responseJSON, write }
