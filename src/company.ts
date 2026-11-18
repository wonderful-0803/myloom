/** Optional Cordis entry for the AI-box company service; replaces the local plugin only by explicit operator configuration. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import s from '@deepseek-ai/schemastery'
import { CompanyServer } from './state/server.ts'
import type { CompanyGatewayHost } from './state/server.ts'
import { NativeOfficeBackend } from './state/native.ts'
import { packagePath } from './infra/paths.ts'
import { SqlSessionPersistence } from './dsh-state/provider.ts'
import type { FeishuWire } from './state/feishu.ts'
import type { CompanyCapacity } from './state/company-capacity.ts'
import { WorkerToolsSchema } from './state/worker-capabilities.ts'

declare module '@deepseek-ai/cordis' { interface Context { loomCompany: CompanyServer; loomCompanyHost: { wire: FeishuWire; capacity: CompanyCapacity; gatewayHost?: CompanyGatewayHost } } }

export { NativeOfficeBackend }

export const name = 'loom-company'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'llm']
export const Config = s.object({ configFile: s.string().required().description('Absolute path to the private company-service configuration; no credentials in the client.') })
const FileConfig = z.object({ tenantId: z.string().min(1), spaceId: z.string().min(1), installationId: z.string().min(1), databaseUrlEnv: z.string().regex(/^LOOM_[A-Z0-9_]+$/),
  appSecretEnv: z.string().regex(/^LOOM_[A-Z0-9_]+$/), legacyWorkspaceRoots: z.array(z.string().startsWith('/')).max(20).default([]), harnessRoot: z.string().startsWith('/').optional(), attachmentHome: z.string().startsWith('/').optional(), blobRoot: z.string().startsWith('/'), scratch: z.string().startsWith('/'),
  origin: z.url(), port: z.number().int().min(1).max(65535).default(3085), cli: z.string().min(1), workerTools: WorkerToolsSchema.default({}), loginMode: z.enum(['feishu', 'feishu-workbench', 'ssh-operator', 'local-operator']).default('feishu-workbench'), nativeState: z.enum(['configured', 'external']).default('configured'),
  gateway: z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535).default(3443), tlsKey: z.string().startsWith('/'), tlsCert: z.string().startsWith('/'), identityKey: z.string().startsWith('/'), requestCert: z.boolean().default(false), ca: z.string().startsWith('/').optional() }).strict().optional(),
  remoteExecution: z.object({ environmentId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200), resourceGrantId: z.string().min(1).max(200), grantRevision: z.number().int().positive(), requestTtlMs: z.number().int().min(5000).max(60000).optional() }).strict().optional() }).strict()
export async function apply(ctx: Context, config: ReturnType<typeof Config>): Promise<void> {
  if (!isAbsolute(config.configFile)) throw new Error('Company configuration requires an absolute private file')
  const info = await lstat(config.configFile)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || await realpath(config.configFile) !== resolve(config.configFile)) throw new Error('Company configuration must be a private regular file without symlinks')
  const value = FileConfig.parse(JSON.parse(await readFile(config.configFile, 'utf8')))
  const host = ctx.get('loomCompanyHost')
  const databaseUrl = process.env[value.databaseUrlEnv]
  if (!databaseUrl) throw new Error('Company database credential environment is missing')
  if (['feishu', 'feishu-workbench'].includes(value.loginMode) && !process.env[value.appSecretEnv]) throw new Error('Company app secret environment is missing')
  const nativeState = value.nativeState === 'external' ? ctx.sessionPersistence : undefined
  if (value.nativeState !== 'external' && ctx.sessionPersistence instanceof SqlSessionPersistence) throw new Error('Select external native state to share the SQL provider lease authority')
  if (nativeState && !(nativeState instanceof SqlSessionPersistence)) throw new Error('External native state requires the SQL SessionPersistence plugin; no local fallback')
  if (nativeState && (nativeState.authority.scope.tenantId !== value.tenantId || nativeState.authority.scope.spaceId !== value.spaceId)) throw new Error('Company/native state scope mismatch')
  if (nativeState && value.attachmentHome) {
    const attached = ctx.get('attachments') as { root?: string } | undefined
    if (attached?.root !== resolve(value.attachmentHome, 'attachments', 'v1') || !await realpath(value.attachmentHome).then(path => path === resolve(value.attachmentHome!), () => false)) throw new Error('Native attachments must use the configured independent persistent home')
    const relative = (await import('node:path')).relative(value.scratch, value.attachmentHome)
    if (relative === '' || !relative.startsWith('../')) throw new Error('Persistent attachments cannot live inside compute scratch')
  }
  const server = await CompanyServer.open({ scope: { tenantId: value.tenantId, spaceId: value.spaceId }, installationId: value.installationId,
    databaseUrl, ...(nativeState ? { store: nativeState.authority.store } : {}), blobRoot: value.blobRoot, scratch: value.scratch, origin: value.origin, port: value.port, cli: value.cli, loginMode: value.loginMode,
    botSecretRoot: join(value.blobRoot, '..', 'bot-secrets'),
    ...(value.gateway ? { gateway: value.gateway } : {}), ...(host?.gatewayHost ? { gatewayHost: host.gatewayHost } : {}), ...(value.remoteExecution ? { remoteExecution: value.remoteExecution } : {}),
    ...(host ? { wire: host.wire, embedded: true } : {}), assets: packagePath('loom', 'dist', 'client'), appSecret: async () => {
      const secret = process.env[value.appSecretEnv]; if (!secret) throw new Error('Company app secret environment is missing'); return secret
    }, backend: async services => { const backend = new NativeOfficeBackend({ ...services, context: ctx, nativeState, nativeWorker: true, workerTools: value.workerTools, legacyWorkspaceRoots: value.legacyWorkspaceRoots }); return host ? host.capacity.wrap(backend) : backend } })
  ctx.effect(() => () => server.stop())
  await server.start()
  ctx.provide('loomCompany', server)
  ctx.logger.info(`Loom company product service started; native Session storage: ${value.nativeState}`)
}
