'use strict'
// Opt-in integration acceptance for this application only. It does not change assistant configuration or send messages.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
async function until(check, timeout = 20_000) {
  const deadline = Date.now() + timeout
  for (;;) { const result = await check(); if (result) return result; if (Date.now() > deadline) throw new Error('Desktop acceptance timed out'); await new Promise(resolve => setTimeout(resolve, 120)) }
}
// Renderer screenshots and isVisible() alone can pass with a broken native surface.
// Inspect only this application's own X window; these tools are acceptance dependencies.
async function mapped(window) {
  const handle = window.getNativeWindowHandle()
  const id = '0x' + handle.readUInt32LE(0).toString(16)
  try {
    const { stdout } = await execute('xwininfo', ['-id', id], { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })
    const { stdout: owner } = await execute('xprop', ['-id', id, '_NET_WM_PID'], { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })
    assert.match(owner, new RegExp('= ' + process.pid + '\\s*$'))
    return /Map State: IsViewable/.test(stdout) ? id : false
  } catch { return false }
}
async function run({ app, window, workspace, runtime, showStatus, show, state, openFromTray, directory, quit }) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assert.equal(runtime.state.connected, true)
    const nativeWindow = await until(() => mapped(window), 5000)
    const frame = await until(async () => {
      const value = workspace.webContents.mainFrame
      if (!value) return
      try { return await value.executeJavaScript('document.querySelector(".live-workspace") && document.querySelector("h1")?.textContent') ? value : undefined } catch {}
    })
    const security = await frame.executeJavaScript('({node:typeof process,require:typeof require,bridge:typeof window.loomDesktop})')
    assert.deepEqual(security, { node: 'undefined', require: 'undefined', bridge: 'undefined' })
    await workspace.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(directory, 'loom-desktop-workspace.png'), (await workspace.webContents.capturePage()).toPNG(), { mode: 0o600 })
    showStatus()
    await until(() => window.webContents.executeJavaScript('!document.getElementById("connection-panel").hidden && document.getElementById("workspace").hidden'))
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise(resolve => setTimeout(resolve, 250)) // Let the native view removal reach the software compositor.
    fs.writeFileSync(path.join(directory, 'loom-desktop-connection.png'), (await window.capturePage()).toPNG(), { mode: 0o600 })
    const connection = await window.webContents.executeJavaScript('({model:document.getElementById("facts").textContent,checked:document.getElementById("notifications").checked})')
    assert.ok(connection.model.includes(runtime.state.model))
    show('tasks')
    await until(async () => {
      return workspace.webContents.getURL().endsWith('#tasks') && await workspace.webContents.executeJavaScript('document.querySelector("h1")?.textContent === "任务"')
    })
    await execute(process.execPath, [app.getAppPath(), '--ozone-platform=x11'], { env: { ...process.env }, timeout: 10_000 })
    await until(() => mapped(window), 5000)
    assert.equal(window.isVisible(), true)
    assert.ok(workspace.webContents.getURL().endsWith('#tasks'))
    const previousURL = workspace.webContents.getURL()
    window.close()
    assert.equal(window.isDestroyed(), false)
    assert.equal(window.isVisible(), false)
    await until(async () => !await mapped(window), 5000)
    await runtime.probe()
    assert.equal(runtime.state.connected, true)
    // Exercise the callback attached to the actual tray MenuItem, then reopen a
    // hidden and a minimized window by launching the app a second time.
    openFromTray()
    await until(() => mapped(window), 5000)
    assert.equal(window.isVisible(), true)
    assert.equal(workspace.webContents.getURL(), previousURL)
    window.hide()
    await until(async () => !await mapped(window), 5000)
    await execute(process.execPath, [app.getAppPath(), '--ozone-platform=x11'], { env: { ...process.env }, timeout: 10_000 })
    await until(() => mapped(window), 5000)
    assert.equal(workspace.webContents.getURL(), previousURL)
    window.minimize()
    await until(() => window.isMinimized(), 5000)
    await execute(process.execPath, [app.getAppPath(), '--ozone-platform=x11'], { env: { ...process.env }, timeout: 10_000 })
    await until(async () => !window.isMinimized() && await mapped(window), 5000)
    show('overview')
    await until(async () => await workspace.webContents.executeJavaScript('document.querySelector("h1")?.textContent === "工作概览"'), 5000)
    const report = { electron: process.versions.electron, chromium: process.versions.chrome, sandbox: window.webContents.getLastWebPreferences().sandbox,
      contextIsolation: window.webContents.getLastWebPreferences().contextIsolation, nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
      unprivilegedWorkspace: security, actualWorkspaceLoaded: true, nativeConnectionScreenVerified: true, nativeTaskNavigationVerified: true,
      singleInstanceVerified: true, closeHidesWindow: true, backgroundStillConnected: runtime.state.connected, reopenPreservesRuntime: true,
      actualNativeWindowMapped: nativeWindow, trayReopensNativeWindow: true, hiddenWindowSecondLaunchVerified: true, minimizedWindowSecondLaunchVerified: true,
      model: state().model, tasks: state().tasks, artifacts: state().artifacts, notifications: state().notifications }
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    process.stdout.write('Loom desktop acceptance passed.\n')
  } catch (error) {
    process.stderr.write('Loom desktop acceptance failed: ' + error.message + '\n')
    app.exit(1)
  } finally { if (!process.env.LOOM_DESKTOP_SMOKE_KEEP_OPEN) quit() }
}
module.exports = { run }
