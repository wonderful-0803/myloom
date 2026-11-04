/** Minimal read-only Codex App Server transport. Never starts, resumes, steers or subscribes to a thread. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type CodexReadMethod = 'thread/list' | 'thread/read' | 'thread/items/list'
export interface CodexReader { call(method: CodexReadMethod, params: Record<string, unknown>): Promise<unknown> }
const methods = new Set(['initialize', 'thread/list', 'thread/read', 'thread/items/list'])
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** One short-lived stdio process per explicit read, with a closed RPC allowlist and bounded buffers/lifetime. */
export class CodexReadClient implements CodexReader {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private sequence = 0
  private buffer = ''
  private bytes = 0
  private closed = false
  private readonly timer: ReturnType<typeof setTimeout>
  constructor(private readonly signal: AbortSignal, launch: typeof spawn = spawn) {
    signal.throwIfAborted()
    this.child = launch('codex', ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk)
      this.buffer += chunk
      if (this.bytes > 32 * 1024 * 1024 || this.buffer.length > 8 * 1024 * 1024) { this.close(); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
        try {
          const value = JSON.parse(line)
          if (value.method && value.id !== undefined) {
            // App Server must never turn a history request into a tool execution or approval interaction.
            this.child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: 'Read-only history client' } }) + '\n')
            continue
          }
          const pending = this.pending.get(value.id)
          if (!pending) continue
          this.pending.delete(value.id); clearTimeout(pending.timer)
          if (value.error) pending.reject(new Error('Codex 历史接口拒绝请求，请核对 CLI 版本及本机会话状态。'))
          else pending.resolve(value.result)
        } catch { this.close(); return }
      }
    })
    // Discard diagnostics: neither source content nor credentials may enter Loom errors or server logs.
    this.child.stderr.resume()
    this.child.on('error', () => this.close())
    this.child.on('exit', () => this.close())
    this.child.stdin.on('error', () => this.close())
    this.timer = setTimeout(() => this.close(), 60_000)
    signal.addEventListener('abort', this.abort, { once: true })
  }
  private readonly abort = () => this.close()
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'loom_codex_history', title: 'Loom Codex History', version: '0.1.0' }, capabilities: { experimentalApi: false } })
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  }
  call(method: CodexReadMethod, params: Record<string, unknown>): Promise<unknown> { return this.request(method, params) }
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!methods.has(method)) return Promise.reject(new Error('Codex 历史入口仅支持只读接口。'))
    if (this.closed || this.signal.aborted) return Promise.reject(new Error('Codex 只读连接已关闭。'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timer = setTimeout(() => this.close(), 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  close(): void {
    if (this.closed) return
    this.closed = true; clearTimeout(this.timer); this.signal.removeEventListener('abort', this.abort)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex 只读连接不可用或读取超时，请确认本机 Codex CLI 可用。')) }
    this.pending.clear(); this.buffer = ''
    this.child.stdin.end(); this.child.kill('SIGTERM')
    if (this.child.exitCode === null) setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL') }, 1000).unref()
  }
}
export async function withCodexReader<T>(signal: AbortSignal, run: (reader: CodexReader) => Promise<T>): Promise<T> {
  const reader = new CodexReadClient(signal)
  try { await reader.initialize(); return await run(reader) } finally { reader.close() }
}
