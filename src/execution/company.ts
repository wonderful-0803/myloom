/** Trusted company-side adapter that turns a Runner target into an ExecutionRouter request. */
import type { StateScope, StateStore } from '../state/ports.ts'
import type { ProductAccess } from '../state/access.ts'
import { control } from '../state/controls.ts'
import { ExecutionUnavailable } from './port.ts'
import { ExecutionRouter, RunnerOffline, type RemoteAuthority, type RemoteTransport } from './router.ts'
import type { Capability, RemoteCancel, RemoteQuery, RemoteRequest } from './protocol.ts'
import { hash } from '../state/hash.ts'
import type { DeviceGateway, DeviceRecord } from './gateway.ts'

export interface RemoteExecutionProfile {
  environmentId: string
  workspaceId: string
  resourceGrantId: string
  grantRevision: number
  requestTtlMs?: number
}

export interface CompanyRemoteExecutionOptions {
  gateway: DeviceGateway
  store: StateStore
  scope: StateScope
  access: ProductAccess
  profile: RemoteExecutionProfile
}

function requestTtl(profile: RemoteExecutionProfile): number {
  const value = profile.requestTtlMs ?? 30_000
  if (!Number.isInteger(value) || value < 5_000 || value > 60_000) throw new ExecutionUnavailable('Remote request TTL is invalid')
  return value
}

/** Selects only the owner-bound online device for the configured environment. */
export class CompanyRemoteExecution implements RemoteAuthority {
  readonly router: ExecutionRouter
  private readonly profile: RemoteExecutionProfile
  constructor(private readonly options: CompanyRemoteExecutionOptions) {
    this.profile = { ...options.profile }
    if (!this.profile.environmentId.trim() || !this.profile.workspaceId.trim() || !this.profile.resourceGrantId.trim() || this.profile.grantRevision < 1)
      throw new ExecutionUnavailable('Remote execution profile is incomplete')
    requestTtl(this.profile)
    this.router = new ExecutionRouter(this, this.transport(), { pollMs: 100, responseMs: 30_000 })
  }

  private async device(request: Pick<RemoteRequest, 'tenantId' | 'spaceId' | 'userId' | 'environmentId'>): Promise<DeviceRecord> {
    const devices = await this.options.gateway.devicesForOwner(request.tenantId, request.spaceId, request.userId)
    const device = devices.find(value => value.environmentId === request.environmentId && value.status === 'online')
    if (!device) throw new RunnerOffline('Configured Runner is offline; task is waiting for its environment')
    return device
  }

  private transport(): RemoteTransport {
    const select = async (request: RemoteRequest) => this.options.gateway.transport((await this.device(request)).deviceId)
    return {
      dispatch: async (request, signal) => (await select(request)).dispatch(request, signal),
      query: async (request, signal) => {
        const device = await this.deviceForReceipt(request)
        return (await this.options.gateway.transport(device.deviceId)).query(request, signal)
      },
      cancel: async (request, signal) => {
        const device = await this.deviceForReceipt(request)
        return (await this.options.gateway.transport(device.deviceId)).cancel(request, signal)
      },
    }
  }

  private async deviceForReceipt(request: RemoteQuery | RemoteCancel): Promise<DeviceRecord> {
    const entry = await this.options.gateway.requestLedger().get(request.requestId, request.intentHash)
    if (!entry) throw new RunnerOffline('Runner receipt is unavailable')
    return this.device({ tenantId: entry.request.tenantId, spaceId: entry.request.spaceId, userId: entry.request.userId, environmentId: entry.request.environmentId })
  }

  async prepare(request: Parameters<RemoteAuthority['prepare']>[0], tool: Capability): Promise<RemoteRequest> {
    const target = request.binding.target
    if (target.kind !== 'runner' || target.environmentId !== this.profile.environmentId || target.workspaceId !== this.profile.workspaceId)
      throw new ExecutionUnavailable('Remote execution target is outside the configured environment')
    if (request.input.name !== 'read' && request.input.name !== 'glob' && request.input.name !== 'grep' && request.input.name !== 'stat')
      throw new ExecutionUnavailable('Remote capability is not installed')
    await this.assertTask(request)
    const device = await this.device({ tenantId: this.options.scope.tenantId, spaceId: this.options.scope.spaceId, userId: request.binding.actor.id, environmentId: target.environmentId })
    if (!device.capabilities.includes(tool.id)) throw new ExecutionUnavailable('Runner capability is not granted')
    const args = tool.input.parse(request.input.arguments), expiresAt = new Date(Date.now() + requestTtl(this.profile)).toISOString()
    const remote: Omit<RemoteRequest, 'permit'> = {
      protocolVersion: 1, requestId: request.requestId, tenantId: this.options.scope.tenantId, spaceId: this.options.scope.spaceId,
      userId: request.binding.actor.id, ticketId: request.binding.ticketId, assignmentId: request.binding.assignmentId,
      sessionId: request.binding.sessionId, environmentId: target.environmentId, workspaceId: target.workspaceId, toolId: tool.id,
      toolVersion: tool.version, effect: 'read', resourceGrantId: this.profile.resourceGrantId, grantRevision: this.profile.grantRevision,
      controlRevision: request.binding.controlRevision, sessionEpoch: request.binding.sessionEpoch ?? 1, expiresAt,
      argsHash: hash(args), args,
    }
    return { ...remote, permit: this.options.gateway.signPermit(remote) }
  }

  async check(request: RemoteRequest): Promise<void> {
    await this.assertTask({ binding: { actor: { id: request.userId }, ticketId: request.ticketId, assignmentId: request.assignmentId, sessionId: request.sessionId,
      controlRevision: request.controlRevision, target: { kind: 'runner', environmentId: request.environmentId, workspaceId: request.workspaceId }, directory: '' }, input: { name: 'read', arguments: request.args } } as never)
    await this.device(request)
  }

  private async assertTask(request: { binding: { actor: { id: string }; ticketId: string; assignmentId: string; controlRevision: number; target: { kind: string; environmentId?: string; workspaceId?: string } } }): Promise<void> {
    await this.options.store.transaction(this.options.scope, async tx => {
      const ticket = await this.options.access.ticket(tx, request.binding.actor.id, request.binding.ticketId), fence = await control(tx, ticket.id), assignment = ticket.assignments.at(-1)
      if (ticket.ended || assignment?.id !== request.binding.assignmentId || fence.value.mode !== 'agent' || fence.value.revision !== request.binding.controlRevision)
        throw new ExecutionUnavailable('Remote task authorization changed')
      if (request.binding.target.environmentId !== this.profile.environmentId || request.binding.target.workspaceId !== this.profile.workspaceId)
        throw new ExecutionUnavailable('Remote task target changed')
    })
  }
}
