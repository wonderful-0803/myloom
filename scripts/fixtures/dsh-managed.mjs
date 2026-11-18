/** Copied into an isolated build directory by smoke-dsh-state; real rc.3 AgentFactory, no model request or business tools. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { apply } from './lib/dsh-state.js'
const [phase, tenantId] = process.argv.slice(2), root = new Context()
try {
  await apply(root, { tenantId, spaceId: 'managed-rc3-smoke', databaseUrlEnv: 'LOOM_DSH_B1_DATABASE_URL' })
  await root.plugin(SessionStore); await root.plugin(SystemPrompt); await root.plugin(AgentRegistry); await root.plugin(SessionProjections)
  // An idle lifecycle must never call a model; a request would fail this probe immediately.
  root.reflect.provide('llm', { resolveCallConfig: async () => { throw new Error('Idle probe must not infer') } })
  await root.plugin(Tools, { mode: 'native', maxParallelSubCalls: 1 })
  await root.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  let ctx
  await root.inject(['agents', 'sessions', 'sessionPersistence', 'systemPrompt', 'tools', 'llm', 'sessionProjections'], child => { ctx = child })
  const provider = ctx.sessionPersistence, { store, scope } = provider.authority, id = SessionId('worker-rc3-managed')
  const lease = await store.transaction(scope, tx => tx.leases.acquire(id, `compute-${phase}`, 5000))
  assert.ok(lease)
  let result
  await provider.useLease(lease, async binding => {
    const order = []
    const setup = async (agentCtx, agent) => {
      assert.equal(ctx.agents.get(id), undefined)
      agentCtx.tools.restrict({ allow: [] }); agentCtx.tools.guard(() => 'No business tools in idle probe')
      await binding.assertCurrent(); order.push('guarded-before-publication')
      agent.session.append('model/selection', { provider: 'fixture', model: `idle-${phase}` })
    }
    const handle = phase === 'seed' ? await ctx.agents.create({ sessionId: id, meta: { cwd: '/tmp/loom-managed-rebuildable-scratch' }, setup })
      : await ctx.agents.resume({ resumeSessionId: id, setup })
    assert.equal(ctx.agents.get(id), handle.agent)
    await binding.flush()
    const reader = await provider.open(id, 'read'), saved = await reader.read(); await reader.close()
    const current = await store.transaction(scope, tx => tx.leases.current(id))
    assert.equal(current.owner, lease.owner); assert.equal(current.epoch, lease.epoch)
    const header = handle.agent.session.header
    await handle.dispose(); await binding.close()
    assert.equal(ctx.agents.get(id), undefined); assert.equal(ctx.sessions.get(id), undefined)
    await store.transaction(scope, async tx => { await tx.leases.assert(lease); assert.equal(await tx.leases.release(lease), true) })
    result = { phase, id, header, count: saved.events.length, epoch: lease.epoch, owner: lease.owner, guardedBeforePublication: true,
      actualAgentDisposed: true, leaseReleasedAfterDispose: true }
  })
  console.log(JSON.stringify(result))
} finally { await root.fiber.dispose() }
