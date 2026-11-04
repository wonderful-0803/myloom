'use strict'
// CI-only native launch of this client's empty first-run screen, never a business task or model request.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
async function run({ app, window, workspace, onboarding, directory, quit }) {
  const watchdog = setTimeout(() => app.exit(1), 30000)
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assert.equal(process.platform, 'darwin'); assert.equal(onboarding.active, true); assert.equal(onboarding.config.prepared, false)
    const values = await window.webContents.executeJavaScript(`({visible:!document.getElementById('onboarding-panel').hidden,
      fields:['setup-key','setup-app-secret','setup-owner'].map(id=>document.getElementById(id).value),
      picker:!!document.getElementById('setup-choose-engine'),require:typeof require,process:typeof process})`)
    assert.equal(values.visible, true); assert.ok(values.fields.every(value => value === '')); assert.equal(values.picker, true)
    assert.equal(values.require, 'undefined'); assert.equal(values.process, 'undefined')
    assert.ok(['', 'about:blank'].includes(workspace.webContents.getURL()))
    const security = workspace.webContents.getLastWebPreferences()
    assert.equal(security.sandbox, true); assert.equal(security.contextIsolation, true); assert.equal(security.nodeIntegration, false)
    assert.ok(!security.preload); assert.equal(window.isVisible(), true)
    const nativeHandlePresent = window.getNativeWindowHandle().some(byte => byte !== 0)
    assert.equal(nativeHandlePresent, true)
    fs.writeFileSync(path.join(directory, 'macos-first-run.png'), (await window.capturePage()).toPNG())
    fs.writeFileSync(path.join(directory, 'macos-launch.json'), JSON.stringify({ nativeElectronLaunch: true, platform: process.platform,
      arch: process.arch, version: app.getVersion(), firstRunVisible: true, nativeHandlePresent, initialSecretsEmpty: true,
      isolatedWorkspace: true, businessTaskStarted: false, modelCalled: false, botListenerStarted: false,
      fullHarnessIntegrationTested: false, developerIdSigned: false, notarized: false }, null, 2))
    process.stdout.write('Loom macOS native first-run launch passed.\n')
    clearTimeout(watchdog); quit()
  } catch (error) { clearTimeout(watchdog); process.stderr.write(error.stack + '\n'); app.exit(1) }
}
module.exports = { run }
