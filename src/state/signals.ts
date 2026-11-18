/** Scoped intake metadata. The original Trigger and device directory remain authoritative. */
import type { Trigger } from '../core/index.ts'
import { hash } from './hash.ts'
import type { StateTransaction } from './ports.ts'

export const FEISHU_INTAKE_WINDOW_MS = 2_000
const feishuSignalId = (triggerId: string) => `signal/feishu/${triggerId}`

export interface FeishuSignal {
  kind: 'message' | 'attachment' | 'thread-reply'
  triggerId: string
  at: string
  contentHash: string
}

export async function recordFeishuSignal(tx: StateTransaction, trigger: Trigger): Promise<void> {
  const id = feishuSignalId(trigger.id)
  if (await tx.get('audit', id)) return
  const media = trigger.meta.messageType
  const attachment = media === 'file' || media === 'audio' || media === 'image'
    || /\[(?:Image|File|Audio):\s(?:img|file|audio)_[A-Za-z0-9_-]+\]/i.test(trigger.text)
    || /^\{"image_key":"img_[A-Za-z0-9_-]+"\}/.test(trigger.text)
  const inThread = trigger.meta.parentId || trigger.meta.rootId && trigger.meta.rootId !== trigger.meta.messageId
  const signal: FeishuSignal = { kind: attachment ? 'attachment' : inThread ? 'thread-reply' : 'message',
    triggerId: trigger.id, at: trigger.at, contentHash: hash(trigger.text) }
  await tx.put('audit', id, signal, 0, { relation: 'signal.feishu', at: trigger.at })
}

/** Connection epochs deduplicate transitions without journaling each heartbeat. */
export async function recordRunnerSignal(tx: StateTransaction, device: {
  deviceId: string; userId: string; environmentId: string; connectionEpoch: number; status: 'online' | 'offline' | 'revoked'
}): Promise<void> {
  const id = `signal/runner/${device.deviceId}/${device.connectionEpoch}/${device.status}`
  if (await tx.get('audit', id)) return
  const at = new Date(await tx.now()).toISOString()
  await tx.put('audit', id, { kind: 'runner-status', deviceId: device.deviceId, userId: device.userId, environmentId: device.environmentId,
    status: device.status, connectionEpoch: device.connectionEpoch, at }, 0, { relation: 'signal.runner', at })
}
