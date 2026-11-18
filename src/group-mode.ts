/** One Loom runtime, with an optional explicitly granted group workspace. No user-token delegation. */
import { z } from 'zod'
import type { Trigger } from './core/index.ts'
import type { Settings } from './policy.ts'

export const GroupMasterSchema = z.object({ id: z.string().regex(/^ou_[A-Za-z0-9]+$/), name: z.string().trim().max(100).optional() }).strict()
export const GroupWorkspaceSchema = z.object({
  mode: z.literal('group'), operator: z.string().regex(/^ou_[A-Za-z0-9]+$/),
  chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/), name: z.string().max(60),
  masters: z.array(GroupMasterSchema).min(1).max(20).refine(items => new Set(items.map(item => item.id)).size === items.length),
  spaceId: z.uuid(), since: z.iso.datetime(),
}).strict().refine(value => value.masters.some(person => person.id === value.operator), '管理者必须保留在主人名单中')
export type GroupWorkspace = z.infer<typeof GroupWorkspaceSchema>
export function groupWorkspace(settings: Pick<Settings, 'policy'>): GroupWorkspace | undefined {
  const value = settings.policy.sources.feishu?.workspace
  return value === undefined ? undefined : GroupWorkspaceSchema.parse(value)
}
/** Both a source-native group and its activation epoch are required: switching mode never shares old personal work. */
export function inGroup(trigger: Pick<Trigger, 'source' | 'meta'>, group: GroupWorkspace): boolean {
  return trigger.source === 'feishu' && trigger.meta.direct !== true && trigger.meta.chatId === group.chatId
    && trigger.meta.loomSpace === group.spaceId
}
export function groupMaster(group: GroupWorkspace, id: string): boolean { return group.masters.some(person => person.id === id) }
