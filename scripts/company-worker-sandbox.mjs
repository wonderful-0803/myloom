/** DSH shell/jobs keep their native lifecycle; only the environment provider is replaced. */
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { workerSandboxArgv } from '../lib/state.js'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
export const inject = []
export async function apply(ctx, config) {
  if (await realpath(config.root) !== resolve(config.root) || await realpath(config.runner) !== resolve(config.runner)) throw Error('Canonical task root and sandbox runner required')
  class CompanySandbox extends SandboxProvider {
    async confine(argv, policy, signal) {
      signal?.throwIfAborted()
      const wrapped = await workerSandboxArgv(argv, policy, config)
      signal?.throwIfAborted()
      return { argv: wrapped, enforcement: 'full', denialSignatures: ['Permission denied', 'Read-only file system'], runnerFailureRules: [{ fatalSignatures: ['bwrap:'] }] }
    }
  }
  ctx.plugin(CompanySandbox)
  ctx.provide('loomWorkerSandbox', { root: config.root, readRoots: config.readRoots ?? [], confined: true })
}
