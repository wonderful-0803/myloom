/** Explicit local device trust bootstrap; online pairing belongs to C3. */
import { constants } from 'node:fs'
import { mkdir, open, realpath, lstat, readFile } from 'node:fs/promises'
import { isAbsolute, resolve, join } from 'node:path'
import { generateKeyPairSync, createPublicKey, createPrivateKey, randomUUID, createHash, verify } from 'node:crypto'
import { z } from 'zod'
import { RemoteRequestSchema, intentHash } from '../protocol.ts'
import type { RemoteRequest } from '../protocol.ts'
const identity = RemoteRequestSchema.pick({ tenantId: true, spaceId: true, userId: true, environmentId: true })
export type RunnerPeer = z.infer<typeof identity>
const configSchema = z.object({ version: z.literal(1), binding: identity, deviceId: z.uuid(), gatewayPublicKey: z.string().max(2000), devicePublicKey: z.string().max(2000), devicePrivateKey: z.string().max(2000) }).strict()
export type RunnerConfig = z.infer<typeof configSchema>
export const permitPayload = (request: RemoteRequest) => Buffer.from(`loom-runner-request-v1\0${intentHash(request)}`)
export function verifyPermit(config: RunnerConfig, request: RemoteRequest) {
  const signature = Buffer.from(request.permit, 'base64url')
  if (signature.length !== 64 || signature.toString('base64url') !== request.permit || !verify(null, permitPayload(request), config.gatewayPublicKey, signature)) throw Error('Runner permit denied')
}
export const samePeer = (a: RunnerPeer, b: RunnerPeer) => a.tenantId === b.tenantId && a.spaceId === b.spaceId && a.userId === b.userId && a.environmentId === b.environmentId
export async function privateHome(home: string, create = false) {
  if (process.platform !== 'linux' || !process.getuid?.()) throw Error('Linux Runner requires a non-root account')
  if (!isAbsolute(home) || resolve(home) !== home) throw Error('Canonical absolute Runner home required')
  if (create) await mkdir(home, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(home)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(home) !== home) throw Error('Runner home must be a private owned canonical directory')
}
export async function privateFile(path: string, create = false): Promise<void> {
  let handle
  try { handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600) }
  catch (error) { if (!create || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return privateFile(path) }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077) throw Error('Runner state file must be private, owned and singly linked')
  } finally { await handle.close() }
}
export async function initializeRunner(home: string, binding: RunnerPeer, publicKey: string) {
  await privateHome(home, true); identity.parse(binding)
  const gateway = createPublicKey(publicKey)
  if (gateway.asymmetricKeyType !== 'ed25519') throw Error('Runner requires an Ed25519 gateway key')
  const keys = generateKeyPairSync('ed25519'), deviceId = randomUUID()
  const config: RunnerConfig = { version: 1, binding, deviceId, gatewayPublicKey: gateway.export({ type: 'spki', format: 'pem' }).toString(),
    devicePublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), devicePrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
  const file = await open(join(home, 'device.json'), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(config)); await file.sync() } finally { await file.close() }
  return { deviceId, publicKey: config.devicePublicKey, gatewayFingerprint: createHash('sha256').update(gateway.export({ type: 'spki', format: 'der' })).digest('hex') }
}
export async function loadRunner(home: string): Promise<RunnerConfig> {
  await privateHome(home); const path = join(home, 'device.json'); await privateFile(path)
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (createPublicKey(config.gatewayPublicKey).asymmetricKeyType !== 'ed25519' || createPrivateKey(config.devicePrivateKey).asymmetricKeyType !== 'ed25519'
    || createPublicKey(createPrivateKey(config.devicePrivateKey)).export({ type: 'spki', format: 'pem' }) !== config.devicePublicKey) throw Error('Runner identity is inconsistent')
  return config
}
