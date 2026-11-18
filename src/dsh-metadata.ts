/** Opt-in native metadata backend; route only explicitly selected DSH domains, using the native provider's exact authority. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { SqlSessionPersistence } from './dsh-state/provider.ts'
import { SqlKvBackend } from './dsh-state/metadata.ts'
import { RecoveryContractSchema } from './dsh-state/catalog.ts'
import { hash } from './state/hash.ts'
export { SqlKvBackend } from './dsh-state/metadata.ts'
export type { SqlKvOptions } from './dsh-state/metadata.ts'
export { sealNativeArchive, validateNativeArchive, nativeArchiveReport, importNativeArchive } from './dsh-state/archive.ts'
export type { NativeArchive, ArchiveSession, ArchiveUnit } from './dsh-state/archive.ts'
export { nativeAttachmentReferences, checkedArchiveAttachments } from './dsh-state/attachments.ts'
export type { ArchiveAttachment, NativeAttachmentIO } from './dsh-state/attachments.ts'
export { RecoveryContractSchema } from './dsh-state/catalog.ts'
export type { RecoveryContract } from './dsh-state/catalog.ts'

export const name = 'loom-dsh-metadata'
export const inject = ['storage', 'sessionPersistence']
export const Config = s.object({ contractFile: s.string().required(), units: s.array(s.string()).default(['workspace']) })
export async function apply(ctx: Context, config: ReturnType<typeof Config>): Promise<void> {
  const path = config.contractFile
  if (!isAbsolute(path)) throw new Error('Explicit private native environment contract required')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 100_000 || await realpath(path) !== resolve(path)) throw new Error('Native contract must be a private regular file without symlinks')
  const contract = RecoveryContractSchema.parse(JSON.parse(await readFile(path, 'utf8'))), provider = ctx.sessionPersistence
  if (!(provider instanceof SqlSessionPersistence)) throw new Error('Native metadata requires the matching SQL SessionPersistence')
  const backend = new SqlKvBackend({ ...provider.authority, contract, units: config.units, onFailure: error => provider.failManaged(error) })
  let closing: Promise<void> | undefined
  const closeMetadata = () => closing ??= (async () => {
    const domains = ctx.get('storageDomain') as { get(name: string): { close(): Promise<void> } | undefined } | undefined
    try {
      const result = await Promise.allSettled(backend.options.units.map(name => domains?.get(name)?.close()))
      const errors = result.filter(item => item.status === 'rejected').map(item => item.reason)
      if (errors.length) throw new AggregateError(errors, 'Native metadata domains did not drain')
    } finally { await backend.close() }
  })()
  let detach: (() => void) | undefined, unregister: (() => void) | undefined
  try {
    detach = provider.attachMetadata({ assertCurrent: tx => backend.assertOwnership(tx), close: closeMetadata, verify: async (preset: string, model: ModelSelection) => {
      backend.check()
      const registry = ctx.get('agentPresets') as { readDocument(id: string): Promise<{ content: string }> } | undefined
      if (!registry || !Object.hasOwn(contract.presets, preset) || hash((await registry.readDocument(preset)).content) !== contract.presets[preset]) throw new Error('Native preset composition differs from recovery contract')
      if (!contract.models.some(value => value.provider === model.provider && value.model === model.model)) throw new Error('Native model is absent from recovery contract')
    } })
    unregister = ctx.storage.backend.register('loom-sql', backend)
    ctx.provide(storageBackendServiceKey('loom-sql'), backend)
    ctx.effect(() => async () => { detach?.(); unregister?.(); await closeMetadata() })
  } catch (error) { detach?.(); unregister?.(); await backend.close(); throw error }
}
