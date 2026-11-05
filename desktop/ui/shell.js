'use strict'
const $ = id => document.getElementById(id)
const bridge = window.loomDesktop
let current, working = false, loaded = false
const componentNames = { runtime: '后台服务', models: '模型连接', feishu: '飞书消息', history: '消息恢复', evals: '需求评估', result: '产物投递' }
const statusNames = { ready: '正常', starting: '准备中', paused: '已暂停', error: '需检查', waiting: '等待' }
function fact(label, value) {
  const element = document.createElement('div'); element.className = 'fact'
  const name = document.createElement('small'); name.textContent = label
  const content = document.createElement('strong'); content.textContent = String(value)
  element.append(name, content); return element
}
function render(state) {
  current = state
  $('platform-label').textContent = state.platformLabel || '本机'
  if (state.platformLabel === 'Windows') $('setup-environment-help').textContent = 'Windows 原生版使用本机 Node.js、DeepSeek Harness、Git 和飞书 CLI。请先准备列表中缺少的依赖，并选择已构建的 Loom 办公引擎。助手使用 Windows 自己的数据目录与后台进程；安装包不包含账号或密钥。'
  window.loomOnboarding.render(state.onboarding)
  if (state.onboarding?.active) {
    document.title = 'Loom · 首次配置'
    $('connection-panel').hidden = true; $('workspace').hidden = true; $('status-button').hidden = true
    $('connection').querySelector('span').textContent = '首次配置 · 独立环境'; return
  }
  document.title = 'Loom · 陆兮个人助手'
  $('status-button').hidden = false
  $('version').textContent = state.desktopVersion
  $('connection').className = state.connected ? 'ready' : 'warn'
  $('connection').querySelector('span').textContent = state.message
  $('message').textContent = state.message
  $('headline').textContent = state.connected ? state.components?.some(part => part.state === 'error') ? '助手已连接，有状态需要检查。' : '你的助手，已在这台设备上就绪。' : state.phase === 'missing' ? '先连接你的本机助手。' : state.phase === 'stopped' ? '准备好时，再继续工作。' : '让工作，安静地向前。'
  $('card-title').textContent = state.connected ? '已连接 · 配置自动沿用' : '连接本机助手'
  $('steps').hidden = state.connected
  $('facts').hidden = !state.connected
  $('facts').replaceChildren()
  if (state.connected) {
    $('facts').append(fact('执行模型', state.model), fact('飞书机器人', state.botName), fact('任务', `${state.active} 项进行中 · ${state.attention} 项需处理`), fact('已保存产物', `${state.artifacts} 份`))
    const components = document.createElement('div'); components.className = 'components'
    for (const part of state.components || []) { const chip = document.createElement('span'); chip.className = 'component' + (part.state === 'error' ? ' warn' : ''); chip.textContent = `${componentNames[part.name] || part.name} · ${statusNames[part.state] || part.state}`; components.append(chip) }
    $('facts').append(components)
  }
  $('missing').hidden = !state.missing?.length
  $('missing').replaceChildren(...(state.missing || []).map(value => { const line = document.createElement('div'); line.textContent = value; return line }))
  $('notifications').checked = state.notifications
  $('open-button').hidden = !state.connected
  $('start-button').hidden = state.phase !== 'stopped'
  $('setup-button').hidden = state.phase !== 'setup'
  $('choose-button').disabled = state.connected || state.busy || working
  $('logs-button').disabled = !state.backendRoot
  for (const name of ['start-button', 'refresh-button', 'setup-button']) $(name).disabled = state.busy || working
  const workspace = $('workspace'), show = state.connected && !state.statusOpen
  // Keep the existing frame during temporary disconnects so unsaved edits survive.
  const retain = loaded && !state.statusOpen && !state.connected
  if (show) loaded = true
  workspace.hidden = !(show || retain)
  $('connection-panel').hidden = show || retain
  $('status-button').textContent = state.statusOpen && state.connected ? '返回工作空间' : '连接与运行状态'
}
async function action(value) {
  if (working) return; working = true; $('error').hidden = true
  if (current) render(current)
  try { render(await bridge.action(value)) }
  catch (error) { $('error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); $('error').hidden = false }
  finally { working = false; if (current) render(current) }
}
$('open-button').addEventListener('click', () => action('workspace'))
$('new-setup-button').addEventListener('click', () => action('new-setup'))
window.addEventListener('loom-onboarding-state', event => render(event.detail))
$('start-button').addEventListener('click', () => action('start'))
$('refresh-button').addEventListener('click', () => action('refresh'))
$('choose-button').addEventListener('click', () => action('choose'))
$('setup-button').addEventListener('click', () => action('setup'))
$('logs-button').addEventListener('click', () => action('logs'))
$('status-button').addEventListener('click', () => action(current?.statusOpen && current?.connected ? 'workspace' : 'status'))
$('notifications').addEventListener('change', async event => { try { render(await bridge.notifications(event.target.checked)) } catch { $('error').textContent = '提醒偏好未保存，请重试。'; $('error').hidden = false } })
bridge.onState(render)
bridge.state().then(render)
