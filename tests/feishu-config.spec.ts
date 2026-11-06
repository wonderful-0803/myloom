/** Fresh desktop sync configuration uses an existing app reference, never a bot's login or secret text. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { desktopFeishuConfig, FeishuUserConfig } from '../src/sync/feishu-config.ts'
import { FeishuDrive, feishuSyncScopes } from '../src/sync/feishu-drive.ts'
import { FeishuSync } from '../src/sync/feishu.ts'
import { SyncDatabase } from '../src/sync/database.ts'
let root: string
const identity = { appId: 'cli_test', owner: 'ou_owner' }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'loom-feishu-config-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const state = join(root, 'state'), lark = join(root, 'lark'), botCli = join(root, 'lark-bot')
  mkdirSync(state); mkdirSync(lark)
  writeFileSync(join(root, '.loom-instance'), 'fixture-instance', { mode: 0o600 })
  writeFileSync(join(state, 'desktop-initialization.json'), JSON.stringify({ stateDir: state, botCli, owner: identity.owner }), { mode: 0o600 })
  writeFileSync(join(lark, 'app-secret'), 'fixture-secret-must-never-be-copied', { mode: 0o600 })
  const source = join(lark, 'config.json'), target = join(state, 'sync-user')
  writeFileSync(source, JSON.stringify({ strictMode: 'bot', currentApp: identity.appId,
    apps: [{ appId: identity.appId, brand: 'feishu', appSecret: { source: 'file', id: join(lark, 'app-secret') }, defaultAs: 'bot', users: [] }] }), { mode: 0o600 })
  const config = new FeishuUserConfig(target, () => desktopFeishuConfig(state, { ...identity, cli: botCli }), () => identity)
  return { config, source, state, target, botCli }
}
it('creates a private user profile only on explicit preparation, preserving the strict bot source', () => {
  const { config, source, target } = fixture(), before = readFileSync(source, 'utf8')
  expect(config.environment()).toEqual({}); expect(existsSync(target)).toBe(false)
  config.prepare(identity.appId)
  expect(config.environment()).toEqual({ LARKSUITE_CLI_CONFIG_DIR: target })
  const text = readFileSync(join(target, 'config.json'), 'utf8'), value = JSON.parse(text)
  expect(value).toMatchObject({ strictMode: 'user', currentApp: identity.appId, apps: [{ defaultAs: 'user', users: [], appSecret: { source: 'file' } }] })
  expect(text).not.toContain('fixture-secret-must-never-be-copied')
  expect(readFileSync(source, 'utf8')).toBe(before)
  if (process.platform !== 'win32') {
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(statSync(join(target, 'config.json')).mode & 0o777).toBe(0o600)
  }
  value.apps[0].users = [{ userOpenId: identity.owner }]
  writeFileSync(join(target, 'config.json'), JSON.stringify(value))
  config.prepare(identity.appId)
  expect(JSON.parse(readFileSync(join(target, 'config.json'), 'utf8')).apps[0].users).toHaveLength(1)
})
it('does not search another instance or reuse an app/owner that differs from the initialized desktop', () => {
  const { config, source, state, target, botCli } = fixture()
  expect(() => desktopFeishuConfig(state, { ...identity, cli: botCli, owner: 'ou_other' })).toThrow()
  expect(() => desktopFeishuConfig(state, { ...identity, cli: join(root, 'other-bot') })).toThrow()
  const value = JSON.parse(readFileSync(source, 'utf8')); value.currentApp = 'cli_other'
  writeFileSync(source, JSON.stringify(value))
  expect(() => config.prepare(identity.appId)).toThrow(); expect(existsSync(target)).toBe(false)
  expect(desktopFeishuConfig(join(root, 'unmanaged'), { ...identity, cli: botCli })).toBeUndefined()
})
it('refuses plaintext secret duplication and unknown existing user configurations', () => {
  const { config, source, target } = fixture(), value = JSON.parse(readFileSync(source, 'utf8'))
  value.apps[0].appSecret = 'fixture-plaintext-secret'
  writeFileSync(source, JSON.stringify(value))
  expect(() => config.prepare(identity.appId)).toThrow(); expect(existsSync(target)).toBe(false)
  mkdirSync(target); writeFileSync(join(target, 'config.json'), '{"unrelated":true}')
  expect(() => config.prepare(identity.appId)).toThrow()
  expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('{"unrelated":true}')
})
it.skipIf(process.platform === 'win32')('rejects a symlink instead of writing outside the owned profile', () => {
  const { config, target } = fixture(), elsewhere = join(root, 'unrelated')
  mkdirSync(elsewhere); symlinkSync(elsewhere, target, 'dir')
  expect(() => config.prepare(identity.appId)).toThrow()
  expect(existsSync(join(elsewhere, 'config.json'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('generates and completes login through actual CLI subprocesses on a fresh desktop without changing the bot', async () => {
  const { config, source, state, target } = fixture(), before = readFileSync(source, 'utf8'), cli = join(root, 'fixture-cli')
  writeFileSync(cli, '#!' + process.execPath + '\n' + `
const fs=require('node:fs'),path=require('node:path'),folder=process.env.LARKSUITE_CLI_CONFIG_DIR;
const cfg=JSON.parse(fs.readFileSync(path.join(folder,'config.json'),'utf8')),args=process.argv.slice(2);
if(cfg.strictMode!=='user'){process.stderr.write(JSON.stringify({error:{type:'config',subtype:'not_configured'}}));process.exit(3)}
if(args[1]==='status'){
 const logged=fs.existsSync(path.join(folder,'fixture-authorized'));
 process.stdout.write(JSON.stringify({appId:'cli_test',identities:{user:{verified:logged,openId:logged?'ou_owner':'',userName:'本人',scope:${JSON.stringify(feishuSyncScopes)}}}}));
}else if(args[1]==='qrcode'){
 fs.writeFileSync('authorization.png',Buffer.from('fixture-qr'));
}else if(args.includes('--no-wait')){
 process.stdout.write(JSON.stringify({device_code:'fixture-private-code',verification_url:'https://accounts.feishu.cn/fixture',expires_in:300}));
}else if(args.includes('--device-code')){
 if(args[args.indexOf('--device-code')+1]!=='fixture-private-code')process.exit(1);
 fs.writeFileSync(path.join(folder,'fixture-authorized'),'ok');process.stdout.write('{}');
}else process.exit(1);
`, { mode: 0o755 })
  const drive = new FeishuDrive(join(state, 'transfers'), () => cli, undefined, () => ({ LARKSUITE_CLI_CONFIG_DIR: join(root, 'lark') }), config)
  const database = new SyncDatabase(join(state, 'sync.sqlite')), controller = new AbortController()
  const sync = new FeishuSync(database, drive, { owner: () => identity.owner, appId: () => identity.appId, paused: () => false, lifetime: controller.signal })
  try {
    expect(await sync.status(identity.owner)).toMatchObject({ account: { state: 'configuration-required' } })
    expect(existsSync(target)).toBe(false)
    const start = await sync.handle(identity.owner, 'POST', ['auth', 'start'], {})
    expect(start).toMatchObject({ url: 'https://accounts.feishu.cn/fixture', qr: expect.stringContaining('data:image/png;base64,') })
    expect(JSON.stringify(start)).not.toContain('fixture-private-code')
    expect(await sync.handle(identity.owner, 'POST', ['auth', 'finish'], {})).toMatchObject({ connected: false, account: { state: 'ready' }, mappings: [] })
    expect(readFileSync(source, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(source, 'utf8')).strictMode).toBe('bot')
  } finally { controller.abort(); await sync.idle(); database.close() }
})
