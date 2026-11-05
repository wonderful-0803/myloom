/** The sync wire contains conversation data, never provider credentials or execution authority. */
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
export const id = z.string().uuid()
export const name = z.string().trim().min(1).max(120)
export const secret = () => randomBytes(32).toString('base64url')
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const Message = z.object({ id: z.string().min(1).max(240), turnId: z.string().max(240), role: z.enum(['user','assistant']),
  at: z.number().int().nonnegative(), text: z.string().max(100_000), truncated: z.boolean(), omittedAttachments: z.boolean() }).strict()
export type SyncMessage = z.infer<typeof Message>
export const Snapshot = z.object({ session: id, title: name, messages: z.array(Message).max(200),
  coverage: z.string().max(500) }).strict()
export type SyncSnapshot = z.infer<typeof Snapshot>
export const Note = z.object({ title: name, current: z.string().trim().min(1).max(12_000), reasons: z.string().max(12_000),
  constraints: z.string().max(12_000), open: z.string().max(12_000), parent: id.nullable(),
  references: z.array(z.string().max(400)).max(100) }).strict()
export type SyncNote = z.infer<typeof Note> & { id: string; device: string; at: string }
export interface Device { id: string; name: string; admin: boolean; projects: string[]; revoked: boolean; at: string }
export interface Project { id: string; name: string; at: string }
export interface Revision extends SyncSnapshot { id: string; project: string; device: string; hash: string; at: string }
/** Safe status and user-facing failure; underlying transport/credential diagnostics are not exposed. */
export class SyncError extends Error { constructor(readonly status: number, message: string) { super(message) } }
/** Production connections require HTTPS; plaintext is reserved for loopback development. */
export function syncUrl(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new SyncError(400, '同步地址应为不含路径、凭据和查询参数的服务地址。')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    throw new SyncError(400, '同步服务必须使用 HTTPS；HTTP 仅用于本机联调。')
  return url.origin
}
