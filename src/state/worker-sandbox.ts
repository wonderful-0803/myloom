/** Minimal task filesystem/process boundary, independent of business scene. */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { StateConflict } from './ports.ts'

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export async function taskPath(root: string, input: string, write = false, readRoots: readonly string[] = []): Promise<string> {
  const path = resolve(root, input), roots = write ? [root] : [root, ...readRoots]
  if (!roots.some(base => inside(base, path))) throw new StateConflict('Path is outside this task environment')
  let current = path
  for (;;) {
    try {
      const canonical = await realpath(current)
      if (!roots.some(base => inside(base, canonical))) throw new StateConflict('Symlink leaves this task environment')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === resolve(current, '..')) throw error
      current = resolve(current, '..')
    }
  }
  return path
}
export async function workerSandboxArgv(argv: readonly string[], policy: { mode: string; workspaceRoot: string }, config: { root: string; runner: string; readRoots?: readonly string[] }): Promise<string[]> {
  const root = await realpath(config.root), cwd = await realpath(policy.workspaceRoot), info = await lstat(cwd)
  if (policy.mode !== 'workspace-write' && policy.mode !== 'read-only' || cwd === root || !inside(root, cwd)
    || !info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.()) throw new StateConflict('A private task workspace and confined mode are required')
  if (!isAbsolute(config.runner) || !argv.length) throw new StateConflict('Explicit sandbox runner and argv required')
  const args = [config.runner, '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv']
  for (const path of ['/usr', '/bin', '/lib', '/lib64']) {
    try { await lstat(path); args.push('--ro-bind', path, path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const path of config.readRoots ?? []) { if (await realpath(path) !== resolve(path)) throw new StateConflict('Reviewed read root must be canonical'); args.push('--ro-bind', path, path) }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', policy.mode === 'read-only' ? '--ro-bind' : '--bind', cwd, cwd,
    '--chdir', cwd, '--setenv', 'HOME', cwd, '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--', ...argv)
  return args
}
