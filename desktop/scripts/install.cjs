'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), source = path.join(root, 'dist/Loom-linux-x64')
const dataRoot = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share')
const target = path.join(dataRoot, 'luxi-loom-desktop'), application = path.join(dataRoot, 'applications', 'luxi-loom.desktop')
if (!fs.existsSync(path.join(source, 'loom'))) throw new Error('请先运行 pnpm desktop:build。')
if (fs.existsSync(target) && fs.existsSync(path.join(target, '.loom-installation')) === false) throw new Error('目标目录已有其他内容，未覆盖。')
fs.mkdirSync(target, { recursive: true, mode: 0o700 }); fs.cpSync(source, target, { recursive: true })
const version = JSON.parse(fs.readFileSync(path.join(source, 'resources/app/package.json'), 'utf8')).version
fs.writeFileSync(path.join(target, '.loom-installation'), version + '\n', { mode: 0o600 })
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'"
const launch = path.join(target, 'start-loom')
const executablePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
fs.writeFileSync(launch, `#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexport PATH=${quote(executablePath)}\nexec ${quote(path.join(target, 'loom'))} --ozone-platform=x11 "$@"\n`, { mode: 0o700 })
const desktopEscape = value => '"' + value.replace(/[%\\"`$]/g, match => match === '%' ? '%%' : '\\' + match) + '"'
const entry = `[Desktop Entry]\nVersion=1.0\nType=Application\nName=Loom\nGenericName=陆兮个人助手\nComment=飞书中的工作，在这里继续推进\nExec=${desktopEscape(launch)}\nIcon=${path.join(target, 'resources/app/assets/icon.png')}\nTerminal=false\nCategories=Office;\nStartupWMClass=loom\nStartupNotify=true\n`
fs.mkdirSync(path.dirname(application), { recursive: true })
fs.writeFileSync(application, entry, { mode: 0o644 })
const setupApplication = path.join(dataRoot, 'applications', 'luxi-loom-setup.desktop')
const setupEntry = entry.replace('Name=Loom\n', 'Name=Loom · 独立助手\n')
  .replace(`Exec=${desktopEscape(launch)}\n`, `Exec=${desktopEscape(launch)} --class=loom-setup --setup-experience\n`)
  .replace('StartupWMClass=loom\n', 'StartupWMClass=loom-setup\n')
fs.writeFileSync(setupApplication, setupEntry, { mode: 0o644 })
try { execFileSync('update-desktop-database', [path.dirname(application)], { timeout: 5000, stdio: 'ignore' }) } catch {}
let desktop
try { desktop = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8', timeout: 3000 }).trim() } catch {}
if (desktop && path.isAbsolute(desktop) && desktop !== os.homedir() && fs.existsSync(desktop)) {
  const shortcut = path.join(desktop, 'Loom.desktop')
  if (!fs.existsSync(shortcut) || fs.readFileSync(shortcut, 'utf8').includes('luxi-loom-desktop')) {
    fs.writeFileSync(shortcut, entry, { mode: 0o755 })
    try { execFileSync('gio', ['set', shortcut, 'metadata::trusted', 'true'], { timeout: 3000, stdio: 'ignore' }) } catch {}
  }
  const setupShortcut = path.join(desktop, 'Loom-独立助手.desktop')
  if (!fs.existsSync(setupShortcut) || fs.readFileSync(setupShortcut, 'utf8').includes('luxi-loom-desktop')) {
    fs.writeFileSync(setupShortcut, setupEntry, { mode: 0o755 })
    try { execFileSync('gio', ['set', setupShortcut, 'metadata::trusted', 'true'], { timeout: 3000, stdio: 'ignore' }) } catch {}
  }
}
process.stdout.write(JSON.stringify({ launch, application, setupApplication, desktop }, null, 2) + '\n')
