#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { TlsRunnerClient } from '../lib/execution.js'

const args = process.argv.slice(2)
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const home = value('--home'), caPath = value('--ca'), host = value('--host'), port = Number(value('--port'))
if (!home || !caPath || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: runner-connect --home <runner-home> --ca <gateway-cert.pem> --host <ai-box> --port <tls-port> [--servername <name>]')
  process.exit(2)
}
const client = await TlsRunnerClient.open(home, { host, port, ca: await readFile(caPath), servername: value('--servername') ?? host,
  heartbeatMs: Number(value('--heartbeat-ms') ?? 30_000), reconnectMs: Number(value('--reconnect-ms') ?? 500), maxReconnectMs: Number(value('--max-reconnect-ms') ?? 10_000) })
const stop = async () => { await client.stop(); process.exit(0) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
await client.start()
console.log(JSON.stringify({ deviceId: client.deviceId, status: client.status, host, port }))
await new Promise(() => {})
