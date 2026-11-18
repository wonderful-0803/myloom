import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CliFeishuWire } from '../../src/state/index.ts'
const folders: string[] = []
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }) })
async function cli(body: string) {
  const folder = await mkdtemp(join(tmpdir(), 'loom-event-cli-')); folders.push(folder)
  const path = join(folder, 'bot-cli'); await writeFile(path, '#!' + process.execPath + '\n' + body); await chmod(path, 0o700)
  return new CliFeishuWire({ cli: path, appId: 'cli_test', botId: 'ou_bot', name: 'Fixture', brand: 'feishu' })
}
it('waits for the documented ready marker and preserves split UTF-8 before yielding NDJSON', async () => {
  const wire = await cli(`const data = Buffer.from(JSON.stringify({text:'中文录音'})+'\\n'); const split=data.indexOf(Buffer.from('中'))+1;
process.stdout.write(data.subarray(0,split));setTimeout(()=>{process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');process.stdout.write(data.subarray(split));},20);`)
  let ready = false; const seen: unknown[] = []
  for await (const event of wire.events(AbortSignal.timeout(2000), () => { ready = true })) { expect(ready).toBe(true); seen.push(event) }
  expect(seen).toEqual([{ text: '中文录音' }])
})
it('does not consume a plausible stdout record if the CLI exits before readiness', async () => {
  const wire = await cli(`process.stdout.write('{"text":"must not be accepted"}\\n')`)
  const seen: unknown[] = []
  await expect((async () => { for await (const event of wire.events(AbortSignal.timeout(2000))) seen.push(event) })()).rejects.toThrow('before readiness')
  expect(seen).toEqual([])
})
it('stops gracefully on abort and rejects an incomplete event instead of committing a cursor', async () => {
  const wire = await cli(`process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');process.stdout.write('{"broken":')`)
  await expect((async () => { for await (const _ of wire.events(AbortSignal.timeout(2000))) {} })()).rejects.toThrow('incomplete')
  const running = await cli(`process.stderr.write('[event] ready event_key=im.message.receive_v1\\n'); process.stdin.resume();process.on('SIGTERM',()=>process.exit(0));`)
  const aborter = new AbortController(); let ready = false
  await (async () => { for await (const _ of running.events(aborter.signal, () => { ready = true; aborter.abort() })) {} })()
  expect(ready).toBe(true)
})
