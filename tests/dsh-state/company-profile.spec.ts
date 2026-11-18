import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { profileModules, verifyProfileImports } = await import(new URL('../../scripts/company-profile-modules.mjs', import.meta.url).href) as {
  profileModules(profile: string, root: string, create?: boolean): Promise<void>
  verifyProfileImports(rows: unknown[], profile: string, harness: string): Promise<void>
}
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'loom-profile-imports-')); folders.push(folder)
  const app = join(folder, 'release'), harness = join(folder, 'harness'), config = join(folder, 'private')
  for (const path of [join(app, 'node_modules'), join(harness, 'node_modules'), config]) await mkdir(path, { recursive: true, mode: 0o700 })
  const module = '@deepseek-ai/nested-preset-probe'
  const installed = join(harness, 'node_modules', module); await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: module, main: 'index.js' }))
  await writeFile(join(installed, 'index.js'), 'module.exports = "reviewed"')
  await symlink(join(harness, 'node_modules', '@deepseek-ai'), join(app, 'node_modules', '@deepseek-ai'), 'dir')
  const profile = join(config, 'profile.json')
  const rows: unknown[] = [{ name: '@deepseek-ai/dsh-agent-preset', disabled: true },
    { name: '/reviewed/registry.js', config: {} }]
  // The registry itself is not relevant to resolution: the child preset is.
  await mkdir(join(harness, 'node_modules', '@deepseek-ai', 'dsh-agent-preset'))
  await writeFile(join(harness, 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'package.json'), '{"main":"index.js"}')
  await writeFile(join(harness, 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'index.js'), '')
  rows.push({ name: '@deepseek-ai/dsh-agent-preset', config: { plugins: [{ name: module }] } })
  await writeFile(profile, JSON.stringify(rows), { mode: 0o600 })
  return { app, harness, config, profile, rows, module }
}
it('preflights nested preset imports for a private profile outside the application dependency tree', async () => {
  const f = await fixture(), original = await readFile(f.profile, 'utf8')
  await expect(profileModules(f.profile, f.app)).rejects.toThrow('node_modules link')
  await expect(verifyProfileImports(f.rows, f.profile, f.harness)).rejects.toThrow()
  await profileModules(f.profile, f.app, true)
  await profileModules(f.profile, f.app, true)
  await verifyProfileImports(f.rows, f.profile, f.harness)
  expect(await readFile(f.profile, 'utf8')).toBe(original) // Preserve pinned preset composition.
})
it('refuses an existing private dependency graph instead of replacing or trusting it', async () => {
  const f = await fixture()
  await mkdir(join(f.config, 'node_modules'))
  await expect(profileModules(f.profile, f.app, true)).rejects.toThrow('node_modules link')
  await rm(join(f.config, 'node_modules'), { recursive: true })
  await symlink(join(f.harness, 'node_modules'), join(f.config, 'node_modules'), 'dir')
  await expect(profileModules(f.profile, f.app, true)).rejects.toThrow('node_modules link')
})
it('detects a nested plugin resolved from a different Harness graph before starting a listener', async () => {
  const f = await fixture()
  await profileModules(f.profile, f.app, true)
  const override = join(f.app, 'node_modules', '@deepseek-ai')
  await rm(override); await mkdir(join(override, f.module.split('/')[1]!), { recursive: true })
  await symlink(join(f.harness, 'node_modules', '@deepseek-ai', 'dsh-agent-preset'), join(override, 'dsh-agent-preset'), 'dir')
  await writeFile(join(override, f.module.split('/')[1]!, 'package.json'), '{"main":"index.js"}')
  await writeFile(join(override, f.module.split('/')[1]!, 'index.js'), '')
  await expect(verifyProfileImports(f.rows, f.profile, f.harness)).rejects.toThrow('different Harness')
})
