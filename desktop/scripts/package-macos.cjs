'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { stageApp } = require('./package-files.cjs')
const { buildMacIcons } = require('./icon.cjs')

async function main() {
  if (process.platform !== 'darwin') throw new Error('请在 macOS 上构建以签署及验证应用；可运行仓库中的 Build macOS desktop 工作流。')
  const arch = process.argv[2] || process.arch
  if (!['arm64', 'x64'].includes(arch)) throw new Error('macOS 压缩包仅支持 arm64 或 x64。')
  const root = path.resolve(__dirname, '..'), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-macos-package-'))
  try {
    const input = path.join(temporary, 'input'), pkg = stageApp(input, root)
    buildMacIcons(path.join(input, 'assets'))
    fs.copyFileSync(path.join(root, '../LICENSE'), path.join(input, 'LICENSE'))
    const { packager } = await import('@electron/packager')
    const [target] = await packager({ dir: input, name: 'Loom', platform: 'darwin', arch,
      electronVersion: require('../package.json').devDependencies.electron,
      out: path.join(root, 'dist/macos'), overwrite: true, prune: false, asar: false,
      appBundleId: 'dev.luxi.loom', helperBundleId: 'dev.luxi.loom.helper', appCategoryType: 'public.app-category.productivity',
      icon: path.join(input, 'assets/icon.icns'), darwinDarkModeSupport: true,
      extendInfo: { NSHumanReadableCopyright: 'Loom contributors; upstream DeepSeek Harness Team. MIT.' } })
    if (!target) throw new Error('macOS 应用目录未生成。')
    const bundle = path.join(target, 'Loom.app')
    // Internal distribution only: this creates a valid local signature, not a Developer ID or notarization claim.
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit', timeout: 120000 })
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { stdio: 'inherit', timeout: 60000 })
    const minimumMacOS = execFileSync('/usr/bin/plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
    const cpu = execFileSync('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents/MacOS/Loom')], { encoding: 'utf8' }).trim()
    if (cpu !== (arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error('应用二进制架构不匹配。')
    fs.writeFileSync(path.join(target, '使用说明.txt'), `Loom ${pkg.version} macOS 本机内测版（${arch}）\n\n` +
      `系统：macOS ${minimumMacOS} 或更新版本。\n把 Loom.app 拖入“应用程序”，再打开。\n` +
      '这是使用本地签名的内测包，尚无 Apple Developer ID 签名或公证。首次打开可能需要在“系统设置 → 隐私与安全性”中核实后选择“仍要打开”；不要关闭系统整体安全保护。\n\n' +
      '包中仅包含桌面客户端，不包含办公引擎、Harness/CLI 依赖、模型、个人凭据或任务库。\n' +
      '首次使用先按项目 docs/DESKTOP.md 准备本机引擎和依赖，在向导中选择已构建的 Loom 源码目录，再配置自己的模型和飞书机器人。\n' +
      '下载源码：https://github.com/wonderful-0803/myloom\n' +
      '所有账户在 Mac 本机输入，不能复用开发者的凭据；不会自动导入其他设备的任务。\n\n' +
      '关闭窗口后可从 Dock 或菜单栏重新打开。退出 Loom 时助手继续运行；停止助手需从菜单明确操作。\n')
    fs.copyFileSync(path.join(root, '../LICENSE'), path.join(target, 'LICENSE'))
    const archive = path.join(root, 'dist', `Loom-${pkg.version}-macos-${arch}.zip`)
    fs.rmSync(archive, { force: true })
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', target, archive], { timeout: 180000 })
    const checksum = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    fs.writeFileSync(archive + '.sha256', `${checksum}  ${path.basename(archive)}\n`)
    const report = { version: pkg.version, electron: require('../package.json').devDependencies.electron, platform: 'darwin', arch, cpu,
      minimumMacOS, signing: 'ad-hoc', signatureVerified: true, notarized: false, archive: path.basename(archive), sha256: checksum,
      runtimeIncluded: false, credentialsIncluded: false }
    fs.writeFileSync(archive + '.json', JSON.stringify(report, null, 2))
    process.stdout.write(JSON.stringify({ bundle, archive, ...report }, null, 2) + '\n')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
