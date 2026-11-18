/** Actual pinned rc.3 attachment codec/store, rooted in an explicitly selected persistent home. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFile, readdir, mkdir, lstat, realpath, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, isAbsolute, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
export async function attachmentIO(harnessRoot, home) {
  if (!isAbsolute(harnessRoot ?? '') || !isAbsolute(home ?? '')) throw new Error('Explicit attachment Harness root and persistent home required')
  const manifest = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.1-rc.3') throw new Error('Native attachments require pinned rc.3 codecs')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const info = await lstat(home)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || await realpath(home) !== resolve(home)) throw new Error('Attachment home must be a private canonical directory')
  const require = createRequire(join(harnessRoot, 'package.json')), load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
  const [{ Context }, { LocalAttachmentStore, commitPreparedImageFile }] = await Promise.all([load('cordis'), load('dsh-attachment-local')])
  const ctx = new Context(), staging = await mkdtemp(join(tmpdir(), 'loom-native-attachment-'))
  const target = new LocalAttachmentStore(ctx, { dshHome: home }), scratchCtx = new Context(), scratch = new LocalAttachmentStore(scratchCtx, { dshHome: staging })
  async function internalHardlinks(root, info) {
    let count = 0, visited = 0
    async function visit(folder) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (++visited > 20000) throw new Error('Attachment index exceeds verification budget')
        const path = join(folder, entry.name), found = await lstat(path)
        if (found.isSymbolicLink()) throw new Error('Unsafe attachment index')
        if (found.isDirectory()) await visit(path)
        else if (found.dev === info.dev && found.ino === info.ino) count++
      }
    }
    await visit(root)
    if (count !== info.nlink) throw new Error('Attachment object has hardlinks outside its persistent root')
  }
  async function safePath(store, entry) {
    const path = entry.kind === 'image' ? store.imageHostPath(entry.ref) : store.fileHostPath(entry.ref), rel = relative(store.root, path)
    if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Attachment escaped its persistent root')
    let current = resolve(store.root, '..', '..')
    for (const piece of ['', ...relative(current, path).split(sep)]) {
      current = piece ? join(current, piece) : current
      try { const info = await lstat(current); if (await realpath(current) !== resolve(current) || info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('Unsafe attachment object path'); if (info.isFile() && info.nlink !== 1) await internalHardlinks(store.root, info) }
      catch (error) { if (error.code === 'ENOENT') return; throw error }
    }
  }
  async function read(store, entry) {
    await safePath(store, entry)
    if (entry.kind === 'image') return Buffer.from((await store.readImage(entry.ref)).data)
    const chunks = []; let total = 0
    for await (const chunk of store.readFileStream(entry.ref)) { if ((total += chunk.byteLength) > 20 * 1024 * 1024) throw new Error('Attachment exceeds import budget'); chunks.push(chunk) }
    return Buffer.concat(chunks)
  }
  async function put(store, entry) {
    await safePath(store, entry)
    const data = Buffer.from(entry.data, 'base64')
    if (entry.kind === 'image') await commitPreparedImageFile(store.root, { data, ref: entry.ref })
    else assert.deepEqual(await store.saveFile({ data, name: entry.ref.name }), entry.ref)
  }
  return {
    read: entry => read(target, entry),
    io: { validate: async entry => { await put(scratch, entry); assert.deepEqual(await read(scratch, entry), Buffer.from(entry.data, 'base64')) },
      put: entry => put(target, entry), verify: async entry => { assert.deepEqual(await read(target, entry), Buffer.from(entry.data, 'base64')) } },
    close: async () => { await ctx.fiber.dispose(); await scratchCtx.fiber.dispose(); await rm(staging, { recursive: true, force: true }) },
  }
}
