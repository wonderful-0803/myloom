'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Explicit input list: never traverse a checkout's profiles, credentials, node_modules or runtime artifacts.
const APP_FILES = ['main.cjs', 'preload.cjs', 'runtime.cjs', 'policy.cjs', 'platform.cjs', 'onboarding.cjs',
  'smoke.cjs', 'setup-smoke.cjs', 'macos-smoke.cjs', 'ui/index.html', 'ui/shell.css', 'ui/shell.js', 'ui/onboarding.js', 'ui/onboarding.css']
function stageApp(destination, source = path.resolve(__dirname, '..'), backendRoot = '') {
  fs.mkdirSync(destination, { recursive: true })
  for (const file of APP_FILES) {
    const input = path.join(source, file)
    if (!fs.lstatSync(input).isFile()) throw new Error(`Package input must be a regular file: ${file}`)
    const target = path.join(destination, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(input, target)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  const packaged = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, license: pkg.license, main: pkg.main }
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(packaged, null, 2))
  fs.writeFileSync(path.join(destination, 'runtime-defaults.json'), JSON.stringify({ backendRoot, serviceURL: 'http://127.0.0.1:3082' }, null, 2))
  return packaged
}
module.exports = { APP_FILES, stageApp }
