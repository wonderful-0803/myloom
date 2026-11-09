/**
 * The `lark-cli` a team workspace runs. It holds no Feishu credentials: every call is forwarded to the gateway, which decides what
 * the workspace may send or read, and `event consume` streams only the events routed to this workspace.
 * Configured through LOOM_TEAM_GATEWAY (gateway URL) and LOOM_TEAM_TOKEN_FILE (this workspace's token).
 */
import { readFileSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const gateway = process.env.LOOM_TEAM_GATEWAY ?? ''
const tokenFile = process.env.LOOM_TEAM_TOKEN_FILE ?? ''
const argv = process.argv.slice(2)

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = readFileSync(tokenFile, 'utf8').trim()
  return fetch(new URL(path, gateway), { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
}

async function consume(eventKey: string): Promise<void> {
  let stopped = false
  const stop = () => { stopped = true }
  process.stdin.on('end', stop); process.stdin.on('close', stop); process.stdin.resume()
  process.on('SIGTERM', () => process.exit(0))
  if (eventKey !== 'im.message.receive_v1') {
    // Card callbacks are not routed in the prototype; stay "ready" so the workspace reports no error.
    process.stderr.write('[event] ready (no events routed for ' + eventKey + ')\n')
    while (!stopped) await delay(1000)
    return
  }
  let after: number | undefined, ready = false, failures = 0
  while (!stopped) {
    try {
      const response = await call(`/ws/events?wait=25${after === undefined ? '' : `&after=${after}`}`)
      if (response.status === 401 || response.status === 403) throw new Error(`gateway refused the event stream (${response.status})`)
      if (!response.ok) throw new Error(`gateway returned ${response.status}`)
      if (!ready) { process.stderr.write('[event] ready\n'); ready = true }
      failures = 0
      const { events } = await response.json() as { events: { seq: number; line: string }[] }
      for (const event of events) { process.stdout.write(event.line + '\n'); after = event.seq }
    } catch (error) {
      if (++failures >= 5) { process.stderr.write(`team gateway error: ${String(error)}\n`); process.exit(1) }
      await delay(1000 * failures)
    }
  }
}

async function main(): Promise<void> {
  if (!gateway || !tokenFile) { process.stderr.write('team gateway error: LOOM_TEAM_GATEWAY and LOOM_TEAM_TOKEN_FILE are required\n'); process.exit(2) }
  if (argv[0] === 'event' && argv[1] === 'consume') return consume(argv[2] ?? '')
  // A file to send is read from the caller's working directory; the prototype passes its size, not its bytes.
  const files: Record<string, number> = {}
  const file = argv.indexOf('--file')
  if (file >= 0 && argv[file + 1]) files[argv[file + 1]!] = statSync(argv[file + 1]!).size
  const response = await call('/ws/cli', { method: 'POST', body: JSON.stringify({ argv, files }) })
  if (!response.ok) { process.stderr.write(`team gateway error: ${response.status} ${await response.text()}\n`); process.exit(1) }
  const result = await response.json() as { code: number; stdout: string; stderr: string }
  process.stdout.write(result.stdout); process.stderr.write(result.stderr)
  process.exit(result.code)
}
void main().catch(error => { process.stderr.write(`team gateway error: ${String(error)}\n`); process.exit(1) })
