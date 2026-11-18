/** Feishu source adapter: one installation lease, committed cursors, bounded recovery and existing Trigger normalization. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { FeishuBot } from '../deployment.ts'
import { groupMaster } from '../group-mode.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { feishuTrigger, HistoricalMessageSchema, historyEvent, HistoryPageSchema } from '../sources/feishu-trigger.ts'
import type { ProductAccess } from './access.ts'
import type { AsyncTaskRuntime } from './runtime.ts'
import type { StateStore, StateScope, SessionLease } from './ports.ts'
import { hash } from './hash.ts'
import { StateConflict } from './ports.ts'
import type { Trigger } from '../core/index.ts'
import { FEISHU_INTAKE_WINDOW_MS, recordFeishuSignal } from './signals.ts'

export interface FeishuWire {
  verify?(signal: AbortSignal): Promise<void>
  /** Finite watch. Must wait for the CLI ready marker, backpressure stdout and stop gracefully on abort. */
  events(signal: AbortSignal, ready?: () => void): AsyncIterable<unknown>
  lark<T>(args: string[], signal: AbortSignal): Promise<T>
  file?(target: { messageId?: string; userId?: string; threaded: boolean }, filename: string, bytes: Uint8Array, requestId: string, signal: AbortSignal): Promise<string>
  download?(messageId: string, fileKey: string, folder: string, signal: AbortSignal): Promise<string>
}
export interface FeishuSourceOptions {
  store: StateStore; scope: StateScope; access: ProductAccess; runtime: AsyncTaskRuntime; bot: FeishuBot; wire: FeishuWire
  command?(trigger: Trigger, lease: SessionLease): Promise<boolean>
  health?(state: 'ready' | 'error' | 'paused' | 'starting', detail: string): void
  /** A shared broker holds the original installation lease; group subscriptions use their own scoped lease. */
  leaseId?: string
}
interface ChatCursor { recoveredThrough: string; topics: string[]; threadRoots?: Record<string, string> }
interface IntakeBatch { id: string; lastAt: string }
/** Authenticates the configured bot installation and persists events before moving any recovery cursor. */
export class DurableFeishuSource {
  private readonly owner = randomUUID()
  constructor(private options: FeishuSourceOptions) {}
  private async batchThread(trigger: Trigger, lease: SessionLease): Promise<string | undefined> {
    const chatId = typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : undefined
    if (!chatId || trigger.meta.direct === true || trigger.addressed || trigger.meta.rootId || trigger.meta.parentId || trigger.meta.threadId) return undefined
    const { store, scope } = this.options, id = `batch/${chatId}`
    return store.transaction(scope, async tx => {
      await tx.leases.assert(lease)
      const existing = await tx.get<Trigger>('trigger', trigger.id), existingBatch = (existing?.value.threads ?? []).find(ref => ref.id.includes(':batch:'))?.id
      if (existing) return existingBatch
      const row = await tx.get<IntakeBatch>('source-state', id), previous = row?.value
      const elapsed = previous ? Date.parse(trigger.at) - Date.parse(previous.lastAt) : Infinity
      const batchId = previous && elapsed >= 0 && elapsed <= FEISHU_INTAKE_WINDOW_MS ? previous.id : `feishu:batch:${chatId}:${trigger.id}`
      await tx.put('source-state', id, { id: batchId, lastAt: trigger.at }, row?.revision ?? 0, { relation: 'source-batch', active: true, at: trigger.at })
      return batchId
    })
  }
  async ingest(raw: unknown, lease: SessionLease): Promise<'stored' | 'duplicate' | 'filtered'> {
    const { store, scope, access, bot, runtime } = this.options
    const trigger = feishuTrigger(raw, bot.botId, bot.appId)
    if (!trigger || !trigger.human) return 'filtered'
    const config = await store.transaction(scope, async tx => {
      await tx.leases.assert(lease)
      const config = await access.configuration(tx)
      if (config.installation.appId !== bot.appId || config.installation.botId !== bot.botId) throw new StateConflict('Verified bot identity differs from installed mapping')
      return config
    })
    if (!config.registry.scope({ source: trigger.source, meta: trigger.meta }).listened) return 'filtered'
    if (Date.parse(trigger.at) < Math.max(Date.parse(config.group?.since ?? config.installation.since), Date.parse(config.installation.since))) return 'filtered'
    if (config.group) trigger.meta.loomSpace = config.group.spaceId
    // Feishu's live event and history APIs use different root IDs for replies in a
    // topic. Persist the topic-id -> canonical root mapping so both paths address the
    // same Loom Thread and can resume an ended ticket.
    if (typeof trigger.meta.threadId === 'string') {
      const threadId = trigger.meta.threadId
      const recovery = isRecoveryTrigger(trigger)
      const id = `history/${trigger.meta.chatId}`
      const canonical = await store.transaction(scope, async tx => {
        await tx.leases.assert(lease)
        await access.source(tx, config.installation.operator, trigger)
        const row = await tx.get<ChatCursor>('source-state', id), roots = { ...row?.value.threadRoots }
        const root = roots[threadId] ?? (typeof trigger.meta.rootId === 'string' ? trigger.meta.rootId
          : typeof trigger.meta.parentId === 'string' ? trigger.meta.parentId : String(trigger.meta.messageId))
        roots[threadId] = root
        const topics = new Set(row?.value.topics ?? []); topics.add(threadId)
        if (topics.size > 500) throw new StateConflict('Topic registry requires an explicit recovery partition')
        await tx.put('source-state', id, { recoveredThrough: row?.value.recoveredThrough ?? config.group?.since ?? config.installation.since,
          topics: [...topics], threadRoots: roots }, row?.revision ?? 0)
        return root
      })
      trigger.meta = { ...trigger.meta, rootId: canonical }
      if (recovery) Object.defineProperty(trigger.meta, 'history', { value: true, enumerable: false })
      trigger.threads = trigger.threads.map(ref => ref.source === 'feishu' ? { ...ref, id: `${trigger.meta.chatId}:${canonical}` } : ref)
    }
    const batchThread = await this.batchThread(trigger, lease)
    if (batchThread) trigger.threads = [{ source: 'feishu', id: batchThread }, ...trigger.threads]
    // CLI live attachments use display markers; history uses JSON bodies.
    // Preserve the first committed representation only when BOTH identify exactly the same attachment
    // and every other normalized field is unchanged. Never relax the content/version guard.
    const sourceEventId = typeof (trigger.meta as { messageId?: unknown }).messageId === 'string' ? String((trigger.meta as { messageId: string }).messageId) : undefined
    const previous = await store.transaction(scope, async tx => {
      await tx.leases.assert(lease)
      const triggerRow = await tx.get<Trigger>('trigger', trigger.id)
      // A previous process may have committed the source-event fence before
      // its trigger transaction became visible. Recovery input can safely
      // converge on that durable fence without re-running the task.
      const sourceRow = sourceEventId ? await tx.get<{ parameterHash: string }>('source-event', hash({ installationId: access.installationId, sourceEventId })) : undefined
      return { trigger: triggerRow, source: sourceRow }
    })
    const priorTrigger = previous.trigger
    if (previous.source && isRecoveryTrigger(trigger)) return 'duplicate'
    const previousRepresentation = priorTrigger && representationKey(priorTrigger.value.text), currentRepresentation = representationKey(trigger.text)
    if (priorTrigger && priorTrigger.value.text !== trigger.text && previousRepresentation !== undefined && previousRepresentation === currentRepresentation) {
      // Keep the first representation only when all semantic fields match after
      // normalizing the transport body.
      if (sourceHash(priorTrigger.value, priorTrigger.value.text) === sourceHash(trigger, priorTrigger.value.text)) {
        trigger.text = priorTrigger.value.text
        return 'duplicate'
      }
    }
    // A history replay carries a topic marker; once the same live message was
    // committed, its message ID is authoritative even if Feishu rewrites the
    // mention/attachment body while backfilling the topic.
    // A shared broker may have queued the live representation while this
    // subscription was reconciling history. Feishu can normalize mentions,
    // attachments and topic fields differently on those two read paths. The
    // message ID + author + timestamp still identify one immutable intake;
    // keep the first committed representation and do not turn reconciliation
    // into a source-health failure. Direct calls without the recovery marker
    // retain the strict changed-content guard covered by the contract tests.
    if (priorTrigger && sameMessageIdentity(priorTrigger.value, trigger)
      && (isRecoveryTrigger(priorTrigger.value) || isRecoveryTrigger(trigger))) return 'duplicate'
    // Recovery can see a message already accepted from the live stream. The history API
    // adds an optional topic marker, so compare the normalized source before handing it to
    // the execution registry; an identical message must be a duplicate, not a new execution.
    if (priorTrigger && sourceHash(priorTrigger.value, priorTrigger.value.text) === sourceHash(trigger, trigger.text)) return 'duplicate'
    const owner = config.group ? groupMaster(config.group, trigger.actor.id) : config.settings.policy.sources.feishu?.allowed.some(value => value.id === trigger.actor.id)
    if (!owner && trigger.meta.direct === true) return 'filtered'
    if (!owner) {
      // Group discussion is context, not authority to create or resume work.
      return store.transaction(scope, async tx => {
        await tx.leases.assert(lease)
        const current = await access.configuration(tx)
        if (current.group?.spaceId !== config.group?.spaceId || !current.registry.scope({ source: trigger.source, meta: trigger.meta }).listened) return 'filtered'
        const prior = await tx.get<Trigger>('trigger', trigger.id)
        if (prior) {
          if (sourceHash(prior.value, prior.value.text) !== sourceHash(trigger, trigger.text)) throw new StateConflict(`Source message changed (${trigger.id})`)
          return 'duplicate'
        }
        await tx.put('trigger', trigger.id, trigger, 0)
        await tx.put('disposition', trigger.id, { fanout: [], at: trigger.at, contextOnly: true }, 0)
        await recordFeishuSignal(tx, trigger)
        return 'stored'
      })
    }
    if (await this.options.command?.(trigger, lease)) {
      await store.transaction(scope, async tx => { await tx.leases.assert(lease); await recordFeishuSignal(tx, trigger) })
      return 'stored'
    }
    return runtime.receive({ id: `${trigger.id}/${lease.epoch}`, userId: trigger.actor.id }, config.installation.id, String(trigger.meta.messageId), trigger, lease)
  }
  async recover(lease: SessionLease, signal: AbortSignal): Promise<void> {
    const { store, scope, access, wire } = this.options
    const config = await store.transaction(scope, async tx => { await tx.leases.assert(lease); return access.configuration(tx) })
    if (!config.settings.sources.feishu?.enabled) throw new StateConflict('Source disabled before history recovery')
    const chats = feishuSettings(config.registry).chats.filter(chat => !config.group || chat.chatId === config.group.chatId)
    for (const chat of chats) {
      const id = `history/${chat.chatId}`, cursor = await store.transaction(scope, tx => tx.get<ChatCursor>('source-state', id))
      const since = cursor?.value.recoveredThrough ?? config.group?.since ?? config.installation.since
      const until = new Date().toISOString(), start = String(Math.floor(Math.max(Date.parse(config.installation.since), Date.parse(config.group?.since ?? config.installation.since), Date.parse(since) - 60_000) / 1000))
      const topics = new Set(cursor?.value.topics ?? [])
      const scheduled = new Set(topics), containers = [{ type: 'chat', id: chat.chatId }, ...[...topics].map(id => ({ type: 'thread', id }))]
      for (const container of containers) {
        let page: string | undefined; const seen = new Set<string>()
        do {
          signal.throwIfAborted()
          await store.transaction(scope, async tx => { await tx.leases.assert(lease); if (!(await access.configuration(tx)).settings.sources.feishu?.enabled) throw new StateConflict('Source disabled during history recovery') })
          const params = { container_id_type: container.type, container_id: container.id, start_time: start, end_time: String(Math.floor(Date.parse(until) / 1000)), sort_type: 'ByCreateTimeAsc', page_size: 50, ...(page ? { page_token: page } : {}) }
          const result = HistoryPageSchema.parse(await wire.lark(['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(params)], signal))
          if (result.items.length > 50) throw new Error('History page exceeds declared limit')
          for (const item of result.items) {
            const message = HistoricalMessageSchema.parse(item)
            if (message.chat_id !== chat.chatId || container.type === 'thread' && message.thread_id !== container.id) throw new StateConflict('Feishu returned another conversation')
            if (message.deleted) continue
            if (message.thread_id) {
              topics.add(message.thread_id)
              if (!scheduled.has(message.thread_id)) { scheduled.add(message.thread_id); containers.push({ type: 'thread', id: message.thread_id }) }
            }
            if (topics.size > 500) throw new StateConflict('Too many active topics; explicit recovery partition required')
            await this.ingest(historyEvent(message, chat.chatId, false), lease)
          }
          if (result.has_more && (!result.page_token || seen.has(result.page_token))) throw new StateConflict('History cursor did not advance')
          page = result.has_more ? result.page_token : undefined; if (page) seen.add(page)
          if (seen.size > 1000) throw new StateConflict('Recovery exceeds bounded page budget; cursor retained')
        } while (page)
      }
      await store.transaction(scope, async tx => {
        await tx.leases.assert(lease)
        const active = await access.configuration(tx)
        if (active.row.value.revision !== config.row.value.revision) throw new StateConflict('Source authorization changed during history recovery')
        const current = await tx.get<ChatCursor>('source-state', id)
        if (current?.value.topics.some(topic => !scheduled.has(topic))) throw new StateConflict('A new topic arrived during recovery; retaining the earlier watermark')
        await tx.put('source-state', id, { recoveredThrough: until, topics: [...topics], ...(current?.value.threadRoots ? { threadRoots: current.value.threadRoots } : {}) }, current?.revision ?? 0)
      })
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    const { store, scope, access, wire } = this.options, sessionId = this.options.leaseId ?? `source/${access.installationId}`
    while (!signal.aborted) {
      let enabled: boolean | undefined, lease: SessionLease | undefined
      try {
        enabled = await store.transaction(scope, async tx => (await access.configuration(tx)).settings.sources.feishu?.enabled)
        if (enabled) lease = await store.transaction(scope, tx => tx.leases.acquire(sessionId, this.owner, 30_000))
      } catch {
        if (!signal.aborted) this.options.health?.('error', 'Source state unavailable; no new events dispatched')
        await delay(1000, undefined, { signal }).catch(() => {}); continue
      }
      if (!enabled) { this.options.health?.('paused', 'Source is disabled'); await delay(3000, undefined, { signal }).catch(() => {}); continue }
      if (!lease) { await delay(3000, undefined, { signal }).catch(() => {}); continue }
      const running = new AbortController(), stop = () => running.abort(), renewal = { tail: Promise.resolve() }
      signal.addEventListener('abort', stop, { once: true })
      const timer = setInterval(() => {
        renewal.tail = renewal.tail.then(async () => {
          const next = await store.transaction(scope, async tx => { if (!(await access.configuration(tx)).settings.sources.feishu?.enabled) throw new StateConflict('Source disabled'); return tx.leases.renew(lease!, 30_000) })
          if (!next) throw new Error('Source lease lost'); lease = next
        }).catch(() => { running.abort(); this.options.health?.('error', 'Source ownership or authorization unavailable') })
      }, 5000)
      try {
        await wire.verify?.(running.signal)
        await this.recover(lease, running.signal)
        this.options.health?.('starting', 'Waiting for event consumer readiness')
        for await (const raw of wire.events(running.signal, () => this.options.health?.('ready', 'Listening to the installed bot'))) await this.ingest(raw, lease)
      } catch (error) {
        if (!signal.aborted) this.options.health?.('error', `Feishu source interrupted; persisted recovery cursor retained: ${String(error)}`)
      }
      finally {
        running.abort(); clearInterval(timer); signal.removeEventListener('abort', stop); await renewal.tail
        await store.transaction(scope, tx => tx.leases.release(lease!)).catch(() => {})
      }
      if (!signal.aborted) await delay(1000, undefined, { signal }).catch(() => {})
    }
  }
}

/** Hash a Feishu source while ignoring the optional live-vs-history topic marker. */
function sourceHash(value: Trigger, text: string): string {
  const meta = { ...value.meta }
  delete meta.threadId
  return hash({ ...value, meta, text })
}

function sameMessageIdentity(a: Trigger, b: Trigger): boolean {
  const am = a.meta as { chatId?: unknown; messageId?: unknown }, bm = b.meta as { chatId?: unknown; messageId?: unknown }
  const sameAddress = am.chatId === bm.chatId && am.messageId === bm.messageId && a.actor.id === b.actor.id
  // History APIs round timestamps to seconds while the live event may retain
  // milliseconds. The message identity remains authoritative on the recovery
  // path; ordinary live inputs keep the exact timestamp check.
  return sameAddress && (a.at === b.at || isRecoveryTrigger(a) || isRecoveryTrigger(b))
}

function isRecoveryTrigger(value: Trigger): boolean {
  return (value.meta as { history?: unknown }).history === true
}


/** Identifies transport-only representations of the same image/file/audio attachment. */
function representationKey(text: string): string | undefined {
  const marker = /^\[Image: (img_[A-Za-z0-9_-]+)\]$/.exec(text)
  if (marker) return `image:${marker[1]}`
  const xml = /^<(image|file|audio)\s+key="([A-Za-z0-9_-]+)"(?:\s+[^>]*)?\/?>(?:<\/\1>)?$/.exec(text)
  if (xml) return `${xml[1]}:${xml[2]}`
  try {
    const value = JSON.parse(text) as unknown
    const image = z.object({ image_key: z.string().regex(/^img_[A-Za-z0-9_-]+$/) }).passthrough().safeParse(value)
    if (image.success && !('caption' in image.data)) return `image:${image.data.image_key}`
    const file = z.object({ file_key: z.string().regex(/^(?:file|audio)_[A-Za-z0-9_-]+$/) }).passthrough().safeParse(value)
    if (file.success) return `${file.data.file_key.startsWith('audio_') ? 'audio' : 'file'}:${file.data.file_key}`
  }
  catch { return }
  return
}
