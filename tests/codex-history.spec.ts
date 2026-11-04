/** Local-only history integration; protocol responses are synthetic and never run a Codex turn. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, MEMBER, type Host } from './fixtures/host.ts'
import * as rpc from '../src/app/codex-rpc.ts'
import { KV } from '../src/kv.ts'

let h: Host
const DAY = '2026-11-04', FROM = Date.parse(DAY + 'T00:00:00+08:00'), TO = FROM + 86400_000
const ID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
const meta = (id = ID) => ({ id, name: '原生会话标题', cwd: '/local/project', createdAt: FROM / 1000 - 86400, updatedAt: FROM / 1000 + 3600, source: 'vscode',
  path: '/private/history', preview: '昨日的原始问题，不应作为今天的预览', parentThreadId: null, ephemeral: false })
const entry = (id: string, type: string, at: number | null, extra: Record<string, unknown> = {}) => ({ turnId: 'turn-1', startedAtMs: at, completedAtMs: at,
  item: { id, type, ...extra } })
let call: ReturnType<typeof vi.fn<rpc.CodexReader['call']>>
beforeEach(async () => {
  h = await startRuntime(undefined, { github: false })
  const s = h.runtime.store.settings(), source = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...source, config: { ...source.config, ownerOnly: true } } } })
  call = vi.fn(async (method, params) => method === 'thread/read' ? { thread: meta(String(params.threadId)) }
    : { data: method === 'thread/list' && !params.archived ? [meta()] : [], nextCursor: null })
  vi.spyOn(rpc, 'withCodexReader').mockImplementation(async (_signal, run) => run({ call }))
})
afterEach(async () => { await h.stop() })
const enable = () => h.api('PUT', 'loom/codex/access', { enabled: true, date: DAY, revision: 0 })
const history = (id = ID, query = '') => h.api('GET', `loom/codex/sessions/${id}?date=${DAY}${query}`)

it('requires a persistent owner/day grant, validates dates and parameters and exposes no generic RPC or execution route', async () => {
  expect(await h.api('GET', 'loom/codex/access')).toMatchObject({ status: 200, body: { enabled: false, revision: 0 } })
  expect(await h.api('GET', 'loom/codex/sessions?date=' + DAY)).toMatchObject({ status: 409 })
  expect(call).not.toHaveBeenCalled()
  expect(await h.api('PUT', 'loom/codex/access', { enabled: true, date: '2026-02-30', revision: 0 })).toMatchObject({ status: 400 })
  expect(await h.api('PUT', 'loom/codex/access', { enabled: true, date: DAY, revision: 0, owner: 'ou_intruder' })).toMatchObject({ status: 400 })
  expect(await enable()).toMatchObject({ status: 200, body: { enabled: true, date: DAY, revision: 1 } })
  expect(h.runtime.store.get(KV.codexHistory.access(MEMBER))).toMatchObject({ owner: MEMBER, date: DAY, enabled: true })
  expect(await h.api('PUT', 'loom/codex/access', { enabled: false, date: DAY, revision: 0 })).toMatchObject({ status: 409 })
  expect(await h.api('GET', 'loom/codex/sessions?date=2026-11-03')).toMatchObject({ status: 409 })
  expect(await history('../private')).toMatchObject({ status: 404 })
  expect(await h.api('POST', 'loom/codex/turn/start', { threadId: ID })).toMatchObject({ status: 404 })
  expect(await h.api('GET', `loom/codex/sessions/${ID}?date=${DAY}&path=/private`)).toMatchObject({ status: 400 })
})

it('paginates current and archived metadata, includes older-created active sessions, and excludes subagents, automated threads and previews', async () => {
  await enable()
  call.mockImplementation(async (method, params) => {
    expect(method).toBe('thread/list')
    expect(params).toMatchObject({ modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer', 'unknown'], useStateDbOnly: true, sortKey: 'updated_at' })
    if (params.archived) return { data: [{ ...meta(OTHER), name: '已归档会话' }], nextCursor: null }
    if (!params.cursor) return { data: [meta(), { ...meta(OTHER), source: 'exec' }], nextCursor: 'next-page' }
    return { data: [meta(), { ...meta(OTHER), parentThreadId: ID }, { ...meta(OTHER), updatedAt: FROM / 1000 - 1 }], nextCursor: null }
  })
  const response = await h.api('GET', 'loom/codex/sessions?date=' + DAY)
  expect(response).toMatchObject({ status: 200, body: { timezone: 'Asia/Shanghai', sessions: [expect.objectContaining({ id: ID, title: '原生会话标题', archived: false }),
    expect.objectContaining({ id: OTHER, title: '已归档会话', archived: true })], truncated: false } })
  expect(JSON.stringify(response.body)).not.toMatch(/昨日的原始问题|private\/history|preview|parentThreadId/)
  expect(call).toHaveBeenCalledTimes(3)
})

it('filters exact Shanghai-day messages, strips supplied context and suppresses reasoning, tools, images and out-of-day text', async () => {
  await enable()
  call.mockImplementation(async (method, params) => {
    if (method === 'thread/read') { expect(params).toEqual({ threadId: ID, includeTurns: false }); return { thread: meta() } }
    return { data: [
      entry('yesterday', 'userMessage', FROM - 1, { content: [{ type: 'text', text: 'yesterday-canary' }] }),
      entry('boundary', 'userMessage', FROM, { content: [{ type: 'text', text: '<in-app-browser-context>hidden-context</in-app-browser-context>\n## My request:\n今日问题' }, { type: 'image', url: 'data:image/png;base64,attachment-canary' }] }),
      entry('commentary', 'agentMessage', FROM + 1, { phase: 'commentary', text: '正在处理' }),
      entry('final', 'agentMessage', TO - 1, { phase: 'final_answer', text: '今日答复' }),
      entry('final', 'agentMessage', TO - 1, { phase: 'final_answer', text: '重复项' }),
      entry('tomorrow', 'agentMessage', TO, { text: 'tomorrow-canary' }),
      entry('reason', 'reasoning', FROM + 2, { content: ['reasoning-canary'] }),
      entry('analysis', 'agentMessage', FROM + 3, { phase: 'analysis', text: 'analysis-canary' }),
      entry('tool', 'commandExecution', FROM + 4, { command: 'secret-command-canary', aggregatedOutput: 'secret-output-canary' }),
      entry('no-time', 'agentMessage', null, { text: 'undated-canary' }),
      entry('env', 'userMessage', FROM + 5, { content: [{ type: 'text', text: '<environment_context>environment-canary</environment_context>' }] }),
    ], nextCursor: null }
  })
  const response = await history()
  expect(response).toMatchObject({ status: 200, body: { messages: [expect.objectContaining({ id: 'boundary', text: '今日问题', role: 'user', omittedAttachments: true }),
    expect.objectContaining({ text: '正在处理', role: 'assistant' }), expect.objectContaining({ text: '今日答复', role: 'assistant' })], skippedUndated: 1, nextCursor: null } })
  expect(JSON.stringify(response.body)).not.toMatch(/canary|重复项|hidden-context/)
})

it('pages past execution-only records, preserves every message at a native page boundary and binds cursors to the requested thread', async () => {
  await enable()
  call.mockImplementation(async (method, params) => {
    expect(params.threadId).toBe(ID)
    if (method === 'thread/read') return { thread: meta() }
    if (!params.cursor) return { data: [entry('tool1', 'reasoning', FROM + 1000)], nextCursor: 'text-page' }
    if (params.cursor === 'text-page') return { data: Array.from({ length: 20 }, (_, i) => entry('m' + i, 'agentMessage', FROM + 100 + i, { text: '消息 ' + i })), nextCursor: 'older-page' }
    return { data: [entry('oldest', 'userMessage', FROM + 10, { content: [{ type: 'text', text: '最早的问题' }] })], nextCursor: null }
  })
  const first = await history()
  expect(first).toMatchObject({ status: 200, body: { messages: expect.any(Array), nextCursor: 'older-page' } })
  expect((first.body.messages as unknown[]).length).toBe(20)
  expect(await history(ID, '&cursor=older-page')).toMatchObject({ status: 200, body: { messages: [expect.objectContaining({ id: 'oldest' })], nextCursor: null } })
})

it('withdraws data across an asynchronous permission revocation without persisting the conversation or touching tasks', async () => {
  await enable()
  const baseline = { tickets: h.runtime.store.tickets.list(), settings: h.runtime.store.settings(), keys: h.runtime.store.keys(KV.artifacts.version) }
  const gate = Promise.withResolvers<unknown>(); let waiting = false
  call.mockImplementation(async method => {
    if (method === 'thread/read') return { thread: meta() }
    waiting = true; return gate.promise
  })
  const reading = history()
  await vi.waitFor(() => expect(waiting).toBe(true))
  expect(await h.api('PUT', 'loom/codex/access', { enabled: false, date: DAY, revision: 1 })).toMatchObject({ status: 200 })
  gate.resolve({ data: [entry('private', 'agentMessage', FROM + 1, { text: 'revoked-private-canary' })], nextCursor: null })
  const result = await reading
  expect(result.status).toBe(409); expect(JSON.stringify(result.body)).not.toContain('revoked-private-canary')
  expect(await history()).toMatchObject({ status: 409 })
  expect({ tickets: h.runtime.store.tickets.list(), settings: h.runtime.store.settings(), keys: h.runtime.store.keys(KV.artifacts.version) }).toEqual(baseline)
  expect(h.runtime.store.db.prepare('SELECT value FROM kv WHERE value LIKE ?').all('%revoked-private-canary%')).toEqual([])
})

it('rechecks the Loom owner after reading and refuses non-personal deployments and non-interactive thread ids', async () => {
  await enable()
  call.mockImplementation(async method => method === 'thread/read' ? { thread: { ...meta(), parentThreadId: OTHER } } : { data: [], nextCursor: null })
  expect(await history()).toMatchObject({ status: 409 })
  call.mockImplementation(async method => {
    const s = h.runtime.store.settings(), part = s.policy.sources.feishu!
    h.runtime.store.saveSettings({ ...s, policy: { ...s.policy, sources: { ...s.policy.sources, feishu: { ...part, allowed: [{ id: 'ou_new', name: 'Other' }] } } } })
    return method === 'thread/list' ? { data: [], nextCursor: null } : { thread: meta() }
  })
  expect(await h.api('GET', 'loom/codex/sessions?date=' + DAY)).toMatchObject({ status: 404 })
  expect(await h.api('GET', 'loom/codex/access')).toMatchObject({ status: 200, body: { enabled: false } })
  const s = h.runtime.store.settings(), part = s.sources.feishu!
  h.runtime.store.saveSettings({ ...s, sources: { ...s.sources, feishu: { ...part, config: { ...part.config, ownerOnly: false } } } })
  expect(await h.api('GET', 'loom/codex/access')).toMatchObject({ status: 503 })
})

it('bounds repeated cursors and oversized user messages with explicit completeness notices', async () => {
  await enable()
  call.mockImplementation(async method => method === 'thread/read' ? { thread: meta() } : {
    data: [entry('long', 'agentMessage', FROM + 1, { text: 'x'.repeat(40_001) })], nextCursor: 'loop' })
  const result = await history()
  expect(result).toMatchObject({ status: 200, body: { limited: true, messages: [expect.objectContaining({ truncated: true })], nextCursor: 'loop' } })
  expect((result.body.messages as { text: string }[])[0]?.text).toHaveLength(40_000)
  expect(call).toHaveBeenCalledTimes(3)
})

it('collects a separate recurring-grant snapshot with exact project scope, source references and no implicit day-view authorization', async () => {
  const other = { ...meta(OTHER), cwd: '/local/project/subdirectory' }
  call.mockImplementation(async (method, params) => {
    if (method === 'thread/list') return { data: params.archived ? [] : [meta(), other], nextCursor: null }
    expect(params.threadId).toBe(ID)
    if (method === 'thread/read') return { thread: meta() }
    if (!params.cursor) return { data: Array.from({length:16},(_,i)=>entry('m'+i,'agentMessage',FROM+100+i,{text:'今天的事实 '+i})), nextCursor:'older' }
    return { data: [entry('oldest','userMessage',FROM,{content:[{type:'text',text:'今天开始'}]}),
      entry('tool','commandExecution',FROM+1,{command:'tool-canary'}),entry('reason','reasoning',FROM+2,{text:'reason-canary'}),
      entry('yesterday','agentMessage',FROM-1,{text:'yesterday-canary'}),entry('undated','agentMessage',null,{text:'undated-canary'})], nextCursor:null }
  })
  const scope = {projects:['/local/project'],sessions:[],time:'18:00',timezone:'Asia/Shanghai' as const,delivery:'none' as const}
  const result = await h.runtime.codexHistory.daily(DAY,scope,()=>{})
  expect(result).toMatchObject({messages:17,sessions:1,warnings:expect.arrayContaining([expect.stringContaining('无原生时间')])})
  const payload=JSON.parse(result.text)
  expect(payload.sessions[0].messages[0]).toMatchObject({ref:'S1-M1',text:'今天开始'})
  expect(result.text).not.toMatch(/canary|subdirectory/)
  expect(h.runtime.codexHistory.access(MEMBER).enabled).toBe(false)
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('rechecks selected project metadata before reading message items and rejects recurring scope revocation across RPCs', async () => {
  const scope={projects:['/local/project'],sessions:[],time:'18:00',timezone:'Asia/Shanghai' as const,delivery:'none' as const}
  call.mockImplementation(async method=>method==='thread/list'?{data:[meta()],nextCursor:null}:{thread:{...meta(),cwd:'/private/unselected'}})
  await expect(h.runtime.codexHistory.daily(DAY,scope,()=>{})).rejects.toThrow('移出委托')
  expect(call.mock.calls.map(([method])=>method)).not.toContain('thread/items/list')
  let allowed=true
  call.mockImplementation(async method=>{allowed=false;return {data:[],nextCursor:null}})
  await expect(h.runtime.codexHistory.daily(DAY,scope,()=>{if(!allowed)throw new Error('revoked')})).rejects.toThrow('revoked')
})
