import http from 'node:http';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error This standalone deployment script intentionally uses Node without compilation.
import { createLanGateway } from '../../scripts/company-lan-gateway.mjs';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function listen(server: http.Server) { servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as AddressInfo).port; }
const origin = 'http://192.168.0.158:3084';
const options = { origin, cidr: '192.168.0.0/21' };
it.skipIf(process.platform === 'win32')('runs the CLI through the release symlink used by systemd', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-lan-cli-'));
  try {
    const path = join(root, 'current.mjs'); symlinkSync(resolve('scripts/company-lan-gateway.mjs'), path);
    const result = spawnSync(process.execPath, [path], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Required: --origin');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fetchRaw(port: number, path: string, extra: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: extra.method ?? 'GET', headers: { host: new URL(origin).host, ...extra.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
    });
    req.on('error', reject); req.end(extra.body ?? undefined);
  });
}

it('rejects non-private origins, non-loopback upstreams and mismatched subnets before binding', () => {
  for (const config of [ { ...options, origin: 'http://0.0.0.0:3084' }, { ...options, origin: 'http://8.8.8.8:3084' }, { ...options, cidr: '10.0.0.0/8' }, { ...options, upstream: 'http://192.168.0.158:3084' } ]) {
    expect(() => createLanGateway({ upstream: 'http://127.0.0.1:3084', ...config })).toThrow();
  }
});
it('checks peers, Host and browser Origin before proxying and preserves CSRF, ACL and scoped product paths', async () => {
  let calls = 0;
  const backend = await listen(http.createServer((req, res) => {
    calls++;
    if (req.url === '/orchestrator/api/loom/forbidden') { res.writeHead(403); return res.end(); }
    if (req.method === 'POST' && req.headers['x-loom-csrf'] !== 'valid-csrf') { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin, forwarded: req.headers['x-forwarded-for'], id: req.headers['idempotency-key'], path: req.url }));
  }));
  const upstream = `http://127.0.0.1:${backend}`;
  // Exercise the production subnet check with a loopback test peer: it must be refused.
  const restricted = await listen(createLanGateway({ ...options, upstream }));
  expect((await fetchRaw(restricted, '/auth/session')).status).toBe(403);
  // Permit the fixture's loopback peer as well as the declared LAN IP via the narrow test seam.
  const gateway: http.Server = createLanGateway({ ...options, upstream });
  const listener = gateway.listeners('request')[0]!;
  gateway.removeAllListeners('request');
  gateway.on('request', (req, res) => { Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: '192.168.0.218' }); listener.call(gateway, req, res); });
  const port = await listen(gateway);
  const request = (path: string, extra: { method?: string; headers?: Record<string, string>; body?: string } = {}) => fetchRaw(port, path, extra);
  expect((await request('/auth/session')).status).toBe(200);
  const before = calls;
  expect((await request('/auth/session', { headers: { host: 'attacker.example' } })).status).toBe(403);
  expect((await request('/auth/session', { headers: { origin: 'http://attacker.example' } })).status).toBe(403);
  expect((await request('/orchestrator/api/loom', { method: 'POST' })).status).toBe(403);
  expect((await request('/orchestrator/api/loom', { method: 'POST', headers: { origin: 'null' } })).status).toBe(403);
  expect((await request('/api/sessions')).status).toBe(404);
  expect((await request('/orchestrator/api/loom%2F..%2Fprivate')).status).toBe(404);
  expect(calls).toBe(before);
  expect((await request('/orchestrator/api/loom', { method: 'POST', headers: { origin } })).status).toBe(403);
  const ok = await request('/orchestrator/api/loom?workspace=original', { method: 'POST', body: '{}', headers: { origin, 'x-loom-csrf': 'valid-csrf', 'idempotency-key': 'unique', 'x-forwarded-for': 'attacker' } });
  expect(await ok.json()).toEqual({ host: `127.0.0.1:${backend}`, origin: upstream, id: 'unique', path: '/orchestrator/api/loom?workspace=original' });
  expect((await request('/orchestrator/api/loom/forbidden')).status).toBe(403);
  expect((await request('/')).headers.get('location')).toBe('/orchestrator/loom/');
});
