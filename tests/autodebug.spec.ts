/** The AutoDebug bridge reports each BugFixer round event once, never replays an old round, and never starts a stopped one. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'

const script = resolve('integrations/autodebug/autodebug.py')
type Event = Record<string, unknown> & { event: string }

/** A BugFixer checkout with one round of three bugs, as its own workflow writes it. */
function checkout(run: (paths: { root: string; batch: string; flow: string; state: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'autodebug-'))
  try {
    mkdirSync(join(root, 'bugfixer'))
    const flow = join(root, '.local', 'pilot-runs', 'automatic-test'), batch = join(flow, 'batch-1')
    mkdirSync(batch, { recursive: true })
    const records = ['BUG-1', 'BUG-2', 'BUG-3'].map(id => ({ record_id: 'r' + id, fields: { Bug编号: id } }))
    writeFileSync(join(batch, 'snapshot.json'), JSON.stringify({ kind: 'AutomaticWorkflow', records }))
    run({ root, batch, flow, state: join(root, 'task-state.json') })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const cli = (root: string, ...args: string[]) => execFileSync('python3', [script, '--bugfixer', root, ...args], { encoding: 'utf8' })
const watch = (root: string, state: string): Event[] =>
  cli(root, 'watch', '--state', state, '--timeout', '1', '--interval', '1').trim().split('\n').map(line => JSON.parse(line))
const report = (batch: string, results: { ticket_id: string; state: string; pr_url?: string; error?: string }[]) =>
  writeFileSync(join(batch, 'report.json'), JSON.stringify(results))

it('reports a running round\'s start, each bug outcome and its end exactly once, skipping intermediate states', () => checkout(({ root, batch, flow, state }) => {
  writeFileSync(join(flow, 'active.json'), JSON.stringify({ batch: 'batch-1' }))
  report(batch, [{ ticket_id: 'BUG-1', state: 'awaiting_human_review', pr_url: 'https://gitee.example/pr/1' }])
  expect(watch(root, state)).toEqual([
    { event: 'round_started', batch: 'batch-1', total: 3, order: ['BUG-1', 'BUG-2', 'BUG-3'] },
    { event: 'bug_outcome', ticket_id: 'BUG-1', state: 'awaiting_human_review', pr_url: 'https://gitee.example/pr/1', error: null },
  ])
  expect(watch(root, state)).toEqual([{ event: 'no_change', running: false }])
  report(batch, [{ ticket_id: 'BUG-1', state: 'awaiting_human_review', pr_url: 'https://gitee.example/pr/1' },
    { ticket_id: 'BUG-2', state: 'verifying' }])
  expect(watch(root, state)).toEqual([{ event: 'no_change', running: false }])
  report(batch, [{ ticket_id: 'BUG-1', state: 'awaiting_human_review', pr_url: 'https://gitee.example/pr/1' },
    { ticket_id: 'BUG-2', state: 'manual_required', error: '基线未复现' }, { ticket_id: 'BUG-3', state: 'manual_required', error: '超时' }])
  expect(watch(root, state).map(event => [event.event, event.ticket_id, event.error])).toEqual([
    ['bug_outcome', 'BUG-2', '基线未复现'], ['bug_outcome', 'BUG-3', '超时']])
  writeFileSync(join(batch, 'final-report.json'), JSON.stringify({ action: 'finished', completed: 1, manual: 2, pending: 0 }))
  unlinkSync(join(flow, 'active.json'))
  expect(watch(root, state)).toEqual([{ event: 'round_finished', batch: 'batch-1', completed: 1, manual: 2, pending: 0, total: 3 }])
  expect(watch(root, state)).toEqual([{ event: 'idle', running: false, batch: 'batch-1' }])
}))

it('records an earlier finished round as seen on a task\'s first watch instead of replaying it', () => checkout(({ root, batch, state }) => {
  report(batch, [{ ticket_id: 'BUG-1', state: 'manual_required', error: 'x' }])
  writeFileSync(join(batch, 'final-report.json'), JSON.stringify({ completed: 0, manual: 1, pending: 0 }))
  expect(watch(root, state)).toEqual([{ event: 'idle', running: false, batch: 'batch-1' }])
  expect(watch(root, state)).toEqual([{ event: 'idle', running: false, batch: 'batch-1' }])
}))

it('refuses to start a round while BugFixer\'s stop switch is on unless the owner asked to resume', () => checkout(({ root }) => {
  const db = new DatabaseSync(join(root, '.local', 'state.db'))
  db.exec('CREATE TABLE switches (id INTEGER PRIMARY KEY CHECK(id=1), stopped INTEGER NOT NULL); INSERT INTO switches VALUES(1,1)'); db.close()
  expect(JSON.parse(cli(root, 'start'))).toMatchObject({ started: false, reason: expect.stringContaining('stop switch') })
  expect(JSON.parse(cli(root, 'status'))).toMatchObject({ stopped: true, running: false })
}))
