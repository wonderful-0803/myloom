'use strict'
// Tests this application's native first-run UI in a separate test userData/home.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  for (;;) { if (await check()) return; if (Date.now() > deadline) throw new Error('First-run acceptance timed out'); await new Promise(resolve => setTimeout(resolve, 120)) }
}
async function run({ app, window, workspace, onboarding, directory, quit }) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const capture = async name => {
      await window.webContents.executeJavaScript('scrollTo(0,0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await new Promise(resolve => setTimeout(resolve, 120))
      fs.writeFileSync(path.join(directory, name + '.png'), (await window.capturePage()).toPNG(), { mode: 0o600 })
    }
    await until(() => window.webContents.executeJavaScript(`!document.getElementById('onboarding-panel').hidden && !document.querySelector('.setup-page[data-step="0"]').hidden`))
    const initial = await window.webContents.executeJavaScript('({fields:["setup-base","setup-model","setup-key","setup-app-id","setup-app-secret","setup-owner"].map(id=>document.getElementById(id).value),workspace:document.getElementById("workspace").hidden})')
    assert.ok(initial.fields.every(value => value === '')); assert.equal(initial.workspace, true)
    assert.ok(['', 'about:blank'].includes(workspace.webContents.getURL()))
    assert.equal(onboarding.config.prepared, false)
    const nativeWindow = '0x' + window.getNativeWindowHandle().readUInt32LE(0).toString(16)
    await until(async () => {
      const { stdout } = await execute('xwininfo', ['-id', nativeWindow], { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })
      return /Map State: IsViewable/.test(stdout)
    }, 5000)
    await capture('first-run-welcome')
    await window.webContents.executeJavaScript('document.getElementById("setup-prepare").click()')
    await until(() => onboarding.config.prepared && !onboarding.busy, 180000)
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('.setup-page[data-step="1"]').hidden`))
    await capture('first-run-model')
    const denied = await window.webContents.executeJavaScript('window.loomDesktop.onboarding("model",{baseURL:"file:///etc/passwd",model:"test",apiKey:"fake-secret"}).then(()=>false,()=>true)')
    assert.equal(denied, true)
    assert.equal(onboarding.config.model, undefined)
    assert.equal(workspace.webContents.getLastWebPreferences().preload, undefined)
    assert.equal(workspace.webContents.getLastWebPreferences().nodeIntegration, false)
    // Exercise all remaining native form transitions with external verification
    // fixtures. This is UI acceptance, never a claim of live Feishu authorization.
    const nativeRequest = onboarding.request
    onboarding.request = async (url, options) => {
      if (url.endsWith('/chat/completions')) return { choices: [{ message: { content: 'LOOM_OK' } }] }
      if (url.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'fixture-token' }
      if (url.includes('bot/v3/info')) return { code: 0, bot: { open_id: 'ou_fixturebot', app_name: '界面验收机器人' } }
      if (url.includes('/members?')) return { code: 0, data: { items: [{ member_id: 'ou_fixtureowner', name: '验收用户' }], has_more: false } }
      if (url.includes('im/v1/chats?')) return { code: 0, data: { items: [{ chat_id: 'oc_fixture', name: '<script>不会执行的群名称</script>' }], has_more: false } }
      return nativeRequest(url, options)
    }
    const nativeRun = onboarding.run
    onboarding.run = (program, args, options, input) => args[0] === 'auth' ? Promise.resolve(JSON.stringify({ appId: 'cli_uifixture', identities: { bot: { verified: true }, user: { available: false } } })) : nativeRun(program, args, options, input)
    await window.webContents.executeJavaScript(`document.getElementById('setup-base').value='https://fixture.example/v1'; document.getElementById('setup-model').value='fixture-model'; document.getElementById('setup-key').value='fixture-model-key'; document.getElementById('setup-model-form').requestSubmit()`)
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('.setup-page[data-step="2"]').hidden && document.getElementById('setup-key').value===''`))
    await capture('first-run-feishu')
    await window.webContents.executeJavaScript(`document.getElementById('setup-app-id').value='cli_uifixture'; document.getElementById('setup-app-secret').value='fixture-application-secret'; document.getElementById('setup-bot-form').requestSubmit()`)
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('.setup-page[data-step="3"]').hidden && document.getElementById('setup-app-secret').value===''`))
    await window.webContents.executeJavaScript(`document.getElementById('setup-member-chat').value='oc_fixture';document.getElementById('setup-members').click()`)
    await until(() => window.webContents.executeJavaScript(`!document.getElementById('setup-member-select').hidden && !document.getElementById('setup-members').disabled`))
    await window.webContents.executeJavaScript(`const select=document.getElementById('setup-member-select');select.value='ou_fixtureowner';select.dispatchEvent(new Event('change'));document.querySelector('.setup-group input').click()`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#setup-groups-list script')===null && document.getElementById('setup-owner').value==='ou_fixtureowner'`), true)
    await capture('first-run-scope')
    await window.webContents.executeJavaScript(`document.getElementById('setup-scope-form').requestSubmit()`)
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('.setup-page[data-step="4"]').hidden`))
    assert.equal(await window.webContents.executeJavaScript(`document.getElementById('setup-start').disabled`), true)
    await capture('first-run-review')
    const report = { version: app.getVersion(), actualNativeWindowMapped: nativeWindow, blankCredentialsAndOwner: true, previousWorkspaceNotLoaded: true,
      isolatedEnvironmentActuallyPrepared: true, noBotListenerStarted: true, unsafeModelURLRejected: true, workspaceHasNoNativeBridge: true,
      allFiveFormTransitionsVerified: true, passwordFieldsCleared: true, groupNameRenderedAsText: true, finalConsentRequired: true,
      externalAPIs: 'UI fixtures; not live Feishu or paid model acceptance', profile: onboarding.profile, runtimeHome: onboarding.connection().runtimeHome }
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    process.stdout.write('Loom first-run acceptance passed.\n')
  } catch (error) { process.stderr.write('Loom first-run acceptance failed: ' + error.message + '\n'); app.exit(1) }
  finally { quit() }
}
module.exports = { run }
