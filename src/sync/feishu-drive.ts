/** User-identity Drive adapter. Secrets stay in the existing CLI credential store, outside Worker tools. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { commandArgv } from '../infra/process.ts'
import { SyncError } from './model.ts'
import { FeishuSetupError, type FeishuUserConfig } from './feishu-config.ts'

export const feishuSyncScopes=['auth:user.id:read','offline_access','space:document:retrieve','space:folder:create','drive:file:upload','drive:file:download','space:document:delete']
export const DriveFile=z.object({name:z.string().max(500),token:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),type:z.string(),modified_time:z.string().optional(),owner_id:z.string().optional()})
export type DriveEntry=z.infer<typeof DriveFile>
export interface DriveIdentity { appId:string;owner:string;name:string;missing:string[] }
export interface DrivePort {
  identity(signal:AbortSignal):Promise<DriveIdentity>
  list(folder:string,signal:AbortSignal):Promise<DriveEntry[]>
  folder(parent:string,name:string,signal:AbortSignal):Promise<string>
  upload(folder:string,name:string,text:string,signal:AbortSignal):Promise<string>
  download(file:string,signal:AbortSignal):Promise<string>
  removeFolder(folder:string,signal:AbortSignal):Promise<void>
}
export type CliRunner=(args:string[],cwd:string|undefined,signal:AbortSignal)=>Promise<unknown>
const exec=promisify(execFile)
/** Closed command construction, private temporary files, bounded results, and safe CLI error envelopes. */
export class FeishuDrive implements DrivePort {
  constructor(private readonly directory:string,private readonly cli:()=>string=()=>process.env.LOOM_SYNC_FEISHU_CLI||'lark-cli',private readonly runner?:CliRunner,private readonly environment:()=>Record<string,string|undefined>=()=>({}),private readonly userConfig?:FeishuUserConfig) {
    mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700)
  }
  private temporary() {return mkdtempSync(join(this.directory,'transfer-'))}
  prepare(appId:string) { if(!process.env.LOOM_SYNC_FEISHU_CLI)this.userConfig?.prepare(appId) }
  async call(args:string[],cwd:string|undefined,signal:AbortSignal):Promise<any> {
    signal.throwIfAborted()
    try {
      if(this.runner)return await this.runner(args,cwd,signal)
      const [file,...argv]=commandArgv(this.cli(),args)
      const {stdout}=await exec(file!,argv,{cwd,signal,windowsHide:true,timeout:45_000,maxBuffer:4_000_000,env:{...process.env,...this.environment(),...(process.env.LOOM_SYNC_FEISHU_CLI?{}:this.userConfig?.environment()),LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}})
      try{return JSON.parse(stdout)}catch{return {}}
    } catch(error) {
      if(error instanceof SyncError)throw error
      const code=(error as {code?:string|number}).code
      if(code==='ENOENT')throw new FeishuSetupError('cli-missing','未找到可运行的飞书 CLI，请在本机安装 lark-cli，并确认 Loom 启动时可以访问它。',503)
      let refusal:any
      for(const stream of ['stderr','stdout'] as const)try{const parsed=JSON.parse(String((error as Record<string,unknown>)[stream]??''));if(parsed.error){refusal=parsed.error;break}}catch{/* never expose raw diagnostics */}
      if(refusal?.type==='config')throw new FeishuSetupError('configuration-required','用于同步的飞书应用尚未配置或凭据不可用。桌面首次配置的助手请更新引擎后重试；手动部署请配置同一应用的独立用户 CLI。',409)
      if(/strict|identity.*(?:disallowed|not_allowed)/i.test(String(refusal?.subtype??'')))throw new FeishuSetupError('bot-only','当前飞书 CLI 只允许机器人身份，无法生成用户授权二维码；请使用独立的同步用户配置，不要解除机器人的身份限制。',409)
      if(refusal?.subtype==='missing_scope')throw new FeishuSetupError('needs-permission','飞书云空间权限尚未授权，请重新完成同步授权。',403)
      if(refusal?.type==='authorization')throw new FeishuSetupError('signed-out','飞书用户授权已失效，请重新登录。',401)
      if((error as {code?:number}).code===10)throw new SyncError(409,'飞书要求确认此操作，尚未执行。')
      throw new FeishuSetupError('unavailable','飞书连接未完成，请检查网络、CLI 版本及应用权限后重试。',502)
    }
  }
  private async data(args:string[],signal:AbortSignal,cwd?:string) {
    const result=await this.call([...args,'--as','user','--format','json'],cwd,signal)
    if(result?.ok!==true||result.identity!=='user')throw new SyncError(401,'同步仅接受飞书用户身份，不能使用机器人身份。')
    return result.data
  }
  async identity(signal:AbortSignal):Promise<DriveIdentity> {
    const result=await this.call(['auth','status','--verify','--json'],undefined,signal),value=result.data??result,user=value.identities?.user
    if(!user?.verified||!user?.openId||!value.appId)throw new SyncError(401,'请先登录飞书并授权同步所需的云空间权限。')
    const scopes=new Set(Array.isArray(user.scope)?user.scope:typeof user.scope==='string'?user.scope.split(/[\s,]+/):[])
    return {appId:value.appId,owner:user.openId,name:user.userName||'本人',missing:feishuSyncScopes.filter(scope=>!scopes.has(scope))}
  }
  async application(signal:AbortSignal) {const result=await this.call(['auth','status','--json'],undefined,signal);return String((result.data??result).appId??'')}
  async begin(signal:AbortSignal) {
    const result=await this.call(['auth','login','--scope',feishuSyncScopes.join(' '),'--no-wait','--json'],undefined,signal)
    const value=result.data??result,raw=z.string().parse(value.verification_url??value.verification_uri_complete??value.verification_uri),url=new URL(raw)
    if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='feishu.cn'||url.hostname.endsWith('.feishu.cn')))throw new SyncError(502,'飞书授权地址无效。')
    const device=z.string().min(1).max(2000).parse(value.device_code),directory=this.temporary()
    try {
      await this.call(['auth','qrcode',raw,'--output','authorization.png'],directory,signal)
      const path=join(directory,'authorization.png');if(statSync(path).size>500_000)throw new SyncError(413,'授权二维码过大。')
      return {device,url:raw,qr:'data:image/png;base64,'+readFileSync(path).toString('base64'),expires:Date.now()+Math.min(Number(value.expires_in)||300,900)*1000}
    }finally{rmSync(directory,{recursive:true,force:true})}
  }
  async finish(device:string,signal:AbortSignal) {await this.call(['auth','login','--device-code',device,'--json'],undefined,signal);return this.identity(signal)}
  async list(folder:string,signal:AbortSignal) {
    const result:DriveEntry[]=[],seen=new Set<string>();let cursor:string|undefined
    for(let page=0;page<20;page++) {
      const data=await this.data(['drive','files','list','--params',JSON.stringify({folder_token:folder,page_size:200,user_id_type:'open_id',...(cursor?{page_token:cursor}:{})})],signal)
      result.push(...z.array(DriveFile).max(5000).parse(data.files??[]))
      if(!data.has_more)return result
      const next=z.string().min(1).parse(data.next_page_token)
      if(seen.has(next))throw new SyncError(409,'飞书文件分页未前进，未使用不完整目录。')
      seen.add(next);cursor=next
    }
    throw new SyncError(413,'同步目录超过本轮扫描上限，请整理专用目录后重试。')
  }
  async folder(parent:string,name:string,signal:AbortSignal) {
    const data=await this.data(['drive','+create-folder','--name',name,...parent?['--folder-token',parent]:[]],signal)
    return z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(data.folder_token??data.token)
  }
  async upload(folder:string,name:string,text:string,signal:AbortSignal) {
    if(Buffer.byteLength(text)>8_000_000)throw new SyncError(413,'同步文件超过8MB。')
    const directory=this.temporary()
    try{writeFileSync(join(directory,'payload.json'),text,{mode:0o600});const data=await this.data(['drive','+upload','--file','payload.json','--folder-token',folder,'--name',name],signal,directory);return z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(data.file_token)}
    finally{rmSync(directory,{recursive:true,force:true})}
  }
  async download(file:string,signal:AbortSignal) {
    const directory=this.temporary()
    try{await this.data(['drive','+download','--file-token',file,'--output','payload.json'],signal,directory);const path=join(directory,'payload.json');if(statSync(path).size>8_000_000)throw new SyncError(413,'同步文件超过8MB。');return readFileSync(path,'utf8')}
    finally{rmSync(directory,{recursive:true,force:true})}
  }
  async removeFolder(folder:string,signal:AbortSignal) {
    const data=await this.data(['drive','+delete','--file-token',folder,'--type','folder','--yes'],signal)
    if(data.deleted!==true||data.failed||data.ready===false)throw new SyncError(409,'云端删除尚未确认完成，请稍后核对。')
  }
}
