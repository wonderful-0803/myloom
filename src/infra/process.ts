import { win32 } from 'node:path'

/** Node CLI entrypoints run directly on Windows; never interpolate their args through cmd.exe. */
export function commandArgv(program: string, args: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' && /\.[cm]?js$/i.test(program) ? [process.execPath, program, ...args] : [program, ...args]
}

/** A configured prepare command uses the platform's native shell. */
export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32'
    ? [win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['sh', '-c', command]
}
