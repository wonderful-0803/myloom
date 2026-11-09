/**
 * Prototype workspace runtime: one DSH process per user on this machine, each with its own DSH_HOME, state directory and port,
 * provisioned the way the desktop onboarding provisions an independent instance (`desktop/onboarding.cjs`).
 * Separate directories are NOT a security boundary; the design moves each workspace into its own container next.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initializePersonalSettings } from '../personal-setup.ts'
import type { WorkspaceRuntime } from './gateway.ts'
import type { Workspace } from './store.ts'

export interface ProcessRuntimeOptions {
  /** Parent of every workspace directory. */
  root: string
  /** Built Loom checkout linked into each workspace's DSH profile. */
  projectRoot: string
  gatewayURL: string
  /** OpenAI-compatible model; the key reaches DSH only through its environment, never a workspace file. */
  model: { baseURL: string; model: string; apiKey: string }
  basePort?: number
  mode?: 'observe' | 'auto'
  dsh?: string
  node?: string
  log?: (line: string) => void
}
const PROFILE = 'superagent'
const write = (path: string, text: string, mode = 0o600) => { writeFileSync(path, text, { mode }); chmodSync(path, mode) }
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Provisions and runs one DSH per workspace, starting each at most once at a time. */
export class ProcessRuntime implements WorkspaceRuntime {
  private readonly running = new Map<string, ChildProcess>()
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly options: ProcessRuntimeOptions) {}

  directory(workspace: Workspace): string { return join(this.options.root, workspace.id) }
  ensure(workspace: Workspace, issueToken: () => string): Promise<void> {
    if (this.running.get(workspace.id)?.exitCode === null) return Promise.resolve()
    const existing = this.pending.get(workspace.id)
    if (existing) return existing
    const started = this.start(workspace, issueToken).finally(() => this.pending.delete(workspace.id))
    this.pending.set(workspace.id, started)
    return started
  }

  private env(directory: string): NodeJS.ProcessEnv {
    return { ...process.env, DSH_HOME: join(directory, 'dsh'), DSH_PERSONAL_HOME: join(directory, 'dsh'), DSH_AGENTS_HOME: join(directory, 'agents'),
      DSH_SUPERAGENT_PROFILE: PROFILE, LOOM_MODEL_API_KEY: this.options.model.apiKey,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
  }
  private async run(command: string, args: string[], directory: string): Promise<void> {
    const log = openSync(join(directory, 'provision.log'), 'a')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd: directory, env: this.env(directory), stdio: ['ignore', log, log] })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.slice(0, 3).join(' ')} exited ${code}; see provision.log`)))
    })
  }
  /** A port is assigned once per workspace and kept in its `workspace.json`, never reused by another workspace. */
  private port(directory: string): number {
    const file = join(directory, 'workspace.json')
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { port: number }).port
    const used = new Set(readdirSync(this.options.root).map(id => join(this.options.root, id, 'workspace.json')).filter(existsSync)
      .map(path => (JSON.parse(readFileSync(path, 'utf8')) as { port: number }).port))
    let port = this.options.basePort ?? 3200
    while (used.has(port)) port++
    write(file, JSON.stringify({ port }))
    return port
  }

  /** First call provisions the workspace; every call starts its DSH if it is not running and waits until it answers. */
  private async start(workspace: Workspace, issueToken: () => string): Promise<void> {
    const directory = this.directory(workspace), dsh = this.options.dsh ?? 'dsh', log = this.options.log ?? (() => {})
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const marker = join(directory, '.loom-instance')
    if (!existsSync(marker)) write(marker, workspace.id)
    const tokenFile = join(directory, 'gateway.token')
    if (!existsSync(tokenFile)) write(tokenFile, issueToken())
    const port = this.port(directory), profile = join(directory, 'dsh', 'profiles', PROFILE)
    if (!existsSync(join(profile, 'package.json'))) {
      log(`${workspace.id}: creating DSH profile`)
      await this.run(dsh, ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], directory)
      await this.run(dsh, ['plugin', '--profile', PROFILE, 'add', 'link:' + this.options.projectRoot], directory)
    }
    const model = this.options.model
    write(join(profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'webserver', config: { host: '127.0.0.1', port } },
      { id: 'dsh-superagent', config: { stateDir: join(directory, 'state') } }, { id: 'dsh-superagent-feishu', disabled: false },
      { id: 'llm-pi-ai', config: { providers: { loom: { displayName: '团队模型', api: 'openai-completions', baseURL: model.baseURL, apiKeyEnv: 'LOOM_MODEL_API_KEY', models: [{ id: model.model, name: model.model }] } } } },
      { id: 'agent-default-model', config: { provider: 'loom', model: model.model } }], null, 2))
    const botCli = join(directory, 'lark-bot')
    write(botCli, `#!/bin/sh\nexport LOOM_TEAM_GATEWAY=${quote(this.options.gatewayURL)}\nexport LOOM_TEAM_TOKEN_FILE=${quote(tokenFile)}\n`
      + `exec ${quote(this.options.node ?? process.execPath)} ${quote(join(this.options.projectRoot, 'lib', 'team-shim.js'))} "$@"\n`, 0o700)
    if (!existsSync(join(directory, 'state', 'desktop-initialization.json'))) {
      initializePersonalSettings({ stateDir: join(directory, 'state'), botCli, owner: workspace.openId, ownerName: workspace.name || '本人',
        chats: [], directMessages: true, otherChats: 'mentions', mode: this.options.mode ?? 'auto', model: model.model })
    }
    log(`${workspace.id}: starting DSH on port ${port}`)
    const output = openSync(join(directory, 'dsh.log'), 'a')
    const child = spawn(dsh, ['--profile', PROFILE, '--no-open'], { cwd: directory, env: this.env(directory), stdio: ['ignore', output, output] })
    this.running.set(workspace.id, child)
    child.once('exit', code => { log(`${workspace.id}: DSH exited (${code})`); if (this.running.get(workspace.id) === child) this.running.delete(workspace.id) })
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`DSH for ${workspace.id} exited during startup; see dsh.log`)
      const ok = await fetch(`http://127.0.0.1:${port}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' } }).then(response => response.ok, () => false)
      if (ok) { log(`${workspace.id}: ready`); return }
      await delay(1000)
    }
    throw new Error(`DSH for ${workspace.id} did not answer within 180 seconds`)
  }

  /** Stops every workspace process this runtime started and waits for them to exit. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', () => resolve()); child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 30_000).unref()
    })))
  }
}
