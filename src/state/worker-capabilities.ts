/** Extensible native DSH tool policies. Policies describe resources/effects, never office scene names. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { taskPath } from './worker-sandbox.ts'
import { StateConflict } from './ports.ts'

/**
 * A Worker capability is deliberately a resource manifest, rather than an
 * office-scene name.  The first two fields are the original configuration
 * contract.  The rest are optional at the input boundary so existing company
 * profiles keep working, then are filled with stable defaults by the parser.
 */
const WorkerToolSchema = z.object({
  effect: z.enum(['read', 'workspace', 'external']),
  description: z.string().min(1).max(1000),
  version: z.number().int().positive().max(1000).optional(),
  executor: z.enum(['native', 'runner', 'connector']).optional(),
  resources: z.array(z.string().min(1).max(200)).max(50).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  maxOutputBytes: z.number().int().positive().max(100_000_000).optional(),
  requiresGrant: z.boolean().optional(),
}).strict().transform(value => ({
  ...value,
  version: value.version ?? 1,
  executor: value.executor ?? (value.effect === 'external' ? 'connector' : 'native'),
  resources: value.resources ?? [],
  requiresGrant: value.requiresGrant ?? value.effect === 'external',
}))
export const WorkerToolsSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), WorkerToolSchema).default({})
export type WorkerTool = z.output<typeof WorkerToolSchema>
export type WorkerTools = z.output<typeof WorkerToolsSchema>
export type WorkerToolsInput = z.input<typeof WorkerToolsSchema>
export interface WorkerCapabilityManifestEntry extends WorkerTool { id: string; name: string }
export interface WorkerEnvironment { root: string; readRoots: readonly string[]; confined: true }
export interface WorkerToolPolicy {
  authorize(input: { tool: string; arguments: unknown; ticketId: string; actor: string; signal: AbortSignal }): Promise<void>
}
declare module '@deepseek-ai/cordis' { interface Context { loomWorkerSandbox: WorkerEnvironment; loomWorkerToolPolicy: WorkerToolPolicy } }
const native: WorkerTools = WorkerToolsSchema.parse(Object.fromEntries([
  ['web_search', 'read'], ['web_fetch', 'read'], ['read', 'read'], ['read_image', 'read'], ['glob', 'read'], ['grep', 'read'],
  ['write', 'workspace'], ['edit', 'workspace'], ['bash', 'workspace'], ['job_output', 'workspace'], ['job_list', 'workspace'], ['job_kill', 'workspace'], ['todo_write', 'workspace'], ['skill', 'read'],
  ['run_code', 'workspace'], ['subagent', 'workspace'], ['list_subagent_models', 'read'], ['send_message', 'workspace'], ['interrupt_agent', 'workspace'],
].map(([name, effect]) => [name!, { effect, description: `Native DSH ${name}`, executor: 'native', resources: [`dsh:${name}`] }])) as WorkerTools)

/** Enforces the declared DSH tool policy and confined task environment before each native call. */
export class WorkerCapabilities {
  readonly policy: WorkerTools
  readonly successfulReads = new Set<string>()
  readonly unavailable = new Set<string>()
  constructor(readonly agent: Agent, readonly environment: WorkerEnvironment | undefined, plugins: WorkerToolsInput = {}, readonly connectorPolicy?: WorkerToolPolicy) {
    const parsed = WorkerToolsSchema.parse(plugins)
    this.policy = { ...native, ...parsed }
    for (const name of Object.keys(parsed)) if (name.startsWith('orchestrator_') || name in native) throw new StateConflict('Plugin policy cannot override built-in resource guards')
  }
  allowed(name: string): boolean {
    const policy = this.policy[name]
    if (!policy) return false
    if (['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill'].includes(name) && !this.environment?.confined) return false
    // An external connector needs its own explicit authorization/receipt adapter; installing a tool is not consent to send.
    return policy.effect !== 'external' || !!this.connectorPolicy
  }
  async before(execution: Pick<ToolExecution, 'name' | 'arguments' | 'signal'>) {
    execution.signal.throwIfAborted()
    if (!this.allowed(execution.name)) throw new StateConflict('Capability requires its declared environment or external-operation adapter')
    const input = execution.arguments as Record<string, unknown>, cwd = this.agent.session.header.cwd
    if (!cwd) throw new StateConflict('Task environment missing')
    if (input.sandbox_permissions && input.sandbox_permissions !== 'use_default' || input.sandboxMode || input.approvedSandboxMode) throw new StateConflict('Task tools cannot escalate server privileges')
    if (['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash'].includes(execution.name)) {
      const path = input.file_path ?? input.path ?? input.workdir ?? '.'
      if (typeof path !== 'string') throw new StateConflict('Task path is invalid')
      await taskPath(cwd, path, ['write', 'edit', 'bash'].includes(execution.name), this.environment?.readRoots)
      if (execution.name === 'glob' && typeof input.pattern === 'string' && (input.pattern.startsWith('/') || input.pattern.split('/').includes('..'))) throw new StateConflict('Glob pattern leaves the task environment')
    }
    execution.signal.throwIfAborted()
  }
  result(name: string, value: unknown, isError: boolean) {
    if (isError) { this.unavailable.add(name); return }
    this.unavailable.delete(name)
    if (name === 'web_fetch' && value && typeof value === 'object') {
      const result = value as Record<string, unknown>
      const status = result.status ?? (result.response as Record<string, unknown> | undefined)?.status
      if (typeof status === 'number' && status >= 400) return
      this.successfulReads.add(name)
    }
  }
  describe(names: readonly string[]) {
    return names.filter(name => this.allowed(name)).map(name => ({ id: name, name, ...this.policy[name] }))
  }
}

/** Returns the complete declared manifest, including capabilities not exposed by a DSH Agent instance yet. */
export function workerCapabilityManifest(policy: WorkerTools): WorkerCapabilityManifestEntry[] {
  return Object.entries(policy).map(([name, descriptor]) => ({ id: name, name, ...descriptor }))
}
