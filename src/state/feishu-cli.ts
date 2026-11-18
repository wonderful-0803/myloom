/** Bot-only CLI transport. Implements the documented lark-event ready marker and finite, gracefully stopped watches. */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { FeishuBot } from '../deployment.ts'
import { commandArgv } from '../infra/process.ts'
import type { FeishuWire } from './feishu.ts'
import type { DeliveryTransport } from './outbox.ts'
import type { ProductAccess } from './access.ts'
import { hash } from './hash.ts'

const exec = promisify(execFile)
/** Uses an independently verified strict-bot executable; no user profile fallback or automatic permission escalation. */
export class CliFeishuWire implements FeishuWire {
  constructor(private bot: FeishuBot, private environment: Record<string, string> = {}) {}
  private async raw(args: string[], signal: AbortSignal, cwd?: string): Promise<string> {
    signal.throwIfAborted()
    const [program, ...argv] = commandArgv(this.bot.cli, args)
    let stdout: string
    try {
      const result = await exec(program!, argv, { signal, cwd, timeout: 60_000, maxBuffer: 4_000_000, windowsHide: true,
        env: { ...process.env, ...this.environment, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      stdout = result.stdout
    } catch { throw new Error('Feishu CLI request failed; check the service connection and scopes') }
    return stdout
  }
  async verify(signal: AbortSignal): Promise<void> {
    const status = z.object({ appId: z.string(), identities: z.object({ bot: z.object({ status: z.literal('ready'), verified: z.literal(true) }) }) }).safeParse(JSON.parse(await this.raw(['auth', 'status', '--verify', '--json'], signal)))
    if (!status.success || status.data.appId !== this.bot.appId) throw new Error('Feishu CLI installation identity mismatch')
    if (!/strict-mode:\s*bot\b/.test(await this.raw(['config', 'strict-mode'], signal))) throw new Error('Company CLI must use strict bot mode')
    const info = z.object({ bot: z.object({ open_id: z.string() }) }).parse(JSON.parse((await this.raw(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'], signal)).split('\n')[0]!))
    if (info.bot.open_id !== this.bot.botId) throw new Error('Feishu bot differs from installed mapping')
  }
  async lark<T>(args: string[], signal: AbortSignal): Promise<T> {
    const stdout = await this.raw([...args, '--as', 'bot', '--format', 'json'], signal)
    const result = z.object({ ok: z.literal(true), data: z.unknown() }).safeParse(JSON.parse(stdout))
    if (!result.success) throw new Error('Feishu CLI did not return a success receipt')
    return result.data.data as T
  }
  async download(messageId: string, fileKey: string, folder: string, signal: AbortSignal): Promise<string> {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId) || !/^file_[A-Za-z0-9_-]+$/.test(fileKey)) throw new Error('Invalid recording resource identity')
    const result = z.object({ ok: z.literal(true), data: z.object({ saved_path: z.string() }) }).parse(JSON.parse(await this.raw(['im', '+messages-resources-download', '--message-id', messageId, '--file-key', fileKey, '--type', 'file', '--output', './recording.audio', '--as', 'bot', '--format', 'json'], signal, folder)))
    return result.data.saved_path
  }
  async file(target: { messageId?: string; userId?: string; threaded: boolean }, filename: string, bytes: Uint8Array, requestId: string, signal: AbortSignal): Promise<string> {
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _().-]{0,100}\.(docx|md|txt)$/iu.test(filename)) throw new Error('Invalid attachment filename')
    const folder = await mkdtemp(join(tmpdir(), 'loom-result-'))
    try {
      await writeFile(join(folder, filename), bytes, { flag: 'wx', mode: 0o600 })
      const args = target.messageId ? ['im', '+messages-reply', '--message-id', target.messageId] : ['im', '+messages-send', '--user-id', target.userId!]
      if (target.threaded) args.push('--reply-in-thread')
      args.push('--file', `./${filename}`, '--idempotency-key', requestId, '--as', 'bot', '--format', 'json')
      const result = z.object({ ok: z.literal(true), data: z.object({ message_id: z.string().min(1) }) }).parse(JSON.parse(await this.raw(args, signal, folder)))
      return result.data.message_id
    } finally { await rm(folder, { recursive: true, force: true }) }
  }
  async *events(signal: AbortSignal, onReady?: () => void): AsyncIterable<unknown> {
    signal.throwIfAborted()
    const [program, ...argv] = commandArgv(this.bot.cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--timeout', '60s'])
    const child = spawn(program!, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...this.environment, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
    let ready = false, stderr = '', error: Error | undefined
    const exit = new Promise<number | null>(resolve => { child.once('error', () => { error = new Error('Feishu consumer could not start'); resolve(null) }); child.once('close', resolve) })
    let resolveReady!: () => void, rejectReady!: (error: Error) => void
    const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const stop = () => { child.stdin.end(); child.kill('SIGTERM') }
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => { rejectReady(new Error('Feishu consumer readiness timeout')); stop() }, 45_000)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 16_384) { error = new Error('Feishu consumer diagnostic overflow'); stop(); return }
      let newline: number
      while ((newline = stderr.indexOf('\n')) >= 0) {
        const line = stderr.slice(0, newline).trim(); stderr = stderr.slice(newline + 1)
        if (line === '[event] ready event_key=im.message.receive_v1') { ready = true; clearTimeout(timer); resolveReady() }
        else if (line.startsWith('{')) {
          try { if ((JSON.parse(line) as { ok?: boolean }).ok === false) { error = new Error('Feishu event subscription or authorization failed'); stop() } } catch { error = new Error('Feishu consumer diagnostic could not be parsed'); stop() }
        } else if (/WARN|drop|error/i.test(line)) { error = new Error('Feishu consumer reported possible event loss'); stop() }
      }
    })
    void exit.then(() => { if (!ready) rejectReady(error ?? new Error('Feishu consumer exited before readiness')) })
    try {
      await readiness
      onReady?.()
      let buffer = ''; const decoder = new StringDecoder('utf8')
      for await (const chunk of child.stdout) {
        buffer += decoder.write(Buffer.from(chunk))
        if (buffer.length > 1_048_576) throw new Error('Feishu event exceeds 1 MiB')
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          if (line.trim()) { signal.throwIfAborted(); yield JSON.parse(line) as unknown }
        }
      }
      buffer += decoder.end(); if (buffer.trim()) throw new Error('Feishu event stream ended with an incomplete record')
      const code = await exit
      if (!signal.aborted && (code !== 0 || error)) throw error ?? new Error('Feishu consumer failed')
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); stop(); await exit }
  }
}
export function feishuDelivery(access: ProductAccess, wire: FeishuWire): DeliveryTransport {
  return {
    authorize: async (tx, intent) => {
      const config = await access.configuration(tx), ticketId = intent.message.ticketId
      if (!ticketId) throw new Error('Delivery requires an authorized task')
      const ticket = await access.ticket(tx, config.installation.operator, ticketId)
      if (!ticket.channels.some(channel => hash(channel) === hash(intent.message.channel))) throw new Error('Delivery channel is outside the task mandate')
    },
    send: async message => {
      const result = await wire.lark<unknown>(['im', '+messages-reply', '--message-id', message.channel.address.messageId!, '--markdown', message.text,
        ...message.channel.address.direct === 'true' ? [] : ['--reply-in-thread'], '--idempotency-key', message.id], AbortSignal.timeout(60_000))
      const receipt = z.object({ message_id: z.string().min(1) }).safeParse(result)
      if (!receipt.success) throw new Error('Feishu message receipt is missing')
      return receipt.data.message_id
    },
  }
}
