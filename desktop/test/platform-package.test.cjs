'use strict'
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { commandEnvironment, dataHome, setupArguments } = require('../platform.cjs')
const { APP_FILES, stageApp } = require('../scripts/package-files.cjs')
const { buildMacIcons } = require('../scripts/icon.cjs')
const roots = []
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-package-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

test('Mac GUI commands find Homebrew and user tools without running a login shell or searching the working directory', () => {
  const env = { PATH: '/usr/bin::relative/bin:/custom/bin:/usr/bin', KEEP: 'value' }
  const result = commandEnvironment(env, 'darwin', '/Users/test person')
  assert.equal(result.KEEP, 'value'); assert.equal(env.PATH, '/usr/bin::relative/bin:/custom/bin:/usr/bin')
  const folders = result.PATH.split(':')
  assert.ok(folders.includes('/opt/homebrew/bin')); assert.ok(folders.includes('/usr/local/bin'))
  assert.ok(folders.includes('/Users/test person/.local/bin')); assert.ok(folders.every(folder => path.isAbsolute(folder)))
  assert.equal(new Set(folders).size, folders.length)
  assert.deepEqual(commandEnvironment(env, 'linux', '/home/test'), env)
  assert.equal(dataHome({}, 'darwin', '/Users/test person'), '/Users/test person/Library/Application Support')
  assert.equal(dataHome({ XDG_DATA_HOME: '/chosen/data' }, 'darwin'), '/chosen/data')
  assert.deepEqual(setupArguments(true, '/Applications/Loom.app', 'darwin'), ['--setup-experience'])
  assert.deepEqual(setupArguments(false, '/a project', 'linux'), ['/a project', '--ozone-platform=x11', '--setup-experience'])
})

test('portable application staging excludes credentials, local defaults, dependencies and unexpected source files', () => {
  const root = temporary(), source = path.join(root, 'source'), target = path.join(root, 'app')
  for (const file of [...APP_FILES, '.credentials.yaml', 'runtime-defaults.json', 'node_modules/private/index.js', 'ui/.env']) {
    const name = path.join(source, file); fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, 'not-a-credential')
  }
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'loom-test', version: '1.2.3', main: 'main.cjs', scripts: { test: 'never packaged' }, privateData: 'not-a-credential' }))
  stageApp(target, source)
  for (const file of ['.credentials.yaml', 'node_modules', 'ui/.env']) assert.equal(fs.existsSync(path.join(target, file)), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'runtime-defaults.json'))), { backendRoot: '', serviceURL: 'http://127.0.0.1:3082' })
  const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json')))
  assert.equal(pkg.scripts, undefined); assert.equal(pkg.privateData, undefined); assert.equal(pkg.version, '1.2.3')
  fs.unlinkSync(path.join(source, APP_FILES[0])); fs.symlinkSync(path.join(source, '.credentials.yaml'), path.join(source, APP_FILES[0]))
  assert.throws(() => stageApp(path.join(root, 'other-app'), source), /regular file/)
})

test('the Mac icon container contains complete PNG entries and the menu icon has the expected dimensions', () => {
  const root = temporary(); buildMacIcons(root)
  const bytes = fs.readFileSync(path.join(root, 'icon.icns'))
  assert.equal(bytes.subarray(0, 4).toString(), 'icns'); assert.equal(bytes.readUInt32BE(4), bytes.length)
  const entries = []; let offset = 8
  while (offset < bytes.length) {
    const kind = bytes.subarray(offset, offset + 4).toString(), length = bytes.readUInt32BE(offset + 4)
    assert.ok(length > 32 && offset + length <= bytes.length)
    const png = bytes.subarray(offset + 8, offset + length)
    assert.equal(png.subarray(1, 4).toString(), 'PNG'); entries.push([kind, png.readUInt32BE(16)]); offset += length
  }
  assert.deepEqual(entries, [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]])
  assert.equal(fs.readFileSync(path.join(root, 'trayTemplate.png')).readUInt32BE(16), 32)
})
