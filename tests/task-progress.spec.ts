/** Authorized read-only progress uses native metadata, retains handover semantics and never exports model reasoning/logs. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import type { ProgressEvent } from '../src/app/task-progress.ts'
import type { LoomProgress } from '../src/app/loom-types.ts'

let h:Host
beforeEach(async()=>{
  h=await startRuntime(undefined,{github:false})
  const s=h.runtime.store.settings(),source=s.sources.feishu!
  h.runtime.store.saveSettings({...s,sources:{...s.sources,feishu:{...source,config:{...source.config,ownerOnly:true}}}})
})
afterEach(async()=>{await h.stop()})
const native=(events:ProgressEvent[])=>h.controller.inspect.mockResolvedValue({events:events as never[]})
const read=async(id:string)=>(await h.api('GET',`loom/tasks/${id}/progress`)).body as unknown as LoomProgress
function record(){const base=Date.now()-5000;return(type:string,seq:number,offset:number,data:unknown):ProgressEvent=>({type,seq,time:base+offset,data})}

it('projects current work, real timings and failures without activating a Session or leaking reasoning, raw commands or output',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progress1','整理资料'))
  const e=record(),secret='PRIVATE_SHOULD_NEVER_APPEAR'
  native([
    e('turn/start',0,0,{turn:1}),e('step/start',1,0,{turn:1,step:1}),
    e('assistant/message',2,1000,{turn:1,step:1,message:{content:[{type:'reasoning',text:secret}]},usage:{outputTokens:123}}),
    e('tool/call',3,1001,{callId:'read1',name:'read',arguments:JSON.stringify({file_path:ticket.execution!.directory+'/input.md',apiKey:secret})}),
    e('tool/result',4,1051,{message:{toolCallId:'read1',content:[{type:'text',text:secret}]}}),
    e('step/start',5,1060,{turn:1,step:2}),e('assistant/message',6,2000,{turn:1,step:2,usage:{outputTokens:50},message:{content:[{type:'text',text:secret}]}}),
    e('tool/call',7,2001,{callId:'shell1',name:'bash',arguments:JSON.stringify({command:'curl -H Authorization:'+secret})}),
    e('tool/result',8,2201,{message:{toolCallId:'shell1',isError:true,content:[{type:'text',text:secret}]},error:{name:'Error',code:secret}}),
    e('step/start',9,2300,{turn:1,step:3}),
  ])
  const creates=h.controller.create.mock.calls.length,resolves=h.controller.resolveAgent.mock.calls.length
  const value=await read(ticket.id)
  expect(value).toMatchObject({phase:'model',modelSteps:2,modelMs:1940,toolMs:250,toolCalls:2,failedTools:1,outputTokens:173})
  expect(value.events).toContainEqual(expect.objectContaining({title:'读取资料：input.md',status:'done',durationMs:50}))
  expect(JSON.stringify(value)).not.toContain(secret)
  expect(JSON.stringify(value)).not.toContain(ticket.execution!.directory)
  await read(ticket.id)
  expect(h.controller.inspect).toHaveBeenCalledTimes(1)
  expect(h.controller.create).toHaveBeenCalledTimes(creates)
  expect(h.controller.resolveAgent).toHaveBeenCalledTimes(resolves)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('shows explicit stage reports and preserves a final report when native telemetry is unavailable',async()=>{
  const {ticket,sessionId}=await h.acceptedTicket(feishu('progress2','整理总结'))
  const e=record()
  native([e('tool/call',1,0,{callId:'report1',name:'orchestrator_report',arguments:JSON.stringify({state:'progress',summary:'已收齐资料，下一步核对口径。'})}),
    e('tool/result',2,10,{message:{toolCallId:'report1'}})])
  await h.runTool(sessionId,'orchestrator_report',{state:'ready',summary:'总结正文与来源核对已完成。'})
  const value=await read(ticket.id)
  expect(value).toMatchObject({phase:'completed',label:'任务已完成'})
  expect(value.events).toContainEqual(expect.objectContaining({kind:'report',detail:'已收齐资料，下一步核对口径。'}))
  expect(value.events).toContainEqual(expect.objectContaining({kind:'report',detail:'总结正文与来源核对已完成。'}))
})

it('shows retry blockers without exposing provider failure bodies',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progress3','整理总结')),e=record()
  native([e('turn/start',0,0,{turn:1}),e('step/start',1,0,{turn:1,step:1}),
    e('llm/retry',2,300,{turn:1,step:1,retry:3,failure:{code:'budget_exceeded',message:'secret-provider-credential'}})])
  const value=await read(ticket.id)
  expect(value).toMatchObject({phase:'retry',label:'模型额度不足，等待重试'})
  expect(value.events).toContainEqual(expect.objectContaining({kind:'retry',detail:'本轮第 3 次重试'}))
  expect(JSON.stringify(value)).not.toContain('secret-provider-credential')
})

it('shows taking-over until managed operations settle, then distinguishes return from a host restart',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progress4','整理总结')),gate=Promise.withResolvers<void>()
  const work=h.runtime.controls.run(ticket.id,'native:write',async()=>gate.promise)
  const initial=h.runtime.controls.view(ticket.id)
  expect(await h.api('POST',`loom/tasks/${ticket.id}/control`,{action:'takeover',revision:initial.revision})).toMatchObject({status:200})
  const waiting=await read(ticket.id)
  expect(waiting).toMatchObject({phase:'taking_over',control:{mode:'taking_over',pending:[expect.objectContaining({label:'保存文件',unknown:false})]}})
  expect(waiting.label).not.toBe('你已接管此任务')
  gate.resolve();await work
  await vi.waitFor(()=>expect(h.runtime.controls.view(ticket.id).mode).toBe('human'))
  expect(await read(ticket.id)).toMatchObject({phase:'human',control:{drained:true,pending:[]}})
  expect(await h.api('POST',`loom/tasks/${ticket.id}/control`,{action:'return',revision:h.runtime.controls.view(ticket.id).revision})).toMatchObject({status:200})
  await h.runtime.idle()
  const resumed=h.runtime.store.tickets.get(ticket.id)!
  expect(resumed.assignments).toContainEqual(expect.objectContaining({endedReason:'controlReturned'}))
  expect(resumed.inputs.filter(i=>i.kind==='text').some(i=>i.text.includes('The host restarted'))).toBe(false)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('returns only a safe unavailable notice when native inspection fails',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progress5','整理总结'))
  h.controller.inspect.mockRejectedValue(new Error('private/path apiKey=do-not-export'))
  const value=await read(ticket.id)
  expect(value.unavailable).toContain('暂不可读')
  expect(JSON.stringify(value)).not.toMatch(/apiKey|private\/path/)
  expect(value.events).toContainEqual(expect.objectContaining({kind:'assignment'}))
})

it('excludes inherited parent-session history instead of borrowing another task context',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progressInherited','整理总结')),e=record()
  const events=[e('tool/call',0,0,{callId:'parent-report',name:'orchestrator_report',arguments:JSON.stringify({state:'progress',summary:'OTHER_TASK_PRIVATE_REPORT'})}),
    e('tool/result',1,1,{message:{toolCallId:'parent-report'}}),e('step/start',2,2,{turn:1,step:1})]
  h.controller.inspect.mockResolvedValue(Object.assign({events:events as never[]},{inheritedEventCount:2}))
  const value=await read(ticket.id)
  expect(JSON.stringify(value)).not.toContain('OTHER_TASK_PRIVATE_REPORT')
  expect(value.toolCalls).toBe(0)
})

it('does not inspect unknown or revoked tasks, including cached progress',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progress6','整理总结'))
  await read(ticket.id)
  const before=h.controller.inspect.mock.calls.length,s=h.runtime.store.settings(),source=s.sources.feishu!
  h.runtime.store.saveSettings({...s,sources:{...s.sources,feishu:{...source,config:{...source.config,chats:[],otherChats:'none'}}}})
  expect(await h.api('GET',`loom/tasks/${ticket.id}/progress`)).toMatchObject({status:404})
  expect(await h.api('GET','loom/tasks/unknown/progress')).toMatchObject({status:404})
  expect(h.controller.inspect).toHaveBeenCalledTimes(before)
})

it('rechecks source authorization after asynchronous native history loading',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progress7','整理总结')),gate=Promise.withResolvers<{events:never[]}>()
  h.controller.inspect.mockReturnValue(gate.promise)
  const request=h.api('GET',`loom/tasks/${ticket.id}/progress`)
  await vi.waitFor(()=>expect(h.controller.inspect).toHaveBeenCalledTimes(1))
  const s=h.runtime.store.settings(),source=s.sources.feishu!
  h.runtime.store.saveSettings({...s,sources:{...s.sources,feishu:{...source,config:{...source.config,chats:[],otherChats:'none'}}}})
  gate.resolve({events:[]})
  expect(await request).toMatchObject({status:404})
})

it('explains a known missing-search-credential failure with fixed safe wording and no raw provider error',async()=>{
  const {ticket}=await h.acceptedTicket(feishu('progressSearch','查询公开资料')),e=record()
  native([e('tool/call',1,0,{callId:'search',name:'web_search',arguments:'{}'}),e('tool/result',2,10,{message:{toolCallId:'search',isError:true,content:[{type:'text',text:'SECRET_PROVIDER_CONFIG'}]},error:{code:'WEB_PROVIDER_CREDENTIAL_MISSING',message:'SECRET_PROVIDER_CONFIG'}})])
  const value=await read(ticket.id)
  expect(value.events).toContainEqual(expect.objectContaining({title:'检索资料',status:'failed',detail:expect.stringContaining('检索服务尚未配置访问凭据')}))
  expect(JSON.stringify(value)).not.toContain('SECRET_PROVIDER_CONFIG')
})
