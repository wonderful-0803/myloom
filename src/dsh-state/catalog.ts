/** Shared native migration gate and explicit, non-secret deployment compatibility contract. */
import { z } from 'zod'
import { StateConflict } from '../state/ports.ts'
import type { StateTransaction } from '../state/ports.ts'
import { hash } from '../state/hash.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const RecoveryContractSchema = z.object({ harnessVersion: z.literal('0.2.1-rc.3'), profileRevision: digest,
  presets: z.record(z.string().min(1).max(200), digest),
  models: z.array(z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) }).strict()).max(100) }).strict()
export type RecoveryContract = z.infer<typeof RecoveryContractSchema>
export async function assertNativeReady(tx: StateTransaction): Promise<void> {
  const marker = await tx.get<{ status: string }>('migration', 'native-import')
  if (marker && marker.value.status !== 'ready') throw new StateConflict('Native import is incomplete; compute remains blocked')
  const restore = await tx.get<{ status: string }>('migration', 'status')
  if (restore && restore.value.status !== 'ready') throw new StateConflict('State restore is incomplete; native compute remains blocked')
}
export async function pinEnvironment(tx: StateTransaction, expected: RecoveryContract): Promise<void> {
  const value = RecoveryContractSchema.parse(expected), row = await tx.get<RecoveryContract>('grant', 'native-environment')
  if (row && hash(row.value) !== hash(value)) throw new StateConflict('Native deployment contract differs; explicit metadata migration required')
  if (!row) await tx.put('grant', 'native-environment', value, 0)
}
