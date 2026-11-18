/** Crash recovery proves process death and a valid durable prefix; it never fabricates a flush receipt. */
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { StateScope, StateStore, StateTransaction } from '../state/ports.ts'
import { hash } from '../state/hash.ts'
import { ComputeIdentitySchema, localComputeIdentity, observeCompute } from './compute.ts'
import { logEvents, logRecord } from './storage.ts'

export interface NativeOwner { sessionId: string; owner: string; epoch: number }
export const computeOwnerKey = (owner: string) => `native-compute/${hash(owner)}`
const OwnerRecord = z.object({ owner: z.string(), identity: ComputeIdentitySchema }).strict()
const ExitProof = z.object({ kind: z.literal('process-exit-prefix-v1'), sessionId: z.string(), owner: z.string(), epoch: z.number().int().positive(),
  computeHash: z.string(), eventCount: z.number().int().nonnegative(), prefixHash: z.string(), at: z.number() }).strict()
export async function registerCompute(tx: StateTransaction, owner: string, identity: Awaited<ReturnType<typeof localComputeIdentity>>) {
  if (!identity) return // Other hosts remain usable but require external supervisor evidence for crash recovery.
  const id = computeOwnerKey(owner), old = await tx.get('grant', id), value = { owner, identity }
  if (old && hash(old.value) !== hash(value)) throw new Error('Compute owner identity cannot be reused by another process')
  if (!old) await tx.put('grant', id, value, 0)
}
/** Metadata/Router may reload only durable state once a local owner is proved dead. */
export async function releaseDeadComputeLease(store: StateStore, scope: StateScope, sessionId: string): Promise<void> {
  const before = await store.transaction(scope, async tx => {
    const lease = await tx.leases.current(sessionId)
    return { lease, owner: lease && await tx.get('grant', computeOwnerKey(lease.owner)) }
  })
  if (!before.lease) return
  const owner = OwnerRecord.safeParse(before.owner?.value)
  if (!owner.success || owner.data.owner !== before.lease.owner || await observeCompute(owner.data.identity) !== 'dead') return
  await store.transaction(scope, async tx => {
    const current = await tx.get('grant', computeOwnerKey(before.lease!.owner))
    if (current && hash(current.value) === hash(before.owner!.value)) await tx.leases.release(before.lease!)
  })
}
export async function nativeStopProved(tx: StateTransaction, binding: NativeOwner): Promise<boolean> {
  const normal = (await tx.get<NativeOwner & { flushed: boolean }>('grant', `native-quiescent/${binding.sessionId}/${binding.epoch}`))?.value
  if (normal?.owner === binding.owner && normal.epoch === binding.epoch && normal.flushed === true) return true
  const saved = await tx.get('grant', `native-recovered/${binding.sessionId}/${binding.epoch}`), proof = ExitProof.safeParse(saved?.value)
  return proof.success && proof.data.owner === binding.owner && proof.data.sessionId === binding.sessionId && proof.data.epoch === binding.epoch
}
export type NativeRecoveryResult = 'recovered' | 'already-recovered' | 'drained' | 'alive' | 'unverifiable' | 'unsafe'
export async function recoverNativeSession(store: StateStore, scope: StateScope, binding: NativeOwner): Promise<NativeRecoveryResult> {
  const before = await store.transaction(scope, async tx => ({ record: await tx.get('grant', computeOwnerKey(binding.owner)),
    normal: await tx.get('grant', `native-quiescent/${binding.sessionId}/${binding.epoch}`), proved: await nativeStopProved(tx, binding) }))
  if (before.proved) return before.normal ? 'drained' : 'already-recovered'
  const owner = OwnerRecord.safeParse(before.record?.value)
  if (!owner.success || owner.data.owner !== binding.owner) return 'unverifiable'
  const observation = await observeCompute(owner.data.identity)
  if (observation !== 'dead') return observation
  return store.transaction(scope, async tx => {
    const currentOwner = await tx.get('grant', computeOwnerKey(binding.owner)), lease = await tx.leases.current(binding.sessionId)
    if (!currentOwner || currentOwner.revision !== before.record!.revision || hash(currentOwner.value) !== hash(before.record!.value)
      || lease && (lease.owner !== binding.owner || lease.epoch !== binding.epoch)) return 'unsafe'
    if (await nativeStopProved(tx, binding)) return 'already-recovered'
    const log = await logRecord(tx, binding.sessionId as SessionId)
    if (!log) return 'unsafe'
    const events = await logEvents(tx, log.value)
    const results = new Set(events.flatMap(event => event.type === 'tool/result' ? [event.data.message.toolCallId] : []))
    if (events.some(event => event.type === 'tool/call' && !results.has(event.data.callId)
      && !['orchestrator_read', 'orchestrator_artifact', 'orchestrator_report', 'orchestrator_eval_decide'].includes(event.data.name))) return 'unsafe'
    const consumed = new Map(events.flatMap(event => {
      if (event.type !== 'user/message' || !event.data.id.startsWith('dsh-superagent:')) return []
      const requestId = event.data.id.slice('dsh-superagent:'.length)
      return [[`native-input/${hash({ session: binding.sessionId, requestId })}`, event.data.content.filter(part => part.type === 'text').map(part => part.text).join('')]]
    }))
    let after: string | undefined
    do {
      const rows = await tx.scan<any>('grant', { after, limit: 100 })
      for (const row of rows) if (row.id.startsWith('native-input/') && row.value.sessionId === binding.sessionId) {
        const input = row.value
        if (input.protocol !== 'sql-lease-v1' || typeof input.payload !== 'string' || hash(input.payload) !== input.textHash || typeof input.basis !== 'string') return 'unsafe'
        if (input.status === 'consumed' && consumed.get(row.id) !== input.payload) return 'unsafe'
      }
      after = rows.length === 100 ? rows.at(-1)!.id : undefined
    } while (after)
    const proof = ExitProof.parse({ kind: 'process-exit-prefix-v1', ...binding, computeHash: hash(owner.data), eventCount: events.length, prefixHash: hash(events), at: await tx.now() })
    await tx.put('grant', `native-recovered/${binding.sessionId}/${binding.epoch}`, proof, 0)
    if (lease) await tx.leases.release(lease)
    await tx.put('audit', `native-recovery/${hash(binding)}`, { kind: proof.kind, sessionId: binding.sessionId, owner: binding.owner, epoch: binding.epoch, eventCount: events.length, at: proof.at }, 0)
    return 'recovered'
  })
}
