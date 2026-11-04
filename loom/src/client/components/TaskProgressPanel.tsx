import React, { useEffect, useState } from 'react';
import type { LoomProgress, LoomTask } from '../../../../src/app/loom-types';
import { startLiveSync } from '../live-sync';
import { formatTime } from './UI';

interface Props { task:LoomTask; load:(id:string,signal?:AbortSignal)=>Promise<LoomProgress> }
const duration=(ms:number)=>{if(ms<1000)return `${Math.round(Math.max(0,ms))} 毫秒`;const s=Math.floor(ms/1000);return s<60?`${s} 秒`:s<3600?`${Math.floor(s/60)} 分 ${s%60} 秒`:`${Math.floor(s/3600)} 时 ${Math.floor(s%3600/60)} 分`;};
const eventStatus={running:'进行中',done:'已完成',failed:'工具报错／需处理',interrupted:'已中断'};
export function TaskProgressPanel({task,load}:Props){
  const [info,setInfo]=useState<LoomProgress|null>(null),[error,setError]=useState(''),[showModels,setShowModels]=useState(false),[all,setAll]=useState(false);
  useEffect(()=>{
    setInfo(null);setError('');setAll(false);
    const sync=startLiveSync({load:signal=>load(task.id,signal),value:result=>{setInfo(result);setError('');},error:error=>setError((error as Error).message)});
    return()=>sync.stop();
  },[task.id,task.control.revision,load]);
  if(error)return <section className="task-progress"><p className="form-error" role="alert">执行明细读取失败：{error}</p></section>;
  if(!info)return <section className="task-progress"><p className="quiet-label" role="status">正在读取执行进展…</p></section>;
  const events=info.events.filter(event=>showModels||event.kind!=='model');
  const current=info.currentSince?duration(Date.now()-Date.parse(info.currentSince)):'';
  return <section className="task-progress" aria-label="任务执行进展">
    <div className="progress-current" role="status"><span className={'status-dot '+(info.phase==='completed'?'is-done':'')}/><div><strong>{info.label}</strong><p>{info.phase==='model'&&current?`本次模型步骤已等待 ${current}。`:info.currentSince?`开始于 ${formatTime(Date.parse(info.currentSince),true)}`:info.lastActivityAt?`最近执行活动 ${formatTime(Date.parse(info.lastActivityAt),true)}`:'尚未取得原生执行记录。'}</p></div><span className="small-label">每 3 秒更新</span></div>
    <div className="progress-metrics">{[{label:'总用时',value:duration(info.elapsedMs)},{label:'模型累计',value:duration(info.modelMs)},{label:'工具累计',value:duration(info.toolMs)},{label:'模型步骤 / 工具动作',value:`${info.modelSteps} / ${info.toolCalls}`}].map(item=><div key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>)}</div>
    {info.unavailable&&<p className="notice-banner">{info.unavailable}</p>}
    {info.control.mode!=='agent'&&<div className="progress-handover">
      <strong>{info.control.mode==='human'?'控制权已交给你':info.control.mode==='taking_over'?'正在完成接管':info.control.mode==='paused'?'任务保持暂停':'正在安全停止任务'}</strong>
      <p>{info.control.mode==='human'?'助手不会自行推进。可查看并编辑已保存的报告；点击“交还助手”后，它会读取当前成果和人工修改再继续。':info.control.mode==='paused'?'新消息和服务重启不会自行解除暂停。点击“继续”才恢复这个任务。':info.control.pending.some(op=>op.unknown)?'有操作的实际结果待核查，暂时不能确认移交完成；已发生的外部动作不会被自动撤回。':'已阻止新的受管操作，正在等待工具、后台作业和子任务停止。只有在途归零且停止已确认后，才会显示“你已接管”。'}</p>
      {info.control.pending.length>0&&<ul>{info.control.pending.map(op=><li key={op.id}>{op.label} · {op.unknown?'结果待核查':'在途中'} · {formatTime(Date.parse(op.startedAt),true)}</li>)}</ul>}
    </div>}
    <div className="progress-heading"><h3>执行记录 <span className="count">{events.length}</span></h3><label className="checkbox-field"><input type="checkbox" checked={showModels} onChange={event=>setShowModels(event.target.checked)}/>显示模型步骤耗时</label></div>
    <div className="progress-timeline">{(all?events:events.slice(0,24)).map(event=><article className={'progress-event is-'+event.status} key={event.id}><time>{new Date(event.at).toLocaleTimeString('zh-CN',{hour12:false})}</time><div><strong>{event.title}</strong><p>{event.kind==='control'?'操作已记录':event.kind==='tool'&&event.status==='done'?'工具已返回':eventStatus[event.status]}{event.durationMs!==undefined?` · ${duration(event.durationMs)}`:''}</p>{event.detail&&<p className="progress-report">{event.detail}</p>}</div></article>)}</div>
    {!events.length&&<p className="quiet-label">尚无执行动作，任务可能正在排队或等待模型。</p>}
    {!all&&events.length>24&&<button className="text-button" onClick={()=>setAll(true)}>展开其余 {events.length-24} 条记录</button>}
    <p className="field-note">{info.failedTools?`${info.failedTools} 次工具报错记录；任务是否完成以报告状态为准。`:'动作与耗时来自实际执行记录。'}{info.truncated?'仅保留最近一段记录。':''}此处展示操作与结果摘要，不展示模型内部推理或原始命令日志。</p>
  </section>;
}
