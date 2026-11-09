/**
 * Prototype workspace runtime: one DSH per user, each with its own DSH_HOME, state directory and port, provisioned the way the
 * desktop onboarding provisions an independent instance (`desktop/onboarding.cjs`).
 * Without `container` it runs as a plain process, which is NOT a security boundary. With `container` each workspace runs in its own
 * Docker container that sees only its own directory (read-write) and the listed read-only paths, and reaches the model only
 * through the gateway's proxy, so it never holds the model key.
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
  container?: ContainerOptions
}
export interface ContainerOptions {
  image: string
  /** Host paths DSH needs, mounted read-only at the same path; nothing else of the host is visible. */
  mounts: string[]
  /** DSH's entry script, inside one of `mounts`. */
  dshEntry: string
  /** The gateway as the container reaches it (the Docker bridge address); model calls go to its `/ws/model` proxy. */
  gatewayURL: string
  /** `uid:gid` the container runs as, so the workspace directory keeps its owner. */
  user: string
  network?: string; memory?: string; cpus?: string; pids?: number
}
const PROFILE = 'superagent'
/**
 * `docker run` arguments for one workspace: no capabilities or privilege gain, read-only root with an exec-capable /tmp (DSH loads
 * native add-ons from there), resource limits, the listed host paths read-only, and only the workspace's own directory writable.
 */
export function dockerRunArgs(container: ContainerOptions, run: { name: string; directory: string; envFile: string; command: string[] }): string[] {
  return ['run', '--rm', '--name', run.name, '--init', '--user', container.user,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
    '--pids-limit', String(container.pids ?? 512), '--memory', container.memory ?? '2g', '--cpus', container.cpus ?? '2', '--network', container.network ?? 'bridge',
    ...container.mounts.flatMap(path => ['-v', `${path}:${path}:ro`]), '-v', `${run.directory}:${run.directory}:rw`, '-w', run.directory, '--env-file', run.envFile,
    container.image, ...run.command]
}
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

  private env(directory: string, token: string): Record<string, string> {
    return { DSH_HOME: join(directory, 'dsh'), DSH_PERSONAL_HOME: join(directory, 'dsh'), DSH_AGENTS_HOME: join(directory, 'agents'),
      DSH_SUPERAGENT_PROFILE: PROFILE, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      // In a container the model key is the workspace's own gateway token; the gateway's proxy swaps in the real key.
      LOOM_MODEL_API_KEY: this.options.container ? token : this.options.model.apiKey, ...this.options.container ? { HOME: directory } : {} }
  }
  private name(workspace: Workspace): string { return `loom-${workspace.id}` }
  /** The command that runs DSH with `args`, directly or inside the workspace's container. */
  private command(workspace: Workspace, directory: string, args: string[], token: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
    const container = this.options.container, env = this.env(directory, token)
    if (!container) return { file: this.options.dsh ?? 'dsh', args, env: { ...process.env, ...env } }
    const envFile = join(directory, '.container.env')
    write(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')
    return { file: 'docker', env: process.env, args: dockerRunArgs(container, { name: this.name(workspace), directory, envFile, command: ['node', container.dshEntry, ...args] }) }
  }
  private async run(args: string[], directory: string): Promise<void> {
    const log = openSync(join(directory, 'provision.log'), 'a')
    const env = { ...process.env, DSH_HOME: join(directory, 'dsh'), DSH_PERSONAL_HOME: join(directory, 'dsh'), DSH_AGENTS_HOME: join(directory, 'agents'), DSH_SUPERAGENT_PROFILE: PROFILE }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.dsh ?? 'dsh', args, { cwd: directory, env, stdio: ['ignore', log, log] })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`dsh ${args.slice(0, 3).join(' ')} exited ${code}; see provision.log`)))
    })
  }
  /** Whether the workspace's DSH answers on its own loopback; in a container that loopback is only reachable from inside it. */
  private async answers(workspace: Workspace, port: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}/orchestrator/api/state`
    if (!this.options.container) return fetch(url, { headers: { 'x-orchestrator-request': '1' } }).then(response => response.ok, () => false)
    const probe = `fetch(${JSON.stringify(url)},{headers:{'x-orchestrator-request':'1'}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`
    return new Promise(resolve => {
      const child = spawn('docker', ['exec', this.name(workspace), 'node', '-e', probe], { stdio: 'ignore' })
      child.once('error', () => resolve(false)); child.once('close', code => resolve(code === 0))
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
    const directory = this.directory(workspace), log = this.options.log ?? (() => {})
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const marker = join(directory, '.loom-instance')
    if (!existsSync(marker)) write(marker, workspace.id)
    const tokenFile = join(directory, 'gateway.token')
    if (!existsSync(tokenFile)) write(tokenFile, issueToken())
    const token = readFileSync(tokenFile, 'utf8').trim(), container = this.options.container
    if (container) await new Promise<void>(resolve => spawn('docker', ['rm', '-f', this.name(workspace)], { stdio: 'ignore' }).once('close', () => resolve()))
    const port = this.port(directory), profile = join(directory, 'dsh', 'profiles', PROFILE)
    if (!existsSync(join(profile, 'package.json'))) {
      log(`${workspace.id}: creating DSH profile`)
      await this.run(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], directory)
      await this.run(['plugin', '--profile', PROFILE, 'add', 'link:' + this.options.projectRoot], directory)
    }
    const model = this.options.model
    write(join(profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'webserver', config: { host: '127.0.0.1', port } },
      { id: 'dsh-superagent', config: { stateDir: join(directory, 'state') } }, { id: 'dsh-superagent-feishu', disabled: false },
      { id: 'llm-pi-ai', config: { providers: { loom: { displayName: '团队模型', api: 'openai-completions', baseURL: container ? `${container.gatewayURL}/ws/model` : model.baseURL, apiKeyEnv: 'LOOM_MODEL_API_KEY', models: [{ id: model.model, name: model.model }] } } } },
      { id: 'agent-default-model', config: { provider: 'loom', model: model.model } }], null, 2))
    const botCli = join(directory, 'lark-bot')
    write(botCli, `#!/bin/sh\nexport LOOM_TEAM_GATEWAY=${quote(container?.gatewayURL ?? this.options.gatewayURL)}\nexport LOOM_TEAM_TOKEN_FILE=${quote(tokenFile)}\n`
      + `exec ${container ? 'node' : quote(this.options.node ?? process.execPath)} ${quote(join(this.options.projectRoot, 'lib', 'team-shim.js'))} "$@"\n`, 0o700)
    if (!existsSync(join(directory, 'state', 'desktop-initialization.json'))) {
      initializePersonalSettings({ stateDir: join(directory, 'state'), botCli, owner: workspace.openId, ownerName: workspace.name || '本人',
        chats: [], directMessages: true, otherChats: 'mentions', mode: this.options.mode ?? 'auto', model: model.model })
    }
    log(`${workspace.id}: starting DSH on port ${port}${container ? ' in its container' : ''}`)
    const output = openSync(join(directory, 'dsh.log'), 'a'), command = this.command(workspace, directory, ['--profile', PROFILE, '--no-open'], token)
    const child = spawn(command.file, command.args, { cwd: directory, env: command.env, stdio: ['ignore', output, output] })
    this.running.set(workspace.id, child)
    child.once('exit', code => { log(`${workspace.id}: DSH exited (${code})`); if (this.running.get(workspace.id) === child) this.running.delete(workspace.id) })
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`DSH for ${workspace.id} exited during startup; see dsh.log`)
      if (await this.answers(workspace, port)) { log(`${workspace.id}: ready`); return }
      await delay(1000)
    }
    throw new Error(`DSH for ${workspace.id} did not answer within 180 seconds`)
  }

  /** Stops every workspace this runtime started and waits for it to exit; containers are stopped by name, since the client exiting does not stop them. */
  async stopAll(): Promise<void> {
    const ids = [...this.running.keys()]
    if (this.options.container) await Promise.all(ids.map(id => new Promise<void>(resolve => {
      spawn('docker', ['stop', '-t', '30', `loom-${id}`], { stdio: 'ignore' }).once('close', () => resolve())
    })))
    await Promise.all([...this.running.values()].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', () => resolve()); child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 30_000).unref()
    })))
  }
}
