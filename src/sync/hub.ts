/** Durable, device-authenticated data service. No management, shell, agent or filesystem routes. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { SyncDatabase } from './database.ts'
import { hash, id, name, secret, Snapshot, Note, SyncError, type Device, type Project, type Revision, type SyncNote } from './model.ts'
interface Identity { space: string; device: Device }
interface Space { id: string; name: string; recoveryHash: string }
interface Credential { space: string; device: string }
const stamp = () => new Date().toISOString()
const equal = (a: string,b: string) => timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)))
/** Authenticates each device and persists isolated spaces, scoped projects and immutable revisions. */
export class SyncHub {
  constructor(readonly data: SyncDatabase, private readonly bootstrap: string) { if (bootstrap.length<32) throw new Error('同步服务初始化凭据至少需要 32 个字符。') }
  /** Used only after the cloud adapter verifies the same Feishu owner; never exposed by the HTTP hub. */
  enrollOwner(space:string,label:string) {
    if(!this.data.get<Space>(`space:${id.parse(space)}`))throw new SyncError(404,'同步空间不存在。')
    return this.data.atomic(()=>this.device(space,name.parse(label),true,[]))
  }
  private device(space: string, label: string, admin: boolean, projects: string[]) {
    const device: Device={id:randomUUID(),name:label,admin,projects,revoked:false,at:stamp()}, token=secret()
    this.data.set(`device:${space}:${device.id}`,device); this.data.set(`auth:${hash(token)}`,{space,device:device.id})
    return {space,device,token}
  }
  private authenticate(token: string): Identity {
    const auth=this.data.get<Credential>(`auth:${hash(token)}`), device=auth && this.data.get<Device>(`device:${auth.space}:${auth.device}`)
    if(!auth || !device || device.revoked) throw new SyncError(401,'设备凭据无效或已撤销。')
    return {space:auth.space,device}
  }
  private project(actor: Identity, project: string) {
    id.parse(project)
    const value=this.data.get<Project>(`project:${actor.space}:${project}`)
    if(!value || !actor.device.admin && !actor.device.projects.includes(project)) throw new SyncError(404,'项目不存在或未授予此设备。')
    return value
  }
  async route(method: string, route: string, token: string, input?: unknown): Promise<unknown> {
    if(route==='/v1/spaces' && method==='POST') {
      if(!equal(token,this.bootstrap)) throw new SyncError(401,'需要同步服务的初始化凭据。')
      const body=z.object({name,deviceName:name}).strict().parse(input)
      return this.data.atomic(()=>{
        const space=randomUUID(), recovery=secret(); this.data.set(`space:${space}`,{id:space,name:body.name,recoveryHash:hash(recovery)})
        return {...this.device(space,body.deviceName,true,[]),recovery}
      })
    }
    if(route==='/v1/join' && method==='POST') {
      const body=z.object({invitation:z.string().min(40).max(100),deviceName:name}).strict().parse(input)
      return this.data.atomic(()=>{
        const key=`invite:${hash(body.invitation)}`, invite=this.data.get<{space:string;expires:number;projects:string[];issuer:string;used:boolean}>(key)
        const issuer=invite && this.data.get<Device>(`device:${invite.space}:${invite.issuer}`)
        if(!invite || invite.used || invite.expires<=Date.now() || !issuer || issuer.revoked || !issuer.admin || invite.projects.some(p=>!this.data.get(`project:${invite.space}:${p}`))) throw new SyncError(403,'配对邀请已失效、已使用或签发设备已撤销。')
        this.data.set(key,{...invite,used:true}); return this.device(invite.space,body.deviceName,false,invite.projects)
      })
    }
    if(route==='/v1/recover' && method==='POST') {
      const body=z.object({space:id,recovery:z.string().min(40).max(100),deviceName:name}).strict().parse(input)
      const space=this.data.get<Space>(`space:${body.space}`)
      if(!space || !equal(hash(body.recovery),space.recoveryHash)) throw new SyncError(403,'恢复凭据无效。')
      return this.data.atomic(()=>this.device(space.id,body.deviceName,true,[]))
    }
    const actor=this.authenticate(token), parts=route.split('/').filter(Boolean), projectId=parts[2]
    if(parts[0]!=='v1')throw new SyncError(404,'同步入口不存在。')
    if(route==='/v1/me' && method==='GET') return {space:actor.space,device:actor.device}
    if(route==='/v1/devices' && method==='GET') return {devices:this.data.list<Device>(`device:${actor.space}:`)}
    if(parts[1]==='devices' && parts.length===3 && method==='DELETE') {
      if(!actor.device.admin) throw new SyncError(403,'只有空间管理设备可以撤销设备。')
      const device=this.data.get<Device>(`device:${actor.space}:${id.parse(parts[2])}`)
      if(!device) throw new SyncError(404,'设备不存在。')
      if(device.id===actor.device.id) throw new SyncError(409,'本机请使用断开连接；使用恢复凭据可重新建立管理设备。')
      this.data.set(`device:${actor.space}:${device.id}`,{...device,revoked:true}); return {revoked:true}
    }
    if(route==='/v1/invitations' && method==='POST') {
      if(!actor.device.admin) throw new SyncError(403,'只有空间管理设备可以添加设备。')
      const body=z.object({projects:z.array(id).min(1).max(30),hours:z.number().int().min(1).max(72).default(24)}).strict().parse(input)
      body.projects.forEach(p=>this.project(actor,p))
      const invitation=secret(),expires=Date.now()+body.hours*3600_000
      this.data.set(`invite:${hash(invitation)}`,{space:actor.space,projects:[...new Set(body.projects)],issuer:actor.device.id,expires,used:false})
      return {invitation,expires,projects:body.projects}
    }
    if(route==='/v1/projects' && method==='GET') return {projects:this.data.list<Project>(`project:${actor.space}:`).filter(p=>actor.device.admin || actor.device.projects.includes(p.id))}
    if(route==='/v1/projects' && method==='POST') {
      if(!actor.device.admin) throw new SyncError(403,'只有空间管理设备可以创建项目。')
      const body=z.object({name}).strict().parse(input), project: Project={id:randomUUID(),name:body.name,at:stamp()}
      this.data.set(`project:${actor.space}:${project.id}`,project); return project
    }
    if(parts[0]!=='v1' || parts[1]!=='projects' || !projectId) throw new SyncError(404,'同步入口不存在。')
    const project=this.project(actor,projectId), prefix=`revision:${actor.space}:${projectId}:`
    if(parts.length===3&&method==='DELETE') {
      if(!actor.device.admin)throw new SyncError(403,'只有空间管理设备可以删除项目记录。')
      this.data.atomic(()=>{
        for(const key of [`project:${actor.space}:${projectId}`,prefix,`note:${actor.space}:${projectId}:`])this.data.db.prepare('DELETE FROM record WHERE substr(key,1,?)=?').run(key.length,key)
      });return {deleted:true}
    }
    if(parts.length===3 && method==='GET') {
      const heads=prefix+'head:'
      return {project,sessions:this.data.db.prepare("SELECT json_remove(value,'$.messages') AS metadata,json_array_length(value,'$.messages') AS count FROM record WHERE substr(key,1,?)=? ORDER BY key").all(heads.length,heads).map(row=>({...JSON.parse(String(row.metadata)),messages:Number(row.count)})),notes:this.data.list<SyncNote>(`note:${actor.space}:${projectId}:`)}
    }
    if(parts[3]==='sessions' && parts.length===4 && method==='POST') {
      const body=Snapshot.parse(input)
      if(new Set(body.messages.map(m=>m.id)).size!==body.messages.length) throw new SyncError(400,'一批记录中存在重复消息。')
      return this.data.atomic(()=>{
        const key=`${prefix}head:${actor.device.id}:${body.session}`, old=this.data.get<Revision>(key)
        const messages=new Map((old?.messages??[]).map(m=>[m.id,m]))
        body.messages.forEach(m=>messages.set(m.id,m))
        if(messages.size>20_000 || [...messages.values()].reduce((n,m)=>n+m.text.length,0)>2_000_000) throw new SyncError(413,'会话达到20000条或200万字符上限，请新建后续会话。')
        const merged={...body,messages:[...messages.values()].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))}
        const digest=hash(JSON.stringify(merged))
        const batchHash=hash(JSON.stringify(body))
        if(old?.hash===digest) return {id:old.id,hash:old.hash,batchHash,at:old.at,messages:old.messages.length,unchanged:true}
        const revision:Revision={...merged,id:randomUUID(),project:projectId,device:actor.device.id,hash:digest,at:stamp()}
        this.data.set(key,revision); this.data.set(`${prefix}version:${revision.id}`,{...revision,messages:body.messages,parent:old?.id??null})
        return {id:revision.id,hash:revision.hash,batchHash,at:revision.at,messages:revision.messages.length,unchanged:false}
      })
    }
    if(parts[3]==='sessions' && parts.length===6 && method==='GET') {
      const value=this.data.get<Revision>(`${prefix}head:${id.parse(parts[4])}:${id.parse(parts[5])}`)
      if(!value) throw new SyncError(404,'未找到同步会话。')
      return value
    }
    if(parts[3]==='notes' && parts.length===4 && method==='POST') {
      const body=Note.parse(input)
      return this.data.atomic(()=>{
        const existing=this.data.list<SyncNote>(`note:${actor.space}:${projectId}:`)
        if(existing.length>=500||existing.reduce((n,v)=>n+JSON.stringify(v).length,0)+JSON.stringify(body).length>1_000_000)throw new SyncError(413,'项目方案记录达到500份或100万字符上限，请归档后建立后续项目。')
        if(body.parent && !this.data.get(`note:${actor.space}:${projectId}:${body.parent}`)) throw new SyncError(409,'前序方案不属于当前项目。')
        const note:SyncNote={...body,id:randomUUID(),device:actor.device.id,at:stamp()}
        this.data.set(`note:${actor.space}:${projectId}:${note.id}`,note); return note
      })
    }
    if(parts[3]==='notes'&&parts.length===5&&method==='GET') {
      const note=this.data.get<SyncNote>(`note:${actor.space}:${projectId}:${id.parse(parts[4])}`)
      if(!note)throw new SyncError(404,'方案记录不存在。');return note
    }
    throw new SyncError(404,'同步入口不存在。')
  }
}
/** Request limits and errors are deliberately independent of the local assistant HTTP adapter. */
export function syncServer(hub: SyncHub) {
  const attempts=new Map<string,{count:number;until:number}>()
  return createServer(async(req:IncomingMessage,res:ServerResponse)=>{
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
    try {
      if(req.headers.origin) throw new SyncError(403,'同步接口不接受浏览器跨站调用；请通过本机 Loom 配对。')
      const route=(req.url??'').split('?')[0]!, remote=req.socket.remoteAddress??'unknown'
      // Pairing/bootstrap/recovery are bounded even when an attacker varies invalid tokens.
      if(['/v1/spaces','/v1/join','/v1/recover'].includes(route)) {
        if(attempts.size>10_000) attempts.clear()
        const old=attempts.get(remote),v=old && old.until>Date.now()?old:{count:0,until:Date.now()+60_000}
        if(++v.count>20) throw new SyncError(429,'配对请求过多，请稍后重试。')
        attempts.set(remote,v)
      }
      let bytes=0,text=''
      for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>2_000_000)throw new SyncError(413,'单次上传超过 2MB。');text+=chunk}
      const token=req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]??''
      const result=await hub.route(req.method??'GET',route,token,text?JSON.parse(text):undefined)
      reply(200,result)
    } catch(error) {reply(error instanceof SyncError?error.status:400,{error:error instanceof SyncError?error.message:'同步请求格式不正确。'})}
  })
}
