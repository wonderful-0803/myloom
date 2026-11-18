#!/usr/bin/env node
/** C2 OS-local administrative/test harness, not a network server or online pairing service. */
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { once } from 'node:events'
import { LinuxRunner, initializeRunner } from '../lib/runner.js'
const { values, positionals } = parseArgs({ allowPositionals: true, options: { home: { type: 'string' }, binding: { type: 'string' }, 'gateway-key': { type: 'string' }, grant: { type: 'string' }, revision: { type: 'string' }, id: { type: 'string' }, help: { type: 'boolean' } } })
async function output(value) { if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain') }
let runner
try {
  const command = positionals[0]
  if (values.help) {
    console.log('runner-local init --home /private/runner --binding /private/binding.json --gateway-key /reviewed/gateway.pub\nrunner-local grant --home /private/runner --grant /private/grant.json [--revision 0]\nrunner-local revoke --home /private/runner --id grant-id --revision N\nrunner-local inspect --home /private/runner\nrunner-local stdio --home /private/runner\nBuild first. Linux non-root only. stdio is a trusted OS-local channel, NOT authenticated network transport. No Feishu, model or server credentials are needed. Admin init/grant/revoke are never network capabilities.')
  } else {
    if (!values.home) throw Error('Explicit private home required')
    if (command === 'init') {
      if (!values.binding || !values['gateway-key']) throw Error('Explicit reviewed binding and public key required')
      await output(await initializeRunner(values.home, JSON.parse(await readFile(values.binding, 'utf8')), await readFile(values['gateway-key'], 'utf8')))
    } else {
      runner = await LinuxRunner.open(values.home)
      if (command === 'grant') { if (!values.grant) throw Error('Explicit grant required'); const g = await runner.grant(JSON.parse(await readFile(values.grant, 'utf8')), Number(values.revision ?? 0)); await output({ id: g.id, revision: g.revision, enabled: g.enabled }) }
      else if (command === 'revoke') { if (!values.id || !values.revision) throw Error('Grant and revision required'); await output(runner.revoke(values.id, Number(values.revision))) }
      else if (command === 'inspect') await output({ grants: runner.grants(), network: 'not-configured', capabilities: ['fs.read', 'fs.glob', 'fs.grep'] })
      else if (command === 'stdio') {
        // The parent process owns this private pipe. C3 must authenticate a peer before binding a transport.
        const device = JSON.parse(await readFile(values.home + '/device.json', 'utf8')), transport = runner.transport(device.binding)
        const decoder = new StringDecoder('utf8'); let buffer = ''
        for await (const chunk of process.stdin) {
          buffer += decoder.write(chunk)
          let end
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue
            if (Buffer.byteLength(line) > 24000) throw Error('Local input budget exceeded')
            try {
              const item = JSON.parse(line)
              if (!item || Object.keys(item).sort().join(',') !== 'op,request' || !['dispatch', 'query', 'cancel'].includes(item.op)) throw Error('Unknown local command')
              await output({ ok: true, receipt: await transport[item.op](item.request, AbortSignal.timeout(10000)) })
            } catch { await output({ ok: false, error: 'runner_request_denied' }) }
          }
          if (Buffer.byteLength(buffer) > 24000) throw Error('Local input budget exceeded')
        }
        if (buffer.trim() || decoder.end()) throw Error('Incomplete local command')
        await runner.idle()
      } else throw Error('Unknown local command')
    }
  }
} catch { console.error('Runner operation failed. Check private configuration, local authorization, protocol and current process owner.'); process.exitCode = 1 }
finally { await runner?.close() }
