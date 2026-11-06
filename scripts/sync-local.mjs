/** Linux loopback hub bootstrap. Creates private state once, never prints or replaces credentials. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'lib', 'sync-server.js');

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('同步目录必须是当前用户拥有的普通目录。');
  chmodSync(path, 0o700);
}

try {
  if (process.argv.includes('--help')) {
    console.log('pnpm sync:local\nLinux 本机同步服务，固定监听 127.0.0.1；Ctrl+C 停止。\nLOOM_SYNC_LOCAL_DIR：独立数据目录，默认 ~/.local/share/loom-sync\nLOOM_SYNC_PORT：端口，默认 7421\n初始化凭据仅保存在该目录的 bootstrap.key，不会打印。');
    process.exit(0);
  }
  if (process.argv.length !== 2) throw Error('不支持额外参数；使用 --help 查看环境变量。');
  if (process.platform !== 'linux') throw Error('此本机引导面向 Linux；其他平台请按 docs/DEVICE_SYNC.md 部署。');
  if (!existsSync(entry)) throw Error('请先在仓库根目录运行 pnpm build。');
  const directory = process.env.LOOM_SYNC_LOCAL_DIR ?? join(homedir(), '.local', 'share', 'loom-sync');
  if (!isAbsolute(directory)) throw Error('LOOM_SYNC_LOCAL_DIR 需要绝对路径。');
  const port = Number(process.env.LOOM_SYNC_PORT ?? 7421);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('同步端口必须在 1 到 65535 之间。');
  privateDirectory(directory);
  const data = join(directory, 'data'), bootstrap = join(directory, 'bootstrap.key');
  privateDirectory(data);
  try {
    writeFileSync(bootstrap, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const file = openSync(bootstrap, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid() || info.size > 256) throw Error('初始化凭据文件不符合本机私有文件要求。');
    const credential = readFileSync(file, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(credential)) throw Error('现有初始化凭据格式无效；未替换文件。');
    fchmodSync(file, 0o600);
  } finally { closeSync(file); }
  console.log(`本机同步服务：http://127.0.0.1:${port}\n数据目录：${data}\n初始化凭据文件：${bootstrap}\n配对不会自动读取或上传 Codex 历史。`);
  const child = spawn(process.execPath, [entry], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, LOOM_SYNC_BOOTSTRAP_FILE: bootstrap, LOOM_SYNC_DATA: data, LOOM_SYNC_HOST: '127.0.0.1', LOOM_SYNC_PORT: String(port) },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('本机同步服务未能启动。'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
