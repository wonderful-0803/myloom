'use strict'
const os = require('node:os')
const path = require('node:path')

/** Finder starts apps without the user's shell PATH; use known user/Homebrew locations without running shell startup files. */
function commandEnvironment(environment = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
    const roaming = environment.APPDATA || path.win32.join(home, 'AppData', 'Roaming')
    const programFiles = environment.ProgramFiles || 'C:\\Program Files'
    const systemRoot = environment.SystemRoot || 'C:\\Windows'
    const folders = [...Object.entries(environment).filter(([key]) => key.toLowerCase() === 'path').flatMap(([, value]) => String(value).split(';')),
      path.win32.join(programFiles, 'nodejs'), path.win32.join(programFiles, 'Git', 'cmd'),
      path.win32.join(local, 'Programs', 'Git', 'cmd'), path.win32.join(roaming, 'npm'),
      path.win32.join(systemRoot, 'System32'), path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
    const result = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path'))
    const unique = new Map()
    for (const folder of folders) {
      const absolute = folder.replace(/^"(.*)"$/, '$1')
      if (path.win32.isAbsolute(absolute) && !unique.has(absolute.toLowerCase())) unique.set(absolute.toLowerCase(), absolute)
    }
    return { ...result, PATH: [...unique.values()].join(';') }
  }
  if (platform !== 'darwin') return { ...environment }
  const folders = [...(environment.PATH || '').split(':'), path.posix.join(home, '.local/bin'), path.posix.join(home, 'Library/pnpm'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return { ...environment, PATH: [...new Set(folders.filter(folder => path.posix.isAbsolute(folder)))].join(':') }
}
/** New Mac assistants use Application Support; existing explicitly saved runtime paths remain authoritative. */
function dataHome(environment = process.env, platform = process.platform, home = os.homedir()) {
  return environment.XDG_DATA_HOME || (platform === 'darwin' ? path.posix.join(home, 'Library/Application Support') : platform === 'win32' ? environment.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local') : path.join(home, '.local/share'))
}
function setupArguments(packaged, appPath, platform = process.platform) {
  return [...packaged ? [] : [appPath], ...platform === 'linux' ? ['--ozone-platform=x11'] : [], '--setup-experience']
}
function platformLabel(value = process.platform) { return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[value] || value }
module.exports = { commandEnvironment, dataHome, setupArguments, platformLabel }
