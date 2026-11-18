/** C1 wire contract. Data only: no closures, shell commands, server paths or delegated credentials. */
import { z } from 'zod'
import { hash } from '../state/hash.ts'
import { ExecutionUnavailable } from './port.ts'
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const relativePath = z.string().min(1).max(500).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part !== '..' && part !== ''), 'Only workspace-relative paths are allowed')
const glob = z.string().min(1).max(200).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..'))
export const capabilities = {
  read: { id: 'fs.read', version: 1, effect: 'read', input: z.object({ path: relativePath, offset: z.number().int().min(0).max(1000000), limit: z.number().int().min(1).max(1000) }).strict() },
  glob: { id: 'fs.glob', version: 1, effect: 'read', input: z.object({ pattern: glob, limit: z.number().int().min(1).max(200) }).strict() },
  grep: { id: 'fs.grep', version: 1, effect: 'read', input: z.object({ query: z.string().min(1).max(200), pattern: glob, limit: z.number().int().min(1).max(200) }).strict() },
  stat: { id: 'fs.stat', version: 1, effect: 'read', input: z.object({ path: relativePath }).strict() },
} as const
export type Capability = typeof capabilities[keyof typeof capabilities]
export function capability(name: string): Capability {
  if (!Object.hasOwn(capabilities, name)) throw new ExecutionUnavailable('Remote capability is not installed; local fallback is forbidden')
  return capabilities[name as keyof typeof capabilities]
}
export const RemoteRequestSchema = z.object({ protocolVersion: z.literal(1), requestId: id, tenantId: id, spaceId: id, userId: id,
  ticketId: id, assignmentId: id, sessionId: id, environmentId: id, workspaceId: id, toolId: z.enum(['fs.read', 'fs.glob', 'fs.grep', 'fs.stat']),
  toolVersion: z.literal(1), effect: z.literal('read'), resourceGrantId: id, grantRevision: z.number().int().positive(),
  controlRevision: z.number().int().nonnegative(), sessionEpoch: z.number().int().positive(), expiresAt: z.iso.datetime(), argsHash: digest,
  args: z.unknown(), permit: z.string().min(32).max(2048) }).strict()
export type RemoteRequest = z.infer<typeof RemoteRequestSchema>
export function checkedRequest(raw: unknown): RemoteRequest {
  const request = RemoteRequestSchema.parse(raw), tool = Object.values(capabilities).find(value => value.id === request.toolId)!
  tool.input.parse(request.args)
  if (hash(request.args) !== request.argsHash || Buffer.byteLength(JSON.stringify(request)) > 20000) throw new ExecutionUnavailable('Remote input digest or budget is invalid')
  return request
}
/** A permit may rotate, but the admitted request's task, resource, deadline and fence remain immutable. */
export const intentHash = (request: RemoteRequest) => { const { permit: _permit, ...intent } = request; return hash(intent) }
export const QuerySchema = z.object({ protocolVersion: z.literal(1), requestId: id, intentHash: digest }).strict()
export const CancelSchema = QuerySchema.extend({ reason: z.enum(['pause', 'revoke', 'timeout', 'shutdown']) }).strict()
export type RemoteQuery = z.infer<typeof QuerySchema>
export type RemoteCancel = z.infer<typeof CancelSchema>
const Result = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(64000), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('paths'), paths: z.array(relativePath).max(200), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('matches'), matches: z.array(z.object({ path: relativePath, line: z.number().int().positive(), text: z.string().max(2000) }).strict()).max(200), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('stat'), path: relativePath, bytes: z.number().int().nonnegative(), modifiedAt: z.iso.datetime() }).strict(),
])
export const ReceiptSchema = z.object({ protocolVersion: z.literal(1), requestId: id, intentHash: digest, sequence: z.number().int().positive(),
  status: z.enum(['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']), result: Result.optional(), resultHash: digest.optional(),
  error: z.enum(['denied', 'not_found', 'budget', 'unsupported', 'internal', 'cancelled']).optional() }).strict()
export type RemoteReceipt = z.infer<typeof ReceiptSchema>
export const terminal = (value: RemoteReceipt) => !['accepted', 'running'].includes(value.status)
export function checkedReceipt(raw: unknown, request: RemoteRequest): RemoteReceipt {
  const receipt = ReceiptSchema.parse(raw)
  if (receipt.requestId !== request.requestId || receipt.intentHash !== intentHash(request) || Buffer.byteLength(JSON.stringify(receipt)) > 80000)
    throw new ExecutionUnavailable('Remote receipt identity or budget is invalid')
  const resultKind = { 'fs.read': 'text', 'fs.glob': 'paths', 'fs.grep': 'matches', 'fs.stat': 'stat' }[request.toolId]
  if (receipt.status === 'succeeded' ? !receipt.result || receipt.result.kind !== resultKind || receipt.resultHash !== hash(receipt.result) || !!receipt.error
    : receipt.result !== undefined || receipt.resultHash !== undefined) throw new ExecutionUnavailable('Remote result type or digest is invalid')
  return receipt
}
/** Reordered/contradictory receipts cannot roll a terminal result back to running. */
export class ReceiptCursor {
  private last?: RemoteReceipt
  constructor(private request: RemoteRequest) {}
  accept(raw: unknown): RemoteReceipt {
    const value = checkedReceipt(raw, this.request), old = this.last
    if (old) {
      if (value.sequence < old.sequence) return old
      if (value.sequence === old.sequence) { if (hash(value) !== hash(old)) throw new ExecutionUnavailable('Contradictory remote receipt'); return old }
      if (terminal(old) && hash({ ...old, sequence: 0 }) !== hash({ ...value, sequence: 0 }) || old.status === 'running' && value.status === 'accepted') throw new ExecutionUnavailable('Remote execution state cannot regress')
    }
    return this.last = value
  }
}
