// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupSpaces } from './GroupSpaces';
import { api } from './api';
vi.mock('./api', () => ({ api: vi.fn(), enc: encodeURIComponent, message: (e: unknown) => e instanceof Error ? e.message : String(e), modeName: { observe: '仅观察', auto: '自动执行' } }));
let host: HTMLDivElement, root: Root, meta: HTMLMetaElement;
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; history.replaceState(null, '', '/?workspace=' + id);
  meta = document.createElement('meta'); meta.name = 'loom-multiple-groups'; document.head.append(meta);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.mocked(api).mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); meta.remove(); });
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text)!;
const directory = { groups: [{ spaceId: id, chatId: 'oc_a', name: 'Group A', enabled: true, mode: 'auto', state: 'ready', revision: 4, canManage: true }], canManage: true, operator: 'ou_owner', maxGroups: 20 };
it('keeps the personal and single-group application free of multi-group requests', async () => {
  meta.remove(); await act(async () => root.render(<GroupSpaces />)); expect(api).not.toHaveBeenCalled(); expect(host.textContent).toBe('');
});
it('requires verified group members and retains the administrator before explicit registration', async () => {
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === '/workspaces') { if (method === 'POST') throw Error('Explicit fixture refusal'); return directory as never; }
    if (path === '/workspaces/chats') return { chats: [{ chatId: 'oc_b', name: 'Group B' }] } as never;
    return { members: [{ id: 'ou_owner', name: 'Owner' }, { id: 'ou_b', name: 'B' }] } as never;
  });
  await act(async () => root.render(<GroupSpaces />)); await act(async () => button('管理接入群').click());
  expect(button('确认接入这个群').disabled).toBe(true);
  await act(async () => button('读取机器人已加入的群').click());
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="目标群"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'oc_b'); select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('核验群并选择主人').click());
  const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); expect(checks[0]!.checked).toBe(true); expect(checks[0]!.disabled).toBe(true); expect(checks[1]!.checked).toBe(false);
  await act(async () => checks[1]!.click()); await act(async () => button('确认接入这个群').click());
  expect(api).toHaveBeenCalledWith('/workspaces', 'POST', expect.objectContaining({ chatId: 'oc_b', masters: ['ou_owner', 'ou_b'], mode: 'observe', requestId: expect.any(String) }));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Explicit fixture refusal');
});
it('hides group registration from non-administrators', async () => {
  vi.mocked(api).mockResolvedValue({ ...directory, canManage: false }); await act(async () => root.render(<GroupSpaces />));
  expect([...host.querySelectorAll('button')].some(item => item.textContent === '管理接入群')).toBe(false);
});
