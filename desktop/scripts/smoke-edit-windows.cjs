'use strict'
const fs = require('node:fs'), path = require('node:path'), net = require('node:net')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
async function main() {
  if (process.platform !== 'win32') throw new Error('Requires native Windows')
  const root = path.resolve(__dirname, '../..'), executable = process.argv[2] ? path.resolve(process.argv[2]) : require('electron')
  const directory = path.join(root, '.artifacts', 'windows-edit-' + randomUUID()), preferences = path.join(directory, 'preferences')
  fs.mkdirSync(preferences, { recursive: true })
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  fs.writeFileSync(path.join(preferences, 'onboarding.json'), JSON.stringify({ version: 1, id: randomUUID(), prepared: true, frozen: true,
    projectRoot: root, serviceURL: 'http://127.0.0.1:' + port, model: { baseURL: 'https://models.example/v1', model: 'fixture-model' },
    bot: { appId: 'cli_fixture', name: 'Fixture bot', botId: 'ou_fixturebot' }, scope: { owner: 'ou_fixtureowner', ownerName: '本人', chats: [], directMessages: true, mode: 'observe' } }))
  const env = { ...process.env, LOOM_WINDOWS_SMOKE_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE
  const args = [...process.argv[2] ? [] : [path.join(root, 'desktop')], '--setup-experience', '--engine-root', root]
  const child = spawn(executable, args, { env, cwd: root, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) throw new Error('Back navigation smoke failed')
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'windows-edit.json'), 'utf8'))
  if (!report.backButtonWorks || !report.modelFieldsEditable || !report.editingPersisted) throw new Error('Back navigation evidence is incomplete')
  fs.copyFileSync(path.join(directory, 'windows-edit.json'), path.join(root, '.artifacts/windows-edit-acceptance.json'))
  process.stdout.write(JSON.stringify({ directory, ...report }, null, 2) + '\n')
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
