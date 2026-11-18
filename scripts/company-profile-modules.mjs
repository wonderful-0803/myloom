/** Pin nested rc.3 preset imports to the reviewed application's dependency graph. */
import { lstat, realpath, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export async function profileModules(profile, applicationRoot, create = false) {
  const target = await realpath(join(applicationRoot, 'node_modules'))
  const link = join(dirname(profile), 'node_modules')
  let info
  try { info = await lstat(link) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!info && create) {
    await symlink(target, link, 'dir')
    info = await lstat(link)
  }
  // Do not replace or silently reuse a different graph in the private config directory.
  if (!info?.isSymbolicLink() || await realpath(link) !== target) throw Error('Private profile requires the reviewed application node_modules link')
}

export async function verifyProfileImports(rows, profile, harness) {
  const fromProfile = createRequire(profile), fromHarness = createRequire(join(harness, 'package.json'))
  const names = new Set()
  function visit(entries) {
    if (!Array.isArray(entries)) throw Error('Invalid profile entries')
    for (const row of entries) {
      if (row.disabled) continue
      if (typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/')) names.add(row.name)
      if (row.name === '@deepseek-ai/dsh-agent-preset') visit(row.config?.plugins)
    }
  }
  visit(rows)
  for (const name of names) {
    if (await realpath(fromProfile.resolve(name)) !== await realpath(fromHarness.resolve(name)))
      throw Error('Private profile resolves a different Harness dependency')
  }
}
