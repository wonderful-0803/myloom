/** An unknown legacy/custom key needs an explicit owner before it can enter external state. */
import { KV } from '../kv.ts'
interface KeyFamily { owner: string; key?: string; prefix?: string }
function collect(value: object, path: string[] = []): KeyFamily[] {
  return Object.entries(value).flatMap(([name, entry]): KeyFamily[] => {
    const owner = [...path, name].join('.')
    if (typeof entry === 'string') return [{ owner, key: entry }]
    if (typeof entry === 'function' && 'prefix' in entry && typeof entry.prefix === 'string') return [{ owner, prefix: entry.prefix }]
    return entry && typeof entry === 'object' ? collect(entry, [...path, name]) : []
  })
}
export const kvFamilies: readonly KeyFamily[] = collect(KV).sort((a, b) => (b.prefix?.length ?? 0) - (a.prefix?.length ?? 0))
export function kvOwner(key: string): string | undefined { return kvFamilies.find(entry => entry.key === key || (entry.prefix && key.startsWith(entry.prefix)))?.owner }
