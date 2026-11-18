/** Explicit SSH-console identity for the private loopback pilot; never an alternate public login. */
import { randomBytes } from 'node:crypto'
import { AccessDenied, ProductAccess } from './access.ts'
import type { LoginProvider } from './auth.ts'
import type { StateStore, StateScope } from './ports.ts'
import { hash } from './hash.ts'

interface ConsoleCode { kind: 'operator-code'; actor: string; appId: string; tenantKey: string; until: number; used: boolean }
export function requireConsoleOrigin(value: string): void {
  const origin = new URL(value)
  if (origin.origin !== value || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password)
    throw new Error('SSH operator login requires an explicit HTTP IPv4 loopback origin')
}
/** Called only by the OS administrator's CLI. No HTTP endpoint can mint a code or select an actor. */
export async function issueOperatorCode(store: StateStore, scope: StateScope, access: ProductAccess) {
  const code = randomBytes(32).toString('base64url')
  await store.transaction(scope, async tx => {
    const config = await access.configuration(tx), actor = config.installation.operator
    await access.user(tx, actor, true)
    const now = await tx.now(), pending = await tx.scan<ConsoleCode>('auth-session', { relation: 'operator-code', limit: 200 })
    for (const row of pending) if (row.value.used || row.value.until <= now) await tx.remove('auth-session', row.id, row.revision)
    if (pending.filter(row => !row.value.used && row.value.until > now).length >= 20) throw new AccessDenied('Too many active operator codes')
    await tx.put<ConsoleCode>('auth-session', `operator-code/${hash(code)}`, { kind: 'operator-code', actor, appId: config.installation.appId,
      tenantKey: config.installation.tenantKey, until: now + 300_000, used: false }, 0, { relation: 'operator-code' })
    await tx.put('audit', `operator-code/${hash(code)}`, { actor, at: now, kind: 'ssh-console-login-issued' }, 0)
  })
  return code
}
/** Exchanges an OS-admin-issued one-use code for the installation's current operator identity. */
export class OperatorLogin implements LoginProvider {
  constructor(private store: StateStore, private scope: StateScope, private access: ProductAccess, private origin: string) { requireConsoleOrigin(origin) }
  authorizeUrl(state: string) { return `${this.origin}/auth/operator?state=${encodeURIComponent(state)}` }
  async exchange(code: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new AccessDenied('Invalid operator code')
    return this.store.transaction(this.scope, async tx => {
      const row = await tx.get<ConsoleCode>('auth-session', `operator-code/${hash(code)}`), config = await this.access.configuration(tx)
      if (!row || row.value.kind !== 'operator-code' || row.value.used || row.value.until <= await tx.now()
        || row.value.actor !== config.installation.operator || row.value.appId !== config.installation.appId || row.value.tenantKey !== config.installation.tenantKey)
        throw new AccessDenied('Operator code expired or already used')
      await this.access.user(tx, row.value.actor, true)
      await tx.put('auth-session', row.id, { ...row.value, used: true }, row.revision, { relation: 'operator-code' })
      return { openId: row.value.actor, tenantKey: row.value.tenantKey, expiresIn: 3600 }
    })
  }
}
