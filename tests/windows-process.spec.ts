import { afterEach, describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandArgv, shellArgv } from '../src/infra/process.ts'
import { windowsShims } from '../src/infra/windows-environment.ts'
import { writeEnvironment, workerBin } from '../src/infra/environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { Config, resolveFeishuBot } from '../src/deployment.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
const exec = promisify(execFile)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'loom native ')); roots.push(root); return root }

describe('Windows native command boundary', () => {
  it('runs JavaScript CLIs through Node and preserves individual data arguments', () => {
    const args = ['a & b', '$env:PATH', '退款测试', '"quoted"']
    expect(commandArgv('C:\\Loom app\\lark-bot.cjs', args, 'win32')).toEqual([process.execPath, 'C:\\Loom app\\lark-bot.cjs', ...args])
    expect(commandArgv('C:\\Git\\git.exe', args, 'win32')).toEqual(['C:\\Git\\git.exe', ...args])
    expect(commandArgv('/tmp/lark-bot', args, 'linux')).toEqual(['/tmp/lark-bot', ...args])
  })
  it('generates explicit native account wrappers and keeps absent accounts blocked', async () => {
    const files = new Map<string, string>()
    const kept = await windowsShims('/native/private/worker-bin', {}, ['curl', 'git'], async (file, text) => { files.set(file, text) })
    expect(kept.has('gh.cmd')).toBe(true); expect(kept.has('lark-cli.cjs')).toBe(true); expect(kept.has('curl.cmd')).toBe(true)
    expect(kept.has('git.cmd')).toBe(false)
    const bodies = [...files.values()].join('\n')
    expect(bodies).toContain('no GitHub account'); expect(bodies).toContain('no Feishu bot'); expect(bodies).toContain('curl is blocked')
    expect(bodies).not.toContain('#!/bin/sh')
  })
})

describe.skipIf(process.platform !== 'win32')('Windows actual backend processes', () => {
  it('runs a native CLI with literal data and isolated environment through Commands', async () => {
    const root = temporary(), entry = join(root, 'account CLI.cjs')
    writeFileSync(entry, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),removed:process.env.LOOM_REMOVED,value:process.env.LOOM_PROBE}))')
    const commands = new Commands(() => testDeployment(), { LOOM_REMOVED: undefined, LOOM_PROBE: 'own value' }, new AbortController().signal)
    const args = ['退款 & test', '"quoted"', '%USERPROFILE%', '; throw 1']
    expect(JSON.parse(await commands.run(entry, args))).toEqual({ args, value: 'own value' })
  })
  it('regenerates its CRLF command wrappers, refuses foreign files, and blocks absent accounts', async () => {
    const root = temporary(), deployment = testDeployment({ stateDir: root, github: undefined, feishu: undefined })
    await writeEnvironment(deployment, ['curl'])
    await writeEnvironment(deployment, ['curl'])
    expect(readFileSync(join(workerBin(root), 'gh.cmd'), 'utf8')).toContain('\r\n')
    await expect(exec(process.execPath, [join(workerBin(root), 'gh.cjs')])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('no GitHub account') })
    writeFileSync(join(workerBin(root), 'gh.cmd'), '@echo foreign\r\n')
    await expect(writeEnvironment(deployment, [])).rejects.toThrow('was not written by dsh-superagent')
  })
  it('resolves a native bot-only CLI using real Node processes without Unix env or shell tools', async () => {
    const root = temporary(), entry = join(root, 'lark bot.cjs')
    writeFileSync(entry, `const args=process.argv.slice(2).join(' ');if(args==='auth status --verify')console.log(JSON.stringify({appId:'cli_test',brand:'feishu',identities:{bot:{status:'ready',verified:true}}}));else if(args==='config strict-mode')console.log('strict-mode: bot (source: profile)');else console.log(JSON.stringify({bot:{open_id:'ou_test',app_name:'Native test bot'}}));`)
    expect(() => Config({ stateDir: join(root, 'state') })).not.toThrow()
    const bot = await resolveFeishuBot(testMachine({ stateDir: root }), { cli: entry }, async argv => (await exec(argv[0]!, argv.slice(1))).stdout)
    expect(bot).toMatchObject({ cli: entry, appId: 'cli_test', botId: 'ou_test', name: 'Native test bot' })
  })
  it('runs configured workspace preparation through native PowerShell', async () => {
    const argv = shellArgv("[Console]::Write('LOOM_NATIVE')")
    expect((await exec(argv[0]!, argv.slice(1))).stdout).toBe('LOOM_NATIVE')
  })
})
