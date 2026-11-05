'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { stageApp } = require('./package-files.cjs')
const { buildWindowsIcon } = require('./icon.cjs')

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上构建并验证 Windows 客户端。')
  const root = path.resolve(__dirname, '..'), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-windows-package-'))
  try {
    const input = path.join(temporary, 'input'), pkg = stageApp(input, root)
    buildWindowsIcon(path.join(input, 'assets'))
    fs.copyFileSync(path.join(root, '../LICENSE'), path.join(input, 'LICENSE'))
    const electronVersion = require('../package.json').devDependencies.electron
    if (require('electron/package.json').version !== electronVersion) throw new Error('已安装的 Electron 与固定构建版本不一致。')
    const { packager } = await import('@electron/packager')
    const [target] = await packager({ dir: input, name: 'Loom', platform: 'win32', arch: 'x64',
      electronVersion, download: { checksums: require('electron/checksums.json') },
      out: path.join(root, 'dist', 'windows-' + pkg.version), overwrite: true, prune: false, asar: false,
      icon: path.join(input, 'assets/icon.ico'), appCopyright: 'Loom contributors; upstream DeepSeek Harness Team. MIT.',
      win32metadata: { CompanyName: 'Loom contributors', FileDescription: 'Loom personal assistant', ProductName: 'Loom' } })
    if (!target) throw new Error('Windows 应用目录未生成。')
    const executable = path.join(target, 'Loom.exe'), binary = fs.readFileSync(executable)
    const pe = binary.readUInt32LE(60)
    if (binary.subarray(0, 2).toString() !== 'MZ' || binary.subarray(pe, pe + 4).toString('hex') !== '50450000' || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Windows 可执行文件架构不匹配。')
    fs.writeFileSync(path.join(target, '使用说明.txt'), `Loom ${pkg.version} Windows x64 本机版\r\n\r\n` +
      '解压整个目录，双击 Loom.exe。不要仅移动 exe；resources、locales 和 DLL 必须保持在一起。\r\n' +
      '这是 Windows 原生 Electron 客户端，助手使用 Windows 本机进程运行。\r\n' +
      '请先准备 Windows 原生 Node.js 22.19+（22 LTS）或 24+、DeepSeek Harness、Git、飞书 CLI 和已构建的 Loom 办公引擎，再在向导中选择引擎目录。\r\n' +
      '账户、凭据和任务库保存在当前 Windows 用户的本机私有目录；凭据目录使用当前用户 ACL。\r\n' +
      '这个压缩包不包含任何人的账户、模型、任务库或完整引擎依赖。\r\n' +
      '准备环境不启动机器人；完成模型、飞书和本人消息范围配置并明确确认后才启动。\r\n' +
      '关闭窗口可从托盘重新打开；退出客户端不停止后台助手，停止助手须在菜单明确确认。\r\n' +
      '本包未使用发布者代码签名；不应关闭系统安全保护。\r\n\r\n源码及说明：https://github.com/wonderful-0803/myloom/blob/main/docs/DESKTOP.md\r\n')
    fs.copyFileSync(path.join(root, '../LICENSE'), path.join(target, 'LICENSE'))
    const archive = path.join(root, 'dist', `Loom-${pkg.version}-windows-x64.zip`)
    execFileSync('tar.exe', ['-a', '-c', '-f', archive, '-C', path.dirname(target), path.basename(target)], { windowsHide: true, timeout: 180000 })
    const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    fs.writeFileSync(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`)
    const report = { version: pkg.version, electron: require('../package.json').devDependencies.electron,
      platform: 'win32', arch: 'x64', nativeWindowsRuntime: true, runtimeIncluded: false, credentialsIncluded: false,
      publisherCodeSigned: false, archive: path.basename(archive), sha256 }
    fs.writeFileSync(archive + '.json', JSON.stringify(report, null, 2))
    process.stdout.write(JSON.stringify({ executable, archive, ...report }, null, 2) + '\n')
  } finally {
    const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir())
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('loom-windows-package-')) throw new Error('临时打包目录超出预期范围，未删除。')
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
