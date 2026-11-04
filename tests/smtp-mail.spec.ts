/** Exercises the real Python SMTP bridge with a fake SMTP server; never connects to or sends through a real mailbox. */
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

const script = new URL('../scripts/personal-mail', import.meta.url).pathname
function probe(body: string): string {
  return execFileSync('python3', ['-c', `import runpy, tempfile, pathlib, json, os, smtplib, ssl\ng = runpy.run_path(${JSON.stringify(script)})\n${body}`], { encoding: 'utf8' })
}
const setup = `calls = []
class SMTP:
 def __init__(self, host, port, **kw):
  assert host == 'smtp.163.com' and port == 465
  assert kw['context'].check_hostname and kw['context'].verify_mode == ssl.CERT_REQUIRED
 def login(self, address, code): calls.append(('login', address, code))
 def close(self): pass
 def send_message(self, message, **kw):
  calls.append(('send', message, kw))
  return {}
smtplib.SMTP_SSL = SMTP
`
const request = `request = {'owner': 'ou_owner', 'appId': 'cli_test', 'accountId': config['accountId'],
 'to': 'owner@163.com', 'subject': '虚构总结', 'body': 'R1 完成整理。<script>untrusted</script>',
 'messageId': '<superagent.' + 'a' * 32 + '@163.com>'}
`

it('verifies TLS/auth before atomic replacement, protects credentials, and exposes public metadata only', () => {
  expect(probe(setup + `with tempfile.TemporaryDirectory() as root:
 path = pathlib.Path(root) / '163-mail.json'
 result = g['configure'](path, 'owner@163.com', 'ou_owner', 'cli_test', 'test-authorization-code')
 assert 'authorizationCode' not in result and not any(c[0] == 'send' for c in calls)
 assert path.stat().st_mode & 0o777 == 0o600
 original = path.read_text()
 def fail(self, *args): raise smtplib.SMTPAuthenticationError(535, b'test-authorization-code')
 SMTP.login = fail
 try: g['configure'](path, 'owner@163.com', 'ou_owner', 'cli_test', 'replacement-code')
 except smtplib.SMTPAuthenticationError: pass
 else: raise AssertionError('authentication failure ignored')
 assert path.read_text() == original
 path.chmod(0o644)
 try: g['load_config'](path)
 except ValueError: pass
 else: raise AssertionError('insecure file accepted')
print('ok')`)).toBe('ok\n')
})

it('sends only the configured owner, requires confirmation, builds safe MIME, and reuses SMTP acceptance without another send', () => {
  expect(probe(setup + `with tempfile.TemporaryDirectory() as root:
 path = pathlib.Path(root) / '163-mail.json'
 g['configure'](path, 'owner@163.com', 'ou_owner', 'cli_test', 'test-authorization-code')
 config = g['load_config'](path)
 ${request.replace(/\n/g, '\n ')}
 for value, confirmed in [({**request, 'to': 'other@163.com'}, True), (request, False), ({**request, 'accountId': 'b' * 32}, True), ({**request, 'subject': 'x\\nBcc: stolen@163.com'}, True)]:
  try: g['send'](path, config, value, confirmed)
  except ValueError: pass
  else: raise AssertionError('unauthorized send accepted')
 assert not any(c[0] == 'send' for c in calls)
 first = g['send'](path, config, request, True)
 assert first['status'] == 'submitted'
 assert g['send'](path, config, request, True) == first
 sent = [c for c in calls if c[0] == 'send']
 assert len(sent) == 1
 msg, envelope = sent[0][1:]
 assert msg['To'] == msg['From'] == 'owner@163.com' and msg['Bcc'] is None
 assert envelope['to_addrs'] == ['owner@163.com']
 assert '&lt;script&gt;' in msg.get_body(preferencelist=('html',)).get_content()
 assert g['status'](path, config, request)['status'] == 'submitted'
print('ok')`)).toBe('ok\n')
})

it('keeps a lost SMTP response unknown and refuses to repeat the same managed message', () => {
  expect(probe(setup + `with tempfile.TemporaryDirectory() as root:
 path = pathlib.Path(root) / '163-mail.json'
 g['configure'](path, 'owner@163.com', 'ou_owner', 'cli_test', 'test-authorization-code')
 config = g['load_config'](path)
 ${request.replace(/\n/g, '\n ')}
 def lost(self, *args, **kw):
  calls.append(('send',))
  raise smtplib.SMTPServerDisconnected('lost final response')
 SMTP.send_message = lost
 try: g['send'](path, config, request, True)
 except smtplib.SMTPServerDisconnected: pass
 else: raise AssertionError('lost response treated as success')
 assert g['send'](path, config, request, True)['status'] == 'unknown'
 assert len([c for c in calls if c[0] == 'send']) == 1
print('ok')`)).toBe('ok\n')
})

it('attaches exactly the fixed text report and rejects paths, mismatched hashes and non-text files before SMTP', () => {
  expect(probe(setup + `import hashlib
with tempfile.TemporaryDirectory() as root:
 path = pathlib.Path(root) / '163-mail.json'
 g['configure'](path, 'owner@163.com', 'ou_owner', 'cli_test', 'test-authorization-code')
 config = g['load_config'](path)
 ${request.replace(/\n/g, '\n ')}
 content = '# 完整报告\\nR1 已完成'
 attachment = {'filename': '总结.md', 'content': content, 'sha256': hashlib.sha256(content.encode()).hexdigest()}
 for bad in [{**attachment, 'filename': '../secret.md'}, {**attachment, 'filename': 'secret.exe'}, {**attachment, 'sha256': 'wrong'}]:
  try: g['send'](path, config, {**request, 'attachment': bad}, True)
  except ValueError: pass
  else: raise AssertionError('unsafe attachment accepted')
 assert not any(c[0] == 'send' for c in calls)
 g['send'](path, config, {**request, 'attachment': attachment}, True)
 msg = [c for c in calls if c[0] == 'send'][0][1]
 attachments = list(msg.iter_attachments())
 assert len(attachments) == 1 and attachments[0].get_filename() == '总结.md'
 assert attachments[0].get_payload(decode=True).decode() == content
print('ok')`)).toBe('ok\n')
})

it('rejects escaping request paths and never prints raw credential-bearing SMTP errors', () => {
  expect(probe(setup + `import sys, io, contextlib, builtins, getpass
with tempfile.TemporaryDirectory() as root:
 os.chdir(root)
 pathlib.Path('outside').symlink_to('/etc/passwd')
 for value in ['/etc/passwd', 'outside']:
  try: g['relative_request'](value)
  except ValueError: pass
  else: raise AssertionError('escaping file accepted')
 os.environ['SUPERAGENT_MAIL_CONFIG'] = str(pathlib.Path(root) / '163-mail.json')
 sys.argv = ['personal-mail', 'configure', '--owner', 'ou_owner', '--app-id', 'cli_test']
 sys.stdin = type('TTY', (), {'isatty': lambda self: True})()
 builtins.input = lambda *args: 'owner@163.com'
 getpass.getpass = lambda *args: 'test-authorization-code'
 def fail(self, *args): raise smtplib.SMTPAuthenticationError(535, b'test-authorization-code')
 SMTP.login = fail
 output = io.StringIO()
 with contextlib.redirect_stderr(output):
  try: runpy.run_path(${JSON.stringify(script)}, run_name='__main__')
  except SystemExit as error: assert error.code == 1
 assert 'test-authorization-code' not in output.getvalue()
 assert '163 mail operation failed' in output.getvalue()
print('ok')`)).toBe('ok\n')
})
