'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows 原生自检须在 Windows 上运行。')
  const root = path.resolve(__dirname, '..'), packaged = process.argv[2]
  const executable = packaged ? path.resolve(packaged) : require('electron')
  const directory = path.resolve(process.argv[3] || path.join(root, '../.artifacts/windows-native'))
  fs.mkdirSync(directory, { recursive: true })
  const env = { ...process.env, LOOM_WINDOWS_SMOKE_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE; delete env.LOOM_WINDOWS_SMOKE_KEEP_OPEN
  const engine = process.argv[4]
  const child = spawn(executable, [...packaged ? [] : [root], '--setup-experience', ...engine ? ['--engine-root', path.resolve(engine)] : []], { env, cwd: root, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
  if (code !== 0) throw new Error('Windows 原生客户端自检失败。')
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'windows-launch.json'), 'utf8'))
  if (!report.nativeElectronLaunch || !report.firstRunVisible || !report.nativeProcess?.handle) throw new Error('Windows 原生窗口验证证据不完整。')
  process.stdout.write(JSON.stringify({ directory, ...report }, null, 2) + '\n')
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
