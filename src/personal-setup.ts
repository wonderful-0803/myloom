/** One-time initialization for an unused desktop-owned state directory; never edits a running assistant. */
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { Store } from './app/store.ts'
import { SettingsSchema, policyVersion } from './policy.ts'
import { feishuKind } from './sources/feishu.ts'

const Input = z.object({
  stateDir: z.string().refine(isAbsolute), botCli: z.string().refine(isAbsolute),
  owner: z.string().regex(/^ou_[A-Za-z0-9]+$/), ownerName: z.string().max(100).default('本人'),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/), name: z.string().max(60), listen: z.enum(['mentions', 'all']) }).strict()).max(3),
  directMessages: z.boolean(), mode: z.enum(['observe', 'auto']), model: z.string().trim().min(1).max(200),
}).strict()
export type PersonalSetupInput = z.input<typeof Input>
export function initializePersonalSettings(input: PersonalSetupInput): void {
  writePersonalSettings(input, false)
}
/** Updates a stopped, desktop-owned first-run instance without replacing its database or settings history. */
export function reconfigurePersonalSettings(input: PersonalSetupInput): void {
  writePersonalSettings(input, true)
}
function writePersonalSettings(input: PersonalSetupInput, reconfigure: boolean): void {
  const value = Input.parse(input)
  const stateDir = resolve(value.stateDir), parent = dirname(stateDir)
  if (!existsSync(join(parent, '.loom-instance'))) throw new Error('Not a desktop-owned assistant directory')
  for (const directory of [parent, stateDir]) if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Symlink directory refused')
  if (!value.directMessages && !value.chats.length) throw new Error('Select at least one message source')
  if (new Set(value.chats.map(chat => chat.chatId)).size !== value.chats.length) throw new Error('Duplicate chat IDs')
  const marker = join(stateDir, 'desktop-initialization.json'), request = JSON.stringify(value)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const lock = join(stateDir, '.desktop-initialization.lock'), fd = openSync(lock, 'wx', 0o600)
  try {
    if (existsSync(marker) && readFileSync(marker, 'utf8') === request && existsSync(join(stateDir, 'orchestrator.sqlite'))) return
    const existing = existsSync(join(stateDir, 'orchestrator.sqlite'))
    if (existing && (!reconfigure || !existsSync(marker))) throw new Error('Existing assistant state is never replaced')
    if (existing) Input.parse(JSON.parse(readFileSync(marker, 'utf8')))
    const feishu = feishuKind.schema.parse({ cli: value.botCli, ownerOnly: true, directMessages: value.directMessages,
      chats: value.chats, otherChats: 'none', cardsEnabled: false, draftsEnabled: false, mailCli: '', smtpCli: '' })
    const settings = SettingsSchema.parse({ paused: false, sources: { github: { enabled: false, config: {} }, feishu: { enabled: true, config: feishu } },
      policy: { sources: { feishu: { allowed: [{ id: value.owner, name: value.ownerName }], syncChat: '', bots: [] } }, rules: [
        { id: 'office-summary', name: '工作总结与纪要', enabled: true, instruction: 'When the authorized owner asks to summarize supplied records or an explicitly scoped discussion, prepare a source-backed report for the specified period. Establish the source scope and deliverable. Keep preparation silent. Do not edit source documents or contact a new audience.' },
        { id: 'office-data', name: '数据汇总', enabled: true, instruction: 'When the authorized owner requests a concrete aggregation of supplied data with an established period and statistical definition, compute a reproducible result and preserve the inputs. Observe if critical definitions are missing. Do not alter source business records. Keep preparation silent.' },
        { id: 'office-research', name: '资料查阅', enabled: true, instruction: 'When the authorized owner requests research with an established question and source scope, prepare a concise cited report using authorized inputs and, when requested, public primary sources. Distinguish facts from analysis. Do not contact others or publish elsewhere. Keep preparation silent.' },
      ] }, eval: { mode: value.mode, model: { provider: 'loom', model: value.model }, timeoutSeconds: 120 },
      executor: { model: { provider: 'loom', model: value.model }, maxWorkers: 2, directory: '', prepare: '', blockedCommands: [] } })
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    try {
      if (existing && store.tickets.list().length) throw new Error('This assistant already has tasks; use workspace settings or a new instance')
      store.saveSettings(settings, { source: 'panel', policyVersion: policyVersion(settings), policyChanged: true, notified: [] })
    }
    finally { store.db.close() }
    writeFileSync(marker, request, { flag: existing ? 'w' : 'wx', mode: 0o600 })
  } finally { closeSync(fd); unlinkSync(lock) }
}
