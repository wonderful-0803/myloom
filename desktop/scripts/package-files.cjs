'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Explicit client files and pinned library packages; never traverse private checkout data or runtime artifacts.
const APP_FILES = ['main.cjs', 'preload.cjs', 'runtime.cjs', 'policy.cjs', 'platform.cjs', 'onboarding.cjs',
  'native-windows.cjs', 'windows-service.cjs', 'commands.cjs', 'private-files.cjs', 'credentials.cjs', 'windows-smoke.cjs', 'smoke.cjs', 'setup-smoke.cjs', 'macos-smoke.cjs', 'ui/index.html', 'ui/shell.css', 'ui/shell.js', 'ui/onboarding.js', 'ui/onboarding.css']
const RUNTIME_PACKAGES = { yaml: require('../package.json').dependencies.yaml }
function stageRuntimePackages(destination) {
  for (const [name, version] of Object.entries(RUNTIME_PACKAGES)) {
    const manifest = require.resolve(name + '/package.json'), directory = path.dirname(manifest)
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (installed.name !== name || installed.version !== version) throw new Error('Pinned runtime dependency does not match: ' + name)
    const target = path.join(destination, 'node_modules', name)
    fs.mkdirSync(target, { recursive: true })
    for (const file of ['package.json', 'LICENSE']) fs.copyFileSync(path.join(directory, file), path.join(target, file))
    const copy = (source, output) => {
      fs.mkdirSync(output, { recursive: true })
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const input = path.join(source, entry.name), file = path.join(output, entry.name)
        if (entry.isDirectory()) copy(input, file)
        else if (entry.isFile()) fs.copyFileSync(input, file)
        else throw new Error('Runtime dependency input must be a regular file or directory')
      }
    }
    copy(path.join(directory, 'dist'), path.join(target, 'dist'))
  }
}
function stageApp(destination, source = path.resolve(__dirname, '..'), backendRoot = '') {
  fs.mkdirSync(destination, { recursive: true })
  for (const file of APP_FILES) {
    const input = path.join(source, file)
    if (!fs.lstatSync(input).isFile()) throw new Error(`Package input must be a regular file: ${file}`)
    const target = path.join(destination, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(input, target)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  stageRuntimePackages(destination)
  const packaged = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, license: pkg.license, main: pkg.main, dependencies: RUNTIME_PACKAGES }
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(packaged, null, 2))
  fs.writeFileSync(path.join(destination, 'runtime-defaults.json'), JSON.stringify({ backendRoot, serviceURL: 'http://127.0.0.1:3082' }, null, 2))
  return packaged
}
module.exports = { APP_FILES, stageApp }
