#!/usr/bin/env node
/** One-shot C4 acceptance: CompanyRemoteExecution -> TLS Gateway -> Linux Runner fs.read. */
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { control } from '../lib/state.js'
import { PostgresStateStore, ProductAccess } from '../lib/state.js'
import { DeviceGateway, GatewayRequestLedger, StateGatewayDirectory, StateGatewayLedgerBackend, TlsGatewayServer } from '../lib/execution.js'
import { CompanyRemoteExecution } from '../lib/execution.js'

const { values } = parseArgs({ options: {
  config: { type: 'string' }, 'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' }, 'identity-key': { type: 'string' },
  host: { type: 'string' }, port: { type: 'string' }, environment: { type: 'string' }, workspace: { type: 'string' },
  'grant-id': { type: 'string' }, 'grant-revision': { type: 'string' }, 'ticket-id': { type: 'string' }, path: { type: 'string' },
} })
for (const name of ['config', 'tls-key', 'tls-cert', 'identity-key', 'host', 'environment', 'workspace', 'grant-id']) if (!values[name]) throw Error(`Missing --${name}`)
const config = JSON.parse(await readFile(values.config, 'utf8')), scope = { tenantId: config.tenantId, spaceId: config.spaceId }, connectionString = process.env[config.databaseUrlEnv]
if (!connectionString) throw Error(`Missing ${config.databaseUrlEnv}`)
const store = await PostgresStateStore.open({ connectionString }), access = new ProductAccess(config.installationId)
const privateKey = createPrivateKey(await readFile(values['identity-key'])), identity = { privateKey, publicKey: createPublicKey(privateKey) }, material = { key: await readFile(values['tls-key']), cert: await readFile(values['tls-cert']) }
const gateway = new DeviceGateway({ keyPair: identity, directory: new StateGatewayDirectory(store, scope), ledger: new GatewayRequestLedger(new StateGatewayLedgerBackend(store, scope)) })
const tls = new TlsGatewayServer({ gateway, key: material.key, cert: material.cert, host: values.host, port: Number(values.port ?? 3444) })
const profile = { environmentId: values.environment, workspaceId: values.workspace, resourceGrantId: values['grant-id'], grantRevision: Number(values['grant-revision'] ?? 1) }
const remote = new CompanyRemoteExecution({ gateway, store, scope, access, profile })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  await tls.start()
  let ticket, synthetic = false
  for (let attempt = 0; attempt < 60 && !ticket; attempt++) {
    ticket = await store.transaction(scope, async tx => {
      if (values['ticket-id']) return (await tx.get('ticket', values['ticket-id']))?.value
      const config = await access.configuration(tx), rows = await tx.scan('ticket', { limit: 1000 })
      return rows.map(row => row.value).find(value => value.mandate?.actor?.id === config.installation.operator && !value.ended && value.assignments?.length)
    })
    if (!ticket) await sleep(500)
  }
  if (!ticket) {
    const now = new Date().toISOString(), ids = { ticket: `remote-acceptance-ticket-${randomUUID()}`, trigger: `remote-acceptance-trigger-${randomUUID()}`, assignment: `remote-acceptance-assignment-${randomUUID()}` }
    ticket = await store.transaction(scope, async tx => {
      const config = await access.configuration(tx)
      if (!config.group) throw Error('Remote-read acceptance requires the configured group workspace')
      const trigger = { id: ids.trigger, source: 'feishu', threads: [{ source: 'feishu', id: `remote-acceptance:${config.group.chatId}` }], actor: { source: 'feishu', id: config.installation.operator }, human: true, addressed: 'mention', at: now,
        text: '远程 Runner 只读验收：仅使用虚构目录中的 daily.txt。', channel: { source: 'feishu', thread: `feishu:${config.group.chatId}`, address: { chatId: config.group.chatId, messageId: ids.trigger } },
        meta: { chatId: config.group.chatId, messageId: ids.trigger, direct: false, loomSpace: config.group.spaceId } }
      const value = { id: ids.ticket, title: '远程 Runner 只读验收', decisionId: `remote-acceptance-decision-${randomUUID()}`, mandate: { strength: 'explicit', policyVersion: config.row.value.settings.policy ? 'remote-acceptance' : 'remote-acceptance',
        basis: { via: 'addressed', addressed: 'mention', source: 'feishu', scope: { loomSpace: config.group.spaceId }, sender: config.installation.operator }, actor: { source: 'feishu', id: config.installation.operator }, scope: '仅读取虚构 Runner 目录' },
        channels: [trigger.channel], assignments: [{ id: ids.assignment, state: 'running', createdAt: now }], inputs: [], undelivered: [], createdAt: now, updatedAt: now,
        origin: { triggerId: trigger.id, triggerIds: [trigger.id] } }
      await tx.put('trigger', trigger.id, trigger, 0); await tx.put('ticket', value.id, value, 0)
      await tx.put('control', value.id, { mode: 'agent', revision: 0, drained: true, operations: [], history: [] }, 0)
      synthetic = true
      return value
    })
  }
  const fence = await store.transaction(scope, tx => control(tx, ticket.id)), assignment = ticket.assignments.at(-1)
  const request = { version: 1, requestId: `remote-acceptance-${randomUUID()}`, operation: 'tool', input: { name: 'read', arguments: { path: values.path ?? 'notes/daily.txt', offset: 0, limit: 100 } }, binding: {
    ticketId: ticket.id, assignmentId: assignment.id, sessionId: `remote-acceptance-${randomUUID()}`, actor: ticket.mandate.actor, spaceId: scope.spaceId,
    target: { kind: 'runner', environmentId: profile.environmentId, workspaceId: profile.workspaceId }, directory: '/var/empty', controlRevision: fence.value.revision, sessionEpoch: 1,
  } }
  let result
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      result = await remote.router.run(request, { signal: AbortSignal.timeout(20_000), authorize() {} }, async () => { throw Error('Remote acceptance attempted local fallback') })
      break
    } catch (error) {
      if (attempt === 59) throw error
      await sleep(500)
    }
  }
  if (synthetic) await store.transaction(scope, async tx => {
    const row = await tx.get('ticket', ticket.id)
    if (row) await tx.put('ticket', ticket.id, { ...row.value, ended: { at: new Date().toISOString(), by: 'executor', outcome: 'completed', reason: 'remote-read acceptance' }, updatedAt: new Date().toISOString() }, row.revision)
  })
  console.log(JSON.stringify({ ticketId: ticket.id, requestId: request.requestId, deviceEnvironment: profile.environmentId, result }, null, 2))
} finally {
  await tls.stop().catch(() => {})
  await store.close()
}
