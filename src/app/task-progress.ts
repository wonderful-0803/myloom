/** Read-only, content-minimized projections of native Harness execution events for the authorized task owner. */
import { basename, resolve, sep } from 'node:path'
import { latestReport, type Ticket } from '../core/index.ts'
import type { Store } from './store.ts'
import type { TaskControls } from './task-control.ts'
import type { LoomProgress, LoomProgressEvent } from './loom-types.ts'

export interface ProgressEvent { type: string; seq: number; time: number; data: unknown }
interface Host { store: Store; controls: TaskControls; inspect(id: string, signal: AbortSignal): Promise<readonly ProgressEvent[]> }
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const names:Record<string,string> = { read:'读取资料',write:'保存文件',edit:'修改文件',bash:'运行本地命令',pwsh:'运行本地命令',skill:'加载工作技能',
  orchestrator_read:'读取任务上下文',orchestrator_artifact:'核对产物版本',orchestrator_report:'保存任务报告',orchestrator_ack:'确认任务要求',
  web_fetch:'读取网页',web_search:'检索资料',todo_write:'更新工作计划',subagent:'执行内部子任务',job_output:'读取后台作业结果',job_list:'检查后台作业',job_kill:'停止后台作业' }
const reportNames:Record<string,string>={ready:'报告已完成',progress:'阶段进展',blocked:'等待处理',failed:'执行失败',waiting:'等待后续输入',dropped:'本轮已结束'}
/** Labels only known actions and task-local filenames, never commands, URLs, tokens or arbitrary tool outputs. */
function label(name: string, args: Record<string, any>, ticket: Ticket): string {
  let value = Object.hasOwn(names,name) ? names[name]! : '执行受管工具'
  if (name === 'bash' || name === 'pwsh') {
    const command = typeof args.command === 'string' ? args.command : ''
    value = /pdftotext|pdfplumber|pypdf/i.test(command) ? '提取 PDF 文本' : /python|analyze\.py/i.test(command) ? '运行本地计算' : /lark|open-apis/i.test(command) ? '访问飞书资料工具' : value
  }
  if (['read','write','edit'].includes(name) && ticket.execution?.directory) {
    const path = args.file_path ?? args.path
    if (typeof path === 'string' && path.length < 4096) {
      const root = resolve(ticket.execution.directory), target = resolve(root, path), file = basename(target)
      if (target.startsWith(root+sep) && /^[\p{L}\p{N}_. -]{1,100}$/u.test(file) && !/secret|credential|token|password|^\.env/i.test(file)) value += `：${file}`
    }
  }
  return value
}
/** Produces task activity without activating a Session, running a model, or exposing private reasoning or raw shell logs. */
export class TaskProgress {
  private readonly cache = new Map<string, { at: number; events: Promise<readonly ProgressEvent[]> }>()
  constructor(private readonly host: Host) {}
  async read(id: string): Promise<LoomProgress> {
    let cached = this.cache.get(id)
    if (!cached || Date.now()-cached.at>2000) {
      if (this.cache.size>=32) this.cache.delete(this.cache.keys().next().value!)
      cached = { at: Date.now(), events: this.host.inspect(id, AbortSignal.timeout(10_000)) }
      this.cache.set(id,cached)
    }
    let events:readonly ProgressEvent[] = [], unavailable:string|undefined
    try { events = await cached.events }
    catch { unavailable = '原生执行明细暂不可读；任务状态和控制记录仍可查看。' }
    const ticket = this.host.store.tickets.get(id)!
    return this.project(ticket, events, unavailable)
  }
  private project(ticket: Ticket, raw: readonly ProgressEvent[], unavailable?:string): LoomProgress {
    const now = Date.now(), control = this.host.controls.view(ticket.id), timeline:LoomProgressEvent[] = []
    const source = raw.slice(-10_000).filter(e => Number.isSafeInteger(e.seq) && Number.isFinite(e.time) && e.time>0 && e.time<=now+30_000)
    const unique = [...new Map(source.map(e=>[e.seq,e])).values()].sort((a,b)=>a.seq-b.seq)
    const calls = new Map<string,{ event:ProgressEvent; row:LoomProgressEvent; report?:{title:string;detail:string;status:'done'|'failed'} }>(), starts = new Map<string,number>(), counted = new Set<string>()
    let modelMs=0,toolMs=0,modelSteps=0,toolCalls=0,failedTools=0,outputTokens=0,lastTurnStart=0,lastTurnEnd=0,lastStep=0,lastModel=0
    let retry:{at:string;time:number;label:string}|undefined
    for (const e of unique) {
      const d=object(e.data), at=new Date(e.time).toISOString(), key=`${d.turn}:${d.step}`
      if(e.type==='turn/start')lastTurnStart=e.time
      if(e.type==='turn/end')lastTurnEnd=e.time
      if(e.type==='step/start'){starts.set(key,e.time);lastStep=e.time;retry=undefined}
      if(e.type==='llm/retry'){
        const failure=object(d.failure),budget=failure.type==='budget_exceeded'||failure.code==='budget_exceeded'
        retry={at,time:e.time,label:budget?'模型额度不足，等待重试':'模型请求失败，等待重试'}
        timeline.push({id:`retry-${e.seq}`,at,kind:'retry',title:retry.label,status:'failed',detail:`本轮第 ${number(d.retry)} 次重试`})
      }
      if(e.type==='assistant/message'&&!counted.has(key)){
        counted.add(key);modelSteps++;lastModel=e.time;outputTokens+=number(object(d.usage).outputTokens);retry=undefined
        const ms=Math.max(0,e.time-(starts.get(key)??e.time));modelMs+=ms
        timeline.push({id:`model-${e.seq}`,at,kind:'model',title:`模型第 ${modelSteps} 步`,status:d.interrupted===true?'interrupted':'done',durationMs:ms})
      }
      if(e.type==='tool/call'&&typeof d.callId==='string'){
        let args:Record<string,any>={};try{if(typeof d.arguments==='string'&&d.arguments.length<=65_536)args=object(JSON.parse(d.arguments))}catch{/* Ignore malformed arguments; they never become page content. */}
        const row:LoomProgressEvent={id:`tool-${e.seq}`,at,kind:'tool',title:label(String(d.name),args,ticket),status:'running'}
        const report=d.name==='orchestrator_report'&&typeof args.summary==='string'&&typeof args.state==='string'&&Object.hasOwn(reportNames,args.state)
          ?{title:reportNames[args.state]!,detail:args.summary.slice(0,500),status:(['failed','blocked'].includes(args.state)?'failed':'done') as 'failed'|'done'}:undefined
        calls.set(d.callId,{event:e,row,report});timeline.push(row);toolCalls++
      }
      if(e.type==='tool/result'){
        const message=object(d.message),call=calls.get(message.toolCallId)
        if(call){const ms=Math.max(0,e.time-call.event.time);toolMs+=ms;call.row.durationMs=ms;call.row.status=message.isError===true||d.error?'failed':'done';if(call.row.status==='failed'){failedTools++;if(object(d.error).code==='WEB_PROVIDER_CREDENTIAL_MISSING')call.row.detail='检索服务尚未配置访问凭据；请以之后的执行记录确认是否转用其他资料来源。';}
          else if(call.report)timeline.push({id:`milestone-${e.seq}`,at,kind:'report',...call.report});
          calls.delete(message.toolCallId)}
      }
    }
    for(const {event,row} of calls.values())if(lastTurnEnd>=event.time||ticket.ended){row.status='interrupted';row.durationMs=Math.max(0,(lastTurnEnd||Date.parse(ticket.ended!.at))-event.time)}
    for(const a of ticket.assignments){
      timeline.push({id:`assignment-${a.id}`,at:a.createdAt,kind:'assignment',title:'执行轮次已建立',status:'done'})
      if(a.endedAt&&a.endedReason){
        const returned=control.history.some(h=>['return','resume'].includes(h.action)&&Math.abs(Date.parse(h.at)-Date.parse(a.endedAt!))<1000)
        const title=a.endedReason==='controlReturned'?'交还／继续后恢复执行':a.endedReason==='hostRestarted'?(returned?'交还后恢复（旧记录标记为重启）':'服务重启，保存任务后恢复'):'执行轮次结束'
        timeline.push({id:`assignment-end-${a.id}`,at:a.endedAt,kind:'assignment',title,status:'interrupted'})
      }
      if(a.report&&!timeline.some(e=>e.kind==='report'&&e.detail===a.report!.summary.slice(0,500)&&Math.abs(Date.parse(e.at)-Date.parse(a.report!.at))<1000))timeline.push({id:`report-${a.id}`,at:a.report.at,kind:'report',title:reportNames[a.report.state]!,
        status:['failed','blocked'].includes(a.report.state)?'failed':'done',detail:a.report.summary.slice(0,500)})
    }
    for(const [i,h] of control.history.entries())timeline.push({id:`control-${i}`,at:h.at,kind:'control',title:({pause:'请求暂停任务',resume:'明确继续任务',takeover:'请求接管任务',return:'明确交还助手',resolve:'核查在途操作'} as Record<string,string>)[h.action]??'任务控制变更',status:'done'})
    const report=latestReport(ticket), pending=[...calls.values()].filter(c=>c.row.status==='running')
    let phase='waiting',phaseLabel='等待新的执行进展',currentSince:string|undefined
    if(pending.length){phase='tool';phaseLabel=pending.at(-1)!.row.title;currentSince=pending.at(-1)!.row.at}
    else if(lastStep>lastModel&&lastTurnStart>lastTurnEnd){phase='model';phaseLabel='模型正在生成下一步';currentSince=new Date(lastStep).toISOString()}
    else if(ticket.assignments.at(-1)?.state==='pending'){phase='queued';phaseLabel='等待执行名额'}
    if(retry&&retry.time>lastTurnEnd){phase='retry';phaseLabel=retry.label;currentSince=retry.at}
    if(report?.state==='blocked'||report?.state==='failed'){phase='blocked';phaseLabel=ticket.attention?.question?.slice(0,200)||'任务有阻碍，等待处理'}
    if(ticket.ended){phase='completed';phaseLabel=ticket.ended.outcome==='completed'?'任务已完成':'本轮已结束'}
    if(control.mode!=='agent'){phase=control.mode;phaseLabel=({paused:'任务已暂停',pausing:'正在暂停，等待在途操作结束',taking_over:'正在移交控制权',human:'你已接管此任务'} as const)[control.mode]}
    timeline.sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id))
    return {taskId:ticket.id,at:new Date(now).toISOString(),phase,label:phaseLabel,currentSince,lastActivityAt:unique.length?new Date(unique.at(-1)!.time).toISOString():undefined,
      elapsedMs:Math.max(0,Date.parse(ticket.ended?.at??new Date(now).toISOString())-Date.parse(ticket.createdAt)),modelMs,toolMs,modelSteps,toolCalls,failedTools,outputTokens,
      events:timeline.slice(0,160),unavailable,truncated:raw.length>10_000||timeline.length>160,
      control:{mode:control.mode,drained:control.drained,detail:control.detail,pending:control.operations.map(op=>({id:op.id,label:op.name.startsWith('mail:')?'邮件提交':op.name.startsWith('reply:')?'原线程交付':names[op.name.split(':').at(-1)!]??'受管操作',startedAt:op.startedAt,unknown:op.status==='unknown'}))}}
  }
}
