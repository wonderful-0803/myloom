import { afterEach, expect, it } from 'vitest'
import { feishuTrigger } from '../../src/sources/feishu-trigger.ts'
import { FEISHU_INTAKE_WINDOW_MS, recordFeishuSignal, recordRunnerSignal } from '../../src/state/signals.ts'
import { SqliteStateStore } from '../../src/state/sqlite.ts'

const stores: SqliteStateStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())) })

function trigger(content: string, patch: Record<string, unknown> = {}) {
  return feishuTrigger({ message_id: patch.message_id ?? 'om_signal', chat_id: 'oc_signal', chat_type: 'group', sender_id: 'ou_owner', sender_type: 'user', content,
    create_time: patch.create_time ?? '1794000000000', mentions: patch.mentions ?? [], ...patch }, 'ou_bot', 'cli_test')!
}

it('records bounded Feishu message, attachment and topic-reply signal metadata', async () => {
  const store = await SqliteStateStore.open(':memory:'); stores.push(store)
  const scope = { tenantId: 'tenant', spaceId: 'space' }
  const messages = [trigger('整理一下记录'), trigger('<file key="file_1"/>', { message_id: 'om_file', msg_type: 'file' }), trigger('补充下一步', { message_id: 'om_reply', parent_id: 'om_signal', root_id: 'om_signal' })]
  await store.transaction(scope, async tx => { for (const value of messages) await recordFeishuSignal(tx, value) })
  const rows = await store.transaction(scope, tx => tx.scan<any>('audit', { relation: 'signal.feishu', limit: 10 }))
  expect(rows.map(row => row.value.kind)).toEqual(expect.arrayContaining(['attachment', 'message', 'thread-reply']))
  expect(rows.every(row => !('text' in row.value))).toBe(true)
  expect(FEISHU_INTAKE_WINDOW_MS).toBe(2_000)
})

it('deduplicates a Feishu source signal and records Runner status by connection epoch', async () => {
  const store = await SqliteStateStore.open(':memory:'); stores.push(store)
  const scope = { tenantId: 'tenant', spaceId: 'space' }, value = trigger('R1')
  await store.transaction(scope, async tx => { await recordFeishuSignal(tx, value); await recordFeishuSignal(tx, value) })
  await store.transaction(scope, async tx => {
    await recordRunnerSignal(tx, { deviceId: 'device-1', userId: 'ou_owner', environmentId: 'linux-1', connectionEpoch: 3, status: 'online' })
    await recordRunnerSignal(tx, { deviceId: 'device-1', userId: 'ou_owner', environmentId: 'linux-1', connectionEpoch: 3, status: 'online' })
    await recordRunnerSignal(tx, { deviceId: 'device-1', userId: 'ou_owner', environmentId: 'linux-1', connectionEpoch: 3, status: 'offline' })
  })
  const rows = await store.transaction(scope, tx => tx.scan<any>('audit', { relation: 'signal.runner', limit: 10 }))
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.value.status)).toEqual(expect.arrayContaining(['online', 'offline']))
})
