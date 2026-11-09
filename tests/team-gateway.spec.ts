/** The team gateway gives each Feishu person their own workspace and checks every send and read a workspace makes. */
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, machineOf, resolveFeishuBot } from '../src/deployment.ts'
import { SimulatedFeishu, type RawMessageEvent } from '../src/team/feishu.ts'
import { Gateway, isPublicRequest, type WorkspaceRuntime } from '../src/team/gateway.ts'
import { teamServer } from '../src/team/server.ts'
import { TeamStore, type Workspace } from '../src/team/store.ts'

const exec = promisify(execFile)
const TENANT = 'tenant_team'
const BOT = { openId: 'ou_bot', appId: 'cli_team', name: '团队助手', brand: 'feishu' as const }
const alice = { open: 'ou_alice', union: 'on_alice' }, bob = { open: 'ou_bob', union: 'on_bob' }
let counter = 0
function event(person: { open: string; union?: string }, text: string, chat: { id: string; type: 'p2p' | 'group' }, extra: {
  tenant?: string; mentions?: { key: string; name: string; id: { open_id?: string } }[]; senderType?: string; eventId?: string; messageId?: string } = {}): RawMessageEvent {
  counter++
  return { header: { event_id: extra.eventId ?? `ev_${counter}`, event_type: 'im.message.receive_v1', tenant_key: extra.tenant ?? TENANT },
    event: { sender: { sender_id: { open_id: person.open, ...person.union ? { union_id: person.union } : {} }, sender_type: extra.senderType ?? 'user', tenant_key: extra.tenant ?? TENANT },
      message: { message_id: extra.messageId ?? `om_m${counter}`, chat_id: chat.id, chat_type: chat.type, message_type: 'text', content: JSON.stringify({ text }),
        create_time: String(Date.parse('2026-11-09T02:00:00Z') + counter * 1000), mentions: extra.mentions ?? [] } } }
}
const dm = (person: { open: string }) => ({ id: 'oc_dm' + person.open.slice(3), type: 'p2p' as const })
const group = { id: 'oc_group', type: 'group' as const }
const mention = [{ key: '@_user_1', name: '团队助手', id: { open_id: BOT.openId } }]

function setup(options: { dailyLimit?: number; admit?: (person: { openId: string; unionId?: string }) => boolean } = {}) {
  const store = new TeamStore(':memory:'), feishu = new SimulatedFeishu(BOT)
  feishu.defineChat(group.id, '项目群', [{ openId: alice.open, name: 'Alice' }, { openId: bob.open, name: 'Bob' }])
  const started: string[] = []
  const runtime: WorkspaceRuntime = { ensure: async workspace => { started.push(workspace.id) } }
  const gateway = new Gateway({ store, feishu, runtime, tenantKey: TENANT, aliases: ['Shannon'], now: () => new Date('2026-11-09T02:00:00Z'), ...options })
  /** Feishu records the message, then delivers the event, as the simulation endpoint does. */
  const deliver = (raw: RawMessageEvent) => { feishu.observe(raw); return gateway.ingest(raw) }
  const ws = (person: { union: string }): Workspace => store.byUnion(person.union)!
  return { store, feishu, gateway, deliver, ws, started }
}

describe('admission and routing', () => {
  it('creates one workspace per union_id on first contact, welcomes the person and queues the compact event once', async () => {
    const { store, feishu, gateway, deliver, ws, started } = setup()
    const first = event(alice, '帮我整理一下周报', dm(alice))
    expect(await deliver(first)).toMatchObject({ outcome: 'routed', created: true })
    expect(await deliver(first)).toEqual({ outcome: 'duplicate', reason: 'already_seen' })
    expect(await deliver(event(alice, '再加一条', dm(alice)))).toMatchObject({ outcome: 'routed', created: false })
    expect(store.workspaces()).toHaveLength(1)
    expect(feishu.sent.filter(item => item.to.userId === alice.open && item.text.includes('单独开了一个工作区'))).toHaveLength(1)
    const events = await gateway.pull(ws(alice), undefined, 0)
    expect(events.map(item => JSON.parse(item.line))).toEqual([
      expect.objectContaining({ message_id: first.event.message.message_id, chat_type: 'p2p', sender_id: alice.open, sender_type: 'user', content: '帮我整理一下周报' }),
      expect.objectContaining({ content: '再加一条' })])
    expect(started).toEqual([ws(alice).id, ws(alice).id])
  })

  it('ignores other tenants, missing union_id, bots, unaddressed group chatter and people the allowlist rejects', async () => {
    const { store, deliver } = setup({ admit: person => person.unionId !== 'on_carol' })
    expect(await deliver(event(alice, 'hi', dm(alice), { tenant: 'tenant_other' }))).toEqual({ outcome: 'ignored', reason: 'external_tenant' })
    expect(await deliver(event({ open: 'ou_nounion' }, 'hi', dm({ open: 'ou_nounion' })))).toEqual({ outcome: 'ignored', reason: 'no_union_id' })
    expect(await deliver(event(alice, 'hi', dm(alice), { senderType: 'app' }))).toEqual({ outcome: 'ignored', reason: 'not_a_user' })
    expect(await deliver(event(alice, '今天中午吃什么', group))).toEqual({ outcome: 'ignored', reason: 'not_addressed' })
    expect(await deliver(event({ open: 'ou_carol', union: 'on_carol' }, 'hi', dm({ open: 'ou_carol' })))).toEqual({ outcome: 'ignored', reason: 'not_admitted' })
    expect(store.workspaces()).toEqual([])
  })

  it('routes a group message addressed by @ or by name to the sender, marks it mentioned and acknowledges with a reaction', async () => {
    const { feishu, gateway, deliver, ws } = setup()
    const named = event(alice, 'Shannon 总结一下今天的讨论', group)
    expect(await deliver(named)).toMatchObject({ outcome: 'routed' })
    expect(await deliver(event(bob, '@_user_1 查一下发布时间', group, { mentions: mention }))).toMatchObject({ outcome: 'routed' })
    const [line] = (await gateway.pull(ws(alice), undefined, 0)).map(item => JSON.parse(item.line) as { mentions: { id: string }[] })
    expect(line!.mentions.map(item => item.id)).toEqual([BOT.openId])
    expect(feishu.reactions.map(item => item.messageId)).toContain(named.event.message.message_id)
    expect(ws(alice).id).not.toBe(ws(bob).id)
  })

  it('declines messages beyond the daily limit and tells the person once', async () => {
    const { feishu, deliver } = setup({ dailyLimit: 1 })
    await deliver(event(alice, 'one', dm(alice)))
    expect(await deliver(event(alice, 'two', dm(alice)))).toMatchObject({ outcome: 'ignored', reason: 'quota' })
    expect(await deliver(event(alice, 'three', dm(alice)))).toMatchObject({ outcome: 'ignored', reason: 'quota' })
    expect(feishu.sent.filter(item => item.text.includes('上限'))).toHaveLength(1)
  })

  it('keeps redelivering events until the workspace acknowledges them, and stops routing a disabled workspace', async () => {
    const { gateway, deliver, ws } = setup()
    await deliver(event(alice, 'a', dm(alice))); await deliver(event(alice, 'b', dm(alice)))
    const [a, b] = await gateway.pull(ws(alice), undefined, 0)
    expect((await gateway.pull(ws(alice), undefined, 0)).map(item => item.seq)).toEqual([a!.seq, b!.seq])
    expect((await gateway.pull(ws(alice), a!.seq, 0)).map(item => item.seq)).toEqual([b!.seq])
    expect(await gateway.pull(ws(alice), b!.seq, 0)).toEqual([])
    gateway.disable(ws(alice).id)
    expect(await deliver(event(alice, 'c', dm(alice)))).toMatchObject({ outcome: 'ignored', reason: 'workspace_disabled' })
    expect((await gateway.cli(ws(alice), ['im', '+chat-list', '--as', 'bot', '--format', 'json'])).code).toBe(1)
  })
})

describe('sends and reads a workspace may make', () => {
  const reply = (messageId: string, text: string, key: string, thread = true) =>
    ['im', '+messages-reply', '--message-id', messageId, '--markdown', text, ...thread ? ['--reply-in-thread'] : [], '--idempotency-key', key, '--as', 'bot', '--format', 'json']

  it('answers DSH\'s own bot checks, so a workspace accepts the gateway CLI as its Feishu bot', async () => {
    const { gateway, deliver, ws } = setup()
    await deliver(event(alice, 'hi', dm(alice)))
    const run = (...argv: string[]) => gateway.cli(ws(alice), argv).then(result => result.stdout)
    expect(JSON.parse(await run('auth', 'status', '--verify'))).toMatchObject({ appId: BOT.appId, identities: { bot: { status: 'ready', verified: true } } })
    expect(await run('config', 'strict-mode')).toContain('strict-mode: bot')
    expect(JSON.parse(await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'))).toEqual({ bot: { open_id: BOT.openId, app_name: BOT.name } })
  })

  it('replies in a direct chat as asked and sends each idempotency key once', async () => {
    const { feishu, gateway, deliver, ws } = setup()
    const request = event(alice, '周报', dm(alice)); await deliver(request)
    const first = await gateway.cli(ws(alice), reply(request.event.message.message_id, '周报好了', 'k1', false))
    const again = await gateway.cli(ws(alice), reply(request.event.message.message_id, '周报好了（重试）', 'k1', false))
    expect(JSON.parse(first.stdout)).toEqual({ ok: true, data: { message_id: expect.stringMatching(/^om_sim/) } })
    expect(again.stdout).toBe(first.stdout)
    expect(feishu.sent.filter(item => item.to.replyTo === request.event.message.message_id)).toHaveLength(1)
  })

  it('answers a group request privately by default and posts to the group only when the request asks for it', async () => {
    const { feishu, gateway, deliver, ws, store } = setup()
    const quiet = event(alice, '@_user_1 帮我查一下上周的数据', group, { mentions: mention }); await deliver(quiet)
    await gateway.cli(ws(alice), reply(quiet.event.message.message_id, '上周数据：12 单', 'q1'))
    expect(feishu.sent.at(-1)).toMatchObject({ to: { userId: alice.open }, text: expect.stringContaining('上周数据：12 单') })
    expect(feishu.sent.at(-1)!.text).toContain('项目群')
    const loud = event(alice, '@_user_1 把发布时间发到群里', group, { mentions: mention }); await deliver(loud)
    await gateway.cli(ws(alice), reply(loud.event.message.message_id, '发布时间：周五', 'q2'))
    expect(feishu.sent.at(-1)).toMatchObject({ to: { replyTo: loud.event.message.message_id }, text: '发布时间：周五', inThread: true })
    // A standalone send to the group follows the latest request in it.
    await gateway.cli(ws(alice), ['im', '+messages-send', '--chat-id', group.id, '--markdown', '补充：周五 18:00', '--idempotency-key', 'q3'])
    expect(feishu.sent.at(-1)).toMatchObject({ to: { chatId: group.id } })
    expect(store.outbox(ws(alice).id).map(item => [item.key, item.decision, item.reason])).toEqual(expect.arrayContaining([
      ['q1', 'redirected', 'private_by_default'], ['q2', 'sent', 'public_request'], ['q3', 'sent', 'public_request']]))
  })

  it('refuses sends to other people, to chats the owner never used and to other workspaces\' messages', async () => {
    const { gateway, deliver, ws, feishu } = setup()
    await deliver(event(alice, 'hi', dm(alice)))
    const bobMessage = event(bob, 'bob 的私事', dm(bob)); await deliver(bobMessage)
    const before = feishu.sent.length
    const refused = async (argv: string[]) => {
      const result = await gateway.cli(ws(alice), argv)
      expect(result.code).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ ok: false })
    }
    await refused(['im', '+messages-send', '--user-id', bob.open, '--text', 'hi bob', '--idempotency-key', 'x1'])
    await refused(['im', '+messages-send', '--chat-id', dm(bob).id, '--text', 'hi', '--idempotency-key', 'x2'])
    await refused(['im', '+messages-send', '--chat-id', 'oc_unknown', '--text', 'hi', '--idempotency-key', 'x3'])
    await refused(reply(bobMessage.event.message.message_id, '我看到了', 'x4'))
    expect(feishu.sent.length).toBe(before)
  })

  it('reads only chats and messages the owner used with this workspace, and refuses every other command', async () => {
    const { gateway, deliver, ws } = setup()
    const mine = event(alice, '@_user_1 看下这个', group, { mentions: mention }); await deliver(mine)
    const theirs = event(bob, 'bob 的私聊', dm(bob)); await deliver(theirs)
    const data = async (argv: string[]) => (JSON.parse((await gateway.cli(ws(alice), argv)).stdout) as { data: unknown }).data
    expect(await data(['im', '+chat-list', '--page-all'])).toEqual({ chats: [{ chat_id: group.id, name: '项目群' }] })
    expect(await data(['im', '+messages-mget', '--message-ids', `${mine.event.message.message_id},${theirs.event.message.message_id}`]))
      .toEqual({ messages: [expect.objectContaining({ message_id: mine.event.message.message_id, content: '@_user_1 看下这个' })] })
    expect(await data(['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify({ container_id_type: 'chat', container_id: group.id })]))
      .toMatchObject({ items: [expect.objectContaining({ message_id: mine.event.message.message_id })], has_more: false })
    for (const argv of [['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify({ container_id_type: 'chat', container_id: dm(bob).id })],
      ['im', '+chat-members-list', '--chat-id', dm(bob).id], ['im', '+messages-delete', '--message-id', mine.event.message.message_id],
      ['api', 'POST', '/open-apis/im/v1/chats'], ['auth', 'login', '--scope', 'im:message']])
      expect((await gateway.cli(ws(alice), argv)).code).toBe(1)
  })

  it('treats only explicit wording as a request to post publicly', () => {
    for (const text of ['发到群里', '给大家同步一下', '把结论告诉大家', 'post it to the group']) expect(isPublicRequest(text)).toBe(true)
    for (const text of ['帮我总结群里的讨论', '群里有人问发布时间', '查一下数据']) expect(isPublicRequest(text)).toBe(false)
  })
})

describe('gateway server and the workspace CLI', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('authenticates each workspace by its token and lets DSH\'s Feishu checks and event stream work through the stand-in CLI', async () => {
    const { store, feishu, gateway } = setup()
    const tokens = new Map<string, string>()
    // Capture the issued token the way the process runtime writes it to the workspace's token file.
    const runtime: WorkspaceRuntime = { ensure: async (workspace, issue) => { if (!tokens.has(workspace.id)) tokens.set(workspace.id, issue()) } }
    const live = new Gateway({ store, feishu, runtime, tenantKey: TENANT })
    const server = teamServer({ gateway: live, store, adminToken: 'admin-token-for-tests-0123456789', simulation: feishu })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const dir = mkdtempSync(join(tmpdir(), 'team-gateway-')); dirs.push(dir)
    try {
      const request = event(alice, '你好', dm(alice))
      const injected = await fetch(url + '/sim/events', { method: 'POST', headers: { authorization: 'Bearer admin-token-for-tests-0123456789' }, body: JSON.stringify(request) })
      expect(await injected.json()).toMatchObject({ outcome: 'routed', created: true })
      expect((await fetch(url + '/sim/events', { method: 'POST', body: '{}' })).status).toBe(401)
      expect((await fetch(url + '/ws/events', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
      const [id, token] = [...tokens][0]!
      writeFileSync(join(dir, 'token'), token, { mode: 0o600 })
      const cli = join(dir, 'lark-bot')
      writeFileSync(cli, `#!/bin/sh\nexport LOOM_TEAM_GATEWAY='${url}'\nexport LOOM_TEAM_TOKEN_FILE='${join(dir, 'token')}'\nexec '${process.execPath}' --experimental-strip-types --no-warnings '${resolve('src/team/shim.ts')}' "$@"\n`)
      chmodSync(cli, 0o700)
      const bot = await resolveFeishuBot(machineOf(Config({ stateDir: join(dir, 'state') })), { cli }, async argv => (await exec(argv[0]!, argv.slice(1))).stdout)
      expect(bot).toEqual({ cli, appId: BOT.appId, brand: 'feishu', botId: BOT.openId, name: BOT.name })
      const consumer = spawn(cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], { stdio: ['pipe', 'pipe', 'pipe'] })
      const first = await new Promise<string>(done => createInterface({ input: consumer.stdout }).once('line', done))
      expect(JSON.parse(first)).toMatchObject({ message_id: request.event.message.message_id, content: '你好' })
      consumer.stdin.end(); consumer.kill('SIGTERM')
      const { stdout } = await exec(cli, ['im', '+messages-reply', '--message-id', request.event.message.message_id, '--text', '你好呀', '--idempotency-key', 'hello', '--as', 'bot', '--format', 'json'])
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { message_id: expect.any(String) } })
      expect(feishu.sent.at(-1)).toMatchObject({ to: { replyTo: request.event.message.message_id }, text: '你好呀' })
      await expect(exec(cli, ['im', '+messages-send', '--user-id', bob.open, '--text', 'x', '--as', 'bot', '--format', 'json'])).rejects.toMatchObject({ code: 1 })
      expect(id).toBe(store.byUnion(alice.union)!.id)
    } finally { await new Promise(done => server.close(done)) }
  }, 30_000)
})

describe('real Feishu through the bot CLI', () => {
  const compact = (open: string, text: string, chat: { id: string; type: 'p2p' | 'group' }, id: string, mentions: { id: string; key: string; name: string }[] = []) =>
    ({ message_id: id, chat_id: chat.id, chat_type: chat.type, sender_id: open, sender_type: 'user', content: text, create_time: String(Date.now()), mentions, event_id: 'ev_' + id })

  it('keys CLI events by open_id and refuses them entirely unless an allowlist keeps external contacts out', async () => {
    const open = setup()
    expect(await open.gateway.ingestCompact(compact(alice.open, 'hi', dm(alice), 'om_c1'))).toEqual({ outcome: 'ignored', reason: 'tenant_unknown' })
    const listed = setup({ admit: person => person.openId === alice.open })
    expect(await listed.gateway.ingestCompact(compact(alice.open, 'hi', dm(alice), 'om_c2'))).toMatchObject({ outcome: 'routed', created: true })
    expect(await listed.gateway.ingestCompact(compact(alice.open, 'hi', dm(alice), 'om_c2'))).toMatchObject({ outcome: 'duplicate' })
    expect(await listed.gateway.ingestCompact(compact(bob.open, 'Shannon hi', group, 'om_c3'))).toEqual({ outcome: 'ignored', reason: 'not_admitted' })
    expect(listed.store.byUnion('open:' + alice.open)).toMatchObject({ openId: alice.open, tenantKey: '' })
    expect(await listed.gateway.ingestCompact({ message_id: 'bad' })).toEqual({ outcome: 'rejected', reason: 'invalid_event' })
  })

  it('drives sends, reactions and reads through the bot CLI with strict bot identity and JSON output', async () => {
    const { LarkFeishu, larkRunner, larkBot } = await import('../src/team/lark.ts')
    const dir = mkdtempSync(join(tmpdir(), 'team-lark-'))
    try {
      const calls = join(dir, 'calls.log'), cli = join(dir, 'lark-cli')
      writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$1 $2" in\n`
        + `"auth status") echo '{"appId":"cli_team","brand":"feishu","identities":{"bot":{"status":"ready","verified":true}}}';;\n`
        + `"config strict-mode") echo 'strict-mode: bot';;\n`
        + `"api GET") case "$3" in /open-apis/bot/v3/info) echo '{"bot":{"open_id":"ou_bot","app_name":"Shannon"}}';; /open-apis/im/v1/chats/*) echo '{"ok":true,"data":{"name":"项目群"}}';; *) echo '{"ok":true,"data":{"items":[]}}';; esac;;\n`
        + `"api POST") echo '{"ok":true,"data":{}}';;\n`
        + `"im +messages-send") echo '{"ok":true,"data":{"message_id":"om_out1"}}';;\n`
        + `"im +messages-reply") echo '{"ok":false,"error":{"message":"no permission","code":230027}}'; exit 1;;\n`
        + `*) echo '{"ok":true,"data":{}}';;\nesac\n`)
      chmodSync(cli, 0o700)
      const bot = await larkBot(cli)
      expect(bot).toEqual({ openId: 'ou_bot', appId: 'cli_team', name: 'Shannon', brand: 'feishu' })
      const port = new LarkFeishu(bot, larkRunner(cli))
      expect(await port.sendToUser(alice.open, { text: '你好' }, 'k1')).toBe('om_out1')
      await expect(port.reply('om_x', { text: '回复' }, 'k2', true)).rejects.toThrow('no permission (230027)')
      await port.react('om_x', 'OK')
      expect(await port.chatName(group.id)).toBe('项目群')
      expect(await port.messages([])).toEqual([])
      const log = (await import('node:fs')).readFileSync(calls, 'utf8')
      expect(log).toContain(`im +messages-send --user-id ${alice.open} --markdown 你好 --idempotency-key k1 --as bot --format json`)
      expect(log).toContain('im +messages-reply --message-id om_x --markdown 回复 --reply-in-thread --idempotency-key k2 --as bot --format json')
      expect(log).toContain('api POST /open-apis/im/v1/messages/om_x/reactions --data {"reaction_type":{"emoji_type":"OK"}} --as bot --format json')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('container isolation', () => {
  it('runs a workspace with no capabilities, a read-only root, limits, read-only host paths and only its own directory writable', async () => {
    const { dockerRunArgs } = await import('../src/team/workspaces.ts')
    const args = dockerRunArgs({ image: 'loom-workspace:0.1', mounts: ['/opt/dsh', '/opt/loom'], dshEntry: '/opt/dsh/bin.js', gatewayURL: 'http://172.17.0.1:7431', user: '1001:1001' },
      { name: 'loom-ws_a', directory: '/data/workspaces/ws_a', envFile: '/data/workspaces/ws_a/.container.env', command: ['node', '/opt/dsh/bin.js'] })
    const pairs = (flag: string) => args.flatMap((item, index) => item === flag ? [args[index + 1]] : [])
    expect(pairs('--cap-drop')).toEqual(['ALL'])
    expect(pairs('--security-opt')).toEqual(['no-new-privileges'])
    expect(args).toContain('--read-only')
    expect(pairs('-v')).toEqual(['/opt/dsh:/opt/dsh:ro', '/opt/loom:/opt/loom:ro', '/data/workspaces/ws_a:/data/workspaces/ws_a:rw'])
    expect(pairs('--user')).toEqual(['1001:1001'])
    expect(pairs('--memory').length && pairs('--pids-limit').length && pairs('--cpus').length).toBeTruthy()
    expect(args.slice(-3)).toEqual(['loom-workspace:0.1', 'node', '/opt/dsh/bin.js'])
  })

  it('proxies model calls with the real key for a valid workspace token, and serves only workspace endpoints on the bridge listener', async () => {
    const { store, feishu, gateway } = setup()
    const tokens: string[] = []
    const live = new Gateway({ store, feishu, runtime: { ensure: async (_workspace, issue) => { tokens.push(issue()) } }, tenantKey: TENANT })
    await live.ingest(event(alice, 'hi', dm(alice)))
    const { createServer } = await import('node:http')
    const seen: { auth?: string; path?: string; body?: string }[] = []
    const upstream = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => {
        seen.push({ auth: request.headers.authorization, path: request.url, body })
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"choices":[{"message":{"content":"ok"}}]}')
      })
    })
    await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
    const model = { baseURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, apiKey: 'real-model-key' }
    const bridge = teamServer({ gateway: live, store, adminToken: 'admin-token-for-tests-0123456789', workspaceOnly: true, model })
    await new Promise<void>(done => bridge.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`
    try {
      const ok = await fetch(url + '/ws/model/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json' }, body: '{"model":"m"}' })
      expect(ok.status).toBe(200)
      expect(seen).toEqual([{ auth: 'Bearer real-model-key', path: '/v1/chat/completions', body: '{"model":"m"}' }])
      expect((await fetch(url + '/ws/model/chat/completions', { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401)
      expect((await fetch(url + '/ws/model/files', { method: 'POST', headers: { authorization: `Bearer ${tokens[0]}` }, body: '{}' })).status).toBe(404)
      expect((await fetch(url + '/admin/workspaces', { headers: { authorization: 'Bearer admin-token-for-tests-0123456789' } })).status).toBe(404)
      expect(seen).toHaveLength(1)
      expect(gateway).toBeDefined()
    } finally { await new Promise(done => bridge.close(done)); await new Promise(done => upstream.close(done)) }
  })
})
