/** Synthetic AgentFactory over actual Cordis scopes, SessionStore and SQL persistence. No model/network calls. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { StateScope, StateStore } from '../../../src/state/ports.ts'
import { SqlSessionPersistence } from '../../../src/dsh-state/provider.ts'

export async function companyNativeFixture(store: StateStore, scope: StateScope,
  work: (agent: any, invoke: (name: string, args: unknown) => Promise<any>, signal: AbortSignal) => Promise<void>) {
  const root = new Context(); await root.plugin(SessionStore); await root.plugin(SystemPrompt)
  let ctx!: Context
  await root.inject(['sessions', 'systemPrompt'], child => { ctx = child })
  const provider = new SqlSessionPersistence(ctx, { store, scope, ttlMs: 1500 })
  const agents = new Map<string, any>(), handles = new Set<AgentHandle>(), failures: unknown[] = [], order: string[] = []
  ctx.reflect.provide('llm', { resolveCallConfig: async (input: unknown) => input })
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) })
  ctx.reflect.provide('agentPresets', { resolve: async (id: string) => ({ id }), mount: async () => { order.push('preset-mounted') } })
  ctx.reflect.provide('permissionPresets', { set: (session: any, preset: string) => { order.push('permissions'); session.append('permission/preset', { preset }) } })
  async function make(options: CreateAgentOptions | ResumeAgentOptions): Promise<AgentHandle> {
    const resumed = 'resumeSessionId' in options, id = resumed ? options.resumeSessionId : options.sessionId
    const writer = resumed ? await provider.open(id, 'write') : undefined
    const saved = writer ? await writer.read() : undefined
    const session = resumed ? ctx.sessions.prepare(id, { seed: [...saved!.events], meta: writer!.header, inheritedEventCount: writer!.inheritedEventCount, eventState: saved!.eventState })
      : ctx.sessions.prepare(id, { meta: (options as CreateAgentOptions).meta })
    const log = writer ?? await provider.create(session.header, { inheritedEventCount: session.inheritedEventCount })
    let live = new AbortController(), ended = false, detached: (() => void) | undefined
    const tools = new Map<string, any>(), guards: ((execution: any) => string | undefined)[] = []
    const agent: any = { id, session, options: options.agentOptions, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, idle: Promise.resolve(),
      cancel: () => { live.abort() }, whenIdle: () => agent.idle }
    const world = createScope(ctx, agent), agentCtx = world.ctx.isolate('tools')
    agent.ctx = agentCtx
    agentCtx.reflect.provide('tools', { restrict: () => { order.push('restricted'); return () => {} }, guard: (fn: (execution: any) => string | undefined) => {
      order.push('guarded'); guards.push(fn); return () => {}
    }, register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
    const invoke = async (name: string, args: unknown) => {
      live.signal.throwIfAborted()
      for (const guard of guards) if (guard({ name })) throw new Error('Scoped tool denied')
      const tool = tools.get(name); if (!tool) throw new Error('Scoped tool missing')
      const callId = `call-${session.seq}`, call = session.append('tool/call', { turn: 1, step: 1, name, callId, arguments: JSON.stringify(args) } as never)
      const value = await tool.execute(args, { signal: live.signal })
      session.append('tool/result', { turn: 1, step: 1, message: { id: `${callId}-result`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
        isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } } as never, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      return value
    }
    agent.followup = (message: any) => {
      agent.inbox.nextTurn.push(message); agent.status = 'running'; live = new AbortController()
      agent.idle = Promise.resolve().then(async () => {
        agent.inbox.nextTurn.shift(); session.append('turn/start', { turn: 1 }); session.append('user/message', message, { surfaceOp: 'append' }); session.append('step/start', { turn: 1, step: 1 })
        await agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: live.signal }, async () => ({ provider: 'fixture', model: 'fixture' }))
        await work(agent, invoke, live.signal)
      }).catch(error => { failures.push(error) }).finally(() => {
        session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } }); agent.status = 'idle'
      })
    }
    try {
      await options.setup?.(agentCtx, agent)
      await log.append(session.snapshotEvents(SessionLogOffset(saved?.events.length ?? 0)))
      detached = ctx.sessions.enter(session); ctx.sessions.announce(session); agents.set(id, agent); order.push('published')
      const handle = { agent, dispose: async () => {
        if (ended) return; ended = true; agent.cancel(); await agent.whenIdle()
        agents.delete(id); detached?.(); await log.close(); await world.dispose(); handles.delete(handle)
        order.push('disposed')
      } } as AgentHandle
      handles.add(handle); return handle
    } catch (error) { detached?.(); await log.close(); await world.dispose(); throw error }
  }
  ctx.reflect.provide('agents', { get: (id: string) => agents.get(id), create: (options: CreateAgentOptions) => make(options), resume: (options: ResumeAgentOptions) => make(options) })
  return { context: ctx, provider, agents, failures, order,
    close: async () => { await Promise.all([...handles].map(handle => handle.dispose())); await provider.dispose(); await root.fiber.dispose() } }
}
