/** Native Windows worker command defaults; account wrappers remain guardrails, not an OS sandbox. */
import { join, resolve, delimiter } from 'node:path'
import type { Deployment } from '../deployment.ts'
import { commandArgv } from './process.ts'
const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
export async function windowsShims(dir: string, deployment: Pick<Deployment, 'github' | 'feishu'>, blocked: readonly string[],
  own: (file: string, text: string) => Promise<void>): Promise<Set<string>> {
  const kept = new Set<string>()
  const quoteCmd = (value: string): string => '"' + value.replaceAll('%', '%%') + '"'
  async function shim(name: string, target?: string, failure?: string): Promise<void> {
    const script = join(dir, name + '.cjs'), command = join(dir, name + '.cmd')
    const argv = target ? commandArgv(target, [], 'win32') : []
    const body = target
      ? `const {spawnSync}=require('node:child_process');\nconst {resolve}=require('node:path');\nconst self=${JSON.stringify(resolve(dir).toLowerCase())};\nprocess.env.PATH=(process.env.PATH||'').split(${JSON.stringify(delimiter)}).filter(p=>resolve(p).toLowerCase()!==self).join(${JSON.stringify(delimiter)});\nconst result=spawnSync(${JSON.stringify(argv[0])},[...${JSON.stringify(argv.slice(1))},...process.argv.slice(2)],{env:process.env,stdio:'inherit',windowsHide:true});\nprocess.exit(result.status??1);`
      : `process.stderr.write(${JSON.stringify((failure || 'Command is unavailable.') + '\n')});process.exit(1);`
    await own(script, `// ${MARKER}\n'use strict'\n${body}\n`)
    await own(command, `@echo off\r\n@rem ${MARKER}\r\nsetlocal DisableDelayedExpansion\r\n${quoteCmd(process.execPath)} ${quoteCmd(script)} %*\r\n`)
    kept.add(name + '.cjs'); kept.add(name + '.cmd')
  }
  await shim('gh', deployment.github?.cli, 'gh is unavailable: this installation has no GitHub account.')
  await shim('lark-cli', deployment.feishu?.cli, 'lark-cli is unavailable: this installation has no Feishu bot.')
  for (const name of new Set(blocked)) {
    if (['gh', 'git', 'lark-cli'].includes(name.toLowerCase())) continue
    await shim(name, undefined, `${name} is blocked in this installation.`)
  }
  return kept
}
