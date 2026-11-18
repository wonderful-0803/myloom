/** DashScope Filetrans adapter. Uploads are private, credentials never cross to OSS, and accepted task IDs survive retries. */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { AudioTranscript } from './audio.ts'

export interface BailianJob { stage: 'uploading' | 'submitting' | 'polling' | 'unknown' | 'failed' | 'succeeded'; model: string; taskId?: string; startedAt: string }
const exec = promisify(execFile)
export function bailianConfig() {
  const endpoint = process.env.LOOM_ASR_ENDPOINT || 'https://dashscope.aliyuncs.com/api/v1'
  const u = new URL(endpoint)
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/api/v1'
    || !/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[A-Za-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)$/.test(u.hostname)) throw new Error('百炼 ASR 地址不在已支持范围内。')
  const model = process.env.LOOM_ASR_MODEL || 'qwen-audio-3.1-asr-flash-filetrans'
  if (!/^qwen(?:-audio-3\.[01]|3)-asr-flash-filetrans(?:-[0-9-]+)?$/.test(model)) throw new Error('请选择已支持的百炼 Filetrans 录音转写模型。')
  return { endpoint, model, keyFile: process.env.LOOM_ASR_API_KEY_FILE || '' }
}
function storageURL(value: string): string {
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname.endsWith('.aliyuncs.com')) throw new Error('百炼存储地址不在允许范围内。')
  return value
}
async function json(response: Response) {
  if (!response.ok) throw new Error(`百炼 ASR 请求失败（HTTP ${response.status}）。`)
  if (Number(response.headers.get('content-length')) > 4_000_000) throw new Error('百炼 ASR 返回结果超出预算。')
  const reader=response.body?.getReader();if(!reader)throw new Error('百炼 ASR 返回空结果。')
  let body='',bytes=0;const decoder=new TextDecoder()
  for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>4_000_000){await reader.cancel();throw new Error('百炼 ASR 返回结果超出预算。')}body+=decoder.decode(part.value,{stream:true})}
  return JSON.parse(body+decoder.decode())
}
export function bailianTranscript(data: any, model: string): AudioTranscript {
  const duration = Number(data.properties?.original_duration_in_milliseconds)/1000
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7200 || !Array.isArray(data.transcripts)) throw new Error('百炼转写缺少完整音频范围。')
  const segments: AudioTranscript['segments'] = data.transcripts.flatMap((t:any) => {
    if (!Array.isArray(t.sentences)) throw new Error('百炼转写缺少带时间戳的句子。')
    return t.sentences.map((s:any) => ({ start:Number(s.begin_time)/1000, end:Number(s.end_time)/1000, text:String(s.text || ''),
      ...(Number.isInteger(s.speaker_id) ? { speaker:`说话人${s.speaker_id+1}` } : {}) }))
  }).sort((a:any,b:any)=>a.start-b.start)
  if (!segments.length || segments.length>10000 || segments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>duration+2||!s.text.trim()) || segments.reduce((n,s)=>n+s.text.length,0)>160000) throw new Error('百炼转写为空、时间戳异常或超出文字预算。')
  return { engine:`百炼 ${model}`, duration, segments }
}
/** No automatic resubmission after an uncertain POST. Existing IDs are polled without another upload or billable task. */
export async function bailianTranscribe(file: string, outer: AbortSignal, checkpoint: (job:BailianJob)=>void|Promise<void>, previous?: BailianJob): Promise<AudioTranscript> {
  const config=bailianConfig()
  if(!isAbsolute(config.keyFile))throw new Error('百炼 ASR 凭据文件尚未配置。')
  const secret=(await readFile(config.keyFile,'utf8')).trim()
  if(secret.length<8||secret.length>8192||/[\s\x00]/.test(secret))throw new Error('百炼 ASR 凭据不可用。')
  const signal=AbortSignal.any([outer,AbortSignal.timeout(30*60_000)])
  let job:BailianJob=previous ?? {stage:'uploading',model:config.model,startedAt:new Date().toISOString()}
  if(job.model!==config.model)throw new Error('转写模型已变化，请重新确认录音。')
  if(!job.taskId&&['submitting','unknown'].includes(job.stage))throw new Error('百炼任务提交结果待核查，未再次上传或提交。')
  const save=async(stage:BailianJob['stage'],taskId=job.taskId)=>{job={...job,stage,...taskId?{taskId}:{}};await checkpoint(job)}
  const call=async(path:string,init:RequestInit={})=>json(await fetch(config.endpoint+path,{...init,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)]),headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json',...init.headers}}))
  signal.throwIfAborted()
  if(!job.taskId){
    if((await stat(file)).size>80*1024*1024)throw new Error('录音超过 80 MB。')
    const formats='mp3,wav,mov,matroska,webm,ogg,flac,aac,amr,asf'
    const probe=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',formats,'-show_entries','format=duration:stream=channels','-select_streams','a:0','-of','json',file],{signal,timeout:20_000,maxBuffer:100_000})
    const meta=JSON.parse(probe.stdout),duration=Number(meta.format?.duration),channels=Number(meta.streams?.[0]?.channels)
    if(!Number.isFinite(duration)||duration<=0||duration>7200||!channels)throw new Error('只接受可解码且不超过 2 小时的录音。')
    let input=file
    if(channels>1){input=join(dirname(file),'cloud-mono.flac');await exec('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-format_whitelist',formats,'-i',file,'-vn','-ac','1','-ar','16000','-c:a','flac',input],{signal,timeout:300_000,maxBuffer:100_000})}
    if((await stat(input)).size>80*1024*1024)throw new Error('处理后的录音超过上传预算。')
    await save('uploading')
    const policy=await call(`/uploads?action=getPolicy&model=${encodeURIComponent(config.model)}`)
    const cert=policy.data
    if(!cert||cert.x_oss_object_acl!=='private'||!cert.upload_dir||typeof cert.upload_dir!=='string'||cert.upload_dir.includes('..'))throw new Error('百炼未提供受限私有上传凭据。')
    const uploadHost=storageURL(cert.upload_host),name=`${randomUUID()}-${basename(input)}`,key=cert.upload_dir+'/'+name
    const form=new FormData()
    for(const [k,v] of Object.entries({OSSAccessKeyId:cert.oss_access_key_id,Signature:cert.signature,policy:cert.policy,key,
      'x-oss-object-acl':'private','x-oss-forbid-overwrite':String(cert.x_oss_forbid_overwrite),'success_action_status':'200'})){
      if(typeof v!=='string'||!v)throw new Error('上传凭据不完整。');form.set(k,v)
    }
    form.set('file',new Blob([await readFile(input)]),name)
    const upload=await fetch(uploadHost,{method:'POST',body:form,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(180_000)])})
    if(!upload.ok)throw new Error('录音上传百炼失败。')
    signal.throwIfAborted()
    await save('submitting')
    let response:any
    try{response=await call('/services/audio/asr/transcription',{method:'POST',headers:{'X-DashScope-Async':'enable','X-DashScope-OssResourceResolve':'enable'},body:JSON.stringify({model:config.model,input:config.model.startsWith('qwen3-')?{file_url:'oss://'+key}:{file_urls:['oss://'+key]},parameters:{channel_id:[0],...(config.model.startsWith('qwen-audio-')?{diarization_enabled:true}:{enable_itn:true})}})})}
    catch{await save('unknown');throw new Error('百炼提交结果待核查；不会自动重复提交。')}
    const taskId=response.output?.task_id
    if(typeof taskId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(taskId)){await save('unknown');throw new Error('百炼未返回可核验的任务 ID。')}
    await save('polling',taskId)
  }
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(job.taskId!))throw new Error('百炼任务 ID 无效。')
  for(;;){
    signal.throwIfAborted()
    const status=await call(`/tasks/${job.taskId}`),output=status.output
    if(output?.task_status==='SUCCEEDED'){
      if(!Array.isArray(output.results)||output.results.length!==1||output.results[0].subtask_status!=='SUCCEEDED')throw new Error('百炼录音子任务未完整成功。')
      const body=await json(await fetch(storageURL(output.results[0].transcription_url),{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)])}))
      const result=bailianTranscript(body,config.model);await save('succeeded');return result
    }
    if(['FAILED','CANCELED','CANCELLED','UNKNOWN'].includes(output?.task_status)){await save('failed');throw new Error('百炼录音识别任务未成功，请核对任务状态。')}
    if(!['PENDING','RUNNING'].includes(output?.task_status))throw new Error('百炼返回未知任务状态。')
    await delay(2000,undefined,{signal})
  }
}
