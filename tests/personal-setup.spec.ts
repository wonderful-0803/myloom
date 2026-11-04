import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializePersonalSettings, type PersonalSetupInput } from '../src/personal-setup.ts'
import { Store } from '../src/app/store.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(): PersonalSetupInput {
  const root = mkdtempSync(join(tmpdir(), 'loom-initial-')); roots.push(root)
  writeFileSync(join(root, '.loom-instance'), 'test', { mode: 0o600 })
  return { stateDir: join(root, 'state'), botCli: join(root, 'lark-bot'), owner: 'ou_owner', ownerName: '本人',
    chats: [{ chatId: 'oc_test', name: '测试群', listen: 'all' }], directMessages: true, mode: 'observe', model: 'test-model' }
}
describe('desktop first-run state', () => {
  it('creates real versioned office settings with one owner and exact scope, without importing any previous data', () => {
    const input = fixture(); initializePersonalSettings(input)
    const store = new Store(join(input.stateDir, 'orchestrator.sqlite'))
    try {
      const settings = store.settings()
      expect(settings.sources.github?.enabled).toBe(false)
      expect(settings.sources.feishu?.config).toMatchObject({ ownerOnly: true, otherChats: 'none', chats: input.chats, cardsEnabled: false, draftsEnabled: false, mailCli: '', smtpCli: '' })
      expect(settings.policy.sources.feishu?.allowed).toEqual([{ id: 'ou_owner', name: '本人' }])
      expect(settings.policy.rules.map(rule => rule.id)).toEqual(['office-summary', 'office-data', 'office-research'])
      expect(settings.eval).toMatchObject({ mode: 'observe', model: { provider: 'loom', model: 'test-model' } })
      expect(store.settingsHistory()).toHaveLength(1)
      expect(store.settingsHistory()[0]?.source).toBe('panel')
      expect(store.db.prepare('select count(*) as n from ticket').get()?.n).toBe(0)
    } finally { store.db.close() }
    const before = readFileSync(join(input.stateDir, 'orchestrator.sqlite'))
    initializePersonalSettings(input)
    expect(readFileSync(join(input.stateDir, 'orchestrator.sqlite'))).toEqual(before)
    expect(() => initializePersonalSettings({ ...input, owner: 'ou_other' })).toThrow('never replaced')
  })
  it('refuses existing foreign state, an unowned directory and an empty or duplicated source scope', () => {
    const input = fixture(); mkdirSync(input.stateDir)
    writeFileSync(join(input.stateDir, 'orchestrator.sqlite'), 'existing-private-state')
    expect(() => initializePersonalSettings(input)).toThrow('never replaced')
    expect(readFileSync(join(input.stateDir, 'orchestrator.sqlite'), 'utf8')).toBe('existing-private-state')
    expect(() => initializePersonalSettings({ ...fixture(), directMessages: false, chats: [] })).toThrow('at least one')
    const duplicate = fixture()
    expect(() => initializePersonalSettings({ ...duplicate, chats: [...duplicate.chats, ...duplicate.chats] })).toThrow('Duplicate')
    rmSync(join(input.stateDir, '../.loom-instance'))
    expect(() => initializePersonalSettings(input)).toThrow('desktop-owned')
  })
})
