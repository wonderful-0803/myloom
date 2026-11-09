/**
 * Team gateway prototype entry. Feishu is simulated: events are injected through `/sim/events` and every send is recorded.
 * The local database lives under LOOM_TEAM_ROOT; set LOOM_TEAM_RUNTIME=process to start one DSH per workspace.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SimulatedFeishu } from './feishu.ts'
import { Gateway, type WorkspaceRuntime } from './gateway.ts'
import { teamServer } from './server.ts'
import { TeamStore } from './store.ts'
import { ProcessRuntime } from './workspaces.ts'

const env = process.env
const required = (name: string): string => { const value = env[name]?.trim(); if (!value) throw new Error(`Set ${name}.`); return value }
const root = resolve(env.LOOM_TEAM_ROOT ?? './team-data'), port = Number(env.LOOM_TEAM_PORT ?? 7431), host = env.LOOM_TEAM_HOST ?? '127.0.0.1'
const adminToken = readFileSync(required('LOOM_TEAM_ADMIN_TOKEN_FILE'), 'utf8').trim()
if (adminToken.length < 24) throw new Error('The admin token must be at least 24 characters.')
const store = new TeamStore(join(root, 'gateway.sqlite'))
const feishu = new SimulatedFeishu({ openId: env.LOOM_TEAM_BOT_OPEN_ID ?? 'ou_simbot', appId: env.LOOM_TEAM_BOT_APP_ID ?? 'cli_simapp', name: env.LOOM_TEAM_BOT_NAME ?? '团队助手', brand: 'feishu' })
const gatewayURL = `http://${host}:${port}`
const log = (line: string) => process.stdout.write(`[team] ${line}\n`)
const process_ = env.LOOM_TEAM_RUNTIME === 'process' ? new ProcessRuntime({ root: join(root, 'workspaces'), projectRoot: resolve(env.LOOM_TEAM_PROJECT_ROOT ?? '.'), gatewayURL,
  model: { baseURL: required('LOOM_TEAM_MODEL_BASE_URL'), model: required('LOOM_TEAM_MODEL'), apiKey: readFileSync(required('LOOM_TEAM_MODEL_KEY_FILE'), 'utf8').trim() },
  basePort: Number(env.LOOM_TEAM_WORKSPACE_PORT ?? 3200), log }) : undefined
const runtime: WorkspaceRuntime = process_ ?? { ensure: async () => {} }
const gateway = new Gateway({ store, feishu, runtime, tenantKey: required('LOOM_TEAM_TENANT'),
  aliases: (env.LOOM_TEAM_ALIASES ?? '').split(',').map(name => name.trim()).filter(Boolean),
  ...env.LOOM_TEAM_DAILY_LIMIT ? { dailyLimit: Number(env.LOOM_TEAM_DAILY_LIMIT) } : {} })
const server = teamServer({ gateway, store, adminToken, simulation: feishu })
server.listen(port, host, () => log(`gateway ready at ${gatewayURL} (simulated Feishu, runtime ${process_ ? 'process' : 'none'})`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(); void (process_?.stopAll() ?? Promise.resolve()).finally(() => { store.close(); process.exit(0) })
})
