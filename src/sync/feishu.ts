/** Single-owner Feishu sync lifecycle, independent from the bot identity and the advanced self-hosted connector. */
import { z } from 'zod'
import { DeviceSync } from './client.ts'
import { FeishuCloud } from './feishu-cloud.ts'
import { FeishuDrive, type DrivePort } from './feishu-drive.ts'
import { SyncDatabase } from './database.ts'
import { hash, name, SyncError } from './model.ts'
import type { ReadCodex } from './codex.ts'
interface Host {owner():string;appId():string;paused():boolean;lifetime:AbortSignal;read?:ReadCodex}
interface Authorization {device:string;url:string;qr:string;expires:number;appId:string}
/** Device-independent cloud discovery after user login; collection and AI grants remain local and opt-in. */
export class FeishuSync {
  readonly connector:DeviceSync
  private readonly cloud:FeishuCloud
  constructor(readonly data:SyncDatabase,private readonly drive:DrivePort,private readonly host:Host) {
    this.cloud=new FeishuCloud(data,drive,host)
    this.connector=new DeviceSync(data,{...host,transport:this.cloud})
  }
  private check(owner:string) {this.host.lifetime.throwIfAborted();if(owner!==this.host.owner())throw new SyncError(403,'本机所有者已变化。')}
  private key(owner:string){return `authorization:${hash(owner)}`}
  private async account(owner:string) {
    try {
      const identity=await this.drive.identity(this.host.lifetime);this.check(owner)
      if(identity.owner!==owner||identity.appId!==this.host.appId())return {state:'wrong-owner' as const,name:'',missing:[] as string[],message:'请使用与本机所有者一致的飞书账号和应用登录。'}
      return {state:identity.missing.length?'needs-permission' as const:'ready' as const,name:identity.name,missing:identity.missing,message:identity.missing.length?'需要补充云空间同步权限。':''}
    }catch(error){this.check(owner);return {state:'signed-out' as const,name:'',missing:[] as string[],message:error instanceof SyncError?error.message:'请检查本机飞书 CLI 并完成用户授权。'}}
  }
  async status(owner:string) {this.check(owner);const account=await this.account(owner);return {...this.connector.status(owner),provider:'feishu' as const,account}}
  async handle(owner:string,method:string,path:string[],input?:unknown):Promise<unknown> {
    this.check(owner)
    if(method==='GET'&&!path.length)return this.status(owner)
    if(path.length===2&&path[0]==='auth'&&method==='POST') {
      z.object({}).strict().parse(input??{})
      if(!(this.drive instanceof FeishuDrive))throw new SyncError(409,'此运行环境不提供交互授权。')
      if(path[1]==='start') {
        if(await this.drive.application(this.host.lifetime)!==this.host.appId())throw new SyncError(403,'飞书 CLI 应用与本机助手不一致，请先配置同一应用。')
        const value=await this.drive.begin(this.host.lifetime);this.check(owner)
        this.data.set(this.key(owner),{...value,appId:this.host.appId()})
        return {url:value.url,qr:value.qr,expires:value.expires}
      }
      if(path[1]==='finish') {
        const pending=this.data.get<Authorization>(this.key(owner))
        if(!pending||pending.expires<=Date.now()||pending.appId!==this.host.appId())throw new SyncError(409,'授权二维码已过期，请重新发起登录。')
        await this.drive.finish(pending.device,this.host.lifetime);this.check(owner)
        this.data.db.prepare('DELETE FROM record WHERE key=?').run(this.key(owner))
        return this.status(owner)
      }
    }
    if(path.length===1&&path[0]==='connect'&&method==='POST') {
      const body=z.object({deviceName:name,consent:z.literal(true)}).strict().parse(input),account=await this.account(owner)
      if(account.state!=='ready')throw new SyncError(403,account.message||'请先完成飞书用户授权。')
      await this.connector.handle(owner,'POST',['connect'],{url:'https://open.feishu.cn',mode:'create',name:'Loom 飞书同步',deviceName:body.deviceName})
      return this.status(owner)
    }
    if(path.length===1&&path[0]==='connection'&&method==='DELETE') {
      const result=await this.connector.handle(owner,method,path,input);this.cloud.clear()
      this.data.db.prepare('DELETE FROM record WHERE key=?').run(this.key(owner));return result
    }
    if(path[0]==='invitations')throw new SyncError(404,'飞书同步通过同一账号连接设备，无需配对邀请。')
    return this.connector.handle(owner,method,path,input)
  }
  tick(){this.connector.tick()}
  idle(){return this.connector.idle()}
}
