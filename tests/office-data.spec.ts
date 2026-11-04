/** The office calculator uses actual Python Decimal arithmetic and preserves reproducible artifacts. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

const script = resolve('skills/dsh-superagent-office/aggregate.py')
const source = 'id,channel,amount\n1,online,0.10\n2,online,0.20\n2,online,0.20\n3,offline,12.50\n4,offline,\n'
const spec = { source: 'synthetic message fixture', period: 'test day', unit: 'CNY', missing: 'exclude',
  group_by: ['channel'], sum: ['amount'], dedup_by: ['id'], filters: {} }
function inTask(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'office-data-'))
  try { writeFileSync(join(root, 'input.csv'), source); writeFileSync(join(root, 'spec.json'), JSON.stringify(spec)); run(root) }
  finally { rmSync(root, { recursive: true, force: true }) }
}
it('computes exact totals, reports exclusions, and hashes retained input and definition snapshots', () => inTask(root => {
  const result = JSON.parse(execFileSync('python3', [script, '--input', 'input.csv', '--spec', 'spec.json'], { cwd: root, encoding: 'utf8' }))
  expect(result.totals).toEqual({ amount: '12.80' })
  expect(result.counts).toEqual({ input: 5, included: 3, duplicates: 1, missing: 1, filtered: 0 })
  expect(result.groups.find((g: { group: { channel: string } }) => g.group.channel === 'online').sums).toEqual({ amount: '0.30' })
  const artifact = join(root, result.artifact_directory), manifest = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8'))
  for (const file of ['input.csv', 'spec.json', 'result.json']) expect(manifest.files[file])
    .toBe(createHash('sha256').update(readFileSync(join(artifact, file))).digest('hex'))
  expect(readFileSync(join(artifact, 'input.csv'), 'utf8')).toBe(source)
}))
it('rejects conflicting duplicates and non-finite numbers instead of silently computing a total', () => inTask(root => {
  for (const data of [source.replace('2,online,0.20\n3', '2,online,0.99\n3'), source.replace('12.50', 'NaN')]) {
    writeFileSync(join(root, 'input.csv'), data)
    expect(spawnSync('python3', [script, '--input', 'input.csv', '--spec', 'spec.json'], { cwd: root }).status).toBe(1)
  }
}))
it('refuses absolute paths and symlinks outside the task directory', () => inTask(root => {
  symlinkSync('/etc/passwd', join(root, 'outside.csv'))
  for (const name of ['/etc/passwd', 'outside.csv']) expect(spawnSync('python3', [script, '--input', name, '--spec', 'spec.json'], { cwd: root }).status).toBe(1)
}))
