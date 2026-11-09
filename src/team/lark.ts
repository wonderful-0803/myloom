/**
 * The gateway's real Feishu port, driven through the bot's own `lark-cli` wrapper (strict bot identity). Only the gateway runs
 * this CLI; workspaces get the credential-free shim instead.
 */
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { FeishuPort, HistoryMessage, Outgoing } from './feishu.ts'

const exec = promisify(execFile)
const ENV = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
const body = (message: Outgoing): string[] => {
  const note = message.file ? `\n\n（附件「${message.file.name}」暂未随原型上传）` : ''
  return ['--markdown', (message.text || (message.file ? `附件「${message.file.name}」` : '')) + note]
}

/** Runs one CLI call with `--as bot --format json` and returns its `data`, throwing the CLI's own error message on failure. */
export type LarkRun = (args: string[]) => Promise<unknown>
export function larkRunner(cli: string): LarkRun {
  return async args => {
    let stdout: string
    try { stdout = (await exec(cli, [...args, '--as', 'bot', '--format', 'json'], { env: ENV, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout }
    catch (error) { stdout = String((error as { stdout?: unknown }).stdout ?? ''); if (!stdout) throw error }
    const result = JSON.parse(stdout) as { ok?: boolean; data?: unknown; error?: { message?: string; code?: number } }
    if (!result.ok) throw new Error(`${result.error?.message ?? 'Feishu command failed'}${result.error?.code ? ` (${result.error.code})` : ''}`)
    return result.data
  }
}

/** Reads the bot's identity the way DSH's setup does: strict bot mode, a verified bot, and its open_id. */
export async function larkBot(cli: string): Promise<FeishuPort['bot']> {
  const run = async (...args: string[]) => (await exec(cli, args, { env: ENV, timeout: 30_000 })).stdout
  const status = JSON.parse((await run('auth', 'status', '--verify')).replace(/^[^{]*/, '')) as { appId: string; brand?: 'feishu' | 'lark'; identities: { bot: { status: string; verified?: boolean } } }
  if (status.identities.bot.status !== 'ready' || status.identities.bot.verified !== true) throw new Error('The Feishu bot is not ready')
  if (!/strict-mode:\s*bot/.test(await run('config', 'strict-mode'))) throw new Error('The gateway CLI must be in strict bot mode')
  const info = JSON.parse((await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0]!) as { bot: { open_id: string; app_name?: string } }
  return { openId: info.bot.open_id, appId: status.appId, name: info.bot.app_name ?? '', brand: status.brand ?? 'feishu' }
}

/** Feishu through the bot CLI; every call runs with strict bot identity and JSON output. */
export class LarkFeishu implements FeishuPort {
  private readonly names = new Map<string, string>()
  constructor(readonly bot: FeishuPort['bot'], private readonly run: LarkRun) {}
  private async id(args: string[]): Promise<string> {
    const data = await this.run(args) as { message_id?: string }
    if (!data?.message_id) throw new Error('Feishu returned no message_id')
    return data.message_id
  }
  sendToUser(openId: string, message: Outgoing, key: string): Promise<string> {
    return this.id(['im', '+messages-send', '--user-id', openId, ...body(message), '--idempotency-key', key])
  }
  sendCard(openId: string, card: Record<string, unknown>, key: string): Promise<string> {
    return this.id(['im', '+messages-send', '--user-id', openId, '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', key])
  }
  sendToChat(chatId: string, message: Outgoing, key: string): Promise<string> {
    return this.id(['im', '+messages-send', '--chat-id', chatId, ...body(message), '--idempotency-key', key])
  }
  reply(messageId: string, message: Outgoing, key: string, inThread: boolean): Promise<string> {
    return this.id(['im', '+messages-reply', '--message-id', messageId, ...body(message), ...inThread ? ['--reply-in-thread'] : [], '--idempotency-key', key])
  }
  async react(messageId: string, emoji: string): Promise<void> {
    await this.run(['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reactions`, '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } })])
  }
  async chatName(chatId: string): Promise<string> {
    if (!this.names.has(chatId)) {
      const data = await this.run(['api', 'GET', `/open-apis/im/v1/chats/${chatId}`]) as { name?: string }
      this.names.set(chatId, data?.name ?? chatId)
    }
    return this.names.get(chatId)!
  }
  async members(chatId: string): Promise<{ member_id: string; name: string }[]> {
    const data = await this.run(['im', '+chat-members-list', '--chat-id', chatId, '--member-types', 'user', '--page-all', '--page-limit', '0']) as { users?: { member_id: string; name: string }[] }
    return data?.users ?? []
  }
  async history(chatId: string, range: { start?: number; end?: number }): Promise<HistoryMessage[]> {
    const params = { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeAsc', page_size: 50,
      ...range.start !== undefined ? { start_time: String(range.start) } : {}, ...range.end !== undefined ? { end_time: String(range.end) } : {} }
    const data = await this.run(['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(params)]) as { items?: HistoryMessage[] }
    return data?.items ?? []
  }
  async messages(ids: string[]): Promise<HistoryMessage[]> {
    if (!ids.length) return []
    const data = await this.run(['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', JSON.stringify({ message_ids: ids })]) as { items?: HistoryMessage[] }
    return data?.items ?? []
  }
}

/** Streams one kind of the bot's events (messages by default) into `receive` until `signal` aborts, restarting the consumer with backoff. */
export async function consumeLark(cli: string, receive: (line: unknown) => Promise<unknown>, log: (line: string) => void, signal: AbortSignal, eventKey = 'im.message.receive_v1'): Promise<void> {
  let retry = 1000
  while (!signal.aborted) {
    const began = Date.now()
    const child = spawn(cli, ['event', 'consume', eventKey, '--as', 'bot'], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
    const stop = () => { child.stdin.end(); child.kill('SIGTERM') }
    signal.addEventListener('abort', stop, { once: true })
    let chain = Promise.resolve()
    createInterface({ input: child.stderr }).on('line', line => { if (/ready|error|WARN|drop/.test(line)) log(`feishu ${eventKey}: ${line.slice(0, 300)}`) })
    createInterface({ input: child.stdout }).on('line', line => {
      chain = chain.then(async () => { await receive(JSON.parse(line)) }).catch(error => log(`feishu: event failed: ${String(error).slice(0, 300)}`))
    })
    const code = await new Promise<number | null>(resolve => { child.once('close', resolve); child.once('error', () => resolve(-1)) })
    signal.removeEventListener('abort', stop)
    await chain
    if (signal.aborted) return
    retry = Date.now() - began > 60_000 ? 1000 : Math.min(retry * 2, 60_000)
    log(`feishu ${eventKey}: event consumer exited (${code}); restarting in ${retry / 1000}s`)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
