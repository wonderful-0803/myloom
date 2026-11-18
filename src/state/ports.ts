/** Async, scoped durable state. No external side effects may run inside transaction(). */
export interface StateScope { tenantId: string; spaceId: string }
export const families = ['installation', 'source-event', 'trigger', 'disposition', 'thread', 'ticket', 'decision',
  'settings', 'delegation', 'kv', 'command', 'control', 'grant', 'execution', 'outbox', 'artifact', 'audit',
  'blob', 'artifact-head', 'artifact-version', 'auth-session', 'source-state', 'migration', 'legacy', 'progress',
  'native-session', 'native-event', 'native-unit', 'native-record'] as const
export type Family = typeof families[number]
export interface StateRecord<T> { id: string; revision: number; value: T; at?: string; index?: RecordIndex; deleted?: boolean }
export interface RecordIndex { relation?: string; active?: boolean; at?: string }
export interface RecordQuery { after?: string; relation?: string; active?: boolean; limit?: number; recent?: boolean; before?: { at: string; id: string }; includeIndex?: boolean; includeDeleted?: boolean }
export interface Job<T = unknown> {
  kind: string; key: string; value: T; generation: number; sequence: number; attempts: number; due: number
  /** Held jobs require explicit reconciliation; the consumer never silently retries them. */
  held?: string
}
export interface JobClaim<T = unknown> extends Job<T> { owner: string; token: string; until: number }
export interface JobPool { name: string; limit: number }
export interface SessionLease { sessionId: string; owner: string; epoch: number; until: number }
export interface StateChange { cursor: number; family: Family; id: string; revision: number; deleted: boolean }
export interface StateTransaction {
  readonly scope: Readonly<StateScope>
  /** Uses database time, including lease and claim checks. */
  now(): Promise<number>
  get<T>(family: Family, id: string): Promise<StateRecord<T> | undefined>
  scan<T>(family: Family, query?: RecordQuery): Promise<StateRecord<T>[]>
  /** expected=0 is create-only. Every update is compare-and-swap. */
  put<T>(family: Family, id: string, value: T, expected: number, index?: RecordIndex): Promise<number>
  /** Offline, create-only restore of a verified record revision. Never exposed as a generic product API. */
  restore<T>(family: Family, id: string, value: T, revision: number, index?: RecordIndex, deleted?: boolean): Promise<void>
  remove(family: Family, id: string, expected: number): Promise<void>
  changes(after: number, limit?: number): Promise<StateChange[]>
  jobs: {
    enqueue<T>(kind: string, key: string, value: T, delayMs?: number): Promise<Job<T>>
    claim<T>(owner: string, ttlMs: number, kinds: readonly string[], pool?: JobPool): Promise<JobClaim<T> | undefined>
    renew(claim: JobClaim, ttlMs: number): Promise<JobClaim | undefined>
    complete(claim: JobClaim): Promise<boolean>
    retry(claim: JobClaim, delayMs: number): Promise<boolean>
    hold(claim: JobClaim, reason: string): Promise<boolean>
    /** Operator reconciliation is compare-and-swap and must be authorized by the application. */
    resume(kind: string, key: string, generation: number): Promise<boolean>
    cancel(kind: string, key: string): Promise<void>
    list<T>(limit?: number): Promise<Job<T>[]>
    hasClaims(): Promise<boolean>
    /** Offline create-only restore, retaining request sequence and holding all work for reconciliation. */
    restore(job: Job): Promise<void>
  }
  leases: {
    acquire(sessionId: string, owner: string, ttlMs: number): Promise<SessionLease | undefined>
    renew(lease: SessionLease, ttlMs: number): Promise<SessionLease | undefined>
    release(lease: SessionLease): Promise<boolean>
    current(sessionId: string): Promise<SessionLease | undefined>
    assert(lease: SessionLease): Promise<void>
  }
}
export interface StateStore {
  readonly dialect: 'sqlite' | 'postgres'
  /** Short, serialized-per-scope transactions; callback is awaited on one connection. */
  transaction<T>(scope: StateScope, work: (tx: StateTransaction) => Promise<T>): Promise<T>
  close(): Promise<void>
}
/** A compare-and-swap, authorization fence or immutable request identity no longer matches. */
export class StateConflict extends Error {}
/** An escaped transaction or closed adapter cannot issue further repository operations. */
export class StateClosed extends Error {}
/** The database no longer recognizes this Session writer and epoch. */
export class LeaseLost extends Error {}
export function validateScope(scope: StateScope): StateScope {
  if (!scope || typeof scope.tenantId !== 'string' || typeof scope.spaceId !== 'string' || !scope.tenantId.trim() || !scope.spaceId.trim()
    || scope.tenantId.length > 200 || scope.spaceId.length > 200) throw new Error('Explicit tenantId and spaceId are required')
  return Object.freeze({ tenantId: scope.tenantId, spaceId: scope.spaceId })
}
