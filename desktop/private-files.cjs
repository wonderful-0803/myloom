'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const protectedDirectories = new Set()
let owner
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') return
  const resolved = fs.realpathSync(directory)
  if (protectedDirectories.has(resolved)) return
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  try {
    owner ||= execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' }).match(/S-1-[0-9-]+/)?.[0]
    if (!owner) throw new Error('No current-user SID')
    execFileSync(path.join(system, 'icacls.exe'), [resolved, '/inheritance:r', '/grant:r', `*${owner}:(OI)(CI)F`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    protectedDirectories.add(resolved)
  } catch { throw new Error('无法设置本机私有目录的 Windows 访问权限，未写入凭据。') }
}
module.exports = { privateDirectory }
