/** A desktop-owned user's sync login is separate from the strict bot configuration. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SyncError } from './model.ts'

export type FeishuSetupState = 'configuration-required' | 'cli-missing' | 'bot-only' | 'unavailable' | 'signed-out' | 'needs-permission'
/** Fixed setup diagnostics distinguish configuration failures without exposing CLI output or credentials. */
export class FeishuSetupError extends SyncError {
  constructor(readonly state: FeishuSetupState, message: string, status = 409) { super(status, message) }
}
const fail = () => new FeishuSetupError('configuration-required', '同步用户配置尚未准备好，请检查桌面助手的应用配置；机器人身份未更改。')
function regular(path: string, directory = false) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || (process.getuid && info.uid !== process.getuid()) || (!directory && info.size > 1_000_000)) throw fail()
}
function json(path: string): any { regular(path); return JSON.parse(readFileSync(path, 'utf8')) }

/** Only the selected, initialized desktop instance may supply its existing app's file reference. */
export function desktopFeishuConfig(stateDir: string, expected: { appId: string; owner: string; cli: string }): string | undefined {
  const root = dirname(stateDir), marker = join(stateDir, 'desktop-initialization.json')
  if (!existsSync(join(root, '.loom-instance')) || !existsSync(marker)) return undefined
  try {
    regular(root, true); regular(stateDir, true); regular(join(root, '.loom-instance'))
    const value = json(marker)
    if (resolve(value.stateDir) !== resolve(stateDir) || resolve(value.botCli) !== resolve(expected.cli) || value.owner !== expected.owner) throw fail()
    return join(root, 'lark', 'config.json')
  } catch { throw fail() }
}

/** Reads metadata only; never reads/copies App Secret contents or imports any existing user login. */
export class FeishuUserConfig {
  constructor(private readonly directory: string, private readonly source: () => string | undefined,
    private readonly expected: () => { appId: string; owner: string }) {}
  private existing() {
    const marker = join(this.directory, '.loom-sync-user.json'), config = join(this.directory, 'config.json')
    if (!existsSync(this.directory)) return false
    try {
      regular(this.directory, true)
      if (!existsSync(marker)) throw fail()
      const value = json(marker), expected = this.expected()
      if (value.format !== 1 || value.appId !== expected.appId || value.owner !== expected.owner) throw fail()
      if (!existsSync(config)) return false
      const current = json(config)
      if (current.currentApp !== expected.appId || current.strictMode !== 'user'
        || current.apps?.length !== 1 || current.apps[0]?.appId !== expected.appId) throw fail()
      return true
    } catch { throw fail() }
  }
  environment(): Record<string, string> { return this.existing() ? { LARKSUITE_CLI_CONFIG_DIR: this.directory } : {} }
  /** Called only by an explicit login action, never by background status polling. */
  prepare(appId: string) {
    if (this.expected().appId !== appId) throw fail()
    if (this.existing()) return
    const source = this.source()
    if (!source) return // Manual deployments may already have their own independent user CLI.
    try {
      regular(dirname(source), true)
      const value = json(source), app = value.apps?.find((item: any) => item.appId === appId)
      if (value.currentApp !== appId || !app || !['feishu', 'lark'].includes(app.brand)
        || app.appSecret?.source !== 'file' || typeof app.appSecret.id !== 'string' || !isAbsolute(app.appSecret.id)
        || resolve(app.appSecret.id) !== resolve(dirname(source), 'app-secret')) throw fail()
      regular(app.appSecret.id) // Check the existing reference, without reading the secret.
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); regular(this.directory, true)
      const marker = join(this.directory, '.loom-sync-user.json')
      if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ format: 1, ...this.expected() }), { mode: 0o600, flag: 'wx' })
      const config = join(this.directory, 'config.json'), temporary = config + '.' + randomUUID()
      writeFileSync(temporary, JSON.stringify({ strictMode: 'user', currentApp: appId,
        apps: [{ appId, brand: app.brand, appSecret: { source: 'file', id: app.appSecret.id }, defaultAs: 'user', users: [] }] }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, config)
    } catch { throw fail() }
  }
}
