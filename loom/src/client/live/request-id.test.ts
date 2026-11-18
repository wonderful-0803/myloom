import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { requestId } from './request-id';
afterEach(() => vi.unstubAllGlobals());
it('creates distinct UUID v4 request IDs on insecure HTTP origins without randomUUID', () => {
  const getRandomValues = vi.fn((array: Uint8Array) => webcrypto.getRandomValues(array));
  vi.stubGlobal('crypto', { getRandomValues });
  const ids = Array.from({ length: 100 }, () => requestId());
  expect(new Set(ids).size).toBe(100);
  expect(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true);
  expect(getRandomValues).toHaveBeenCalledTimes(100);
});
it('uses native randomUUID when available', () => {
  const randomUUID = vi.fn(() => 'native-id');
  vi.stubGlobal('crypto', { randomUUID });
  expect(requestId()).toBe('native-id');
  expect(randomUUID).toHaveBeenCalledOnce();
});
