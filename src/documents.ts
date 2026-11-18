/** Runs a fixed document renderer with time/memory bounds; models supply Markdown and a safe filename, never code or paths. */
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { DocumentOutputSchema, DOCX_MIME, type ArtifactFile } from './document-format.ts'

export const fileHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export interface PreparedDocument { metadata: ArtifactFile; bytes: Buffer; sourceHash: string }
export async function generateDocument(title: string, body: string, input: unknown, signal: AbortSignal): Promise<PreparedDocument> {
  const output = DocumentOutputSchema.parse(input)
  signal.throwIfAborted()
  if (!body.trim() || body.length > 40000 || title.length > 500) throw new Error('Word 正文应为 1–40000 字符。')
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './document-worker.ts' : './document-worker.js', import.meta.url), {
      workerData: { title, body }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
    let settled = false
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      void worker.terminate(); if (error) reject(error); else resolve(value!)
    }
    const abort = () => finish(new Error('Word 生成已因暂停、接管或服务关闭中断。'))
    const timer = setTimeout(() => finish(new Error('Word 生成超时，未生成替代 TXT。')), 20000)
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (value: { bytes?: Uint8Array; error?: string }) => {
      if (!value.bytes || value.bytes.byteLength > 2_000_000) return finish(new Error(value.error || 'Word 文件超出预算。'))
      const buffer = Buffer.from(value.bytes)
      if (buffer.subarray(0, 4).toString('hex') !== '504b0304') return finish(new Error('生成器未返回有效 Word 文件。'))
      finish(undefined, buffer)
    })
    worker.once('error', () => finish(new Error('Word 生成组件不可用；这是 Loom 能力故障，不是飞书权限不足。')))
    worker.once('exit', () => { if (!settled) finish(new Error('Word 生成进程提前结束。')) })
    if (signal.aborted) abort()
  })
  signal.throwIfAborted()
  return { metadata: { format: 'docx', filename: output.filename, mediaType: DOCX_MIME, sha256: fileHash(bytes), byteLength: bytes.length }, bytes, sourceHash: fileHash(Buffer.from(body)) }
}
