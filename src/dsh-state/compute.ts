/** Host observations are evidence about one Linux process, never a lease-expiry heuristic. */
import { readFile, readlink, stat } from 'node:fs/promises'
import { z } from 'zod'
import { hash } from '../state/hash.ts'

export const ComputeIdentitySchema = z.object({ host: z.string().regex(/^[a-f0-9]{64}$/), boot: z.uuid(), namespace: z.string().regex(/^pid:\[\d+\]$/),
  pid: z.number().int().positive(), start: z.string().regex(/^\d+$/), uid: z.number().int().nonnegative() }).strict()
export type ComputeIdentity = z.infer<typeof ComputeIdentitySchema>
export type ComputeObservation = 'alive' | 'dead' | 'unverifiable'
async function processFacts(pid: number) {
  const [text, info] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), stat(`/proc/${pid}`)])
  // comm may contain spaces and parentheses; fields after its final ')' begin at stat field 3.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (fields.length < 20 || !/^\d+$/.test(fields[19]!)) throw new Error('Unrecognized Linux process identity')
  return { start: fields[19]!, uid: info.uid, state: fields[0] }
}
export async function localComputeIdentity(): Promise<ComputeIdentity | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const [machine, boot, namespace, facts] = await Promise.all([readFile('/etc/machine-id', 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid'), processFacts(process.pid)])
    if (!/^[a-f0-9]{32}$/.test(machine.trim())) return undefined
    return ComputeIdentitySchema.parse({ host: hash(machine.trim()), boot: boot.trim(), namespace, pid: process.pid, start: facts.start, uid: facts.uid })
  } catch { return undefined }
}
/** Different hosts/namespaces and denied inspection do not prove death. PID reuse does prove that the old process is gone. */
export async function observeCompute(saved: ComputeIdentity): Promise<ComputeObservation> {
  const old = ComputeIdentitySchema.parse(saved), here = await localComputeIdentity()
  if (!here || old.host !== here.host || old.uid !== here.uid) return 'unverifiable'
  if (old.boot !== here.boot) return 'dead'
  if (old.namespace !== here.namespace) return 'unverifiable'
  try {
    const current = await processFacts(old.pid)
    return current.start !== old.start || current.uid !== old.uid || ['Z', 'X', 'x'].includes(current.state ?? '') ? 'dead' : 'alive'
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unverifiable' }
}
