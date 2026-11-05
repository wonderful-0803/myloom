'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
async function editFlow({ window, onboarding, directory }) {
  assert.equal(onboarding.active, true); assert.equal(onboarding.config.frozen, true)
  const page = () => window.webContents.executeJavaScript(`Number(document.querySelector('.setup-page:not([hidden])').dataset.step)`)
  assert.equal(await page(), 4)
  const steps = [4]
  for (const expected of [3, 2, 1]) {
    await window.webContents.executeJavaScript(`(()=>{const b=document.querySelector('.setup-page:not([hidden]) .setup-back');if(!b||b.disabled)throw new Error('Back button is disabled');b.click();return true})()`)
    const deadline = Date.now() + 10000
    while (await page() !== expected) { if (Date.now() > deadline) throw new Error('Back navigation did not complete'); await new Promise(resolve => setTimeout(resolve, 100)) }
    steps.push(expected)
  }
  const fields = await window.webContents.executeJavaScript(`({base:document.getElementById('setup-base').readOnly,model:document.getElementById('setup-model').readOnly,key:document.getElementById('setup-key').disabled,provider:document.getElementById('setup-provider').disabled})`)
  assert.deepEqual(fields, { base: false, model: false, key: false, provider: false })
  assert.equal(onboarding.config.editing, true)
  const saved = JSON.parse(fs.readFileSync(path.join(onboarding.directory, 'onboarding.json'), 'utf8'))
  assert.equal(saved.editing, true); assert.equal(saved.id, onboarding.config.id)
  fs.writeFileSync(path.join(directory, 'windows-edit.json'), JSON.stringify({ nativeElectronLaunch: true, packaged: require('electron').app.isPackaged,
    steps, backButtonWorks: true, modelFieldsEditable: true, editingPersisted: true, sameInstance: true, fixtureConfiguration: true, businessTaskStarted: false }, null, 2))
  process.stdout.write('Loom Windows failed-startup back navigation passed.\n')
}
async function run({ app, window, workspace, tray, onboarding, runtime, show, directory, keepOpen, quit }) {
  const watchdog = setTimeout(() => app.exit(1), 45000)
  try {
    if (onboarding.config.frozen) {
      await editFlow({ window, onboarding, directory })
      clearTimeout(watchdog); quit(); return
    }
    assert.equal(process.platform, 'win32'); assert.equal(onboarding.active, true); assert.equal(onboarding.config.prepared, false)
    fs.mkdirSync(directory, { recursive: true })
    const values = await window.webContents.executeJavaScript(`({visible:!document.getElementById('onboarding-panel').hidden,
      fields:['setup-key','setup-app-secret','setup-owner'].map(id=>document.getElementById(id).value),
      picker:!!document.getElementById('setup-choose-engine'),require:typeof require,process:typeof process,
      checks:[...document.querySelectorAll('#setup-environment > *')].map(e=>e.textContent)})`)
    assert.equal(values.visible, true); assert.ok(values.fields.every(value => value === '')); assert.equal(values.picker, true)
    assert.equal(values.require, 'undefined'); assert.equal(values.process, 'undefined')
    assert.ok(['', 'about:blank'].includes(workspace.webContents.getURL()))
    const security = workspace.webContents.getLastWebPreferences()
    assert.equal(security.sandbox, true); assert.equal(security.contextIsolation, true); assert.equal(security.nodeIntegration, false)
    assert.ok(!security.preload); assert.equal(window.isVisible(), true)
    assert.ok(window.getNativeWindowHandle().some(byte => byte !== 0))
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const nativeProcess = await new Promise((resolve, reject) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $loomWindowProcess = Get-Process -Id ${process.pid}; [pscustomobject]@{id=$loomWindowProcess.Id;handle=$loomWindowProcess.MainWindowHandle.ToInt64();title=$loomWindowProcess.MainWindowTitle} | ConvertTo-Json -Compress`],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))))
    assert.equal(nativeProcess.id, process.pid); assert.ok(nativeProcess.handle > 0); assert.match(nativeProcess.title, /Loom/)
    // A HWND can exist before Chromium has submitted its first capturable frame.
    let screenshot, captureError
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250))
      try { screenshot = await window.capturePage(); if (!screenshot.isEmpty()) break } catch (error) { captureError = error }
    }
    assert.ok(screenshot && !screenshot.isEmpty(), captureError?.message || 'Window frame is unavailable')
    fs.writeFileSync(path.join(directory, 'windows-first-run.png'), screenshot.toPNG())
    assert.ok(tray && !tray.isDestroyed())
    await new Promise(resolve => { window.once('hide', resolve); window.close() })
    assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false)
    tray.emit('click'); assert.equal(window.isVisible(), true)
    fs.writeFileSync(path.join(directory, 'windows-launch.json'), JSON.stringify({ nativeElectronLaunch: true, platform: process.platform,
      arch: process.arch, version: app.getVersion(), packaged: app.isPackaged, firstRunVisible: true, nativeProcess,
      closeToTrayAndRestore: true, initialSecretsEmpty: true, isolatedWorkspace: true, nativeWindowsRuntime: true,
      environment: onboarding.view().environment, businessTaskStarted: false, modelCalled: false, botListenerStarted: false,
      fullHarnessIntegrationTested: false, executable: process.execPath }, null, 2))
    process.stdout.write('Loom Windows native first-run launch passed.\n')
    clearTimeout(watchdog)
    if (!keepOpen) quit()
  } catch (error) { clearTimeout(watchdog); process.stderr.write(error.stack + '\n'); app.exit(1) }
}
module.exports = { run }
