/** Real Linux process owner/crash fixture. Synthetic local files only; no company or network configuration. */
import { setImmediate as immediate } from 'node:timers/promises'
import { LinuxRunner } from '../../src/execution/runner/index.ts'
import type { RunnerPeer } from '../../src/execution/runner/index.ts'
import type { RemoteRequest, RemoteReceipt } from '../../src/execution/protocol.ts'
import { intentHash } from '../../src/execution/protocol.ts'
const input = JSON.parse(process.argv[2]!) as { home: string; peer: RunnerPeer; request: RemoteRequest; mode: 'hold' | 'recover' }
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
let runner: LinuxRunner | undefined
try {
  runner = await LinuxRunner.open(input.home)
  const transport = runner.transport(input.peer), query = { protocolVersion: 1 as const, requestId: input.request.requestId, intentHash: intentHash(input.request) }
  if (input.mode === 'hold') {
    await transport.dispatch(input.request, AbortSignal.timeout(5000))
    for (;;) {
      await immediate()
      const receipt = await transport.query(query, AbortSignal.timeout(5000)) as RemoteReceipt
      if (receipt.status === 'running') {
        emit({ state: 'running', sequence: receipt.sequence })
        process.kill(process.pid, 'SIGSTOP') // Stop the real read while it is awaiting filesystem I/O.
        break
      }
      if (receipt.status !== 'accepted') throw Error('Missed running checkpoint')
    }
    process.stdin.resume()
  } else { emit({ state: 'recovered', receipt: await transport.query(query, AbortSignal.timeout(5000)) }); await runner.close() }
} catch { emit({ state: 'refused' }); await runner?.close(); process.exitCode = 1 }
