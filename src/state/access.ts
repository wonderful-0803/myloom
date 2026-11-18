/** Server-owned installation, current settings and resource authorization. Browser parameters never select scope. */
import { z } from 'zod'
import type { Ticket, Trigger } from '../core/index.ts'
import { groupMaster, groupWorkspace, inGroup } from '../group-mode.ts'
import { SettingsSchema, settingsPolicy } from '../policy.ts'
import type { Settings } from '../policy.ts'
import { feishuKind } from '../sources/feishu.ts'
import { feishuTriggerId } from '../sources/feishu-trigger.ts'
import { SourceRegistry } from '../sources/registry.ts'
import type { ArtifactManifest } from './artifacts.ts'
import type { CommandContext } from './application.ts'
import type { StateTransaction } from './ports.ts'
import { StateConflict } from './ports.ts'
import { hash } from './hash.ts'
import { bytesHash } from './blobs.ts'

export const InstallationSchema = z.object({ id: z.string().min(1).max(200), appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/),
  botId: z.string().min(1), tenantKey: z.string().min(1), operator: z.string().regex(/^ou_[a-zA-Z0-9]+$/), enabled: z.boolean(),
  name: z.string().max(100), since: z.iso.datetime() }).strict()
export type Installation = z.infer<typeof InstallationSchema>
export interface SettingsRecord { revision: number; settings: Settings; at: string; actor: string }
export function ticketSourceIds(ticket: Ticket): string[] {
  return [...new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds ?? [],
    ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])]
}
/** Explicit access denial suitable for product routes. No record contents are included. */
export class AccessDenied extends Error {}
/** Rebuilds the real SourceRegistry and Policy from the transaction's current persisted settings. */
export class ProductAccess {
  taskGuard?: (tx: StateTransaction, actor: string, ticket: Ticket) => Promise<void>
  private readonly configurations = new WeakMap<StateTransaction, Promise<Awaited<ReturnType<ProductAccess['loadConfiguration']>>>>()
  constructor(readonly installationId: string) { if (!installationId.trim()) throw new Error('Installation ID required') }
  configuration(tx: StateTransaction) {
    let value = this.configurations.get(tx)
    if (!value) { value = this.loadConfiguration(tx); this.configurations.set(tx, value) }
    return value
  }
  private async loadConfiguration(tx: StateTransaction) {
    const migration = (await tx.get<{ status: string; executionEnabled?: boolean }>('migration', 'status'))?.value
    if (migration && migration.status !== 'ready') throw new AccessDenied('State migration has not completed verification')
    const installation = InstallationSchema.parse((await tx.get('installation', this.installationId))?.value)
    if (!installation.enabled) throw new AccessDenied('Application installation is disabled')
    const row = await tx.get<SettingsRecord>('settings', 'current')
    if (!row) throw new StateConflict('Product settings have not been initialized')
    const settings = SettingsSchema.parse(row.value.settings), registry = new SourceRegistry(() => settings)
    if (migration?.executionEnabled === false) settings.paused = true
    registry.register(feishuKind)
    // SourceRegistry's legacy read fallback disables invalid config. A server installation must fail explicitly instead.
    registry.validate('feishu', settings.sources.feishu ?? { enabled: false, config: {} })
    if (settings.sources.github?.enabled !== false) throw new AccessDenied('Company product entry currently requires Feishu-only configuration')
    const group = groupWorkspace(settings)
    if (group && group.spaceId !== tx.scope.spaceId) throw new AccessDenied('Configured group space differs from the external state scope')
    if (group && group.operator !== installation.operator) throw new AccessDenied('Installation operator mapping changed')
    return { installation, settings, registry, group, row, policy: settingsPolicy(settings, registry) }
  }
  async user(tx: StateTransaction, actor: string, operator = false) {
    const config = await this.configuration(tx)
    const permitted = config.group ? groupMaster(config.group, actor)
      : actor === config.installation.operator && config.settings.policy.sources.feishu?.allowed.some(value => value.id === actor)
    if (!permitted || operator && actor !== config.installation.operator) throw new AccessDenied('Current user is not authorized')
    return config
  }
  async source(tx: StateTransaction, actor: string, trigger: Trigger): Promise<void> {
    const config = await this.user(tx, actor)
    if (trigger.source !== 'feishu' || !config.registry.scope({ source: trigger.source, meta: trigger.meta }).listened
      || (config.group ? !inGroup(trigger, config.group) || Date.parse(trigger.at) < Date.parse(config.group.since) : !!trigger.meta.loomSpace))
      throw new AccessDenied('Source is outside the current authorized workspace')
  }
  /** Follow only links supplied by the Feishu transport, within the same conversation and workspace. */
  async referencedSources(tx: StateTransaction, actor: string, triggers: readonly Trigger[]): Promise<Trigger[]> {
    await this.user(tx, actor)
    const seen = new Set(triggers.map(trigger => trigger.id)), references: Trigger[] = []
    for (const trigger of triggers.slice(-4).reverse()) {
      if (trigger.source !== 'feishu') continue
      for (const nativeId of [trigger.meta.parentId, trigger.meta.rootId]) {
        if (typeof nativeId !== 'string' || nativeId === trigger.meta.messageId) continue
        const id = feishuTriggerId(nativeId)
        if (seen.has(id)) continue
        const source = (await tx.get<Trigger>('trigger', id))?.value
        if (!source || !source.human || source.meta.messageId !== nativeId || source.meta.chatId !== trigger.meta.chatId
          || source.meta.direct !== trigger.meta.direct || source.meta.loomSpace !== trigger.meta.loomSpace || source.at > trigger.at) continue
        try { await this.source(tx, actor, source) } catch (error) { if (error instanceof AccessDenied) continue; throw error }
        seen.add(id); references.push(source)
        if (references.length === 4) return references
      }
    }
    return references
  }
  async ticket(tx: StateTransaction, actor: string, id: string): Promise<Ticket> {
    const config = await this.user(tx, actor), ticket = (await tx.get<Ticket>('ticket', id))?.value
    if (!ticket || (config.group ? ticket.mandate.basis.scope?.loomSpace !== config.group.spaceId
      || !groupMaster(config.group, ticket.mandate.actor.id) : ticket.mandate.actor.id !== actor || !!ticket.mandate.basis.scope?.loomSpace)) throw new AccessDenied('Task is unavailable')
    for (const sourceId of ticketSourceIds(ticket)) {
      const trigger = (await tx.get<Trigger>('trigger', sourceId))?.value
      if (!trigger) throw new AccessDenied('Task source is unavailable')
      await this.source(tx, actor, trigger)
    }
    await this.taskGuard?.(tx, actor, ticket)
    return ticket
  }
  async artifact(tx: StateTransaction, actor: string, subject: string, operation: 'read' | 'publish' | 'gc', version?: ArtifactManifest) {
    if (operation === 'gc') { await this.user(tx, actor, true); return }
    await this.ticket(tx, actor, subject)
    for (const ref of version?.sources ?? []) {
      const trigger = (await tx.get<Trigger>('trigger', ref.triggerId))?.value
      if (!trigger) throw new AccessDenied('Artifact source is unavailable')
      await this.source(tx, actor, trigger)
      if ((version?.sourceHash === 'text-v1' ? bytesHash(Buffer.from(trigger.text)) : hash(trigger)) !== ref.hash) throw new AccessDenied('Artifact source version has changed')
    }
  }
  authorize = async (tx: StateTransaction, command: CommandContext) => {
    if (command.name === 'stopWork' || command.name === 'policyChanged') {
      const installation = InstallationSchema.parse((await tx.get('installation', this.installationId))?.value)
      if (installation.operator !== command.userId) throw new AccessDenied('Stop principal mismatch')
      const settings = SettingsSchema.parse((await tx.get<SettingsRecord>('settings', 'current'))?.value.settings)
      const registry = new SourceRegistry(() => settings); registry.register(feishuKind)
      return { policy: () => settingsPolicy(settings, registry), scope: registry }
    }
    const config = await this.user(tx, command.userId)
    if (command.installationId && command.installationId !== this.installationId) throw new AccessDenied('Source installation mismatch')
    if (command.ticketId) await this.ticket(tx, command.userId, command.ticketId)
    if (command.triggerId) {
      const trigger = (await tx.get<Trigger>('trigger', command.triggerId))?.value
      if (trigger) await this.source(tx, command.userId, trigger)
    }
    return { policy: () => config.policy, scope: config.registry }
  }
}
