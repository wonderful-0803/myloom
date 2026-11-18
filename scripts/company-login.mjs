#!/usr/bin/env node
/** OS-admin CLI only. Prints one short-lived login code; never mounted as a web route. */
import { parseArgs } from 'node:util'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { PostgresStateStore, ProductAccess, issueOperatorCode, requireConsoleOrigin } from '../lib/state.js'
const { values } = parseArgs({ options: { config: { type: 'string' } } })
try {
  const path = values.config
  if (!isAbsolute(path ?? '')) throw Error('Explicit private configuration required')
  const info = await lstat(path)
  if (!info.isFile() || info.mode & 0o077 || info.isSymbolicLink() || info.size > 160000 || await realpath(path) !== resolve(path)) throw Error('Private canonical configuration required')
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (config.loginMode !== 'ssh-operator' || !/^LOOM_[A-Z0-9_]+$/.test(config.databaseUrlEnv) || !process.env[config.databaseUrlEnv]) throw Error('Explicit SSH operator mode required')
  requireConsoleOrigin(config.origin)
  const store = await PostgresStateStore.open({ connectionString: process.env[config.databaseUrlEnv] })
  try {
    const code = await issueOperatorCode(store, { tenantId: config.tenantId, spaceId: config.spaceId }, new ProductAccess(config.installationId))
    console.log(JSON.stringify({ login: `${config.origin}/auth/login`, code, expiresInSeconds: 300 }))
  } finally { await store.close() }
} catch { console.error('Cannot issue an operator code. Check the private SSH-only configuration and current installation authority.'); process.exitCode = 1 }
