// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceMode } from './WorkspaceMode'
import { WorkspaceContext, type Workspace } from './context'
import { api } from './api'
vi.mock('./api', () => ({ api: vi.fn(), enc: encodeURIComponent, message: (e: unknown) => e instanceof Error ? e.message : String(e) }))
let host: HTMLDivElement, root: Root
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.mocked(api).mockReset() })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const button = (text: string) => [...host.querySelectorAll('button')].find(button => button.textContent === text)!
async function render() {
  const workspace = { data: { workspace: { mode: 'personal', operator: 'ou_alice', revision: 7 }, policyRevision: 7,
    connection: { chats: [{ chatId: 'oc_team', name: '工作群', listen: 'all' }] } }, locked: false,
    run: async (work: () => Promise<void>) => { await work(); return true } } as unknown as Workspace
  await act(async () => root.render(<WorkspaceContext.Provider value={workspace}><WorkspaceMode /></WorkspaceContext.Provider>))
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click())
}
it('requires reading members and explicitly choosing additional masters before saving a versioned group mode', async () => {
  vi.mocked(api).mockResolvedValue({ members: [{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }] })
  await render()
  expect(button('保存运行模式与主人名单').disabled).toBe(true)
  expect(vi.mocked(api)).not.toHaveBeenCalled()
  await act(async () => button('读取群成员，选择主人').click())
  const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  expect(checks[0]!.disabled).toBe(true)
  expect(checks[0]!.checked).toBe(true)
  expect(checks[1]!.checked).toBe(false)
  await act(async () => checks[1]!.click())
  vi.mocked(api).mockResolvedValue({ message: '已保存' })
  await act(async () => button('保存运行模式与主人名单').click())
  expect(api).toHaveBeenLastCalledWith('/workspace', 'PUT', { mode: 'group', revision: 7, chatId: 'oc_team',
    masters: [{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }] })
})
it('keeps membership failures visible and does not permit saving an unverified selection', async () => {
  vi.mocked(api).mockRejectedValue(new Error('群成员权限不足'))
  await render()
  await act(async () => button('读取群成员，选择主人').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('群成员权限不足')
  expect(button('保存运行模式与主人名单').disabled).toBe(true)
  expect(vi.mocked(api).mock.calls.every(call => call[1] !== 'PUT')).toBe(true)
})
it('keeps a company scope fixed and prevents non-operators from editing its membership', async () => {
  const workspace = { data: { workspace: { mode: 'group', operator: 'ou_alice', revision: 7, scopeFixed: true, canManage: false,
    group: { chatId: 'oc_team', name: '工作群', masters: [{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }] } }, policyRevision: 7,
    connection: { chats: [{ chatId: 'oc_team', name: '工作群', listen: 'all' }] } }, locked: false } as unknown as Workspace
  await act(async () => root.render(<WorkspaceContext.Provider value={workspace}><WorkspaceMode /></WorkspaceContext.Provider>))
  expect(host.querySelector<HTMLFieldSetElement>('fieldset.lv-options')?.disabled).toBe(true)
  expect(host.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true)
  expect(button('读取群成员，选择主人').disabled).toBe(true)
  expect(button('保存运行模式与主人名单').disabled).toBe(true)
  expect(host.textContent).toContain('避免混入历史资料')
  expect(api).not.toHaveBeenCalled()
})
