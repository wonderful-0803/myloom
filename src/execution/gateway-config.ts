import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { KeyObject } from 'node:crypto'
import { ExecutionUnavailable } from './port.ts'

export interface GatewayIdentity { publicKey: KeyObject; privateKey: KeyObject }
export interface GatewayTlsMaterial { key: Buffer; cert: Buffer }

async function privateRegular(path: string, allowMissing = false, requirePrivate = true): Promise<boolean> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new ExecutionUnavailable('Gateway credential path must be canonical absolute')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || requirePrivate && info.mode & 0o077 || await realpath(path) !== path)
      throw new ExecutionUnavailable('Gateway credential file must be private, regular and canonical')
    return true
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Stable server identity; it is generated once and then kept in a private file. */
export async function loadOrCreateGatewayIdentity(path: string): Promise<GatewayIdentity> {
  if (await privateRegular(path, true)) {
    const privateKey = createPrivateKey(await readFile(path)), publicKey = createPublicKey(privateKey)
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') throw new ExecutionUnavailable('Gateway identity must be Ed25519')
    return { privateKey, publicKey }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const generated = generateKeyPairSync('ed25519'), privatePem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' })
  try {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(privatePem); await file.sync() } finally { await file.close() }
    await chmod(path, 0o600)
    return { privateKey: generated.privateKey, publicKey: generated.publicKey }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return loadOrCreateGatewayIdentity(path)
  }
}

export async function loadGatewayTlsMaterial(keyPath: string, certPath: string): Promise<GatewayTlsMaterial> {
  await privateRegular(keyPath)
  await privateRegular(certPath, false, false)
  return { key: await readFile(keyPath), cert: await readFile(certPath) }
}
