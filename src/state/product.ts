/** Authorized async product commands and read models shared by HTTP, Feishu and desktop adapters. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, latestReport, threadKey } from '../core/index.ts'
import type { Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../core/index.ts'
import { DelegationInput } from '../app/delegations.ts'
import type { LoomArtifact, LoomDelegation, LoomProgress, LoomSnapshot, LoomTask } from '../app/loom-types.ts'
import { RuleSchema, SettingsSchema, policyVersion, settingsPolicy, policyEffects } from '../policy.ts'
import type { Rule, Settings } from '../policy.ts'
import { feishuSettings, feishuKind } from '../sources/feishu.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { changeControl } from './controls.ts'
import { GroupMasterSchema, GroupWorkspaceSchema } from '../group-mode.ts'
import type { FeishuWire } from './feishu.ts'
import { asrInfo } from '../audio.ts'
import { projectTaskProgress } from '../app/task-progress.ts'
import type { ProgressEvent } from '../app/task-progress.ts'
import type { AsyncTaskRuntime } from './runtime.ts'
import { AccessDenied, ProductAccess } from './access.ts'
import type { SettingsRecord } from './access.ts'
import type { ArtifactManifest, DurableArtifacts } from './artifacts.ts'
import type { DurableResults } from './results.ts'
import type { DurableMeetings } from './meetings.ts'
import { control } from './controls.ts'
import { hash } from './hash.ts'
import { StateConflict } from './ports.ts'
import { Reconciliation, reconcileOutcome } from './recovery.ts'
import type { StateScope, StateStore, StateTransaction } from './ports.ts'
import type { FeishuSignal } from './signals.ts'

export interface ProductOptions { store: StateStore; scope: StateScope; access: ProductAccess; runtime: AsyncTaskRuntime; artifacts: DurableArtifacts; results?: DurableResults; meetings?: DurableMeetings; wire?: FeishuWire; health?(): { id: string; state: string }[]; recover?(ticketId: string): Promise<void> }
const rev = z.number().int().nonnegative()
/** Product boundary with explicit authenticated actor, bounded reads and atomic versioned writes. */
export class StateProduct {
  constructor(readonly options: ProductOptions) {}
  private tx<T>(work: (tx: StateTransaction) => Promise<T>) { return this.options.store.transaction(this.options.scope, work) }
  async snapshot(actor: string, after = ''): Promise<LoomSnapshot & { next?: string }> {
    const { access, runtime } = this.options
    return this.tx(async tx => {
      const config = await access.user(tx, actor), settings = config.settings, source = feishuSettings(config.registry)
      const before = after ? z.object({ at: z.string().max(40), id: z.string().min(1).max(2048) }).strict().parse(JSON.parse(Buffer.from(after, 'base64url').toString('utf8'))) : undefined
      const held = new Set((await tx.jobs.list(1000)).filter(job => job.held).map(job => (job.value as { ticketId?: string }).ticketId))
      const rows = await tx.scan<Ticket>('ticket', { recent: true, before, limit: 100 }), tasks: LoomTask[] = [], artifacts: LoomArtifact[] = []
      for (const row of rows) {
        try { await access.ticket(tx, actor, row.id) } catch (error) { if (error instanceof AccessDenied) continue; throw error }
        const ticket = row.value, state = (await control(tx, ticket.id)).value, assignment = ticket.assignments.at(-1), report = latestReport(ticket)
        tasks.push({ id: ticket.id, title: ticket.title, description: ticket.mandate.scope, status: ticket.ended ? 'ended' : (held.has(ticket.id) || ['failed', 'blocked'].includes(report?.state ?? '')) ? 'blocked' : 'open',
          ...(ticket.ended ? { outcome: ticket.ended.outcome } : {}), createdAt: Date.parse(ticket.createdAt), updatedAt: Date.parse(report?.at ?? ticket.createdAt), summary: report?.summary ?? '',
          completed: !!ticket.ended && ticket.ended.outcome === 'completed', executionState: held.has(ticket.id) ? 'waiting' : assignment?.state === 'running' ? report?.state === 'waiting' ? 'waiting' : 'running' : 'queued',
          ruleIds: ticket.mandate.basis.rules ?? [], control: { mode: state.mode, revision: state.revision, pending: state.operations.length } })
        const head = (await tx.get<number>('artifact-head', ticket.id))?.value
        if (head) {
          const manifest = (await tx.get<ArtifactManifest>('artifact-version', `${ticket.id}/${String(head).padStart(12, '0')}`))?.value
          if (manifest) { await access.artifact(tx, actor, ticket.id, 'read', manifest); artifacts.push(this.artifactDto(manifest, '')) }
        }
      }
      const signalRows = await tx.scan<FeishuSignal>('audit', { relation: 'signal.feishu', recent: true, limit: 100 })
      const signals = new Map(signalRows.map(row => [row.value.triggerId, row.value.kind]))
      const triggers = await tx.scan<Trigger>('trigger', { recent: true, limit: 100 }), events: LoomSnapshot['events'] = []
      const threads = new Map<string, Thread | undefined>()
      for (const row of triggers) {
        try { await access.source(tx, actor, row.value) } catch (error) { if (error instanceof AccessDenied) continue; throw error }
        const disposition = (await tx.get<TriggerDisposition & { contextOnly?: boolean }>('disposition', row.id))?.value
        const decision = disposition?.decisionId ? (await tx.get<Decision>('decision', disposition.decisionId))?.value : undefined
        const ref = row.value.threads[0], inputKind = signals.get(row.id)
        let processing: LoomSnapshot['events'][number]['processing'], batched = (decision?.triggerIds?.length ?? 0) > 1
        if (ref && !decision && disposition && !disposition.contextOnly && !disposition.filtered && !disposition.fanout.length) {
          const id = threadKey(ref)
          if (!threads.has(id)) threads.set(id, (await tx.get<Thread>('thread', id))?.value)
          const thread = threads.get(id)
          if (thread?.evaluating?.triggerIds.includes(row.id)) {
            processing = 'evaluating'
            batched = thread.evaluating.triggerIds.length > 1
          } else if (thread?.pending.includes(row.id)) processing = 'queued'
        }
        events.push({ id: row.id, text: row.value.text, at: row.value.at, chat: String(row.value.meta.chatId ?? ''), direct: row.value.meta.direct === true,
          actor: row.value.actor.id, contextOnly: disposition?.contextOnly === true, observed: !decision || decision.audit?.would_accept === true,
          decision: decision?.kind, processing, ...(inputKind && inputKind !== 'message' ? { inputKind } : {}), ...(batched ? { batched } : {}),
          taskIds: [...new Set([...disposition?.fanout ?? [], ...decision?.ticketId ? [decision.ticketId] : []])] })
      }
      const resultReceipts: LoomSnapshot['resultDeliveries'] = []
      for (const row of await tx.scan<LoomSnapshot['resultDeliveries'][number]>('kv', { relation: 'results.receipt', recent: true, limit: 100 })) {
        try { await access.ticket(tx, actor, row.value.ticketId) } catch (error) { if (error instanceof AccessDenied) continue; throw error }
        resultReceipts.push(row.value)
      }
      return { identity: { uid: actor, tenantKey: config.installation.tenantKey }, at: new Date(await tx.now()).toISOString(), paused: settings.paused, mode: settings.eval.mode,
        model: settings.executor.model?.model ?? 'Harness default',
        workspace: { mode: config.group ? 'group' : 'personal', operator: config.installation.operator, revision: config.row.value.revision, scopeFixed: true, canManage: actor === config.installation.operator,
          ...(config.group ? { group: { chatId: config.group.chatId, name: config.group.name, masters: config.group.masters } } : {}) },
        automation: { revision: config.row.value.revision, maxWorkers: settings.executor.maxWorkers, timeoutSeconds: settings.eval.timeoutSeconds },
        delivery: this.options.results ? (await this.options.results.viewIn(tx, actor)).setting : { mode: config.group ? 'feishu' : 'default', effectiveMode: 'feishu', revision: 0 }, resultDeliveries: resultReceipts,
        connection: { appId: config.installation.appId, name: config.installation.name, cardsEnabled: source.cardsEnabled, draftsEnabled: source.draftsEnabled,
          mailProvider: config.group ? 'unavailable-in-group' : 'configured-by-owner', chats: source.chats.map(chat => ({ ...chat, name: chat.name ?? chat.chatId })),
          health: [{ id: 'runtime', state: runtime.health.get()?.state ?? 'starting' }, { id: 'jobs', state: runtime.jobsHealth.get()?.state ?? 'starting' }, ...this.options.health?.() ?? []] },
        tasks, artifacts, drafts: [], events, policyRevision: config.row.value.revision,
        delegations: this.delegations(settings, actor, tasks), rules: settings.policy.rules.filter(rule => !rule.delegation).map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled, text: rule.instruction })),
        deliveries: [], ...(this.options.meetings && config.group ? { recordings: await this.options.meetings.list(tx, actor) } : {}), ...(rows.length === 100 ? { next: Buffer.from(JSON.stringify({ at: rows.at(-1)!.at, id: rows.at(-1)!.id })).toString('base64url') } : {}) }
    })
  }
  private artifactDto(manifest: ArtifactManifest, body: string): LoomArtifact {
    return { subject: manifest.subject, kind: manifest.kind, title: manifest.title, version: manifest.version, body, hash: manifest.body.sha256,
      author: manifest.author, at: manifest.at, sources: manifest.sources, ...(manifest.editedBy ? { editedBy: manifest.editedBy, editedVia: 'loom' } : {}),
      ...(manifest.filename ? { filename: manifest.filename } : {}), ...(manifest.file ? { file: manifest.file } : {}) }
  }
  async artifact(actor: string, id: string, version?: number) {
    const value = await this.options.artifacts.read(actor, id, version)
    return this.artifactDto(value.manifest, value.bytes.toString('utf8'))
  }
  async progress(actor: string, ticketId: string): Promise<LoomProgress> {
    return this.tx(async tx => {
      const ticket = await this.options.access.ticket(tx, actor, ticketId), fence = (await control(tx, ticketId)).value, assignment = ticket.assignments.at(-1)
      const rows = await tx.scan<ProgressEvent>('progress', { relation: ticketId, recent: true, limit: 1000 })
      const jobs = (await tx.jobs.list(1000)).filter(job => (job.value as { ticketId?: string }).ticketId === ticketId && job.held)
      const recovery = (await tx.get<{ state: string }>('grant', `native-recovery-status/${ticketId}`))?.value
      const reasons: Record<string, string> = { alive: '旧计算进程仍在运行；不会并行恢复同一任务。', unverifiable: '无法核验旧计算进程是否退出；需在原主机或由受信监督程序确认。',
        unsafe: '持久日志或执行结果需要核查；不会自动重放。', operations: '存在未确认的外部操作；先核对回执再恢复。', authorization: '任务来源或授权已变化；恢复被阻止。', control: '保持人工控制或暂停状态；不会自动接续。' }
      const detail = jobs.length ? reasons[recovery?.state ?? ''] ?? '后台作业已挂起，等待核查；不会自动重复执行。' : undefined
      const view = { mode: fence.mode, drained: fence.drained, detail,
        history: fence.history.map(item => ({ ...item, at: new Date(item.at).toISOString() })),
        operations: fence.operations.map(op => ({ ...op, name: 'managed', startedAt: new Date(op.at).toISOString() })) }
      const result = projectTaskProgress(ticket, rows.map(row => row.value), view)
      if (jobs.length && fence.mode === 'agent') { result.phase = 'blocked'; result.label = '等待后台作业核查'; result.unavailable = view.detail }
      return result
    })
  }
  private delegations(settings: Settings, actor: string, tasks: LoomTask[]): LoomDelegation[] {
    return settings.policy.rules.flatMap(rule => rule.delegation?.owner === actor ? [{ id: rule.id, title: rule.name, description: rule.instruction,
      enabled: rule.enabled, mode: rule.delegation.mode, chatIds: rule.delegation.chatIds, keywords: rule.delegation.keywords,
      ...(rule.delegation.codex ? { codex: rule.delegation.codex } : {}), ...(rule.delegation.meeting ? { meeting: rule.delegation.meeting } : {}),
      createdAt: rule.delegation.createdAt, updatedAt: rule.delegation.updatedAt, available: true,
      scopes: rule.delegation.chatIds.map(chatId => ({ chatId, name: chatId })), taskIds: tasks.filter(task => task.ruleIds.includes(rule.id)).map(task => task.id) }] : [])
  }
  private async save(tx: StateTransaction, actor: string, expected: number, settings: Settings) {
    const config = await this.options.access.user(tx, actor), current = config.row
    if (current.value.revision !== expected) throw new StateConflict('Settings version changed')
    const record: SettingsRecord = { revision: expected + 1, settings: SettingsSchema.parse(settings), at: new Date(await tx.now()).toISOString(), actor }
    await tx.put('settings', 'current', record, current.revision)
    await tx.put('settings', `version/${String(record.revision).padStart(12, '0')}`, record, 0)
    await tx.put('audit', `settings/${randomUUID()}`, { actor, at: record.at, revision: record.revision, from: policyVersion(config.settings), to: policyVersion(settings) }, 0)
    const registry = new SourceRegistry(() => record.settings); registry.register(feishuKind)
    const policy = settingsPolicy(record.settings, registry), active = await tx.scan<Ticket>('ticket', { active: true, limit: 1000 })
    if (active.length === 1000) throw new StateConflict('Revalidate active tasks in an explicit batch before changing this large workspace')
    for (const row of active) if (!policy.revalidate(row.value.mandate)) {
      const fence = await control(tx, row.id)
      if (fence.value.mode === 'agent') await changeControl(tx, row.id, fence.value.revision, 'pause', actor)
    }
    if (policyVersion(config.settings) !== policy.version) {
      const scopeFor = (value: Settings) => { const registry = new SourceRegistry(() => value); registry.register(feishuKind); return registry }
      const effects = policyEffects(active.map(row => row.value), config.settings, record.settings, scopeFor)
      await tx.jobs.enqueue('policy.changed', String(record.revision), { from: policyVersion(config.settings), to: policy.version, effects: [...effects] })
    }
    return { revision: record.revision, message: '配置已保存；后续执行将使用当前授权。' }
  }
  async delegation(actor: string, id: string | undefined, body: unknown, toggle = false) {
    const input = toggle ? z.object({ revision: rev, enabled: z.boolean() }).strict().parse(body)
      : DelegationInput.extend({ revision: rev, requestId: z.uuid().optional() }).strict().parse(body)
    const creationId = 'requestId' in input && typeof input.requestId === 'string' ? input.requestId : undefined
    const result = await this.tx(async tx => {
      const config = await this.options.access.user(tx, actor), settings = structuredClone(config.settings), at = new Date(await tx.now()).toISOString()
      const old = id ? settings.policy.rules.find(rule => rule.id === id) : undefined
      if (id && (!old?.delegation || old.delegation.owner !== actor)) throw new AccessDenied('Delegation is unavailable')
      if (!id && (toggle || !('requestId' in input) || !input.requestId)) throw new Error('Creation requestId required')
      const ruleId = id ?? `loom-delegate-${key('standing', creationId!).slice(0, 20)}`
      if (!old && settings.policy.rules.filter(rule => rule.delegation?.owner === actor).length >= 20) throw new Error('At most 20 delegations per owner')
      let rule: Rule
      if (toggle) rule = { ...old!, enabled: input.enabled, delegation: { ...old!.delegation!, updatedAt: at, ...(input.enabled ? { since: at } : {}) } }
      else {
        const fields = DelegationInput.parse(input)
        if (fields.codex && (!fields.codexConsent || config.group) || fields.meeting && (!fields.meetingConsent || !config.group || fields.meeting.provider !== asrInfo().provider)) throw new AccessDenied('Delegation connector consent or mode is invalid')
        if (fields.chatIds.some(chatId => !feishuSettings(config.registry).chats.some(chat => chat.chatId === chatId && chat.listen === 'all'))
          || config.group && fields.chatIds.some(chatId => chatId !== config.group!.chatId)) throw new AccessDenied('Delegation source is not authorized')
        if (old && (!!old.delegation?.codex !== !!fields.codex || !!old.delegation?.meeting !== !!fields.meeting)) throw new StateConflict('Cannot change delegation source type')
        rule = RuleSchema.parse({ id: ruleId, name: fields.title, instruction: fields.description ?? fields.title, enabled: fields.enabled,
          delegation: { owner: actor, ...(config.group ? { groupSpace: config.group.spaceId } : {}), chatIds: fields.chatIds, keywords: fields.keywords, mode: fields.mode,
            ...(fields.codex ? { codex: fields.codex } : {}), ...(fields.meeting ? { meeting: fields.meeting } : {}), createdAt: old?.delegation?.createdAt ?? at,
            updatedAt: at, since: at, requestId: old?.delegation?.requestId ?? creationId!, initialHash: key(JSON.stringify(fields)) } })
      }
      const existing = settings.policy.rules.find(value => value.id === ruleId)
      if (!id && existing) {
        if (existing.delegation?.owner !== actor || existing.delegation.initialHash !== rule.delegation?.initialHash) throw new StateConflict('Delegation request reused with changed content')
        return { id: ruleId, revision: config.row.value.revision, replay: true }
      }
      settings.policy.rules = [...settings.policy.rules.filter(value => value.id !== ruleId), rule]
      await tx.put('delegation', ruleId, rule, (await tx.get('delegation', ruleId))?.revision ?? 0, { relation: actor, active: rule.enabled })
      return { id: ruleId, ...await this.save(tx, actor, input.revision, settings) }
    })
    this.options.runtime.consumer.kick(); return result
  }
  private async members(actor: string, chatId: string) {
    const before = await this.tx(tx => this.options.access.user(tx, actor, true))
    if (!before.group || before.group.chatId !== chatId || !this.options.wire) throw new AccessDenied('Only current installed group membership is available')
    const result = z.object({ users: z.array(z.object({ member_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), name: z.string().max(100).optional() })).max(10_000), has_more: z.literal(false), truncations: z.array(z.unknown()).max(0).optional() }).parse(
      await this.options.wire.lark(['im', '+chat-members-list', '--chat-id', chatId, '--member-types', 'user', '--page-all', '--page-limit', '0'], AbortSignal.timeout(60_000)))
    await this.tx(async tx => { const current = await this.options.access.user(tx, actor, true); if (current.row.value.revision !== before.row.value.revision) throw new StateConflict('Workspace changed while verifying membership') })
    return result.users.map(user => ({ id: user.member_id, name: user.name }))
  }
  async handle(actor: string, method: string, path: string[], query: Record<string, string>, body: unknown, requestId: string) {
    const [kind, id, action] = path, identity = { id: requestId, userId: actor }
    if (method === 'GET' && !kind) return this.snapshot(actor, query.after)
    if (method === 'GET' && kind === 'workspace' && id === 'members') return { members: await this.members(actor, z.string().regex(/^oc_[A-Za-z0-9]+$/).parse(query.chatId)) }
    if (method === 'GET' && kind === 'workspace' && !id) return (await this.snapshot(actor)).workspace
    if (method === 'PUT' && kind === 'workspace' && id === 'source') {
      const input = z.object({ enabled: z.boolean(), revision: rev }).strict().parse(body)
      const value = await this.tx(async tx => {
        const config = await this.options.access.user(tx, actor, true), settings = structuredClone(config.settings)
        if (input.enabled && !settings.sources.feishu!.enabled) {
          const installation = (await tx.get<import('./access.ts').Installation>('installation', this.options.access.installationId))!
          await tx.put('installation', installation.id, { ...installation.value, since: new Date(await tx.now()).toISOString() }, installation.revision)
        }
        settings.sources.feishu!.enabled = input.enabled
        if (!input.enabled) settings.paused = true
        return this.save(tx, actor, input.revision, settings)
      })
      this.options.runtime.consumer.kick(); return value
    }
    if (method === 'PUT' && kind === 'workspace' && !id) {
      const input = z.object({ mode: z.literal('group'), revision: rev, chatId: z.string(), masters: z.array(GroupMasterSchema).min(1).max(20) }).strict().parse(body)
      const members = await this.members(actor, input.chatId), ids = new Set(input.masters.map(person => person.id))
      if (ids.size !== input.masters.length || input.masters.some(person => !members.some(member => member.id === person.id))) throw new StateConflict('Select current verified group members without duplicates')
      return this.tx(async tx => { const config = await this.options.access.user(tx, actor, true), settings = structuredClone(config.settings)
        if (!config.group || config.group.chatId !== input.chatId) throw new AccessDenied('Changing group or personal mode requires an explicitly separate server scope')
        settings.policy.sources.feishu!.workspace = GroupWorkspaceSchema.parse({ ...config.group, masters: members.filter(member => ids.has(member.id)) })
        return this.save(tx, actor, input.revision, settings) })
    }
    if (method === 'POST' && kind === 'tasks' && id && action === 'recovery') {
      z.object({}).strict().parse(body)
      await this.tx(async tx => { await this.options.access.user(tx, actor, true); await this.options.access.ticket(tx, actor, id) })
      if (!this.options.recover) throw new StateConflict('Native recovery inspector is unavailable')
      await this.options.recover(id)
      await this.tx(async tx => { await this.options.access.user(tx, actor, true); await this.options.access.ticket(tx, actor, id) })
      this.options.runtime.consumer.kick()
      return this.progress(actor, id)
    }
    if (method === 'GET' && kind === 'tasks' && id && action === 'progress') return this.progress(actor, id)
    if (method === 'GET' && kind === 'artifacts' && id && path.length === 2) {
      const artifact = await this.artifact(actor, id, query.version ? z.coerce.number().int().positive().parse(query.version) : undefined)
      const versions = await this.tx(async tx => {
        await this.options.access.artifact(tx, actor, id, 'read')
        const rows = await tx.scan<ArtifactManifest>('artifact-version', { relation: id, limit: 100 })
        for (const row of rows) await this.options.access.artifact(tx, actor, id, 'read', row.value)
        return rows.map(({ value }) => ({ version: value.version, hash: value.body.sha256, author: value.author, at: value.at, ...(value.editedBy ? { editedVia: 'loom' } : {}) }))
      })
      return { artifact, versions }
    }
    if (method === 'GET' && kind === 'artifacts' && id && action === 'export') {
      const value = await this.options.artifacts.read(actor, id, query.version ? z.coerce.number().int().positive().parse(query.version) : undefined, true)
      return { filename: value.manifest.filename ?? 'result.txt', content: value.bytes.toString('base64'), encoding: 'base64', mediaType: value.manifest.file?.mediaType ?? 'text/plain; charset=utf-8', sha256: value.manifest.fileBlob?.sha256 ?? value.manifest.body.sha256 }
    }
    if (method === 'PUT' && kind === 'artifacts' && id) {
      const input = z.object({ version: rev, body: z.string().min(1).max(100_000) }).strict().parse(body)
      await this.options.artifacts.publish(identity, { subject: id, expectedVersion: input.version, body: input.body, author: 'human' })
      return this.artifact(actor, id)
    }
    if (method === 'POST' && kind === 'tasks' && id && action === 'control') {
      const input = z.object({ revision: rev, action: z.enum(['pause', 'resume', 'takeover', 'return']) }).strict().parse(body)
      return this.options.runtime.app.changeControl(identity, id, input.revision, input.action)
    }
    if (method === 'POST' && kind === 'tasks' && id && action === 'note') {
      const input = z.object({ text: z.string().min(1).max(20_000) }).strict().parse(body); return this.options.runtime.app.note(identity, id, input.text)
    }
    if (method === 'POST' && kind === 'tasks' && id && action === 'stop') return this.options.runtime.app.stopTicket(identity, id)
    if (method === 'POST' && kind === 'tasks' && id && action === 'retry') return this.options.runtime.app.retryTicket(identity, id)
    if (method === 'POST' && kind === 'tasks' && id && action === 'rerun') {
      const input = z.object({ note: z.string().min(1).max(20_000) }).strict().parse(body)
      return this.options.runtime.app.rerunTicket(identity, id, input.note)
    }
    if (method === 'POST' && kind === 'tasks' && id && action === 'reconcile') return this.tx(async tx => { await reconcileOutcome(tx, this.options.access, actor, id, Reconciliation.parse(body)); return { message: '已记录核查结果；任务仍保持当前控制状态，请重新查看后明确继续。' } })
    if (method === 'PUT' && kind === 'pause') {
      const input = z.object({ revision: rev, paused: z.boolean() }).strict().parse(body)
      return this.tx(async tx => { const config = await this.options.access.user(tx, actor, true)
        if ((await tx.get<{ executionEnabled?: boolean }>('migration', 'status'))?.value.executionEnabled === false) throw new StateConflict('迁移仍处于停写核查阶段，请先完成管理员激活。')
        const settings = structuredClone(config.settings); settings.paused = input.paused
        return this.save(tx, actor, input.revision, settings) })
    }
    if (kind === 'delegations' && (method === 'POST' || method === 'PUT' || method === 'PATCH')) return this.delegation(actor, id, body, method === 'PATCH')
    if ((method === 'PATCH' && kind === 'mode') || method === 'PUT' && kind === 'automation') {
      const input = z.object({ revision: rev, mode: z.enum(['off', 'observe', 'auto']) }).strict().parse(body)
      return this.tx(async tx => { const config = await this.options.access.user(tx, actor, true); const settings = structuredClone(config.settings); settings.eval.mode = input.mode; return this.save(tx, actor, input.revision, settings) })
    }
    if (method === 'PATCH' && kind === 'rules' && id) {
      const input = z.object({ revision: rev, enabled: z.boolean() }).strict().parse(body)
      return this.tx(async tx => {
        const config = await this.options.access.user(tx, actor, true), settings = structuredClone(config.settings)
        const rule = settings.policy.rules.find(value => value.id === id && !value.delegation)
        if (!rule) throw new StateConflict('Unknown base rule'); rule.enabled = input.enabled
        return this.save(tx, actor, input.revision, settings)
      })
    }
    if (this.options.results && (kind === 'delivery' || kind === 'tasks' && id && action === 'delivery')) {
      const taskId = kind === 'tasks' ? id : undefined
      if (method === 'GET') return taskId ? this.options.results.view(actor, taskId) : (await this.options.results.view(actor)).setting
      if (method === 'PUT') return this.options.results.save(actor, z.object({ mode: z.enum(['default', 'feishu', 'none', 'mail']), revision: rev, mailboxKey: z.string().optional() }).strict().parse(body), taskId)
    }
    throw new AccessDenied('Product operation is unavailable')
  }
}
