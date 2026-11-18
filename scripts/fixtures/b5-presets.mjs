/** Empty reviewed compositions: company tools are registered per turn; no inherited device, shell or channel capabilities. */
export const inject = ['agentPresets']
export async function apply(ctx) {
  for (const id of ['dsh-superagent-worker', 'dsh-superagent-router']) {
    const remove = await ctx.agentPresets.register({ id, plugins: [] }); ctx.effect(() => remove)
  }
}
