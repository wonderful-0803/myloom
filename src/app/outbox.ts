/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'
import type { TaskControls } from './task-control.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  readonly controls?: TaskControls
  /** Revalidates all inherited source permissions before a queued result leaves the process. */
  canDeliver?(ticketId: string): boolean
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  private readonly inflight = new Set<string>()
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => {
      if (!store.receipts.add(message)) return
      if (message.ticketId && this.host.controls?.held(message.ticketId)) store.receipts.settle(message, 'controlChanged')
      else if (message.ticketId && this.host.canDeliver?.(message.ticketId) === false) store.receipts.settle(message, 'channelIgnored')
      else effects.enqueue('reply', message.id, {})
    })
  }
  /** Tombstone queued results on a handover; never replay them after human edits or resume. */
  hold(ticketId: string): void {
    for (const receipt of this.host.store.receipts.waiting()) {
      if (receipt.ticketId !== ticketId || this.inflight.has(receipt.id)) continue
      this.host.store.atomic(() => {
        this.host.store.receipts.settle(receipt, 'controlChanged'); this.host.effects.cancel('reply', receipt.id)
      })
    }
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (receipt.ticketId && this.host.controls?.held(receipt.ticketId)) throw new Later('Task is paused or under human control')
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    if (receipt.ticketId && this.host.canDeliver?.(receipt.ticketId) === false) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    this.inflight.add(id)
    try {
      const send = async (signal?: AbortSignal) => {
        if (receipt.ticketId && this.host.canDeliver?.(receipt.ticketId) === false) { store.receipts.settle(receipt, 'channelIgnored'); return }
        const result = await sources.send(receipt, signal ? commands.withSignal(signal) : commands)
        if (result === 'waiting') throw new Later('The Source is not installed')
        store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
      }
      if (receipt.ticketId && this.host.controls) await this.host.controls.run(receipt.ticketId, `reply:${id}`, send)
      else await send()
    } catch (error) {
      // A cancelled send may already have reached Feishu. It stays in control's unknown leases; never replay its stale body.
      if (receipt.ticketId && this.host.controls?.held(receipt.ticketId)) store.receipts.settle(receipt, 'controlChanged')
      throw error
    } finally { this.inflight.delete(id) }
  }
}
