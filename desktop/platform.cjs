'use strict'
const os = require('node:os')
const path = require('node:path')

/** Finder starts apps without the user's shell PATH; use known user/Homebrew locations without running shell startup files. */
function commandEnvironment(environment = process.env, platform = process.platform, home = os.homedir()) {
  if (platform !== 'darwin') return { ...environment }
  const folders = [...(environment.PATH || '').split(':'), path.join(home, '.local/bin'), path.join(home, 'Library/pnpm'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return { ...environment, PATH: [...new Set(folders.filter(folder => path.isAbsolute(folder)))].join(':') }
}
/** New Mac assistants use Application Support; existing explicitly saved runtime paths remain authoritative. */
function dataHome(environment = process.env, platform = process.platform, home = os.homedir()) {
  return environment.XDG_DATA_HOME || (platform === 'darwin' ? path.join(home, 'Library/Application Support') : path.join(home, '.local/share'))
}
function setupArguments(packaged, appPath, platform = process.platform) {
  return [...packaged ? [] : [appPath], ...platform === 'linux' ? ['--ozone-platform=x11'] : [], '--setup-experience']
}
module.exports = { commandEnvironment, dataHome, setupArguments }
