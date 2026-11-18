import { createHash } from 'node:crypto'
/** Stable parameter hashes: object key ordering is not request identity. Reject non-JSON inputs. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new Error('Durable requests must contain only JSON values')
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
