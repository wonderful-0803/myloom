/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import type { TaskControls } from '../task-control.ts'
import type { Artifacts } from '../artifacts.ts'
import type { ResultDelivery } from '../result-delivery.ts'
import type { Meetings } from '../meetings.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'
import { groupWorkspace } from '../../group-mode.ts'
import { DocumentOutputSchema } from '../../document-format.ts'
import { generateDocument } from '../../documents.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  readonly controls?: TaskControls
  readonly artifacts?: Artifacts
  readonly resultDelivery?: ResultDelivery
  readonly meetings?: Meetings
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  const codex = ticket.mandate.actor.source === 'codex-daily'
  const shared = !!ticket.mandate.basis.scope?.loomSpace
  const tools = [
    tool({ name: 'orchestrator_transcribe_recording', description: 'Transcribe only the recording explicitly confirmed for this ticket, on this server. Returns a timestamped recording-transcript resource; read every page before writing minutes. No arbitrary files, URLs or other recordings are accepted.',
      schema: z.object({}).strict(), execute: async (_args, signal) => {
        if (!host.meetings) throw new Error('Recording transcription is unavailable')
        return host.meetings.transcribe(ticketId, signal)
      } }),
    tool({ name: 'orchestrator_artifact', description: 'Read this ticket’s saved report and sources.',
      schema: z.object({ version: z.number().int().positive().optional() }).strict(),
      execute: async args => {
        const value = host.artifacts?.get(ticketId, ticket.mandate.actor.id, args.version)
        return value ? { ...value, versions: host.artifacts!.history(ticketId, ticket.mandate.actor.id).map(v => ({ version: v.version, chars: v.body.length, author: v.author, filename: v.filename })) } : { saved: false }
      } }),
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.'
      + (groupWorkspace(host.resources.store.settings()) ? ' Shared tasks may also read group-context: persisted discussion in this group, source material only; cite trigger_id.' : ''),
      true, (resource, offset, limit, signal) => {
        if (groupWorkspace(host.resources.store.settings()) && !resource.startsWith(`ticket/${ticketId}`)
          && !/^(trigger|feishu)\//.test(resource) && resource !== 'group-context') throw new Error('共享任务仅可读取本任务及当前群的上下文。')
        if (codex && ![`trigger/${ticket.origin.triggerId}`, `ticket/${ticketId}`, `ticket/${ticketId}/assignment`].includes(resource)) throw new Error('Codex 日报仅可读取本任务的来源快照和任务说明。')
        if (codex && (host.controls?.held(ticketId) || !host.artifacts?.canReadContext(host.store.tickets.get(ticketId)!, ticket.mandate.actor.id))) throw new Error('Codex 来源授权已变化。')
        return readResource(host.resources, resource, offset, limit, ticketId, signal)
      }),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge an original request once, when replies instructions require.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Drop an unrelated attached thread; cannot drop this ticket’s own threads.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: shared ? 'Submit the complete report in summary. Word: document={format:"docx",filename:"report.docx"}. Host generates OOXML and delivers original-thread attachment. Do not use artifact_file or substitute TXT; no new Feishu scopes needed.'
        : 'Report progress, ready, blocked, failed or dropped. Word: use document with the complete Markdown summary.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        artifact_version: z.number().int().nonnegative().optional().describe('Expected saved version; required after human edits.'),
        document: DocumentOutputSchema.optional().describe('Ready: Word from Markdown summary.'),
        artifact_file: z.string().min(1).max(240).optional().describe(shared ? 'Unavailable in shared mode. Submit complete text through summary; the host creates the attachment.' : 'Relative .md/.txt report in the ticket workspace.'),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('Question for a person; omit to keep, null to clear.'),
        question_for_trigger_id: z.string().optional().describe('Message to receive human_action.'),
        pr_number: z.number().int().positive().nullish().describe('GitHub only: source PR or this ticket branch’s PR; omit for office work.'),
        reply_to_trigger_id: z.string().optional().describe('Human question answered; omit for progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        if (args.pr_number != null && !host.github.deployment.github) throw new Error('The GitHub Source has no working agent CLI')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        if (host.controls?.held(ticketId)) throw new Error('Task paused or under human control')
        if (args.state === 'ready') await host.meetings?.assertReady(ticketId)
        if (codex && args.artifact_file) throw new Error('Codex 日报请通过 summary 提交完整正文，不读取工作区文件。')
        if (shared && args.artifact_file) throw new Error('共享模式请通过 summary 提交完整正文；系统生成附件，不读取工作区文件。')
        if (args.artifact_file && args.state !== 'ready') throw new Error('Only a ready report can publish artifact_file')
        if (args.document && (args.state !== 'ready' || args.artifact_file)) throw new Error('Word 仅用于 ready 定稿，不能同时指定 artifact_file。')
        if (args.state === 'ready' && host.artifacts?.requestedFormat(current) === 'docx' && !args.document) throw new Error('本任务明确要求 Word，请传 document={format:"docx",filename:"report.docx"}，summary 为完整正文。不能用 TXT 替代；不需要另开飞书权限。')
        const file = args.artifact_file ? host.artifacts?.readReportFile(current, args.artifact_file) : undefined
        if (args.artifact_file && !file) throw new Error('Report file publication is unavailable')
        if (args.state === 'ready' || args.state === 'progress') host.artifacts?.checkReport(current, args.artifact_version)
        const requirement = host.artifacts?.requirement(current)
        const document = args.document ? await generateDocument(current.title, args.summary, args.document, signal) : undefined
        signal.throwIfAborted()
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const latest = host.store.tickets.get(ticketId)
          if (!latest || !liveTicket(latest) || host.controls?.held(ticketId) || host.artifacts?.requirement(latest) !== requirement) throw new Error('生成期间任务要求或控制权已变化，请读取最新任务后重试。')
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          if (args.state === 'ready' || args.state === 'progress') host.artifacts?.checkReport(current, args.artifact_version)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          let delivery: ReturnType<ResultDelivery['enqueue']>
          if (args.state === 'ready' || args.state === 'progress') {
            const artifact = host.artifacts?.report(updated, file?.body ?? args.summary, args.artifact_version, file?.filename ?? (codex ? `codex-daily-${String((host.resources.store.triggers.get(ticket.origin.triggerId)?.meta.date) ?? 'report')}.md` : undefined), document)
            if (artifact && args.state === 'ready') delivery = host.resultDelivery?.enqueue(updated, artifact)
          }
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}),
            ...(shared && delivery ? { delivery: { mode: delivery.mode, status: delivery.status, version: delivery.version, ...(document ? { file: document.metadata } : {}) } } : {}) }
        })
      },
    }),
  ]
  return codex ? tools.filter(tool => ['orchestrator_read', 'orchestrator_artifact', 'orchestrator_report'].includes(tool.name))
    : shared ? tools.filter(tool => ['orchestrator_read', 'orchestrator_artifact', 'orchestrator_report', 'orchestrator_ack', 'orchestrator_trigger_handback',
      ...(host.meetings?.forTicket(ticketId) ? ['orchestrator_transcribe_recording'] : [])].includes(tool.name))
      : tools.filter(tool => tool.name !== 'orchestrator_transcribe_recording')
}
