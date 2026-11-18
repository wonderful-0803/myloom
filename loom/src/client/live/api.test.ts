// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
afterEach(() => { document.head.innerHTML = ''; vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });
it('binds an in-flight write to its selected group before waiting for login, and honors explicit management targets', async () => {
  const meta = document.createElement('meta'); meta.name = 'loom-product-server'; document.head.append(meta);
  history.replaceState(null, '', '/?workspace=group-A');
  let login: (value: unknown) => void = () => {};
  const fetcher = vi.fn(async (url: string) => url === '/auth/session' ? new Promise(resolve => { login = resolve; }) : { ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetcher);
  const pending = api('/mode', 'PATCH', { mode: 'observe' });
  history.replaceState(null, '', '/?workspace=group-B');
  login({ ok: true, json: async () => ({ csrf: 'synthetic' }) }); await pending;
  expect(fetcher.mock.calls[1]![0]).toBe('/orchestrator/api/loom/mode?workspace=group-A');
  await api('/workspace/source?workspace=group-C', 'PUT', { enabled: false });
  expect(fetcher.mock.calls[2]![0]).toBe('/orchestrator/api/loom/workspace/source?workspace=group-C');
  meta.remove(); await api('/tasks');
  expect(fetcher.mock.calls[3]![0]).toBe('/orchestrator/api/loom/tasks');
});
