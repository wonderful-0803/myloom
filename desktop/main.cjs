'use strict'
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, Notification, dialog, shell, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const { RuntimeLink } = require('./runtime.cjs')
const { Onboarding } = require('./onboarding.cjs')
const policy = require('./policy.cjs')

app.setName('luxi-loom')
const setupExperience = process.argv.includes('--setup-experience')
const setupSmoke = process.env.LOOM_DESKTOP_SETUP_SMOKE_DIR
if (setupExperience) app.setPath('userData', setupSmoke ? path.join(path.resolve(setupSmoke), 'preferences') : path.join(app.getPath('appData'), 'luxi-loom-first-run'))
// Ozone can initialize before main.cjs. Appending this switch here is too late on
// Wayland hosts: Electron may report a visible window without a mapped X window.
// The launcher supplies it at process startup; direct binary launches relaunch once.
if (process.platform === 'linux' && process.env.DISPLAY && app.commandLine.getSwitchValue('ozone-platform') !== 'x11') {
  const args = process.argv.slice(1).filter((value, index, all) => value !== '--ozone-platform'
    && !value.startsWith('--ozone-platform=') && all[index - 1] !== '--ozone-platform')
  app.relaunch({ args: [...args, '--ozone-platform=x11'] }); app.exit(0); return
}
app.enableSandbox()
// Office UI does not need GPU acceleration; software rendering avoids Linux driver incompatibilities without disabling the sandbox.
app.disableHardwareAcceleration()
if (process.platform !== 'linux') { app.whenReady().then(() => { dialog.showErrorBox('Loom', '此版本仅支持 Linux。本机执行端尚未完成其他系统的适配。'); app.quit() }); return }
if (!app.requestSingleInstanceLock()) { app.quit(); return }

let window, workspace, tray, trayMenu, trayState, runtime, onboarding, projectRootHint, quitting = false, timer, previous, statusOpen = false, refreshing = false, selectedPage = 'overview', requestedWorkspace = '', workspaceLoaded = false
let preferences = { backendRoot: '', serviceURL: 'http://127.0.0.1:3082', notifications: false }
const shellFile = path.join(__dirname, 'ui', 'index.html')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const icon = path.join(__dirname, 'assets', 'icon.png')
const smokeDirectory = process.env.LOOM_DESKTOP_SMOKE_DIR
function link() { const value = new RuntimeLink(preferences); value.changed = publish; return value }
function openSetup() {
  const env = { ...process.env }
  for (const name of ['LOOM_DESKTOP_SMOKE_DIR', 'LOOM_DESKTOP_SMOKE_KEEP_OPEN', 'LOOM_DESKTOP_SETUP_SMOKE_DIR', 'ELECTRON_RUN_AS_NODE']) delete env[name]
  const child = spawn(process.execPath, [...app.isPackaged ? [] : [app.getAppPath()], '--ozone-platform=x11', '--class=loom-setup', '--setup-experience'], { env, detached: true, stdio: 'ignore' })
  child.unref()
}
function savePreferences() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 })
  const temp = settingsFile() + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(preferences, null, 2), { mode: 0o600, flag: 'wx' })
  fs.renameSync(temp, settingsFile())
}
function initialPreferences() {
  let saved = {}, defaults = {}
  try { defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime-defaults.json'), 'utf8')) } catch {}
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch {}
  const candidate = { ...defaults, ...saved }
  projectRootHint = typeof defaults.backendRoot === 'string' ? defaults.backendRoot : path.resolve(__dirname, '..')
  preferences.backendRoot = typeof candidate.backendRoot === 'string' ? candidate.backendRoot : path.resolve(__dirname, '..')
  if (setupExperience && !saved.backendRoot) preferences.backendRoot = ''
  if (saved.runtimeHome && saved.profile) { preferences.runtimeHome = saved.runtimeHome; preferences.profile = saved.profile }
  try { preferences.serviceURL = policy.serviceURL(candidate.serviceURL) } catch {}
  preferences.notifications = saved.notifications === true
}
function state() {
  return { ...runtime.state, workspaceURL: policy.workspaceURL(runtime.base, selectedPage), statusOpen,
    notifications: preferences.notifications, desktopVersion: app.getVersion(), busy: runtime.busy, onboarding: onboarding?.view() }
}
function publish() {
  if (!window || window.isDestroyed()) return
  window.webContents.send('loom-desktop:changed', state())
  syncWorkspace()
  if (tray) {
    tray.setToolTip(`Loom · ${runtime.state.message}`)
    const signature = JSON.stringify([runtime.state.message, runtime.state.connected, runtime.busy])
    if (signature !== trayState) {
      trayState = signature
      trayMenu = Menu.buildFromTemplate([
        { id: 'open-loom', label: '打开 Loom', click: () => show() },
        { label: runtime.state.message, enabled: false },
        { type: 'separator' },
        { label: '任务', click: () => show('tasks') }, { label: '交付物', click: () => show('deliverables') },
        { label: '连接与运行状态', click: showStatus },
        { type: 'separator' },
        { label: '停止助手并退出…', enabled: runtime.state.connected && !runtime.busy, click: () => void stopAndQuit() },
        { label: '退出 Loom（助手继续运行）', click: () => { quitting = true; app.quit() } },
      ])
      tray.setContextMenu(trayMenu)
    }
  }
}
function syncWorkspace() {
  if (!workspace || workspace.webContents.isDestroyed()) return
  const visible = !onboarding?.active && !statusOpen && (runtime.state.connected || workspaceLoaded)
  workspace.setVisible(visible)
  const [width, height] = window.getContentSize()
  workspace.setBounds({ x: 0, y: 54, width, height: Math.max(0, height - 54) })
  const target = policy.workspaceURL(runtime.base, selectedPage)
  if (runtime.state.connected && visible && requestedWorkspace !== target) {
    requestedWorkspace = target
    workspace.webContents.loadURL(target).then(() => { workspaceLoaded = true }).catch(() => {
      requestedWorkspace = ''; statusOpen = true; publish()
    })
  }
}
function show(page) {
  if (!window || window.isDestroyed()) return
  statusOpen = false
  if (page) selectedPage = page
  if (window.isMinimized()) window.restore()
  window.show(); window.moveTop(); window.focus(); publish()
}
function showStatus() { statusOpen = true; if (window.isMinimized()) window.restore(); window.show(); window.moveTop(); window.focus(); publish() }
async function refresh(autoStart = false) {
  if (onboarding?.active) { publish(); return }
  if (refreshing || runtime.busy) return
  refreshing = true
  try {
    await runtime.probe(); publish()
    if (autoStart && runtime.state.phase === 'stopped' && !runtime.state.intentionallyStopped) {
      const action = runtime.action('start'); publish(); await action; publish()
    }
    if (runtime.state.connected && runtime.snapshot) {
      if (preferences.notifications && Notification.isSupported()) for (const change of policy.notificationChanges(previous, runtime.snapshot)) {
        const notification = new Notification({ title: change.title, body: change.body, icon, silent: true })
        notification.on('click', () => show(change.page)); notification.show()
      }
      previous = runtime.snapshot
    }
  } finally { refreshing = false; publish() }
}
async function stopAndQuit() {
  const answer = await dialog.showMessageBox(window, { type: 'question', title: '停止个人助手', message: '停止后台助手并退出 Loom？',
    detail: '正在进行的任务将中断，后续飞书消息暂不处理。任务和已有产物保留；下次需明确启动助手。', buttons: ['取消', '停止助手并退出'], defaultId: 0, cancelId: 0, noLink: true })
  if (answer.response !== 1) return
  await runtime.action('stop', true); publish()
  if (runtime.state.phase === 'stopped') { quitting = true; app.quit() }
  else await dialog.showMessageBox(window, { type: 'warning', message: '尚未确认后台已停止', detail: '客户端保持打开，请检查实际状态；没有强制结束进程。', buttons: ['查看状态'] })
}
function trusted(event) {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !policy.localShell(event.senderFrame.url, shellFile))
    throw new Error('此操作仅限本机桌面界面。')
}
function installIPC() {
  ipcMain.handle('loom-desktop:onboarding', async (event, action, input) => {
    trusted(event)
    if (!onboarding || typeof action !== 'string' || JSON.stringify(input || {}).length > 32768) throw new Error('无效的首次配置操作。')
    await onboarding.action(action, input)
    if (!onboarding.active) await refresh()
    return state()
  })
  ipcMain.handle('loom-desktop:state', event => { trusted(event); return state() })
  ipcMain.handle('loom-desktop:notifications', (event, enabled) => {
    trusted(event); if (typeof enabled !== 'boolean') throw new Error('无效设置。')
    preferences.notifications = enabled; savePreferences(); publish(); return state()
  })
  ipcMain.handle('loom-desktop:action', async (event, action) => {
    trusted(event)
    if (action === 'new-setup') { openSetup(); return state() }
    if (action === 'feishu-console') { await shell.openExternal('https://open.feishu.cn/app'); return state() }
    if (onboarding?.active) throw new Error('请先完成首次配置，或退出此独立配置窗口。')
    if (action === 'refresh') await refresh()
    else if (action === 'workspace') { statusOpen = false; publish() }
    else if (action === 'status') { statusOpen = true; publish() }
    else if (action === 'start') { const pending = runtime.action('start', true); publish(); await pending; publish() }
    else if (action === 'choose') {
      const answer = await dialog.showOpenDialog(window, { title: '选择已配置的 Superagent 项目目录', properties: ['openDirectory'] })
      if (!answer.canceled && answer.filePaths[0]) {
        const { installation } = require('./runtime.cjs'), found = installation(answer.filePaths[0])
        if (!found.valid) throw new Error(found.missing[0])
        preferences.backendRoot = found.root; savePreferences()
        runtime = link(); previous = undefined; await refresh(true)
      }
    } else if (action === 'logs') { const folder = path.join(runtime.root, '.artifacts'); if (fs.existsSync(folder)) await shell.openPath(folder) }
    else if (action === 'setup') { if (runtime.state.phase === 'setup') await shell.openExternal(runtime.base + '/') }
    else throw new Error('不支持此操作。')
    return state()
  })
}
function harden(contents, isWorkspace = false) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.on('will-navigate', (event, url) => { if (!(isWorkspace ? policy.workspaceNavigation(url, runtime.base) : policy.localShell(url, shellFile))) event.preventDefault() })
  contents.on('will-frame-navigate', event => {
    const allowed = event.isMainFrame && (isWorkspace ? policy.workspaceNavigation(event.url, runtime.base) : policy.localShell(event.url, shellFile))
    if (!allowed) event.preventDefault()
  })
}
app.on('second-instance', () => show())
app.on('before-quit', () => { quitting = true; if (timer) clearInterval(timer) })
app.on('window-all-closed', () => { if (quitting) app.quit() })
app.on('activate', () => show())
app.whenReady().then(async () => {
  initialPreferences()
  const existingHome = process.env.DSH_PERSONAL_HOME || path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local/share'), 'superagent/dsh')
  if (setupExperience || !preferences.runtimeHome && !fs.existsSync(path.join(existingHome, 'profiles/superagent/package.json'))) {
    onboarding = new Onboarding({ directory: app.getPath('userData'), projectRoot: projectRootHint,
      dataRoot: setupSmoke ? path.join(path.resolve(setupSmoke), 'data') : undefined,
      legacy: { backendRoot: projectRootHint, serviceURL: 'http://127.0.0.1:3082' } })
    onboarding.changed = publish
    onboarding.completed = connection => { Object.assign(preferences, connection); savePreferences(); runtime = link() }
    if (!onboarding.active) { Object.assign(preferences, onboarding.connection()); savePreferences() }
  }
  runtime = link()
  const desktopSession = session.fromPartition('loom-desktop') // Ephemeral cookies/cache; no copied browser credentials.
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  desktopSession.setPermissionCheckHandler(() => false)
  const shellAssets = ['ui/index.html', 'ui/shell.css', 'ui/shell.js', 'ui/onboarding.js', 'ui/onboarding.css', 'assets/icon.png'].map(file => pathToFileURL(path.join(__dirname, file)).href)
  desktopSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !shellAssets.includes(details.url)
    && !policy.workspaceRequest(details.url, runtime.base) }))
  desktopSession.on('will-download', (event, item) => {
    const filename = policy.downloadName(item.getFilename())
    if (!policy.workspaceRequest(item.getURL(), runtime.base) || !/\.(txt|md)$/i.test(filename)) { event.preventDefault(); return }
    item.setSaveDialogOptions({ title: '保存 Loom 报告', defaultPath: path.join(app.getPath('downloads'), filename), buttonLabel: '保存报告' })
  })
  window = new BrowserWindow({ title: setupExperience ? 'Loom · 首次配置' : 'Loom · 陆兮个人助手', width: 1280, height: 860, minWidth: 900, minHeight: 640,
    show: false, backgroundColor: '#fafaf7', icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, devTools: !app.isPackaged && !!smokeDirectory, session: desktopSession } })
  workspace = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, devTools: false, session: desktopSession } })
  window.contentView.addChildView(workspace); workspace.setVisible(false); harden(workspace.webContents, true)
  window.on('resize', syncWorkspace)
  window.on('closed', () => { if (!workspace.webContents.isDestroyed()) workspace.webContents.close() })
  harden(window.webContents); installIPC()
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide() } else if (!quitting) { quitting = true; app.quit() } })
  workspace.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (!isMainFrame) { statusOpen = true; publish() }
  })
  try { tray = new Tray(icon); tray.on('click', () => show('overview')) } catch { tray = undefined }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Loom', submenu: [{ label: '工作空间', click: () => show() }, { label: '连接与运行状态', click: showStatus },
      { label: '从零配置独立助手', click: openSetup },
      { type: 'separator' }, { label: '退出 Loom（助手继续运行）', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit() } }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]))
  await window.loadFile(shellFile)
  // The first-run screen has no workspace load to trigger another paint. Show the
  // already-loaded local shell explicitly rather than waiting on compositor timing.
  window.show()
  await refresh(true)
  timer = setInterval(() => void refresh().catch(() => {}), 4000)
  publish()
  if (setupSmoke && onboarding?.active) require('./setup-smoke.cjs').run({ app, window, workspace, onboarding, directory: setupSmoke, quit: () => { quitting = true; app.quit() } })
  if (smokeDirectory) require('./smoke.cjs').run({ app, window, workspace, runtime, showStatus, show, publish, state,
    openFromTray: () => trayMenu.getMenuItemById('open-loom').click(), directory: smokeDirectory, quit: () => { quitting = true; app.quit() } })
}).catch(() => { dialog.showErrorBox('Loom 启动失败', '桌面端暂时无法启动，请检查本机运行环境。后台助手与已有任务保持原状。'); app.quit() })
