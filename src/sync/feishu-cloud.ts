/** Immutable Drive event files, reconstructed through the same scoped hub model as self-hosted sync. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SyncDatabase } from './database.ts'
import { SyncHub } from './hub.ts'
import { hash, id, name, Note, Snapshot, SyncError, type Revision } from './model.ts'
import type { DrivePort, DriveEntry, DriveIdentity } from './feishu-drive.ts'
import type { SyncTransport } from './client.ts'

const digest=z.string().regex(/^[a-f0-9]{64}$/),at=z.string().datetime()
const device=z.object({id,name,admin:z.boolean(),projects:z.array(id).max(1000),revoked:z.boolean(),at}).strict()
const project=z.object({id,name,at}).strict()
const version=Snapshot.extend({id,project:id,device:id,hash:digest,at,parent:id.nullable()}).strict()
const eventSchema=z.object({format:z.literal('loom-feishu-sync/1'),id,appId:z.string().regex(/^cli_[A-Za-z0-9]+$/),owner:z.string().regex(/^ou_[A-Za-z0-9]+$/),space:id,at,project:id.nullable(),deleted:z.boolean(),changes:z.array(z.object({key:z.string().max(300),value:z.unknown()}).strict()).max(10)}).strict()
type CloudEvent=z.infer<typeof eventSchema>
interface Root {token:string;space:string;appId:string;owner:string}
interface Pending {event:CloudEvent;result:unknown;fingerprint:string;folder:string}
const eventName=(e:CloudEvent)=>`loom-${e.id}-${hash(JSON.stringify(e))}.json`
const entries=(db:SyncDatabase)=>new Map(db.db.prepare('SELECT key,value FROM record ORDER BY key').all().map(row=>[String(row.key),JSON.parse(String(row.value))] as const))
/** Rechecks cloud identity, device revocation and source receipts; neither tokens nor local paths enter Drive files. */
export class FeishuCloud implements SyncTransport {
  private serial:Promise<unknown>=Promise.resolve()
  constructor(private readonly local:SyncDatabase,private readonly drive:DrivePort,private readonly host:{owner():string;appId():string}) {}
  private key(suffix:string) {return `cloud:${hash(this.host.appId()+':'+this.host.owner())}:${suffix}`}
  private async identity(signal:AbortSignal) {
    signal.throwIfAborted()
    const value=await this.drive.identity(signal)
    signal.throwIfAborted()
    if(value.appId!==this.host.appId()||value.owner!==this.host.owner())throw new SyncError(403,'飞书账号或应用与本机所有者不一致。')
    if(value.missing.length)throw new SyncError(403,'飞书同步权限尚未完整授权，请重新完成授权。')
    return value
  }
  clear() {const prefix=this.key('');this.local.db.prepare('DELETE FROM record WHERE substr(key,1,?)=?').run(prefix.length,prefix)}
  request(_url:string,route:string,method:string,body:unknown,token:string,signal:AbortSignal):Promise<any> {
    const run=()=>{signal.throwIfAborted();return this.route(route,method,body,token,signal)}
    const result=this.serial.then(run,run);this.serial=result.catch(()=>{});return result
  }
  private async folder(root:string,label:string,signal:AbortSignal,create=false) {
    const matches=(await this.drive.list(root,signal)).filter(f=>f.type==='folder'&&f.name===label)
    if(matches.length)return matches
    if(!create)return []
    return [{type:'folder',name:label,token:await this.drive.folder(root,label,signal)}]
  }
  private async events(folder:string,identity:DriveIdentity,signal:AbortSignal) {
    const files=(await this.drive.list(folder,signal)).filter(f=>f.type==='file'&&/^loom-[a-f0-9-]{36}-[a-f0-9]{64}\.json$/.test(f.name))
    if(files.length>1000)throw new SyncError(413,'项目同步批次超过1000份，请整理后继续；未使用不完整历史。')
    const result:CloudEvent[]=[],seen=new Map<string,string>();let bytes=0
    for(const file of files) {
      signal.throwIfAborted()
      if(file.owner_id&&file.owner_id!==identity.owner)throw new SyncError(403,'同步目录中存在其他所有者的文件，已停止读取。')
      const key=this.key('cache:'+file.token),cached=this.local.get<{modified:string;name:string;text:string}>(key)
      const text=cached&&file.modified_time&&cached.modified===file.modified_time&&cached.name===file.name?cached.text:await this.drive.download(file.token,signal)
      signal.throwIfAborted()
      if(this.host.owner()!==identity.owner||this.host.appId()!==identity.appId)throw new SyncError(403,'本机所有者授权已变化。')
      bytes+=Buffer.byteLength(text);if(bytes>24_000_000)throw new SyncError(413,'项目同步历史超过24MB，请归档后建立后续项目。')
      let value:CloudEvent
      try{value=eventSchema.parse(JSON.parse(text))}catch{throw new SyncError(409,'云端同步文件格式无效，未继续合并。')}
      if(value.appId!==identity.appId||value.owner!==identity.owner||eventName(value)!==file.name)throw new SyncError(409,'云端记录的身份或内容哈希不匹配。')
      const fingerprint=hash(text)
      if(seen.has(value.id)&&seen.get(value.id)!==fingerprint)throw new SyncError(409,'云端存在冲突批次，未覆盖已有记录。')
      if(!seen.has(value.id)){result.push(value);seen.set(value.id,fingerprint)}
      this.local.set(key,{modified:file.modified_time??'',name:file.name,text})
    }
    return result.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id))
  }
  private apply(db:SyncDatabase,events:CloudEvent[],space:string,projectId:string|null) {
    const revoked=new Set<string>(),deleted=new Set<string>()
    for(const e of events) {
      if(e.space!==space||e.project!==projectId)throw new SyncError(409,'云端批次不属于当前同步空间或项目。')
      if(e.deleted&&e.project)deleted.add(e.project)
      for(const change of e.changes) {
        const p=change.key.split(':'),kind=p[0],value=change.value
        if(value===null){if(kind!=='project'||p[1]!==space)throw new SyncError(409,'云端删除记录格式无效。');db.db.prepare('DELETE FROM record WHERE key=?').run(change.key);deleted.add(id.parse(p[2]));continue}
        if(projectId) {
          if(p[1]!==space||p[2]!==projectId)throw new SyncError(409,'云端记录超出当前项目。')
          if(kind==='note'){const note=Note.extend({id,device:id,at}).strict().parse(value);if(p[3]!==note.id)throw new SyncError(409,'方案标识不匹配。');db.set(change.key,note)}
          else if(kind==='revision'&&p[3]==='version'){const v=version.parse(value);if(p[4]!==v.id||v.project!==projectId)throw new SyncError(409,'会话版本标识不匹配。');db.set(change.key,v)}
          else throw new SyncError(409,'项目批次包含不支持的记录。')
        }else {
          if(kind==='auth'){const auth=z.object({space:id,device:id}).strict().parse(value);if(!digest.safeParse(p[1]).success||auth.space!==space)throw new SyncError(409,'设备记录不属于此空间。');db.set(change.key,auth)}
          else if(kind==='space'&&p[1]===space){const s=z.object({id,name,recoveryHash:digest}).strict().parse(value);if(s.id!==space)throw new SyncError(409,'空间标识不匹配。');db.set(change.key,s)}
          else if(kind==='device'&&p[1]===space){const d=device.parse(value);if(p[2]!==d.id)throw new SyncError(409,'设备标识不匹配。');db.set(change.key,d);if(d.revoked)revoked.add(change.key)}
          else if(kind==='project'&&p[1]===space){const v=project.parse(value);if(p[2]!==v.id)throw new SyncError(409,'项目标识不匹配。');db.set(change.key,v)}
          else throw new SyncError(409,'同步批次包含不支持的管理记录。')
        }
      }
    }
    for(const key of revoked)db.set(key,{...db.get<object>(key),revoked:true})
    for(const p of deleted)db.db.prepare('DELETE FROM record WHERE key=?').run(`project:${space}:${p}`)
  }
  private rebuild(db:SyncDatabase,space:string,projectId:string) {
    const groups=new Map<string,z.infer<typeof version>[]>()
    for(const v of db.list<z.infer<typeof version>>(`revision:${space}:${projectId}:version:`)){const key=v.device+':'+v.session;groups.set(key,[...groups.get(key)??[],v])}
    for(const [key,versions] of groups) {
      const remaining=new Map(versions.map(v=>[v.id,v])),messages=new Map<string,Revision['messages'][number]>();let parent:string|null=null,latest:Revision|undefined
      while(remaining.size) {
        const next=[...remaining.values()].filter(v=>v.parent===parent)
        if(next.length!==1)throw new SyncError(409,'同一来源会话存在缺失或并行批次，已保留原文并停止自动合并。')
        const v=next[0]!;remaining.delete(v.id);v.messages.forEach(m=>messages.set(m.id,m))
        if(messages.size>20_000||[...messages.values()].reduce((sum,m)=>sum+m.text.length,0)>2_000_000)throw new SyncError(413,'同步会话超过文字覆盖上限。')
        const snapshot=Snapshot.parse({session:v.session,title:v.title,messages:[...messages.values()].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)),coverage:v.coverage})
        if(hash(JSON.stringify(snapshot))!==v.hash)throw new SyncError(409,'会话合并哈希不匹配，未提供不完整上下文。')
        latest={...snapshot,id:v.id,project:projectId,device:v.device,hash:v.hash,at:v.at};parent=v.id
      }
      if(latest)db.set(`revision:${space}:${projectId}:head:${key}`,latest)
    }
  }
  private async live(event:CloudEvent,token:string,signal:AbortSignal) {
    const identity=await this.identity(signal)
    if(!token)return
    const root=this.local.get<Root>(this.key('root'))!,database=new SyncDatabase(':memory:')
    try {
      this.apply(database,await this.events(root.token,identity,signal),event.space,null)
      await new SyncHub(database,'cloud-adapter-private-bootstrap-01234567890123456789').route('GET','/v1/me',token)
      if(event.project&&!database.get(`project:${event.space}:${event.project}`))throw new SyncError(404,'项目已删除或不在当前同步空间。')
    }finally{database.close()}
  }
  private async persist(event:CloudEvent,result:unknown,fingerprint:string,folder:string,token:string,signal:AbortSignal) {
    const pending:Pending={event,result,fingerprint,folder};this.local.set(this.key('pending'),pending)
    try{signal.throwIfAborted();await this.live(event,token,signal)}catch(error){this.local.db.prepare('DELETE FROM record WHERE key=?').run(this.key('pending'));throw error}
    const file=await this.drive.upload(folder,eventName(event),JSON.stringify(event),signal)
    const confirmed=await this.drive.download(file,signal)
    if(hash(confirmed)!==hash(JSON.stringify(event)))throw new SyncError(409,'飞书上传后读回的内容不一致，检查点未前进。')
    await this.live(event,token,signal);signal.throwIfAborted()
    this.local.db.prepare('DELETE FROM record WHERE key=?').run(this.key('pending'))
    return result
  }
  private async route(route:string,method:string,body:any,token:string,signal:AbortSignal):Promise<any> {
    const identity=await this.identity(signal),connecting=route==='/v1/spaces'&&method==='POST'
    let root=this.local.get<Root>(this.key('root'))
    if(!root) {
      if(!connecting)throw new SyncError(409,'请先连接飞书同步。')
      const label='Loom Sync '+hash(identity.appId+':'+identity.owner).slice(0,12),matches=await this.folder('',label,signal,true)
      if(matches.length!==1)throw new SyncError(409,'发现多个同名同步空间，请先在飞书核对专用目录。')
      root={token:matches[0]!.token,space:'',appId:identity.appId,owner:identity.owner};this.local.set(this.key('root'),root)
    }
    if(root.owner!==identity.owner||root.appId!==identity.appId)throw new SyncError(403,'飞书同步目录身份不匹配。')
    const global=await this.events(root.token,identity,signal),spaces=[...new Set(global.map(e=>e.space))]
    if(spaces.length>1)throw new SyncError(409,'同步目录中存在多个空间，未自动合并。')
    const space=spaces[0]??root.space,parts=route.split('/').filter(Boolean),projectId=parts[1]==='projects'&&parts[2]?id.parse(parts[2]):null
    const database=new SyncDatabase(':memory:')
    try {
      if(space)this.apply(database,global,space,null)
      let folders:DriveEntry[]=[],history:CloudEvent[]=[]
      if(projectId&&database.get(`project:${space}:${projectId}`)) {
        folders=await this.folder(root.token,'project-'+projectId,signal)
        for(const f of folders)history.push(...await this.events(f.token,identity,signal))
        const unique=new Map(history.map(e=>[e.id,e]));this.apply(database,[...unique.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)),space!,projectId);this.rebuild(database,space!,projectId)
      }
      const hub=new SyncHub(database,'cloud-adapter-private-bootstrap-01234567890123456789'),fingerprint=hash(JSON.stringify([route,method,body??null,hash(token)]))
      const deleted=method==='DELETE'&&projectId&&parts.length===3
      if(deleted&&!database.get(`project:${space}:${projectId}`)) {
        await hub.route('GET','/v1/me',token)
        for(const folder of await this.folder(root.token,'project-'+projectId,signal))await this.drive.removeFolder(folder.token,signal)
        return {deleted:true}
      }
      let pending=this.local.get<Pending>(this.key('pending'))
      if(pending&&pending.fingerprint!==fingerprint&&[...global,...history].some(e=>e.id===pending!.event.id)) {
        this.local.db.prepare('DELETE FROM record WHERE key=?').run(this.key('pending'));pending=undefined
      }
      if(pending?.fingerprint===fingerprint) {
        if(!connecting)await hub.route('GET','/v1/me',token)
        const found=[...global,...history].some(e=>e.id===pending.event.id)
        if(found){this.local.db.prepare('DELETE FROM record WHERE key=?').run(this.key('pending'));return pending.result}
        return this.persist(pending.event,pending.result,fingerprint,pending.folder,token,signal)
      }
      const before=entries(database)
      let result:any
      if(connecting)result=space?hub.enrollOwner(space,body.deviceName):await hub.route('POST','/v1/spaces','cloud-adapter-private-bootstrap-01234567890123456789',{name:'Loom 飞书同步',deviceName:body.deviceName})
      else result=await hub.route(method,route,token,body)
      const actualSpace=space||result.space
      const changes=deleted?[{key:`project:${actualSpace}:${projectId}`,value:null}]:[...entries(database)].filter(([key,value])=>!key.includes(':head:')&&JSON.stringify(before.get(key))!==JSON.stringify(value)).map(([key,value])=>({key,value}))
      if(!changes.length)return result
      if(pending)throw new SyncError(409,'上一次云端写入尚待核对，请重试原操作后再进行新的写入。')
      const scoped=!!projectId&&!deleted
      if(scoped&&!folders.length)folders=await this.folder(root.token,'project-'+projectId,signal,true)
      const event:CloudEvent={format:'loom-feishu-sync/1',id:randomUUID(),appId:identity.appId,owner:identity.owner,space:actualSpace,at:new Date().toISOString(),project:scoped?projectId:null,deleted:!!deleted,changes}
      // A root tombstone is authoritative; remove all matching project folders only after explicit owner DELETE.
      const output=await this.persist(event,result,fingerprint,scoped?folders[0]!.token:root.token,token,signal)
      this.local.set(this.key('root'),{...root,space:actualSpace})
      if(deleted)for(const folder of folders)await this.drive.removeFolder(folder.token,signal)
      return output
    }finally{database.close()}
  }
}
