#!/usr/bin/env node
/** Synthetic strict-bot CLI for actual multi-root acceptance; never contacts Feishu. */
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
const args = process.argv.slice(2), folder = process.env.LOOM_GROUPS_TEST_ROOT, value = name => args[args.indexOf(name) + 1], output = data => console.log(JSON.stringify({ ok: true, data }))
if (!folder) throw Error('Explicit synthetic root required')
if (args[0] === 'auth') console.log(JSON.stringify({ appId: 'cli_groups', identities: { bot: { status: 'ready', verified: true } } }))
else if (args[0] === 'config') console.log('strict-mode: bot')
else if (args[0] === 'event') {
  console.error('[event] ready event_key=im.message.receive_v1')
  const lifetime = new AbortController(); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => lifetime.abort()); process.stdin.on('end', () => lifetime.abort()); process.stdin.resume()
  while (!lifetime.signal.aborted) {
    const go = await readFile(join(folder, 'go.json'), 'utf8').then(JSON.parse, () => undefined)
    if (go) {
      let first = false; try { await writeFile(join(folder, 'events-sent'), '1', { flag: 'wx', mode: 0o600 }); first = true } catch {}
      if (first) for (const [index, chat] of ['oc_groupA', 'oc_groupB', 'oc_unregistered'].entries()) console.log(JSON.stringify({ message_id: `om_group${index}`, chat_id: chat, chat_type: 'group', sender_id: 'ou_owner', sender_type: 'user', create_time: String(Date.now()), mentions: [], content: `仅总结虚构记录 ${index === 0 ? 'GROUP_A_R1' : 'GROUP_B_R2'}，不读取其他资料，回复原线程。` }))
    }
    await delay(50, undefined, { signal: lifetime.signal }).catch(() => {})
  }
} else if (args.includes('/open-apis/bot/v3/info')) console.log(JSON.stringify({ bot: { open_id: 'ou_groupsbot' } }))
else if (args.includes('/open-apis/im/v1/messages')) output({ items: [], has_more: false })
else if (args.includes('/open-apis/im/v1/chats')) output({ items: [{ chat_id: 'oc_groupA', name: 'Fictional A' }, { chat_id: 'oc_groupB', name: 'Fictional B' }], has_more: false })
else if (args.some(a => a.startsWith('/open-apis/im/v1/chats/'))) output({ name: 'Fictional B' })
else if (args.includes('+chat-members-list')) output({ users: [{ member_id: 'ou_owner', name: 'Fictional owner' }], has_more: false })
else if (args.includes('+messages-reply')) {
  if (args.includes('--file')) { const bytes = await readFile(value('--file')); await appendFile(join(folder, 'deliveries.ndjson'), JSON.stringify({ root: value('--message-id'), hash: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') }) + '\n', { mode: 0o600 }) }
  output({ message_id: 'om_receipt_' + value('--idempotency-key') })
} else throw Error('Unexpected synthetic bot operation')
