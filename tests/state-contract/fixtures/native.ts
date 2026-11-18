/** Deterministic native-Session transport fixture. Uses the actual Loom native adapter, with no model/network service. */
import type { Context } from '@deepseek-ai/cordis'
export function nativeFixture(work: (agent: any, invoke: (name: string, args: unknown) => Promise<any>) => Promise<void>) {
  let interruptFlush = false
  const listeners = new Map<string, Set<(...args: any[]) => void>>(), agents = new Map<string, any>(), failures: unknown[] = [], history = new Map<string, any[]>(), denied: string[] = []
  function on(name: string, fn: (...args: any[]) => void) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => { set.delete(fn) } }
  function emit(session: any, type: string, data: unknown) {
    const events = history.get(session.id)!, event = { type, data, time: Date.now(), seq: events.length }
    events.push(event); for (const fn of listeners.get('session/event') ?? []) fn(session, event)
  }
  const ctx: any = { on, agents, get: () => undefined, permissionPresets: { set: () => {} },
    workspaceRegistry: { create: async () => ({ id: 'fixture-workspace' }) },
    sessionPersistence: { flush: async () => { await new Promise(resolve => setTimeout(resolve, 5)); if (interruptFlush && [...history.values()].some(events => events.some(e => e.type === 'user/message'))) { interruptFlush = false; throw new Error('Fixture input flush interrupted') } },
      open: async (id: string) => ({ read: async (offset: number, limit: number) => ({ events: history.get(id)!.slice(offset, offset + limit) }), [Symbol.asyncDispose]: async () => {} }) },
    sessionController: {
      rename: async () => {}, resolveAgent: async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId: id }: { sessionId: string }) => {
        history.set(id, [])
        const tools = new Map<string, any>(), guards: ((execution: { name: string }) => string | undefined)[] = []
        const session = { id, requestHeader: () => true, snapshotEvents: () => history.get(id)! }
        const agent: any = { id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, idle: Promise.resolve(),
          cancel: () => {}, whenIdle: () => agent.idle, ctx: { on, systemPrompt: { section: () => () => {} }, tools: {
            restrict: () => () => {}, guard: (fn: (execution: { name: string }) => string | undefined) => { guards.push(fn); return () => {} },
            register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } }
        const invoke = async (name: string, args: unknown) => {
          for (const guard of guards) if (guard({ name })) { denied.push(name); throw new Error('Scoped tool denied') }
          const tool = tools.get(name); if (!tool) throw new Error('No such scoped tool')
          const callId = `call-${history.get(id)!.length}`; emit(session, 'tool/call', { callId, name, arguments: JSON.stringify(args) })
          try { const result = await tool.execute(args, { signal: new AbortController().signal }); emit(session, 'tool/result', { message: { toolCallId: callId, isError: false } }); return result }
          catch (error) { emit(session, 'tool/result', { message: { toolCallId: callId, isError: true }, error: { code: 'fixture' } }); throw error }
        }
        agent.followup = (message: any) => {
          agent.inbox.nextTurn.push(message); agent.status = 'running'
          agent.idle = Promise.resolve().then(async () => {
            agent.inbox.nextTurn.shift(); emit(session, 'turn/start', { turn: 1 }); emit(session, 'user/message', message); emit(session, 'step/start', { turn: 1, step: 1 })
            await work(agent, invoke); emit(session, 'assistant/message', { turn: 1, step: 1, usage: { outputTokens: 23 } })
          }).catch(error => { failures.push(error) }).finally(() => { emit(session, 'turn/end', { turn: 1 }); agent.status = 'idle' })
        }
        agents.set(id, agent)
      }
    }
  }
  return { context: ctx as Context, agents, failures, denied, history, interruptNextInputFlush: () => { interruptFlush = true } }
}
