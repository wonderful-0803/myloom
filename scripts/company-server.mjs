#!/usr/bin/env node
/** Pinned company launcher. Stop the product/Agent lifecycles before disposing native storage. */
import { parseArgs } from 'node:util'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileModules, verifyProfileImports } from './company-profile-modules.mjs'
const { values } = parseArgs({ options: { profile: { type: 'string' }, 'harness-root': { type: 'string' } } })
const harness = values['harness-root'], profile = values.profile
let root, stopping
async function stop() {
  return stopping ??= (async () => { try { await root?.get('loomCompany')?.stop() } finally { await root?.fiber.dispose() } })()
}
try {
  if (!isAbsolute(profile ?? '') || !isAbsolute(harness ?? '')) throw new Error('Explicit private profile and installed Harness root required')
  const info = await lstat(profile)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || await realpath(profile) !== resolve(profile)) throw new Error('Expected private canonical profile')
  const pkg = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== '0.2.1-rc.3') throw new Error('Company launcher requires pinned Harness rc.3')
  await profileModules(profile, resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  await verifyProfileImports(JSON.parse(await readFile(profile, 'utf8')), profile, harness)
  const require = createRequire(join(harness, 'package.json'))
  const [{ boot }, { provideCmdline }] = await Promise.all(['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-cmdline'].map(name => import(pathToFileURL(require.resolve(name)).href)))
  root = await boot('loom-company', profile, [], host => provideCmdline(host, { args: ['--no-open'], exit: () => { throw new Error('Unexpected company CLI exit') } }), new URL('../package.json', import.meta.url).href)
  if (!root.get('loomCompany')) throw new Error('Company product entry is not active')
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 }) })
} catch {
  await stop().catch(() => {})
  console.error('Company startup failed; inspect the private service journal and pinned profile. No fallback runtime was started.')
  process.exitCode = 1
}
