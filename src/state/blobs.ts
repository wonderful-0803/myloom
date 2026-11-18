/** Immutable, scope-separated files in an independently mounted directory. No model-selected filesystem paths. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { StateScope } from './ports.ts'
import { validateScope } from './ports.ts'
import { hash } from './hash.ts'

export interface BlobRef { sha256: string; byteLength: number }
export interface BlobStore {
  put(scope: StateScope, bytes: Uint8Array): Promise<BlobRef>
  head(scope: StateScope, digest: string): Promise<BlobRef | undefined>
  read(scope: StateScope, ref: BlobRef): Promise<Buffer>
  delete(scope: StateScope, digest: string): Promise<void>
  list(scope: StateScope, after?: string, limit?: number): Promise<BlobRef[]>
}
export const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function digest(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid blob digest') }
/** Content-addressed local backend; root must be a persistent volume outside the replaceable compute directory. */
export class LocalBlobStore implements BlobStore {
  private constructor(private readonly root: string, readonly maxBytes: number) {}
  static async open(root: string, maxBytes = 2_000_000): Promise<LocalBlobStore> {
    if (!isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64_000_000) throw new Error('Explicit absolute blob root and size limit required')
    await mkdir(root, { recursive: true, mode: 0o700 })
    if ((await realpath(root)) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('Blob root cannot contain symlinks')
    await chmod(root, 0o700)
    return new LocalBlobStore(resolve(root), maxBytes)
  }
  private async directory(scope: StateScope): Promise<string> {
    const path = join(this.root, hash(validateScope(scope)))
    await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe blob namespace')
    return path
  }
  async put(scope: StateScope, input: Uint8Array): Promise<BlobRef> {
    const bytes = Buffer.from(input)
    if (bytes.byteLength > this.maxBytes) throw new Error('Blob exceeds size limit')
    const ref = { sha256: bytesHash(bytes), byteLength: bytes.byteLength }, dir = await this.directory(scope), target = join(dir, ref.sha256), temporary = join(dir, `.upload-${randomUUID()}`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try {
      try { await link(temporary, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      // Existing content must actually match; never overwrite a damaged object or trust its filename.
      await this.read(scope, ref)
      const directory = await open(dir, 'r'); try { await directory.sync() } finally { await directory.close() }
      return ref
    } finally { await unlink(temporary).catch(() => {}) }
  }
  async head(scope: StateScope, value: string): Promise<BlobRef | undefined> {
    digest(value)
    try {
      const file = await open(join(await this.directory(scope), value), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > this.maxBytes) throw new Error('Invalid blob object')
        return { sha256: value, byteLength: info.size }
      } finally { await file.close() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async read(scope: StateScope, ref: BlobRef): Promise<Buffer> {
    digest(ref.sha256)
    if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > this.maxBytes) throw new Error('Invalid blob size')
    const file = await open(join(await this.directory(scope), ref.sha256), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size !== ref.byteLength) throw new Error('Blob length mismatch')
      const bytes = await file.readFile()
      if (bytesHash(bytes) !== ref.sha256) throw new Error('Blob integrity check failed')
      return bytes
    } finally { await file.close() }
  }
  async delete(scope: StateScope, value: string): Promise<void> {
    digest(value)
    await unlink(join(await this.directory(scope), value)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  }
  async list(scope: StateScope, after = '', limit = 100): Promise<BlobRef[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid blob page size')
    const dir = await this.directory(scope), names = (await readdir(dir)).filter(name => /^[a-f0-9]{64}$/.test(name) && name > after).sort().slice(0, limit)
    const result: BlobRef[] = []
    for (const name of names) { const ref = await this.head(scope, name); if (ref) result.push(ref) }
    return result
  }
}
