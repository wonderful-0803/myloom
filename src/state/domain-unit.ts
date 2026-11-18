/** A bounded, transaction-local identity map for the existing synchronous domain reducer.
 * Async I/O is explicit in load()/flush(). This map is discarded after each command, never an authoritative state mirror.
 */
import { MemoryRepositories, threadKey } from '../core/index.ts'
import type { Decision, Repositories, Thread, Ticket, Trigger, TriggerDisposition } from '../core/index.ts'
import type { Family, StateRecord, StateTransaction } from './ports.ts'
import { StateConflict } from './ports.ts'

type DomainFamily = 'trigger' | 'disposition' | 'thread' | 'ticket' | 'decision'
type Root = { family: Exclude<DomainFamily, 'disposition'>; id: string }
/** Loads only a bounded connected command aggregate and flushes the existing domain reducer's writes atomically. */
export class DomainUnit {
  private memory = new MemoryRepositories()
  private loaded = new Map<string, StateRecord<unknown> | undefined>()
  private dirty = new Map<string, { family: DomainFamily; id: string; value: unknown }>()
  private decisionsLoaded = new Set<string>()
  private readonly maxRecords = 1000
  private check(family: DomainFamily, id: string): void {
    if (!this.loaded.has(JSON.stringify([family, id])) && !this.dirty.has(JSON.stringify([family, id])))
      throw new Error(`Domain aggregate was not loaded: ${family}/${id}`)
  }
  readonly repo: Repositories = {
    atomic: work => this.memory.atomic(work),
    triggers: {
      get: id => { this.check('trigger', id); return this.memory.triggers.get(id) },
      save: value => { this.memory.triggers.save(value); this.save('trigger', value.id, value) },
      disposition: id => { this.check('disposition', id); return this.memory.triggers.disposition(id) },
      saveDisposition: (id, value) => { this.memory.triggers.saveDisposition(id, value); this.save('disposition', id, value) },
    },
    threads: {
      get: id => { this.check('thread', id); return this.memory.threads.get(id) },
      save: value => { this.memory.threads.save(value); this.save('thread', value.key, value) },
      list: () => { throw new Error('Unbounded thread command has not been migrated') },
      active: () => this.memory.threads.active(),
    },
    tickets: {
      get: id => { this.check('ticket', id); return this.memory.tickets.get(id) },
      save: value => { this.memory.tickets.save(value); this.save('ticket', value.id, value) },
      list: () => { throw new Error('Unbounded ticket command has not been migrated; use an explicit ticket') },
      open: () => this.memory.tickets.open(),
      active: () => this.memory.tickets.active(),
    },
    decisions: {
      get: id => { this.check('decision', id); return this.memory.decisions.get(id) },
      save: value => { this.memory.decisions.save(value); this.save('decision', value.id, value) },
      byThread: id => {
        if (!this.decisionsLoaded.has(id)) throw new Error('Decision history was not loaded')
        return this.memory.decisions.byThread(id)
      },
    },
  }
  private save(family: DomainFamily, id: string, value: unknown): void { this.dirty.set(JSON.stringify([family, id]), { family, id, value: structuredClone(value) }) }
  async load(tx: StateTransaction, roots: readonly Root[]): Promise<void> {
    const queue: { family: DomainFamily; id: string }[] = [...roots]
    const push = (family: DomainFamily, id: string) => { queue.push({ family, id }) }
    while (queue.length) {
      const { family, id } = queue.shift()!, cacheKey = JSON.stringify([family, id])
      if (this.loaded.has(cacheKey)) continue
      if (this.loaded.size >= this.maxRecords) throw new StateConflict('Command aggregate exceeds 1000 records; narrow the thread scope')
      const record = await tx.get<unknown>(family, id)
      this.loaded.set(cacheKey, record)
      // Negative reads are tracked as well, so a broken dependency cannot masquerade as a missing record.
      if (family === 'trigger') push('disposition', id)
      if (family === 'thread' && !this.decisionsLoaded.has(id)) {
        const decisions = await tx.scan<Decision>('decision', { relation: id, limit: this.maxRecords })
        if (decisions.length >= this.maxRecords) throw new StateConflict('Decision history needs pagination before this command can proceed')
        this.decisionsLoaded.add(id)
        for (const decision of decisions) push('decision', decision.id)
      }
      if (!record) continue
      switch (family) {
        case 'trigger': {
          const trigger = record.value as Trigger
          this.memory.triggers.save(trigger)
          for (const ref of trigger.threads) push('thread', threadKey(ref))
          break
        }
        case 'disposition': {
          const value = record.value as TriggerDisposition
          this.memory.triggers.saveDisposition(id, value)
          for (const ticket of value.fanout) push('ticket', ticket)
          if (value.decisionId) push('decision', value.decisionId)
          break
        }
        case 'thread': {
          const value = record.value as Thread
          this.memory.threads.save(value)
          for (const ticket of value.subscriptions) push('ticket', ticket)
          for (const trigger of [...value.pending, ...value.evaluating?.triggerIds ?? []]) push('trigger', trigger)
          break
        }
        case 'ticket': {
          const value = record.value as Ticket
          this.memory.tickets.save(value)
          push('decision', value.decisionId)
          for (const trigger of value.origin.triggerIds) push('trigger', trigger)
          push('trigger', value.origin.triggerId)
          for (const input of value.inputs) {
            if ('triggerId' in input) push('trigger', input.triggerId)
            if ('decisionId' in input) push('decision', input.decisionId)
          }
          for (const follow of value.follows ?? []) push('thread', follow.thread)
          if (value.attention?.triggerId) push('trigger', value.attention.triggerId)
          break
        }
        case 'decision': {
          const value = record.value as Decision
          this.memory.decisions.save(value)
          for (const trigger of value.triggerIds) push('trigger', trigger)
          if (value.ticketId) push('ticket', value.ticketId)
          break
        }
      }
    }
  }
  tickets(): Ticket[] { return this.memory.tickets.list() }
  isNewTicket(id: string): boolean { return !this.loaded.get(JSON.stringify(['ticket', id])) }
  async flush(tx: StateTransaction): Promise<void> {
    for (const [cacheKey, item] of this.dirty) {
      let relation = '', active = false
      if (item.family === 'decision') relation = (item.value as Decision).threadKey
      if (item.family === 'ticket') {
        const ticket = item.value as Ticket; relation = ticket.mandate.actor.id
        active = ticket.undelivered.length > 0 || ['pending', 'running'].includes(ticket.assignments.at(-1)?.state ?? '')
        if (ticket.assignments.filter(value => value.state !== 'ended').length > 1) throw new StateConflict('A ticket cannot have multiple active assignments')
      }
      if (item.family === 'thread') { const thread = item.value as Thread; active = !!thread.evaluating || thread.pending.length > 0 }
      await tx.put(item.family as Family, item.id, item.value, this.loaded.get(cacheKey)?.revision ?? 0, { relation, active })
    }
  }
}
