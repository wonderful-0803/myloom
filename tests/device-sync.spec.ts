/** Real HTTP + disk + two independent connectors. Only native Codex responses are synthetic. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { SyncDatabase } from '../src/sync/database.ts'
import { SyncHub, syncServer } from '../src/sync/hub.ts'
import { DeviceSync } from '../src/sync/client.ts'
import { captureCodex, visibleMessage, type ReadCodex } from '../src/sync/codex.ts'
import { syncUrl, type Project } from '../src/sync/model.ts'
let dir:string,db:SyncDatabase,server:Server,hub:SyncHub,url:string
const bootstrap='test-bootstrap-not-a-real-secret-0123456789'
const stores:SyncDatabase[]=[],controllers:AbortController[]=[]
const owner='local-owner',sessionA='11111111-1111-4111-8111-111111111111',sessionB='22222222-2222-4222-8222-222222222222'
const time=Date.parse('2026-11-06T09:00:00+08:00')
const entry=(id:string,text:string,type='userMessage')=>({item:{id,type,...type==='userMessage'?{content:[{type:'text',text}]}:{text,phase:'final_answer'}},turnId:'turn-'+id,startedAtMs:time})
function native(cwd:string,id:string,text:string):ReadCodex {
  return async(_signal,run)=>run({call:async(method,params)=>{
    if(method==='thread/list')return {data:params.archived?[]:[{id,name:'讨论方案',cwd,source:'cli'},{id:randomUUID(),name:'私有其他项目',cwd:'/excluded',source:'cli'}],nextCursor:null}
    expect(params.threadId).toBe(id)
    if(method==='thread/read')return {thread:{id,name:'讨论方案',cwd,source:'cli'}}
    expect(method).toBe('thread/items/list');return {data:[entry('u-'+id,text),entry('a-'+id,'这是一条候选建议，需要用户判断。','agentMessage'),entry('tool','不应同步的工具内容','commandExecution'),entry('env','<environment_context>private</environment_context>')],nextCursor:null}
  }})
}
function local(label:string,read:ReadCodex) {
  const data=new SyncDatabase(join(dir,label+'.sqlite')),controller=new AbortController();stores.push(data);controllers.push(controller)
  return {data,controller,client:new DeviceSync(data,{owner:()=>owner,paused:()=>false,lifetime:controller.signal,read})}
}
async function start(port=0) {db=new SyncDatabase(join(dir,'hub.sqlite'));hub=new SyncHub(db,bootstrap);server=syncServer(hub);await new Promise<void>(r=>server.listen(port,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`}
async function stopHub() {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close()}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'loom-sync-'));await start()})
afterEach(async()=>{vi.restoreAllMocks();controllers.splice(0).forEach(c=>c.abort());for(const data of stores.splice(0))data.close();await stopHub();if(!resolve(dir).startsWith(resolve(tmpdir())+requireSeparator()+'loom-sync-'))throw Error('unsafe cleanup');rmSync(dir,{recursive:true,force:true})})
function requireSeparator(){return process.platform==='win32'?'\\':'/'}
async function create(client:DeviceSync) {return client.handle(owner,'POST',['connect'],{url,mode:'create',name:'私人空间',deviceName:'家里',bootstrap}) as Promise<{recovery:string;space:string}>}
const view=(client:DeviceSync,p:string)=>client.handle(owner,'GET',['projects',p]) as Promise<any>
const context=(client:DeviceSync,p:string)=>client.handle(owner,'GET',['ai','projects',p,'context']) as Promise<{text:string;conflict:boolean}>
const note=(title:string,current:string,parent:string|null=null)=>({title,current,reasons:'因为失败应允许重试',constraints:'按实付退款',open:'边界情况待确认',parent,references:[]})
async function grant(client:DeviceSync,p:string,cwd:string) {await client.handle(owner,'PUT',['projects',p,'mapping'],{cwd,enabled:true,consent:true,revision:0});const c=client.status(owner);await client.handle(owner,'PUT',['connection'],{enabled:true,revision:c.revision})}

it('A → offline source → B with reasons → hub restart → A, without remote agent execution',async()=>{
  const a=local('home',native('/home/project',sessionA,'方案A：对成功的重复回调去重。'))
  const identity=await create(a.client);expect(identity.recovery.length).toBeGreaterThan(40)
  const p=await a.client.handle(owner,'POST',['projects'],{name:'退款设计'}) as Project
  const invite=await a.client.handle(owner,'POST',['invitations'],{projects:[p.id],hours:24}) as {invitation:string}
  const b=local('office',native('/office/project',sessionB,'基于方案A补充：失败后仍允许正常重试。'))
  await b.client.handle(owner,'POST',['connect'],{url,mode:'join',deviceName:'公司',invitation:invite.invitation})
  await grant(a.client,p.id,'/home/project');await a.client.run(owner)
  const first=(await view(a.client,p.id)).sessions[0]
  await a.client.run(owner);expect((await view(a.client,p.id)).sessions[0].id).toBe(first.id)
  const aNote=await a.client.handle(owner,'POST',['projects',p.id,'notes'],note('方案A','成功请求幂等')) as {id:string}
  a.controller.abort() // home is offline; the office only contacts the durable hub
  await expect(context(b.client,p.id)).rejects.toMatchObject({status:403})
  await b.client.handle(owner,'PUT',['projects',p.id,'ai'],{enabled:true,consent:true})
  expect((await context(b.client,p.id)).text).toContain('方案A')
  await grant(b.client,p.id,'/office/project');await b.client.run(owner)
  await b.client.handle(owner,'POST',['projects',p.id,'notes'],note('方案B','成功幂等，失败重试',aNote.id))
  const port=(server.address() as {port:number}).port;await stopHub();await start(port)
  const home=local('home',native('/home/project',sessionA,'方案A'))
  await home.client.handle(owner,'PUT',['projects',p.id,'ai'],{enabled:true,consent:true})
  const resumed=await context(home.client,p.id)
  expect(resumed.text).toContain('方案B');expect(resumed.text).toContain('因为失败应允许重试');expect(resumed.conflict).toBe(false)
  expect(resumed.text).not.toMatch(/不应同步的工具内容|environment_context|私有其他项目/)
  expect(JSON.stringify(home.client.status(owner))).not.toMatch(/"token"|recovery|known|bootstrap/)
  b.controller.abort()
  expect((await context(home.client,p.id)).text).toContain('失败后仍允许正常重试')
})

it('isolates spaces/projects, consumes invitations once, and enforces recovery and revocation',async()=>{
  const a=local('a',native('/a',sessionA,'A')),identity=await create(a.client)
  const p=await a.client.handle(owner,'POST',['projects'],{name:'分享项目'}) as Project
  const privateProject=await a.client.handle(owner,'POST',['projects'],{name:'未分享'}) as Project
  const invitation=await a.client.handle(owner,'POST',['invitations'],{projects:[p.id]}) as {invitation:string}
  const b=local('b',native('/b',sessionB,'B'))
  await b.client.handle(owner,'POST',['connect'],{url,mode:'join',deviceName:'B',invitation:invitation.invitation})
  const c=local('c',native('/c',sessionB,'C'))
  await expect(c.client.handle(owner,'POST',['connect'],{url,mode:'join',deviceName:'C',invitation:invitation.invitation})).rejects.toMatchObject({status:403})
  await expect(view(b.client,privateProject.id)).rejects.toMatchObject({status:404})
  await expect(b.client.handle(owner,'POST',['invitations'],{projects:[p.id]})).rejects.toMatchObject({status:403})
  await expect(b.client.handle(owner,'POST',['projects',p.id,'notes'],note('伪造前序','B',randomUUID()))).rejects.toMatchObject({status:409})
  await c.client.handle(owner,'POST',['connect'],{url,mode:'recover',deviceName:'恢复设备',space:identity.space,recovery:identity.recovery})
  await c.client.handle(owner,'DELETE',['devices',b.client.status(owner).device!.id])
  await expect(view(b.client,p.id)).rejects.toMatchObject({status:401})
  const outsider=local('outside',native('/x',sessionB,'X'));await create(outsider.client)
  await expect(view(outsider.client,p.id)).rejects.toMatchObject({status:404})
})

it('preserves divergent plans, checks AI grants independently and never starts source reads by pairing',async()=>{
  let calls=0;const base=native('/a',sessionA,'A'),a=local('a',async(s,r)=>{calls++;return base(s,r)})
  await create(a.client);a.client.tick();await a.client.idle();expect(calls).toBe(0)
  const p=await a.client.handle(owner,'POST',['projects'],{name:'P'}) as Project
  const plan=await a.client.handle(owner,'POST',['projects',p.id,'notes'],note('A','A')) as {id:string}
  await a.client.handle(owner,'POST',['projects',p.id,'notes'],note('B','B',plan.id))
  await a.client.handle(owner,'POST',['projects',p.id,'notes'],note('C','C',plan.id))
  await expect(context(a.client,p.id)).rejects.toMatchObject({status:403})
  await a.client.handle(owner,'PUT',['projects',p.id,'ai'],{enabled:true,consent:true})
  expect(await context(a.client,p.id)).toMatchObject({conflict:true,text:expect.stringContaining('多个方案分支')})
  await a.client.handle(owner,'PUT',['projects',p.id,'ai'],{enabled:false,consent:true})
  await expect(context(a.client,p.id)).rejects.toMatchObject({status:403})
  expect(calls).toBe(0)
})

it('stops an in-flight capture when its source grant is withdrawn, without uploading or advancing a checkpoint',async()=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  const base=native('/a',sessionA,'A'),a=local('a',async(s,r)=>{entered.resolve();await release.promise;return base(s,r)})
  await create(a.client);const p=await a.client.handle(owner,'POST',['projects'],{name:'P'}) as Project;await grant(a.client,p.id,'/a')
  const running=a.client.run(owner).catch(()=>{});await entered.promise
  await a.client.handle(owner,'PUT',['projects',p.id,'mapping'],{cwd:'/a',enabled:false,consent:true,revision:1})
  release.resolve();await running
  expect((await view(a.client,p.id)).sessions).toHaveLength(0)
  expect(a.client.status(owner).mappings[0]?.lastSuccess).toBeUndefined()
})

it('requires TLS away from loopback and does not expose a browser or management gateway',async()=>{
  expect(()=>syncUrl('http://company.example')).toThrow(/HTTPS/)
  expect(()=>syncUrl('https://user:password@example.com')).toThrow()
  expect(()=>syncUrl('https://example.com/?token=secret')).toThrow()
  expect((await fetch(url+'/v1/me')).status).toBe(401)
  expect((await fetch(url+'/v1/me',{headers:{Origin:'https://untrusted.example'}})).status).toBe(403)
  expect((await fetch(url+'/orchestrator/api/loom')).status).toBe(401)
})

it('does not advance on an invalid upload receipt, and safely retries a batch already committed by the server',async()=>{
  const a=local('receipt',native('/a',sessionA,'A'));await create(a.client)
  const p=await a.client.handle(owner,'POST',['projects'],{name:'P'}) as Project;await grant(a.client,p.id,'/a')
  const original=globalThis.fetch
  const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const response=await original(input,init)
    if(init?.method==='POST'&&String(input).endsWith('/sessions'))return new Response(JSON.stringify({...await response.json(),batchHash:'invalid'}),{status:200,headers:{'content-type':'application/json'}})
    return response
  })
  await a.client.run(owner)
  expect(a.client.status(owner).mappings[0]).toMatchObject({lastError:expect.stringContaining('回执与上传批次不一致')})
  expect(a.client.status(owner).mappings[0]?.lastSuccess).toBeUndefined()
  const committed=(await view(a.client,p.id)).sessions[0]
  spy.mockRestore();await a.client.run(owner)
  expect(a.client.status(owner).mappings[0]?.lastSuccess).toBeTruthy()
  expect((await view(a.client,p.id)).sessions[0].id).toBe(committed.id)
})

it('deletes only the selected project data and expires an unused invitation',async()=>{
  const a=local('delete',native('/a',sessionA,'A'));await create(a.client)
  const p=await a.client.handle(owner,'POST',['projects'],{name:'P'}) as Project,p2=await a.client.handle(owner,'POST',['projects'],{name:'保留'}) as Project
  await grant(a.client,p.id,'/a');await a.client.run(owner)
  await a.client.handle(owner,'POST',['projects',p.id,'notes'],note('删除的方案','P'))
  await a.client.handle(owner,'POST',['projects',p2.id,'notes'],note('保留的方案','P2'))
  const invite=await a.client.handle(owner,'POST',['invitations'],{projects:[p.id],hours:1}) as {invitation:string}
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+2*3600_000)
  await expect(hub.route('POST','/v1/join','',{invitation:invite.invitation,deviceName:'迟到设备'})).rejects.toMatchObject({status:403})
  vi.restoreAllMocks()
  await a.client.handle(owner,'DELETE',['projects',p.id])
  await expect(view(a.client,p.id)).rejects.toMatchObject({status:404})
  expect((await view(a.client,p2.id)).notes).toHaveLength(1)
  expect(db.list(`revision:${a.client.status(owner).space}:${p.id}:`)).toHaveLength(0)
  expect(db.list(`note:${a.client.status(owner).space}:${p.id}:`)).toHaveLength(0)
})

it('filters hidden/tool/environment items and incrementally backfills older visible text',async()=>{
  expect(visibleMessage(entry('env','<external_browser_tabs>ambient</external_browser_tabs>'))).toBeUndefined()
  expect(visibleMessage(entry('tool','secret','commandExecution'))).toBeUndefined()
  const controller=new AbortController();controllers.push(controller)
  let seenCalls=0
  const read:ReadCodex=async(_s,run)=>run({call:async(method,params)=>{
    if(method==='thread/list')return {data:params.archived?[]:[{id:sessionA,cwd:'/p',source:'cli'}],nextCursor:null}
    if(method==='thread/read')return {thread:{id:sessionA,cwd:'/p',source:'cli'}}
    seenCalls++;const n=params.cursor?Number(params.cursor):0
    return {data:[entry('m'+n,'第'+n+'条')],nextCursor:n<5?String(n+1):null}
  }})
  const first=await captureCodex('/p',{},()=>{},controller.signal,read)
  expect(first.state[sessionA]?.pending.length).toBeGreaterThan(0)
  const second=await captureCodex('/p',first.state,()=>{},controller.signal,read)
  const third=await captureCodex('/p',second.state,()=>{},controller.signal,read)
  const messages=[...first.snapshots,...second.snapshots,...third.snapshots].flatMap(s=>s.messages)
  expect(new Set(messages.map(m=>m.id)).size).toBe(6);expect(third.state[sessionA]?.pending).toHaveLength(0);expect(seenCalls).toBe(8)
})
