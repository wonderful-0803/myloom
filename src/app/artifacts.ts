/** Immutable, owner-scoped report revisions. Source access is checked again on every read and publication. */
import { createHash } from 'node:crypto'
import { openSync, closeSync, fstatSync, readFileSync, realpathSync, constants } from 'node:fs'
import { executionTarget, ExecutionUnavailable } from '../execution/port.ts'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { key, latestReport, type Ticket, type Trigger } from '../core/index.ts'
import { delegationMatches, settingsPolicy } from '../policy.ts'
import { KV } from '../kv.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'
import type { TaskControls } from './task-control.ts'

export interface ArtifactVersion {
  id: string; subject: string; kind: 'task' | 'draft'; version: number; owner: string; title: string
  body: string; hash: string; at: string; author: 'agent' | 'human'; sources: { triggerId: string; hash: string }[]
  requirement: string; reportKey?: string
  editedByTrigger?: string
  /** An authenticated loopback owner edit, distinct from a native Feishu message. */
  editedVia?: 'loom'
  /** Explicitly published UTF-8 report, snapshotted here rather than read again at delivery time. */
  filename?: string
}
interface Host { store: Store; sources: SourceRegistry; controls: TaskControls }
export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex')
/** Versions are appended under distinct keys; a separate pointer identifies the latest revision. */
export class Artifacts {
  constructor(private readonly host: Host) {}
  sourceAllowed(trigger: Trigger, owner: string): boolean {
    if (trigger.source === 'codex-daily') return !trigger.human && trigger.actor.source === 'codex-daily' && trigger.actor.id === owner
      && this.host.sources.scope(trigger).listened && this.host.store.settings().policy.rules.some(rule => rule.delegation?.codex && delegationMatches(rule, [trigger]))
      && this.host.sources.policyPart('feishu')?.allowed.length === 1
      && this.host.sources.policyPart('feishu')?.allowed[0]?.id === owner
    return trigger.source === 'feishu' && trigger.human && trigger.actor.source === 'feishu' && trigger.actor.id === owner
      && this.host.sources.scope(trigger).listened
      && (this.host.sources.policyPart('feishu')?.allowed.some(person => person.id === owner) ?? false)
  }
  owns(ticket: Ticket, owner: string): boolean {
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    return ['feishu', 'codex-daily'].includes(ticket.mandate.actor.source) && ticket.mandate.actor.id === owner
      && !!origin && this.sourceAllowed(origin, owner)
  }
  canReadContext(ticket: Ticket, owner: string): boolean {
    const sources = [...this.taskSources(ticket), ...this.current(ticket.id)?.sources.map(source => source.triggerId) ?? []]
    return this.owns(ticket, owner) && sources.every(id => {
      const trigger = this.host.store.triggers.get(id)
      return !!trigger && this.visible(trigger, owner, 'task')
    })
  }
  requirement(ticket: Ticket): string {
    return contentHash(JSON.stringify(ticket.inputs.filter(input => input.kind === 'trigger').map(input => {
      const trigger = this.host.store.triggers.get(input.triggerId)
      return [input.id, trigger?.text ?? '', trigger?.at ?? '']
    })))
  }
  private current(subject: string): ArtifactVersion | undefined {
    const version = this.host.store.get(KV.artifacts.head(subject))
    return version ? this.host.store.get(KV.artifacts.version(subject, version)) : undefined
  }
  private allowed(value: ArtifactVersion, owner: string): boolean {
    if (value.owner !== owner || !value.sources.length) return false
    if (value.kind === 'task') {
      const ticket = this.host.store.tickets.get(value.subject)
      if (!ticket || !this.owns(ticket, owner)) return false
    }
    return value.sources.every(source => {
      const trigger = this.host.store.triggers.get(source.triggerId)
      // Other participants' records are not implicitly imported into a personal draft.
      return !!trigger && this.visible(trigger, owner, value.kind) && contentHash(trigger.text) === source.hash
    })
  }
  private visible(trigger: Trigger, owner: string, kind: ArtifactVersion['kind']): boolean {
    if (trigger.source === 'codex-daily') return kind === 'task' && this.sourceAllowed(trigger, owner)
    return kind === 'draft' ? this.sourceAllowed(trigger, owner)
      : (this.host.sources.policyPart('feishu')?.allowed.some(person => person.id === owner) ?? false) && this.host.sources.scope(trigger).listened
  }
  get(subject: string, owner: string, version?: number): ArtifactVersion | undefined {
    const value = version === undefined ? this.current(subject) : this.host.store.get(KV.artifacts.version(subject, version))
    return value && this.allowed(value, owner) ? value : undefined
  }
  history(subject: string, owner: string): ArtifactVersion[] {
    const head = this.get(subject, owner)
    return head ? Array.from({ length: head.version }, (_, index) => this.get(subject, owner, index + 1)).filter((v): v is ArtifactVersion => !!v) : []
  }
  /** Imports legacy reports once; querying after a human edit never overwrites that edit with the old report. */
  snapshot(ticket: Ticket): ArtifactVersion | undefined {
    const owner = ticket.mandate.actor.id
    if (!this.canReadContext(ticket, owner)) return
    const report = latestReport(ticket)
    if (!report || !['ready', 'progress'].includes(report.state)) return this.get(ticket.id, owner)
    const reportKey = contentHash(JSON.stringify(report))
    const head = this.get(ticket.id, owner)
    if (head?.reportKey === reportKey) return head
    if (head?.author === 'human') return head
    return this.append(ticket.id, owner, ticket.title, report.summary, [...this.taskSources(ticket), ...head?.sources.map(source => source.triggerId) ?? []], 'task', 'agent', this.requirement(ticket), head?.version ?? 0, reportKey)
  }
  private taskSources(ticket: Ticket): string[] {
    return [...new Set([ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])]
  }
  /** A worker must explicitly acknowledge a newer human revision before publishing over it. */
  checkReport(ticket: Ticket, expected?: number): void {
    if (!['feishu', 'codex-daily'].includes(ticket.mandate.actor.source)) return
    if (ticket.mandate.actor.source === 'codex-daily' && !settingsPolicy(this.host.store.settings(), this.host.sources).revalidate(ticket.mandate)) throw new Error('Codex 日报委托已撤销或变更。')
    const head = this.get(ticket.id, ticket.mandate.actor.id)
    if (this.current(ticket.id) && !head) throw new Error('Artifact source authorization was revoked')
    if (head?.author === 'human' && expected !== head.version) throw new Error('Human artifact changed. Read orchestrator_artifact, preserve the edit, then report with artifact_version.')
    if (expected !== undefined && expected !== (head?.version ?? 0)) throw new Error('Artifact version changed; reread before reporting')
  }
  report(ticket: Ticket, body: string, expected?: number, filename?: string): ArtifactVersion | undefined {
    if (!['feishu', 'codex-daily'].includes(ticket.mandate.actor.source)) return
    this.checkReport(ticket, expected)
    const head = this.get(ticket.id, ticket.mandate.actor.id)
    const report = latestReport(ticket)
    return this.append(ticket.id, ticket.mandate.actor.id, ticket.title, body, [...this.taskSources(ticket), ...head?.sources.map(source => source.triggerId) ?? []], 'task', 'agent', this.requirement(ticket), head?.version ?? 0,
      report ? contentHash(JSON.stringify(report)) : undefined, undefined, undefined, filename)
  }
  /** Accept only an explicit text report in this task's real workspace; never follow a symlink or scan other files. */
  readReportFile(ticket: Ticket, path: string): { body: string; filename: string } {
    if (executionTarget(ticket).kind !== 'local') throw new ExecutionUnavailable('Runner artifact transfer is not configured; local file access is forbidden')
    if (!ticket.execution?.directory || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => part === '..' || part.startsWith('.'))
      || !['.md', '.txt'].includes(extname(path).toLowerCase())) throw new Error('Report file must be a relative .md or .txt file inside this task workspace')
    const root = realpathSync(ticket.execution.directory), target = resolve(root, path), resolved = realpathSync(target)
    if (resolved !== target || relative(root, resolved).startsWith('..' + sep) || !relative(root, resolved) || isAbsolute(relative(root, resolved)))
      throw new Error('Report file is outside this task workspace or is a symbolic link')
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 160_000 || stat.nlink !== 1 || realpathSync(`/proc/self/fd/${fd}`) !== target) throw new Error('Report file is not a bounded regular task file')
      const bytes = readFileSync(fd), body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (bytes.length > 160_000 || !body.trim() || body.length > 40_000 || body.includes('\0')) throw new Error('Report file must contain 1–40000 UTF-8 text characters')
      return { body, filename: basename(path).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-120).replace(/^\.+/, '_') }
    } finally { closeSync(fd) }
  }
  /** Register an older task's explicit report file without sending it or rerunning work. */
  importReportFile(ticket: Ticket, owner: string, expected: number, path: string): ArtifactVersion {
    const head = this.get(ticket.id, owner), control = this.host.controls.view(ticket.id)
    if (!head || head.version !== expected || head.author !== 'agent' || head.requirement !== this.requirement(ticket)
      || ticket.ended?.outcome !== 'completed' || latestReport(ticket)?.state !== 'ready' || !this.canReadContext(ticket, owner)
      || control.mode !== 'agent' || control.operations.length) throw new Error('仅可为已完成且未被人工改写的最新报告登记文件。')
    const file = this.readReportFile(ticket, path)
    return this.append(ticket.id, owner, head.title, file.body, head.sources.map(source => source.triggerId), 'task', 'agent', head.requirement,
      expected, head.reportKey, undefined, undefined, file.filename)
  }
  draft(subject: string, owner: string, title: string, body: string, sources: string[]): ArtifactVersion {
    return this.append(subject, owner, title, body, sources, 'draft', 'agent', contentHash(sources.join(':')), 0)
  }
  edit(subject: string, owner: string, expected: number, body: string, editedByTrigger?: string, editedVia?: 'loom'): ArtifactVersion {
    const head = this.get(subject, owner)
    if (!head || head.version !== expected) throw new Error('产物版本已变化或来源授权已撤销，请重新打开最新版本。')
    if (editedByTrigger) {
      const edit = this.host.store.triggers.get(editedByTrigger)
      if (!edit || edit.meta.direct !== true || !this.sourceAllowed(edit, owner)) throw new Error('改稿来源不是本人获授权的私聊消息。')
    }
    if (head.kind === 'task') {
      const control = this.host.controls.view(subject)
      if (control.mode !== 'human' || control.operations.length) throw new Error('请先接管任务，等待在途操作结束后再保存改稿。')
    }
    return this.append(subject, owner, head.title, body, [...head.sources.map(source => source.triggerId), ...editedByTrigger ? [editedByTrigger] : []],
      head.kind, 'human', head.requirement, expected, head.reportKey, editedByTrigger, editedVia, head.filename)
  }
  private append(subject: string, owner: string, title: string, body: string, sourceIds: string[], kind: ArtifactVersion['kind'], author: ArtifactVersion['author'], requirement: string, expected: number, reportKey?: string, editedByTrigger?: string, editedVia?: 'loom', filename?: string): ArtifactVersion {
    if (!body.trim() || body.length > 40_000) throw new Error('产物正文应为 1–40000 字符。')
    return this.host.store.atomic(() => {
      if ((this.current(subject)?.version ?? 0) !== expected) throw new Error('Artifact version conflict')
      const sources = [...new Set(sourceIds)].map(id => {
        const trigger = this.host.store.triggers.get(id)
        if (!trigger || !this.visible(trigger, owner, kind)) throw new Error('Artifact source is outside the current owner scope')
        return { triggerId: id, hash: contentHash(trigger.text) }
      })
      if (!sources.length) throw new Error('An artifact needs at least one authorized source')
      const value: ArtifactVersion = { id: key('artifact', subject), subject, kind, version: expected + 1, owner, title, body,
        hash: contentHash(body), at: new Date().toISOString(), author, sources, requirement, ...reportKey ? { reportKey } : {}, ...editedByTrigger ? { editedByTrigger } : {}, ...editedVia ? { editedVia } : {}, ...filename ? { filename } : {} }
      this.host.store.set(KV.artifacts.version(subject, value.version), value)
      this.host.store.set(KV.artifacts.head(subject), value.version)
      return value
    })
  }
}
