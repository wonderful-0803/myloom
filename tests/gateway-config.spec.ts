import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { loadGatewayTlsMaterial, loadOrCreateGatewayIdentity } from '../src/execution/gateway-config.ts'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Gateway certificate and identity files', () => {
  it('creates a stable private Ed25519 identity and refuses permissive replacement', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'loom-gateway-config-')); folders.push(folder)
    const path = join(folder, 'gateway.key'), first = await loadOrCreateGatewayIdentity(path), before = await readFile(path)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const second = await loadOrCreateGatewayIdentity(path)
    expect(second.publicKey.export({ type: 'spki', format: 'pem' }).toString()).toBe(first.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    expect(await readFile(path)).toEqual(before)
    await chmod(path, 0o644)
    await expect(loadOrCreateGatewayIdentity(path)).rejects.toThrow('private')
  })

  it.skipIf(process.platform === 'win32')('loads private TLS material only from private canonical files', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'loom-gateway-tls-')); folders.push(folder)
    const key = join(folder, 'server.key'), cert = join(folder, 'server.crt')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=loom-test', '-days', '1'], { stdio: 'ignore' })
    expect((await loadGatewayTlsMaterial(key, cert)).cert.length).toBeGreaterThan(0)
    await chmod(key, 0o644)
    await expect(loadGatewayTlsMaterial(key, cert)).rejects.toThrow('private')
  })
})
