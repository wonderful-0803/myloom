/** Real Linux launcher + persistent hub restart. Uses only disposable credentials and synthetic plan text. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw Error('Linux local-service acceptance requires Linux.');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'loom-sync-local-'));
const directory = join(temporary, 'hub');
const children = new Set();
let diagnostics = '';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function launch(directory, port) {
  const child = spawn(process.execPath, [join(root, 'scripts/sync-local.mjs')], {
    cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOOM_SYNC_LOCAL_DIR: directory, LOOM_SYNC_PORT: String(port), LOOM_SYNC_HOST: '0.0.0.0' },
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function start(port) {
  const child = launch(directory, port);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('Local hub readiness timed out.')); }, 10_000);
    const collect = chunk => {
      diagnostics += chunk.toString();
      if (diagnostics.includes('Loom sync hub ready')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Local hub exited before readiness.')); });
  });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Local hub graceful stop timed out.')); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
try {
  const port = await unusedPort(), address = `http://127.0.0.1:${port}`;
  let child = await start(port);
  const sockets = readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1).map(line => line.trim().split(/\s+/));
  const listeners = sockets.filter(row => row[3] === '0A' && row[1]?.endsWith(':' + port.toString(16).toUpperCase().padStart(4, '0')));
  assert.ok(listeners.length > 0);
  assert.ok(listeners.every(row => row[1].startsWith('0100007F:')));
  const keyFile = join(directory, 'bootstrap.key'), key = readFileSync(keyFile, 'utf8').trim();
  const request = async (path, method = 'GET', token = '', body) => {
    const response = await fetch(address + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/v1/me')).status, 401);
  const created = await request('/v1/spaces', 'POST', key, { name: 'Linux acceptance', deviceName: 'A' });
  assert.equal(created.status, 200);
  const project = await request('/v1/projects', 'POST', created.body.token, { name: 'Disposable project' });
  assert.equal(project.status, 200);
  for (const path of [directory, join(directory, 'data')]) assert.equal(statSync(path).mode & 0o777, 0o700);
  for (const path of [keyFile, join(directory, 'data/hub.sqlite')]) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(diagnostics.includes(`http://127.0.0.1:${port}`));
  assert.ok(!diagnostics.includes(key));
  await stop(child);
  diagnostics = '';
  child = await start(port);
  assert.equal(readFileSync(keyFile, 'utf8').trim(), key);
  const persisted = await request('/v1/projects', 'GET', created.body.token);
  assert.equal(persisted.status, 200);
  assert.deepEqual(persisted.body.projects.map(p => p.id), [project.body.id]);
  await stop(child);
  const unsafe = join(temporary, 'unsafe'), target = join(temporary, 'keep.key');
  mkdirSync(unsafe, { mode: 0o700 });
  writeFileSync(target, 'do-not-read-or-replace', { mode: 0o600 });
  symlinkSync(target, join(unsafe, 'bootstrap.key'));
  const rejected = launch(unsafe, port);
  rejected.stdout.resume(); rejected.stderr.resume();
  const code = await new Promise(resolve => rejected.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.equal(readFileSync(target, 'utf8'), 'do-not-read-or-replace');
  console.log('PASS: Linux local hub startup, loopback-only configuration, private files, protected credentials, persistent restart and symlink rejection; synthetic data only.');
} finally {
  for (const child of [...children]) await stop(child);
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep + 'loom-sync-local-')) throw Error('Unsafe cleanup.');
  rmSync(temporary, { recursive: true, force: true });
}
