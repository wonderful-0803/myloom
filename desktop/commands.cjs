'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { commandEnvironment } = require('./platform.cjs')
const PACKAGES = { dsh: '@deepseek-ai/dsh', 'lark-cli': '@larksuite/cli' }
function packageEntry(root, name) {
  try {
    const directory = fs.realpathSync(path.join(root, PACKAGES[name]))
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name]
    if (pkg.name !== PACKAGES[name] || typeof bin !== 'string') return
    const file = fs.realpathSync(path.resolve(directory, bin))
    if (!file.startsWith(directory + path.sep) || !fs.statSync(file).isFile()) return
    return file
  } catch {}
}
function executable(name, environment = process.env, root = '') {
  const folders = (commandEnvironment(environment).PATH || '').split(path.delimiter).filter(Boolean)
  if (process.platform === 'win32') {
    if (PACKAGES[name]) {
      const modules = [root && path.join(root, '.artifacts/windows-tools/node_modules'), root && path.join(root, 'node_modules'),
        ...folders.flatMap(folder => [path.join(folder, 'node_modules'), path.resolve(folder, '..')])].filter(Boolean)
      for (const directory of modules) { const entry = packageEntry(directory, name); if (entry) return entry }
    }
    const names = name === 'python3' ? ['python3.exe', 'python.exe'] : [name + '.exe', name + '.com', name]
    for (const folder of folders) {
      if (/[\\/]Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(folder)) continue // Store aliases are not installed runtimes.
      for (const binary of names) {
        const file = path.join(folder, binary)
        try { if (fs.statSync(file).isFile()) return file } catch {}
      }
    }
    return
  }
  return folders.map(folder => path.join(folder, name)).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
  })
}
function commandSpec(program, args, root = '') {
  if (process.platform === 'win32' && /\.[cm]?js$/i.test(program)) {
    const node = executable('node', process.env, root)
    if (!node) throw new Error('请先安装 Windows 原生 Node.js 22.19 或更新版本。')
    return { program: node, args: [program, ...args] }
  }
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(program)) throw new Error('请使用 Windows 原生可执行文件或 Node.js CLI 入口。')
  return { program, args }
}
function run(program, args, options = {}, input) {
  return new Promise((resolve, reject) => {
    const spec = commandSpec(program, args, options.cwd)
    const child = execFile(spec.program, spec.args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, ...options },
      (error, stdout) => error ? reject(new Error('本机配置命令未完成，请检查 Windows 依赖和连接状态后重试。')) : resolve(stdout))
    child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}
module.exports = { executable, commandSpec, run }
