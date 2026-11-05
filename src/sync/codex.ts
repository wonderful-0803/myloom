/** Incremental read-only capture, with overlapping live pages and durable historical backfill. */
import { z } from 'zod'
import { withCodexReader, type CodexReader } from '../app/codex-rpc.ts'
import type { SyncMessage, SyncSnapshot } from './model.ts'
const meta=z.object({id:z.string().uuid(),name:z.string().nullable().optional(),cwd:z.string(),source:z.unknown(),parentThreadId:z.string().nullable().optional(),ephemeral:z.boolean().optional()})
const interactive=(source:unknown)=>typeof source==='string'&&['cli','vscode','appServer','unknown'].includes(source)
const page=z.object({data:z.array(z.object({item:z.record(z.string(),z.unknown()),turnId:z.string(),startedAtMs:z.number().nullable().optional(),completedAtMs:z.number().nullable().optional()})).max(100),nextCursor:z.string().nullable().optional()})
export interface CaptureCursor { known: string[]; pending: string[] }
export type CaptureState=Record<string,CaptureCursor>
export type ReadCodex=<T>(signal:AbortSignal,run:(reader:CodexReader)=>Promise<T>)=>Promise<T>
export function visibleMessage(entry:z.infer<typeof page>['data'][number]):SyncMessage|undefined {
  const m=entry.item, at=entry.startedAtMs??entry.completedAtMs
  if(typeof m.id!=='string'||!['userMessage','agentMessage'].includes(String(m.type))||at==null) return
  if(m.type==='agentMessage' && m.phase!=null && !['commentary','final_answer'].includes(String(m.phase)))return
  const parts=m.type==='userMessage' && Array.isArray(m.content)?m.content:[]
  let text=m.type==='userMessage'?parts.filter(p=>p?.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n'):typeof m.text==='string'?m.text:''
  if(/^\s*<(?:environment_context|external_codex_apps_open_page|external_browser_tabs|in-app-browser-context)[\s>]/.test(text)&&!text.includes('## My request:'))return
  text=text.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,'').replace(/^\s*## My request:\s*/,'').trim()
  const omittedAttachments=parts.some(p=>p?.type!=='text')
  if(!text&&!omittedAttachments)return
  return {id:m.id,turnId:entry.turnId,role:m.type==='userMessage'?'user':'assistant',at,text:text.slice(0,40_000),truncated:text.length>40_000,omittedAttachments}
}
export async function captureCodex(cwd:string,state:CaptureState,check:()=>void,signal:AbortSignal,read:ReadCodex=withCodexReader) {
  const result:SyncSnapshot[]=[],next:CaptureState=structuredClone(state),warnings:string[]=[]
  await read(signal,async raw=>{
    const call=async(method:Parameters<CodexReader['call']>[0],params:Record<string,unknown>)=>{check();signal.throwIfAborted();const value=await raw.call(method,params);check();return value}
    const selected=new Map<string,z.infer<typeof meta>>()
    for(const archived of [false,true]) {
      let cursor:string|undefined;const seen=new Set<string>()
      for(let n=0;n<10;n++) {
        const p=z.object({data:z.array(meta).max(200),nextCursor:z.string().nullable().optional()}).parse(await call('thread/list',{archived,cursor,limit:100,sortKey:'updated_at',sortDirection:'desc',modelProviders:[],sourceKinds:['cli','vscode','appServer','unknown'],useStateDbOnly:true}))
        for(const s of p.data)if(s.cwd===cwd&&!s.parentThreadId&&!s.ephemeral&&interactive(s.source))selected.set(s.id,s)
        if(!p.nextCursor)break
        if(seen.has(p.nextCursor)||n===9){warnings.push('会话目录扫描达到上限，较早会话可能未覆盖。');break}
        seen.add(p.nextCursor);cursor=p.nextCursor
      }
    }
    if(selected.size>20)warnings.push('当前仅同步最近列出的20个项目会话，其余尚未覆盖。')
    for(const s of [...selected.values()].slice(0,20)) {
      const actual=meta.parse(z.object({thread:meta}).parse(await call('thread/read',{threadId:s.id,includeTurns:false})).thread)
      if(actual.id!==s.id||actual.cwd!==cwd||actual.parentThreadId||actual.ephemeral||!interactive(actual.source))throw new Error('Codex 会话已移出授权项目。')
      const previous=state[s.id]??{known:[],pending:[]},known=new Set(previous.known),pending=[...previous.pending],messages:SyncMessage[]=[]
      let missing=0
      const collect=(p:z.infer<typeof page>)=>{for(const e of p.data){if(typeof e.item.id==='string')known.add(e.item.id);const m=visibleMessage(e);if(m)messages.push(m);else if(e.startedAtMs==null&&e.completedAtMs==null)missing++}}
      const latest=page.parse(await call('thread/items/list',{threadId:s.id,limit:50,sortDirection:'desc'}))
      const overlap=latest.data.some(e=>typeof e.item.id==='string'&&previous.known.includes(e.item.id))
      if(latest.nextCursor&&!overlap&&!pending.includes(latest.nextCursor))pending.unshift(latest.nextCursor)
      collect(latest)
      const visited=new Set<string>()
      for(let n=0;n<2 && pending.length;n++) {
        const cursor=pending.shift()!;if(visited.has(cursor))throw new Error('Codex 历史分页没有前进。')
        visited.add(cursor)
        const older=page.parse(await call('thread/items/list',{threadId:s.id,cursor,limit:50,sortDirection:'desc'}))
        const reached=older.data.some(e=>typeof e.item.id==='string'&&known.has(e.item.id))
        collect(older)
        if(older.nextCursor&&!reached&&!pending.includes(older.nextCursor))pending.push(older.nextCursor)
      }
      next[s.id]={known:[...known].slice(-20_000),pending}
      const coverage=`仅用户/助手可见文字；不含工具输出、内部推理和附件正文。${pending.length?'较早历史补齐中。':'已扫描到历史末尾。'}${missing?`${missing}条无时间记录未纳入。`:''}`
      const unique=[...new Map(messages.map(m=>[m.id,m])).values()]
      let batch:SyncMessage[]=[],bytes=0
      for(const m of unique){const size=Buffer.byteLength(JSON.stringify(m));if(batch.length&&bytes+size>1_400_000){result.push({session:s.id,title:(s.name||'未命名会话').slice(0,120),messages:batch,coverage});batch=[];bytes=0}batch.push(m);bytes+=size}
      result.push({session:s.id,title:(s.name||'未命名会话').slice(0,120),messages:batch,coverage})
    }
  })
  check();return {snapshots:result,state:next,warnings}
}
