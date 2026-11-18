/** Linux descriptor-relative, bounded text tools. No shell, network, file writes or native image decoding. */
import { constants } from 'node:fs'
import { open, realpath, opendir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, relative, isAbsolute, extname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { capabilities, relativePath } from '../protocol.ts'
import type { RemoteRequest, RemoteReceipt } from '../protocol.ts'
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/)
export const GrantInputSchema = z.object({ id, workspaceId: id, scope: z.enum(['personal', 'shared-group']), root: z.string().startsWith('/').max(2000),
  capabilities: z.array(z.enum(['fs.read', 'fs.glob', 'fs.grep', 'fs.stat'])).min(1).max(4), expiresAt: z.iso.datetime(),
  extensions: z.array(z.enum(['.txt', '.md', '.csv', '.json', '.log', '.ts', '.tsx', '.js', '.py', '.yml', '.yaml', '.html', '.css'])).min(1).max(14) }).strict()
export interface LocalGrant extends z.infer<typeof GrantInputSchema> { revision: number; enabled: boolean; device: string; inode: string }
export type RunnerResult = NonNullable<RemoteReceipt['result']>
/** Safe, content-free failure classification for the remote receipt. */
export class FileDenied extends Error {
  constructor(readonly reason: 'denied' | 'not_found' | 'budget' | 'unsupported') { super(`Runner operation ${reason}`) }
}
const proc = (fd: number) => `/proc/self/fd/${fd}`
const inside = (root: string, child: string) => { const rel = relative(root, child); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') }
const visible = (name: string) => name !== '' && name !== '.' && name !== '..' && !name.startsWith('.') && !/[\x00-\x1f\x7f\\]/.test(name)
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
function checkDirectory(info: { isDirectory(): boolean; uid: number | bigint; mode: number | bigint }) {
  if (!info.isDirectory() || Number(info.uid) !== process.getuid?.() || Number(info.mode) & 0o002) throw new FileDenied('denied')
}
export async function describeRoot(root: string, home: string): Promise<Pick<LocalGrant, 'device' | 'inode'>> {
  if (!isAbsolute(root) || root === '/' || await realpath(root) !== root || inside(root, home) || inside(home, root)) throw new FileDenied('denied')
  const handle = await open(root, directoryFlags)
  try { const info = await handle.stat({ bigint: true }); checkDirectory(info); return { device: String(info.dev), inode: String(info.ino) } }
  finally { await handle.close() }
}
function componentMatch(pattern: string, text: string): boolean {
  let p = 0, t = 0, star = -1, retry = 0
  while (t < text.length) {
    if (pattern[p] === '?' || pattern[p] === text[t]) { p++; t++ }
    else if (pattern[p] === '*') { star = p++; retry = t }
    else if (star >= 0) { p = star + 1; t = ++retry }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
function matcher(pattern: string) {
  const parts = pattern.split('/')
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes('**') && p !== '**') || /[\x00-\x1f\x7f\\]/.test(pattern)) throw new FileDenied('unsupported')
  return (path: string) => {
    const names = path.split('/'), memo = new Map<string, boolean>()
    const match = (a: number, b: number): boolean => {
      const key = `${a}/${b}`, old = memo.get(key); if (old !== undefined) return old
      const value = a === parts.length ? b === names.length : parts[a] === '**' ? match(a + 1, b) || b < names.length && match(a, b + 1)
        : b < names.length && componentMatch(parts[a]!, names[b]!) && match(a + 1, b + 1)
      memo.set(key, value); return value
    }
    return match(0, 0)
  }
}
/** Opens every path component under pinned directory handles and revalidates location before releasing data. */
export class SafeTextFiles {
  private count = 0
  private bytes = 0
  private deadline = performance.now() + 5000
  constructor(private grant: LocalGrant, private signal: AbortSignal, private current: () => void) {}
  private check() { this.signal.throwIfAborted(); this.current(); if (performance.now() >= this.deadline) throw new FileDenied('budget') }
  private async located(handle: FileHandle, path: string, directory: boolean) {
    this.check()
    const info = await handle.stat({ bigint: true })
    if (String(info.dev) !== this.grant.device || Number(info.uid) !== process.getuid?.() || Number(info.mode) & 0o002 || await realpath(proc(handle.fd)) !== path) throw new FileDenied('denied')
    if (directory) checkDirectory(info)
    else if (!info.isFile() || info.nlink !== 1n || info.size > 1_048_576n) throw new FileDenied(info.size > 1_048_576n ? 'budget' : 'denied')
    this.check(); return info
  }
  private async root() {
    const handle = await open(this.grant.root, directoryFlags)
    try {
      const info = await this.located(handle, this.grant.root, true)
      if (String(info.ino) !== this.grant.inode) throw new FileDenied('denied')
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  private async at<T>(path: string, work: (file: FileHandle) => Promise<T>): Promise<T> {
    relativePath.parse(path)
    const names = path.split('/'); if (!names.every(visible) || names.length > 16 || !this.grant.extensions.some(ext => ext === extname(path))) throw new FileDenied('denied')
    const handles = [await this.root()]
    try {
      for (let i = 0; i < names.length; i++) {
        this.check(); const dir = i < names.length - 1, parent = handles.at(-1)!
        const handle = await open(`${proc(parent.fd)}/${names[i]}`, dir ? directoryFlags : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        handles.push(handle); await this.located(handle, join(this.grant.root, ...names.slice(0, i + 1)), dir)
      }
      const value = await work(handles.at(-1)!)
      // A parent can be renamed while its fd remains valid; do not release the result from a moved/replaced path.
      for (let i = 0; i < handles.length; i++) {
        const info = await this.located(handles[i]!, join(this.grant.root, ...names.slice(0, i)), i < handles.length - 1)
        if (!i && String(info.ino) !== this.grant.inode) throw new FileDenied('denied')
      }
      const again = await this.root(); await again.close(); return value
    } finally { for (const handle of handles.reverse()) await handle.close() }
  }
  private async text(path: string): Promise<string> {
    return this.at(path, async file => {
      const before = await file.stat({ bigint: true }), chunks: Buffer[] = []; let size = 0
      for (;;) {
        this.check(); const buffer = Buffer.alloc(16_384), { bytesRead } = await file.read(buffer, 0, buffer.length, size)
        if (!bytesRead) break
        size += bytesRead; this.bytes += bytesRead
        if (size > 1_048_576 || this.bytes > 2_097_152) throw new FileDenied('budget')
        chunks.push(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat({ bigint: true })
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new FileDenied('denied')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { throw new FileDenied('unsupported') }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new FileDenied('unsupported')
      return text.replaceAll('\r\n', '\n')
    })
  }
  private async *paths(handle: FileHandle, parent = '', depth = 0): AsyncGenerator<string> {
    this.check(); await this.located(handle, join(this.grant.root, parent), true)
    const entries = await opendir(proc(handle.fd))
    for await (const item of entries) {
      this.check(); if (++this.count > 2000) throw new FileDenied('budget')
      if (!visible(item.name)) continue
      const path = parent ? `${parent}/${item.name}` : item.name
      if (path.length > 500) throw new FileDenied('budget')
      if (item.isDirectory()) {
        if (depth >= 15) throw new FileDenied('budget')
        const child = await open(`${proc(handle.fd)}/${item.name}`, directoryFlags)
        try { yield* this.paths(child, path, depth + 1) } finally { await child.close() }
      } else if (item.isFile() && this.grant.extensions.some(ext => ext === extname(path))) {
        // Pin and validate even for glob: replaced symlinks/hardlinks must not be listed as permitted files.
        await this.at(path, async () => {}); yield path
      }
    }
    await this.located(handle, join(this.grant.root, parent), true)
  }
  async execute(request: RemoteRequest): Promise<RunnerResult> {
    try {
      this.check()
      if (request.toolId === 'fs.read') {
        const args = capabilities.read.input.parse(request.args), lines = (await this.text(args.path)).split('\n')
        const selected = lines.slice(args.offset, args.offset + args.limit).join('\n'), text = clip(selected, 60_000)
        return { kind: 'text', text, truncated: selected !== text || args.offset + args.limit < lines.length }
      }
      if (request.toolId === 'fs.stat') {
        const args = capabilities.stat.input.parse(request.args)
        const value = await this.at(args.path, async file => {
          const info = await file.stat()
          return { kind: 'stat' as const, path: args.path, bytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() }
        })
        return value
      }
      const args = request.toolId === 'fs.glob' ? capabilities.glob.input.parse(request.args) : capabilities.grep.input.parse(request.args)
      const match = matcher(args.pattern), paths: string[] = [], matches: { path: string; line: number; text: string }[] = []
      let total = 0, read = 0, truncated = false; const root = await this.root()
      try {
        for await (const path of this.paths(root)) {
          if (!match(path)) continue
          if (request.toolId === 'fs.glob') {
            if (paths.length >= args.limit || total + Buffer.byteLength(JSON.stringify(path)) > 60_000) { truncated = true; break }
            paths.push(path); total += Buffer.byteLength(JSON.stringify(path))
          }
          else {
            if (++read > 200) throw new FileDenied('budget')
            const lines = (await this.text(path)).split('\n')
            for (let n = 0; n < lines.length; n++) {
              this.check(); if (!lines[n]!.includes(capabilities.grep.input.parse(request.args).query)) continue
              const text = clip(lines[n]!, 4000, 2000), value = { path, line: n + 1, text }
              if (matches.length >= args.limit || total + Buffer.byteLength(JSON.stringify(value)) > 60_000) { truncated = true; break }
              matches.push(value); total += Buffer.byteLength(JSON.stringify(value))
              if (text !== lines[n]) { truncated = true; break }
            }
            if (truncated) break
          }
        }
        await this.located(root, this.grant.root, true)
      } finally { await root.close() }
      this.check(); return request.toolId === 'fs.glob' ? { kind: 'paths', paths, truncated } : { kind: 'matches', matches, truncated }
    } catch (error) {
      if (error instanceof FileDenied || this.signal.aborted) throw error
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new FileDenied('not_found')
      throw new FileDenied('denied')
    }
  }
}
function clip(text: string, bytes: number, maxChars = 64000): string {
  let size = 0, output = ''
  for (const char of text) { size += Buffer.byteLength(JSON.stringify(char)) - 2; if (size > bytes || output.length + char.length > maxChars) break; output += char }
  return output
}
