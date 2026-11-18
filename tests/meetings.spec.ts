import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFileSync, readdirSync } from 'node:fs'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { asrReady, transcribeAudio } from '../src/audio.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, feishu, MEMBER, CHAT, type Host } from './fixtures/host.ts'
vi.mock('../src/audio.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/audio.ts')>(), asrReady: vi.fn(), transcribeAudio: vi.fn() }))
let h: Host
const BOB='ou_bob', OTHER='ou_other'
const members=[{id:MEMBER,name:'Alice'},{id:BOB,name:'Bob'}]
const event=(id:string,text:string,extra:Record<string,unknown>={}) => feishu(id,text,{create_time:String(Date.now()),mentions:[],...extra})
const audio=(id='rec1', extra:Record<string,unknown>={}) => event(id,'[Audio: file_recording]',{msg_type:'audio',...extra})
let sourceType='audio', sourceName='会议录音.m4a', sourceChat=CHAT, sourceSender=MEMBER, deleted=false
beforeEach(async()=>{
  sourceType='audio';sourceName='会议录音.m4a';sourceChat=CHAT;sourceSender=MEMBER;deleted=false
  vi.mocked(asrReady).mockReset().mockReturnValue(true)
  vi.mocked(transcribeAudio).mockReset().mockResolvedValue({engine:'test-asr',duration:10,segments:[{start:0,end:5,text:'决定本周先完成原型验证。'},{start:5,end:10,text:'小王负责测试，周五交付。'}]})
  h=await startRuntime(store=>{
    const s=store.settings(), at=new Date(Date.now()-1000).toISOString()
    store.saveSettings({...s,policy:{...s.policy,sources:{feishu:{allowed:[{id:MEMBER}],admission:{},workspace:{mode:'group',operator:MEMBER,chatId:CHAT,name:'工作群',masters:members,spaceId:randomUUID(),since:at}}}}})
  },{github:false})
  const settings=h.runtime.store.settings(),source=settings.sources.feishu!
  h.runtime.store.saveSettings({...settings,sources:{...settings.sources,feishu:{...source,config:{...source.config,ownerOnly:true}}}})
  vi.mocked(Commands.prototype.lark).mockImplementation(async(args,cwd)=>{
    if(args.includes('+chat-members-list')) return {users:members.map(p=>({member_id:p.id,name:p.name})),has_more:false}
    if(args.includes('/open-apis/im/v1/messages/mget')) {
      const id=JSON.parse(args[args.indexOf('--params')+1]!).message_ids[0]
      return {items:[{message_id:id,chat_id:sourceChat,msg_type:sourceType,sender:{id:sourceSender,sender_type:'user'},deleted,
        body:{content:JSON.stringify({file_key:'file_recording',file_name:sourceName})}}]}
    }
    if(args.includes('+messages-resources-download')) {writeFileSync(join(cwd!,'recording.audio'),'synthetic audio fixture'); return {saved_path:join(cwd!,'recording.audio')}}
    return {message_id:'om_botask'}
  })
})
afterEach(async()=>{await h.stop()})
async function delegate(mode:'auto'|'observe'='auto'){
  const result=await h.api('POST','loom/delegations',{title:'录音会议纪要',description:'录音先询问，确认后生成纪要',chatIds:[CHAT],keywords:[],meeting:{audio:'confirm'},meetingConsent:true,
    enabled:true,mode,requestId:randomUUID(),revision:h.runtime.store.blockRevision('policy')})
  expect(result.status).toBe(200)
  return result.body.id as string
}
async function offer(){await delegate();const trigger=audio();expect(h.runtime.receive(trigger)).toBe('stored');await h.runtime.idle();return trigger}
async function confirm(){const t=await offer();h.runtime.receive(event('confirm1','需要',{sender_id:BOB,root_id:String(t.meta.messageId),parent_id:'om_botask'}));await h.runtime.idle();
 const ticket=h.runtime.store.tickets.list()[0]!; expect(ticket).toBeDefined(); return {ticket,sessionId:`worker-${ticket.id}`,trigger:t}}

it('requires explicit delegation consent and never treats every ordinary summary as a recording grant',async()=>{
 const body={title:'录音',chatIds:[CHAT],keywords:[],meeting:{audio:'confirm'},enabled:true,mode:'auto',requestId:randomUUID(),revision:h.runtime.store.blockRevision('policy')}
 expect((await h.api('POST','loom/delegations',body)).status).toBe(400)
 const id=await delegate()
 expect((await h.api('GET','loom')).body.delegations).toEqual([expect.objectContaining({id,meeting:{audio:'confirm',provider:'bailian'}})])
 expect((await h.api('POST','loom/delegations',{...body,meetingConsent:true,requestId:randomUUID(),revision:h.runtime.store.blockRevision('policy')})).status).toBe(400)
})
it('asks once in the source thread without downloading, calling ASR, starting a worker, or replaying the recording',async()=>{
 const t=await offer()
 expect(h.runtime.store.tickets.list()).toHaveLength(0)
 expect(transcribeAudio).not.toHaveBeenCalled()
 const calls=vi.mocked(Commands.prototype.lark).mock.calls.map(([a])=>a)
 expect(calls.filter(a=>a.includes('+messages-resources-download'))).toHaveLength(0)
 expect(calls.filter(a=>a.includes('+messages-reply'))).toEqual([expect.arrayContaining(['--message-id','om_rec1','--reply-in-thread'])])
 expect(h.runtime.receive(t)).toBe('duplicate');await h.runtime.idle()
 expect(vi.mocked(Commands.prototype.lark).mock.calls.filter(([a])=>a.includes('+messages-reply'))).toHaveLength(1)
})
it('reopens persisted recording tasks only after resolving bot identity and exposes the management API after restart',async()=>{
 const {ticket}=await confirm()
 const policy=h.runtime.store.settings().policy
 const record=h.runtime.meetings.forTicket(ticket.id)!
 const triggers=h.runtime.store.db.prepare('SELECT value FROM trigger').all().map(row=>JSON.parse(row.value as string))
 await h.stop()
 h=await startRuntime(store=>{
   const settings=store.settings(), source=settings.sources.feishu!;store.saveSettings({...settings,paused:true,policy,sources:{...settings.sources,feishu:{...source,config:{...source.config,ownerOnly:true}}}})
   for(const trigger of triggers)store.triggers.save(trigger)
   store.db.prepare('INSERT INTO ticket (id,value) VALUES (?,?)').run(ticket.id,JSON.stringify(ticket))
   store.set(KV.meetings.record(record.id),record)
 },{github:false})
 const restored=h.runtime.store.settings(), restoredSource=restored.sources.feishu!
 h.runtime.store.saveSettings({...restored,sources:{...restored.sources,feishu:{...restoredSource,config:{...restoredSource.config,ownerOnly:true}}}})
 expect(h.runtime.configured()).toBe(true)
 expect((await h.api('GET','loom')).status).toBe(200)
 expect(h.runtime.meetings.forTicket(ticket.id)?.file).toEqual(record.file)
})
it('accepts another saved master’s exact-thread consent, reads the full transcript, and publishes an ordinary versioned report with audio evidence',async()=>{
 const {ticket,sessionId}=await confirm()
 await expect(h.runTool(sessionId,'orchestrator_report',{state:'ready',summary:'假装听过录音'})).rejects.toThrow('先完成')
 const result=await h.runTool(sessionId,'orchestrator_transcribe_recording',{})
 expect(result).toMatchObject({resource:`ticket/${ticket.id}/recording-transcript`,duration_seconds:10})
 expect(readdirSync(h.directory).filter(n=>n.startsWith('recording-'))).toEqual([])
 await expect(h.runTool(sessionId,'orchestrator_report',{state:'ready',summary:'仅读摘要'})).rejects.toThrow('分页读完')
 let offset:number|null=0, text=''
 while(offset!==null){const page=await h.runTool(sessionId,'orchestrator_read',{resource:result.resource,offset,limit:80});text+=page.text;offset=page.next_offset as number|null}
 expect(text).toContain('小王负责测试')
 await h.runTool(sessionId,'orchestrator_report',{state:'ready',summary:'决定：本周完成原型验证。[S1 00:00]\n待办：小王周五交付测试。[S1 00:05]'});await h.runtime.idle()
 expect(h.runtime.artifacts.get(ticket.id,MEMBER)).toMatchObject({recording:{sourceMessageId:'om_rec1',confirmedBy:BOB,audioHash:expect.stringMatching(/^[a-f0-9]{64}$/),transcriptHash:expect.any(String)}})
 expect(h.runtime.resultDelivery.list(MEMBER,ticket.id)).toHaveLength(1)
})
it('ignores non-master confirmation, cross-thread confirmation, and cancellation starts no task',async()=>{
 const t=await offer()
 h.runtime.receive(event('other1','需要',{sender_id:OTHER,root_id:String(t.meta.messageId)}))
 h.runtime.receive(event('cross1','需要',{sender_id:BOB,root_id:'om_unrelated'}));await h.runtime.idle()
 expect(h.runtime.store.tickets.list()).toHaveLength(0)
 h.runtime.receive(event('cancel1','取消',{sender_id:BOB,root_id:String(t.meta.messageId)}));await h.runtime.idle()
 expect(h.runtime.meetings.list()[0]?.status).toBe('cancelled')
 h.runtime.receive(event('late1','需要',{root_id:String(t.meta.messageId)}));await h.runtime.idle()
 expect(h.runtime.store.tickets.list()).toHaveLength(0);expect(transcribeAudio).not.toHaveBeenCalled()
})
it('validates source message type, group, sender and deletion rather than trusting a pasted file key',async()=>{
 await delegate();sourceChat='oc_other'
 h.runtime.receive(audio());await h.runtime.idle()
 expect(h.runtime.meetings.list()[0]?.status).toBe('failed')
 expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([a])=>a.includes('+messages-reply')||a.includes('+messages-resources-download'))).toBe(false)
})
it('observes without asking or transcribing',async()=>{
 await delegate('observe');h.runtime.receive(audio());await h.runtime.idle()
 expect(h.runtime.meetings.list()[0]?.status).toBe('observed')
 expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([a])=>a.includes('+messages-reply'))).toBe(false)
})
it('does not start a task after the specific recording confirmation expires',async()=>{
 const t=await offer(),r=h.runtime.store.keys(KV.meetings.record)[0]!
 h.runtime.store.set(r,{...h.runtime.store.get(r)!,expiresAt:new Date(Date.now()-1).toISOString()})
 h.runtime.receive(event('expired1','需要',{root_id:String(t.meta.messageId),parent_id:'om_botask'}));await h.runtime.idle()
 expect(h.runtime.store.tickets.list()).toHaveLength(0);expect(transcribeAudio).not.toHaveBeenCalled()
})
it.each(['sender','deleted','type'])('rechecks recording %s before downloading bytes after consent',async(change)=>{
 const {ticket,sessionId}=await confirm()
 if(change==='sender')sourceSender=OTHER
 if(change==='deleted')deleted=true
 if(change==='type')sourceType='text'
 await expect(h.runTool(sessionId,'orchestrator_transcribe_recording',{})).rejects.toThrow('失败')
 expect(h.runtime.meetings.forTicket(ticket.id)?.transcript).toBeUndefined()
 expect(transcribeAudio).not.toHaveBeenCalled()
 expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([a])=>a.includes('+messages-resources-download'))).toBe(false)
})
it('revoking the standing grant prevents transcription, reading and report publication',async()=>{
 const {ticket,sessionId}=await confirm(), record=h.runtime.meetings.forTicket(ticket.id)!
 expect((await h.api('PATCH',`loom/delegations/${record.ruleId}`,{enabled:false,revision:h.runtime.store.blockRevision('policy')})).status).toBe(200)
 await expect(h.runTool(sessionId,'orchestrator_transcribe_recording',{})).rejects.toThrow()
 expect(h.runtime.artifacts.canReadContext(h.runtime.store.tickets.get(ticket.id)!,MEMBER)).toBe(false)
 expect(transcribeAudio).not.toHaveBeenCalled()
})
it('stops an in-flight local recognizer on task pause and never saves partial text',async()=>{
 const {ticket,sessionId}=await confirm()
 let started!:()=>void; const ready=new Promise<void>(r=>started=r)
 vi.mocked(transcribeAudio).mockImplementation(async(_file,signal)=>{started();return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))})
 const running=h.runTool(sessionId,'orchestrator_transcribe_recording',{})
 const rejected=expect(running).rejects.toThrow('中断')
 await ready
 h.runtime.controls.change(ticket.id,'pause',h.runtime.controls.view(ticket.id).revision)
 await rejected
 expect(h.runtime.meetings.forTicket(ticket.id)?.transcript).toBeUndefined()
})
it('does not repeat a question when the external send outcome is unknown',async()=>{
 await delegate()
 const original=vi.mocked(Commands.prototype.lark).getMockImplementation()!
 vi.mocked(Commands.prototype.lark).mockImplementation(async(args,cwd)=>{if(args.includes('+messages-reply'))throw new Error('network lost after submit');return original(args,cwd)})
 h.runtime.receive(audio());await h.runtime.idle()
 const message=h.runtime.store.keys(KV.meetings.message).map(k=>h.runtime.store.get(k)!)[0]!
 expect(message.status).toBe('unknown')
 h.runtime.effects.enqueue('meeting-message',message.id,{});await h.runtime.idle()
 expect(vi.mocked(Commands.prototype.lark).mock.calls.filter(([a])=>a.includes('+messages-reply'))).toHaveLength(1)
})
