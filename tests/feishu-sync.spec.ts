/** Two independent connectors and private SQLite stores; synthetic Drive and Codex, no user account access. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncDatabase } from '../src/sync/database.ts'
import { FeishuSync } from '../src/sync/feishu.ts'
import { SyncError, type Project } from '../src/sync/model.ts'
import type { DrivePort, DriveEntry } from '../src/sync/feishu-drive.ts'
import type { ReadCodex } from '../src/sync/codex.ts'
type File=DriveEntry&{parent:string;text:string}
let dir:string,files:Map<string,File>,writes:number,reads:number,clock:number,corruptNext:boolean,corruptToken:string
const stores:SyncDatabase[]=[],controllers:AbortController[]=[]
const owner='ou_owner',appId='cli_test',sessionA='11111111-1111-4111-8111-111111111111',sessionB='22222222-2222-4222-8222-222222222222'
class Drive implements DrivePort {
  owner=owner
  async identity(){return {appId,owner:this.owner,name:'本人',missing:[]}}
  async list(parent:string){reads++;return [...files.values()].filter(f=>f.parent===parent).map(({text:_text,parent:_parent,...f})=>f)}
  async folder(parent:string,name:string){const token=randomUUID();writes++;files.set(token,{token,parent,name,type:'folder',text:'',owner_id:owner,modified_time:String(++clock)});return token}
  async upload(parent:string,name:string,text:string){const token=randomUUID();writes++;files.set(token,{token,parent,name,text,type:'file',owner_id:owner,modified_time:String(++clock)});if(corruptNext){corruptToken=token;corruptNext=false}return token}
  async download(token:string){reads++;if(corruptToken===token){corruptToken='';return '{}'}const file=files.get(token);if(!file)throw new SyncError(404,'missing fixture');return file.text}
  async removeFolder(token:string){for(const f of [...files.values()])if(f.parent===token)files.delete(f.token);files.delete(token);writes++}
}
function reader(cwd:string,session:string,text:string,onRead=()=>{}):ReadCodex {
  return async(_signal,run)=>{onRead();return run({call:async(method)=>{
    if(method==='thread/list')return {data:[{id:session,name:'测试讨论',cwd,source:'cli'}],nextCursor:null}
    if(method==='thread/read')return {thread:{id:session,cwd,source:'cli'}}
    return {data:[{item:{id:'u1',type:'userMessage',content:[{type:'text',text}]},turnId:'t1',startedAtMs:1000}],nextCursor:null}
  }})}
}
function local(label:string,capture:ReadCodex,drive=new Drive()) {
  const data=new SyncDatabase(join(dir,label+'.sqlite')),controller=new AbortController();stores.push(data);controllers.push(controller)
  return {data,controller,drive,sync:new FeishuSync(data,drive,{owner:()=>owner,appId:()=>appId,paused:()=>false,lifetime:controller.signal,read:capture})}
}
const call=(sync:FeishuSync,method:string,path:string[],input?:unknown)=>sync.handle(owner,method,path,input) as Promise<any>
const connect=(s:FeishuSync,deviceName:string)=>call(s,'POST',['connect'],{deviceName,consent:true})
const view=(s:FeishuSync,p:string)=>call(s,'GET',['projects',p])
const context=(s:FeishuSync,p:string)=>call(s,'GET',['ai','projects',p,'context'])
const note=(title:string,parent:string|null=null)=>({title,current:title,reasons:'失败请求仍需恢复',constraints:'退款不超过实付',open:'超时待确定',parent,references:[]})
async function grant(s:FeishuSync,p:string,cwd:string){await call(s,'PUT',['projects',p,'mapping'],{cwd,enabled:true,consent:true,revision:0});await call(s,'PUT',['connection'],{enabled:true,revision:s.connector.status(owner).revision})}
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'loom-feishu-sync-'));files=new Map();writes=0;reads=0;clock=0;corruptNext=false;corruptToken=''})
afterEach(()=>{controllers.splice(0).forEach(c=>c.abort());stores.splice(0).forEach(s=>s.close());rmSync(dir,{recursive:true,force:true})})

it('pairs by verified owner, does not read cloud/history on status, and refuses implicit upload consent',async()=>{
  let native=0;const a=local('a',reader('/a',sessionA,'A',()=>native++))
  expect(await call(a.sync,'GET',[])).toMatchObject({connected:false,account:{state:'ready'}})
  expect(reads).toBe(0);expect(writes).toBe(0)
  await expect(call(a.sync,'POST',['connect'],{deviceName:'A'})).rejects.toThrow()
  expect(writes).toBe(0)
  await connect(a.sync,'A');expect(a.sync.connector.status(owner)).toMatchObject({enabled:false,readProjects:[],mappings:[]})
  a.sync.tick();await a.sync.idle();expect(native).toBe(0)
})

it('continues A → source offline → B with plan reasons → restarted A through Drive without a hub server',async()=>{
  let bReads=0
  const a=local('a',reader('/home/project',sessionA,'方案A：成功回调幂等'))
  await connect(a.sync,'家里')
  const p=await call(a.sync,'POST',['projects'],{name:'退款设计'}) as Project
  await grant(a.sync,p.id,'/home/project');await a.sync.connector.run(owner)
  expect(a.sync.connector.status(owner).mappings[0]?.lastSuccess).toBeTruthy()
  const before=(await view(a.sync,p.id)).sessions[0],count=files.size
  await a.sync.connector.run(owner)
  expect((await view(a.sync,p.id)).sessions[0].id).toBe(before.id);expect(files.size).toBe(count)
  const plan=await call(a.sync,'POST',['projects',p.id,'notes'],note('方案A'))
  const b=local('b',reader('/office/project',sessionB,'方案B：失败后可以重试',()=>bReads++))
  await connect(b.sync,'公司');expect(bReads).toBe(0)
  await expect(context(b.sync,p.id)).rejects.toMatchObject({status:403})
  await call(b.sync,'PUT',['projects',p.id,'ai'],{enabled:true,consent:true})
  a.controller.abort()
  expect((await context(b.sync,p.id)).text).toContain('成功回调幂等')
  await grant(b.sync,p.id,'/office/project');await b.sync.connector.run(owner)
  await call(b.sync,'POST',['projects',p.id,'notes'],note('方案B',plan.id))
  const restarted=local('a',reader('/home/project',sessionA,'A'))
  await call(restarted.sync,'PUT',['projects',p.id,'ai'],{enabled:true,consent:true})
  const result=await context(restarted.sync,p.id)
  expect(result).toMatchObject({conflict:false,text:expect.stringContaining('失败请求仍需恢复')})
  expect(result.text).toContain('方案B：失败后可以重试')
  expect(result.text).toContain('退款不超过实付')
  expect([...files.values()].filter(f=>f.type==='file').map(f=>f.text).join('\n')).not.toMatch(/"token"|\/home\/project|\/office\/project|device_code/)
})

it('does not advance on a bad read-back and resolves the already committed batch without duplicates',async()=>{
  const a=local('a',reader('/a',sessionA,'批次验收'));await connect(a.sync,'A')
  const p=await call(a.sync,'POST',['projects'],{name:'P'}) as Project;await grant(a.sync,p.id,'/a')
  corruptNext=true;await a.sync.connector.run(owner)
  expect(a.sync.connector.status(owner).mappings[0]?.lastSuccess).toBeUndefined()
  const count=files.size
  await a.sync.connector.run(owner)
  expect(a.sync.connector.status(owner).mappings[0]?.lastSuccess).toBeTruthy()
  expect(files.size).toBe(count)
  expect((await view(a.sync,p.id)).sessions).toHaveLength(1)
})

it('rechecks device revocation and refuses another Feishu account before transferring data',async()=>{
  const a=local('a',reader('/a',sessionA,'A')),b=local('b',reader('/b',sessionB,'B'))
  await connect(a.sync,'A');await connect(b.sync,'B')
  const p=await call(a.sync,'POST',['projects'],{name:'P'}) as Project
  await grant(b.sync,p.id,'/b');await call(b.sync,'PUT',['projects',p.id,'ai'],{enabled:true,consent:true})
  await call(a.sync,'DELETE',['devices',b.sync.connector.status(owner).device!.id])
  await expect(b.sync.connector.run(owner)).rejects.toMatchObject({status:401})
  expect(b.sync.connector.status(owner)).toMatchObject({enabled:false,readProjects:[],device:{revoked:true}})
  const count=writes;a.drive.owner='ou_other'
  await expect(call(a.sync,'POST',['projects'],{name:'不可写入'})).rejects.toMatchObject({status:403})
  expect(writes).toBe(count)
})

it('keeps projects and AI grants separate and removes only the explicitly selected cloud project',async()=>{
  const a=local('a',reader('/a',sessionA,'A'));await connect(a.sync,'A')
  const p=await call(a.sync,'POST',['projects'],{name:'P'}) as Project,p2=await call(a.sync,'POST',['projects'],{name:'保留'}) as Project
  await grant(a.sync,p.id,'/a');await a.sync.connector.run(owner)
  await call(a.sync,'POST',['projects',p.id,'notes'],note('删除'))
  await call(a.sync,'POST',['projects',p2.id,'notes'],note('保留'))
  await call(a.sync,'PUT',['projects',p.id,'ai'],{enabled:true,consent:true})
  await expect(context(a.sync,p2.id)).rejects.toMatchObject({status:403})
  await call(a.sync,'DELETE',['projects',p.id])
  await expect(view(a.sync,p.id)).rejects.toMatchObject({status:404})
  expect((await view(a.sync,p2.id)).notes).toHaveLength(1)
  expect([...files.values()].filter(f=>f.name==='project-'+p.id)).toHaveLength(0)
})

it('rejects modified immutable files instead of silently falling back to cached context',async()=>{
  const a=local('a',reader('/a',sessionA,'A'));await connect(a.sync,'A')
  const p=await call(a.sync,'POST',['projects'],{name:'P'}) as Project
  await call(a.sync,'POST',['projects',p.id,'notes'],note('完整方案'))
  const folder=[...files.values()].find(f=>f.name==='project-'+p.id)!
  const target=[...files.values()].find(f=>f.parent===folder.token&&f.type==='file')!
  target.text=target.text.replace('完整方案','损坏方案');target.modified_time=String(++clock)
  await expect(view(a.sync,p.id)).rejects.toMatchObject({status:409})
})
