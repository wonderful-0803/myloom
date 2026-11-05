'use strict'
// One native Windows service process. Its private named pipe permits status and
// graceful shutdown only; it is not a command-execution or network interface.
const net = require('node:net')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { timingSafeEqual } = require('node:crypto')
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows service host requires Windows')
  let text = ''
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 65536) throw new Error('Startup record too large') }
  const value = JSON.parse(text)
  if (!/^[a-f0-9]{64}$/.test(value.token) || !/^\\\\\.\\pipe\\loom-[a-f0-9]{40}$/.test(value.pipe)
    || !path.isAbsolute(value.cwd) || !path.isAbsolute(value.program) || !Array.isArray(value.argv) || !value.argv.every(arg => typeof arg === 'string')) throw new Error('Invalid startup record')
  const token = Buffer.from(value.token), server = net.createServer(client => {
    let request = ''; client.setTimeout(2000, () => client.destroy())
    client.on('data', chunk => {
      request += chunk.toString('utf8'); if (request.length > 2048) { client.destroy(); return }
      if (!request.includes('\n')) return
      let input
      try { input = JSON.parse(request.slice(0, request.indexOf('\n'))) } catch { client.destroy(); return }
      const supplied = Buffer.from(String(input.token || ''))
      if (supplied.length !== token.length || !timingSafeEqual(token, supplied)) { client.destroy(); return }
      if (input.action === 'status') client.end(JSON.stringify({ ok: true, pid: process.pid, cwd: value.cwd, profile: value.profile, url: value.url }) + '\n')
      else if (input.action === 'stop' && process.listenerCount('SIGINT') > 0) {
        client.end('{"ok":true}\n', () => setImmediate(() => process.emit('SIGINT')))
      } else client.end('{"ok":false}\n')
    })
    client.on('error', () => {})
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(value.pipe, resolve) })
  server.unref()
  process.chdir(value.cwd)
  // dsh is a Node CLI entry, resolved from its installed package without cmd.exe.
  if (path.resolve(value.program) !== path.resolve(process.execPath) || !value.argv.length || !/\.[cm]?js$/i.test(value.argv[0])) throw new Error('Expected a native Node CLI')
  process.argv = [process.execPath, ...value.argv]
  const cli = await import(pathToFileURL(value.argv[0]).href)
  if (typeof cli.runCli === 'function') await cli.runCli()
}
main().catch(() => { process.stderr.write('Windows 本机助手启动未完成，请检查原生依赖与配置。\n'); process.exit(1) })
