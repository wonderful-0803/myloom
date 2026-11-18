/** Permissions need a shell's declared default; this test fixture supplies no executable environment or shell tools. */
export function apply(ctx) { ctx.provide('shell', { sandboxMode: 'read-only', exec: () => { throw new Error('B5 fixture has no shell executor') } }) }
