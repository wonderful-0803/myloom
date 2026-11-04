/** The operator's secret travels only through stdin; bad input and CLI output cannot leak it. */
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

const script = new URL('../scripts/configure-feishu-bot', import.meta.url).pathname
function probe(body: string): string {
  return execFileSync('python3', ['-c', `import runpy, tempfile, pathlib, subprocess, json\nconfigure = runpy.run_path(${JSON.stringify(script)})['configure']\n${body}`], { encoding: 'utf8' })
}
it('refuses masked secrets before calling the CLI', () => {
  expect(probe(`subprocess.run = lambda *a, **kw: (_ for _ in ()).throw(AssertionError('CLI must not run'))
with tempfile.TemporaryDirectory() as root:
 for secret in ['****', '*' * 32, '<redacted>']:
  try: configure('lark-cli', 'cli_test', root, 'feishu', secret)
  except ValueError: pass
  else: raise AssertionError('mask accepted')
print('ok')`)).toBe('ok\n')
})
it('never exposes credentials echoed by a failing CLI', () => {
  expect(probe(`secret = 'test-secret-for-stdin-only'
def fail(*a, **kw):
 assert kw['input'] == secret + '\\n'
 assert secret not in a[0]
 return subprocess.CompletedProcess(a[0], 3, stdout=secret, stderr=secret)
subprocess.run = fail
with tempfile.TemporaryDirectory() as root:
 try: configure('lark-cli', 'cli_test', root, 'feishu', secret)
 except ValueError as error:
  assert secret not in str(error)
 else: raise AssertionError('failure ignored')
print('ok')`)).toBe('ok\n')
})
it('keeps user login configurations intact and verifies the dedicated bot', () => {
  expect(probe(`calls = []
def run(argv, **kw):
 calls.append((argv, kw))
 return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({'identities': {'bot': {'verified': True}, 'user': {'available': False}}}), stderr='')
subprocess.run = run
with tempfile.TemporaryDirectory() as root:
 path = pathlib.Path(root) / 'config.json'
 original = json.dumps({'apps': [{'appId': 'cli_test', 'users': [{'userOpenId': 'ou_owner'}]}]})
 path.write_text(original)
 try: configure('lark-cli', 'cli_test', root, 'feishu', 'test-secret-for-stdin-only')
 except ValueError: pass
 else: raise AssertionError('user configuration overwritten')
 assert not calls and path.read_text() == original
 path.write_text(json.dumps({'apps': [{'appId': 'cli_test'}]}))
 configure('lark-cli', 'cli_test', root, 'feishu', 'test-secret-for-stdin-only')
 assert calls[1][0][1:] == ['config', 'strict-mode', 'bot', '--global']
 assert calls[2][0][1:] == ['auth', 'status', '--json', '--verify']
 assert all(call[1]['env']['LARKSUITE_CLI_CONFIG_DIR'] == root for call in calls)
print('ok')`)).toBe('ok\n')
})
