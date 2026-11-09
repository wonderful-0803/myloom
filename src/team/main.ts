/**
 * Team gateway prototype entry. LOOM_TEAM_FEISHU=sim (default) simulates Feishu: events arrive through `/sim/events` and every send
 * is recorded. LOOM_TEAM_FEISHU=lark consumes the real bot through LOOM_TEAM_LARK_CLI and then requires LOOM_TEAM_ALLOW_OPEN_IDS,
 * because CLI events carry no tenant. The local database lives under LOOM_TEAM_ROOT; LOOM_TEAM_RUNTIME=process starts one DSH per workspace.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SimulatedFeishu, type FeishuPort } from './feishu.ts'
import { Gateway, type WorkspaceRuntime } from './gateway.ts'
import { readTickets } from './board.ts'
import { consumeLark, larkBot, LarkFeishu, larkRunner } from './lark.ts'
import { teamServer } from './server.ts'
import { TeamStore } from './store.ts'
import { ProcessRuntime } from './workspaces.ts'

const env = process.env
const required = (name: string): string => { const value = env[name]?.trim(); if (!value) throw new Error(`Set ${name}.`); return value }
const root = resolve(env.LOOM_TEAM_ROOT ?? './team-data'), port = Number(env.LOOM_TEAM_PORT ?? 7431), host = env.LOOM_TEAM_HOST ?? '127.0.0.1'
const log = (line: string) => process.stdout.write(`[team] ${new Date().toISOString().slice(11, 19)} ${line}\n`)
const adminToken = readFileSync(required('LOOM_TEAM_ADMIN_TOKEN_FILE'), 'utf8').trim()
if (adminToken.length < 24) throw new Error('The admin token must be at least 24 characters.')
const real = env.LOOM_TEAM_FEISHU === 'lark'
const allowed = (env.LOOM_TEAM_ALLOW_OPEN_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean)
if (real && !allowed.length) throw new Error('Set LOOM_TEAM_ALLOW_OPEN_IDS: real Feishu events carry no tenant, so only listed people may get a workspace.')
const cli = real ? required('LOOM_TEAM_LARK_CLI') : ''
const simulation = real ? undefined : new SimulatedFeishu({ openId: env.LOOM_TEAM_BOT_OPEN_ID ?? 'ou_simbot', appId: env.LOOM_TEAM_BOT_APP_ID ?? 'cli_simapp', name: env.LOOM_TEAM_BOT_NAME ?? '团队助手', brand: 'feishu' })
const feishu: FeishuPort = simulation ?? new LarkFeishu(await larkBot(cli), larkRunner(cli))
const store = new TeamStore(join(root, 'gateway.sqlite'))
const gatewayURL = `http://${host}:${port}`
const modelKey = env.LOOM_TEAM_RUNTIME ? readFileSync(required('LOOM_TEAM_MODEL_KEY_FILE'), 'utf8').trim() : ''
// LOOM_TEAM_RUNTIME=container runs each workspace in Docker; containers reach the gateway on LOOM_TEAM_BRIDGE_HOST (the docker0 address).
const bridge = env.LOOM_TEAM_RUNTIME === 'container' ? required('LOOM_TEAM_BRIDGE_HOST') : ''
const container = bridge ? { image: env.LOOM_TEAM_IMAGE ?? 'node:22-bookworm-slim', gatewayURL: `http://${bridge}:${port}`,
  mounts: required('LOOM_TEAM_MOUNTS').split(':').filter(Boolean), dshEntry: required('LOOM_TEAM_DSH_ENTRY'), user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}` } : undefined
const process_ = env.LOOM_TEAM_RUNTIME ? new ProcessRuntime({ root: join(root, 'workspaces'), projectRoot: resolve(env.LOOM_TEAM_PROJECT_ROOT ?? '.'), gatewayURL,
  model: { baseURL: required('LOOM_TEAM_MODEL_BASE_URL'), model: required('LOOM_TEAM_MODEL'), apiKey: modelKey },
  basePort: Number(env.LOOM_TEAM_WORKSPACE_PORT ?? 3200), log, ...container ? { container } : {} }) : undefined
const runtime: WorkspaceRuntime = process_ ?? { ensure: async () => {} }
const gateway = new Gateway({ store, feishu, runtime, tenantKey: env.LOOM_TEAM_TENANT ?? '',
  // The menu board reads each workspace's task database on the host, read-only.
  tickets: workspace => readTickets(join(root, 'workspaces', workspace.id, 'state', 'orchestrator.sqlite')),
  aliases: (env.LOOM_TEAM_ALIASES ?? '').split(',').map(name => name.trim()).filter(Boolean),
  ...allowed.length ? { admit: (person: { openId: string }) => allowed.includes(person.openId) } : {},
  ...env.LOOM_TEAM_DAILY_LIMIT ? { dailyLimit: Number(env.LOOM_TEAM_DAILY_LIMIT) } : {} })
const model = modelKey ? { baseURL: required('LOOM_TEAM_MODEL_BASE_URL'), apiKey: modelKey } : undefined
const server = teamServer({ gateway, store, adminToken, ...simulation ? { simulation } : {}, ...model ? { model } : {} })
// Containers reach only the workspace endpoints, on the bridge address; admin and simulation stay on loopback.
const bridgeServer = bridge ? teamServer({ gateway, store, adminToken, workspaceOnly: true, ...model ? { model } : {} }) : undefined
bridgeServer?.listen(port, bridge, () => log(`workspace endpoints on http://${bridge}:${port}`))
const stopping = new AbortController()
server.listen(port, host, () => log(`gateway ready at ${gatewayURL} (Feishu ${real ? `bot ${feishu.bot.name || feishu.bot.appId}` : 'simulated'}, runtime ${container ? 'container' : process_ ? 'process' : 'none'}, allowlist ${allowed.length})`))
if (real) void consumeLark(cli, async line => {
  const outcome = await gateway.ingestCompact(line)
  log(`event ${outcome.outcome}${'reason' in outcome ? ` (${outcome.reason})` : ''}${outcome.workspaceId ? ` → ${outcome.workspaceId}` : ''}`)
}, log, stopping.signal)
// Clicks on the bot's menu (items set to "push event") answer with a private task board.
if (real) void consumeLark(cli, async line => {
  const outcome = await gateway.menu(line)
  log(`menu ${outcome.outcome}${'reason' in outcome ? ` (${outcome.reason})` : ` ${outcome.focus}`}${outcome.workspaceId ? ` → ${outcome.workspaceId}` : ''}`)
}, log, stopping.signal, 'application.bot.menu_v6')
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopping.abort(); server.close(); bridgeServer?.close()
  void (process_?.stopAll() ?? Promise.resolve()).finally(() => { store.close(); process.exit(0) })
})
