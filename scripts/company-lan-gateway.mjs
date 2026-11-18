/** Explicit, single-origin LAN access to the loopback-only personal workbench. */
import http from 'node:http';
import https from 'node:https';
import { readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const number = ip => ip.split('.').reduce((result, byte) => (result * 256 + Number(byte)) >>> 0, 0);
function subnet(value) {
  const [ip, width, extra] = value.split('/'), bits = Number(width);
  if (extra !== undefined || isIP(ip) !== 4 || !/^\d+$/.test(width ?? '') || bits < 8 || bits > 32) throw Error('Invalid IPv4 subnet');
  const mask = (0xffffffff << (32 - bits)) >>> 0, network = number(ip) & mask;
  return peer => isIP(peer) === 4 && (number(peer) & mask) === network;
}
const privateIP = ip => isIP(ip) === 4 && ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].some(value => subnet(value)(ip));
const permitted = path => path === '/' || /^\/(?:healthz|readyz|auth\/(?:session|login|operator|callback|logout))$/.test(path)
  || /^\/orchestrator\/(?:loom(?:\/|$)|api\/loom(?:\/|$))/.test(path);
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
function headers(input) {
  const excluded = new Set([...hop, ...(input.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !excluded.has(key)));
}

export function createLanGateway({ origin, upstream, cidr, tlsKey, tlsCert }) {
  const external = new URL(origin), target = new URL(upstream), allowed = subnet(cidr);
  if (!['http:', 'https:'].includes(external.protocol) || external.origin !== origin || !privateIP(external.hostname) || !allowed(external.hostname)) throw Error('LAN origin must be an exact private IPv4 origin inside its subnet');
  if (external.protocol === 'https:' && (!tlsKey || !tlsCert)) throw Error('HTTPS LAN origin requires --tls-key and --tls-cert');
  if (external.protocol === 'http:' && (tlsKey || tlsCert)) throw Error('HTTP LAN origin cannot include TLS material');
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.origin !== upstream) throw Error('Upstream must be an exact loopback HTTP origin');
  const handler = (request, response) => {
    const deny = (status = 403) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: '局域网入口拒绝此请求。' })); };
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
    if (!allowed(peer) || request.headers.host !== external.host) return deny();
    if (request.headers.origin !== undefined && request.headers.origin !== origin) return deny();
    if (request.headers['sec-fetch-site'] === 'cross-site' && request.headers['sec-fetch-mode'] !== 'navigate') return deny();
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) return deny();
    const raw = request.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//') || /\\|%(?:2f|5c|2e)/i.test(raw) || /(?:^|\/)\.\.(?:\/|\?|$)/.test(raw)) return deny(404);
    const url = new URL(raw, origin);
    if (!permitted(url.pathname)) return deny(404);
    if (Number(request.headers['content-length'] ?? 0) > 2 * 1024 * 1024) return deny(413);
    if (url.pathname === '/') { response.writeHead(302, { location: '/orchestrator/loom/' }); return response.end(); }
    const outgoing = headers(request.headers);
    outgoing.host = target.host;
    // Never erase the Origin check: validate the browser's public origin above first.
    if (outgoing.origin !== undefined) outgoing.origin = external.protocol === 'https:' ? external.origin : target.origin;
    const proxy = http.request({ hostname: target.hostname, port: target.port || 80, path: raw, method: request.method, headers: outgoing }, result => {
      response.writeHead(result.statusCode ?? 502, headers(result.headers));
      result.on('error', () => response.destroy());
      result.pipe(response);
    });
    proxy.setTimeout(60_000, () => proxy.destroy());
    proxy.on('error', () => { if (!response.headersSent) deny(502); else response.destroy(); });
    request.on('aborted', () => proxy.destroy());
    response.on('close', () => { if (!response.writableFinished) proxy.destroy(); });
    let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { request.unpipe(proxy); proxy.destroy(); if (!response.headersSent) deny(413); } });
    request.pipe(proxy);
  };
  const server = external.protocol === 'https:'
    ? https.createServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }, handler)
    : http.createServer(handler);
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, upstream: { type: 'string' }, subnet: { type: 'string' }, 'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' } } });
  if (!values.origin || !values.upstream || !values.subnet) throw Error('Required: --origin http://PRIVATE_IP:PORT --upstream http://127.0.0.1:PORT --subnet CIDR');
  const origin = new URL(values.origin);
  const server = createLanGateway({ origin: values.origin, upstream: values.upstream, cidr: values.subnet, tlsKey: values['tls-key'], tlsCert: values['tls-cert'] });
  server.listen(Number(origin.port || 80), origin.hostname, () => console.log('Loom LAN gateway ready at ' + origin.origin + '/orchestrator/loom/'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
