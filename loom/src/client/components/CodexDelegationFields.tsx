import React, { useRef, useState, useEffect } from 'react';
import type { LoomCodexSessions, LoomDelegation } from '../../../../src/app/loom-types';

type Config = NonNullable<LoomDelegation['codex']>;
interface Props { value:Config; change:(value:Config)=>void; request:<T>(path:string,method?:string,body?:unknown)=>Promise<T>; disabled:boolean; consent:boolean; setConsent:(value:boolean)=>void }
export function CodexDelegationFields({value,change,request,disabled,consent,setConsent}:Props){
  const [options,setOptions]=useState<LoomCodexSessions|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [scopeType,setScopeType]=useState<'projects'|'sessions'>(value.sessions.length?'sessions':'projects');
  const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  const load=async()=>{const id=++generation.current;setLoading(true);setError('');
    try{const result=await request<LoomCodexSessions>('/delegations/codex-options');if(id===generation.current)setOptions(result);}
    catch(error){if(id===generation.current)setError((error as Error).message);}finally{if(id===generation.current)setLoading(false);}
  };
  const projects=[...new Set([...(options?.sessions.map(session=>session.cwd)??[]),...value.projects])].sort();
  const choose=(id:string,on:boolean)=>{const previous=value[scopeType];change({...value,[scopeType]:on?[...previous,id]:previous.filter(item=>item!==id)});setConsent(false);};
  return <>
    <div className="codex-delegation-note"><strong>本机 Codex 对话 → 工作日报</strong><p>读取当天用户与助手的文字对话，由 Loom 当前模型汇总；不启动 Codex 执行任务。讨论、计划和已完成事项分别整理，并保留会话依据。</p></div>
    <label className="field"><span>资料范围</span><select value={scopeType} disabled={disabled} onChange={event=>{const type=event.target.value as 'projects'|'sessions';setScopeType(type);change({...value,projects:[],sessions:[]});setConsent(false);}}><option value="projects">指定项目（包括该项目之后的新会话）</option><option value="sessions">指定会话（仅选中的会话）</option></select><small>项目路径精确匹配，不递归包含其他目录。最多 10 个项目或 20 个会话。</small></label>
    <div><button className="btn-secondary" type="button" disabled={disabled||loading} onClick={()=>void load()}>{loading?'正在读取列表…':'读取今天的本机会话列表'}</button><p className="field-note">这一步只读取会话名称和项目路径，选择并保存授权后才读取正文。列表包含今天更新的会话，部分可能没有当天正文。</p></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <fieldset className="delegation-chats codex-scope-picker"><legend>{scopeType==='projects'?'选择项目':'选择会话'} <span className="required">*</span></legend>
      {scopeType==='projects'?projects.map(project=><label className="checkbox-field" key={project}><input type="checkbox" disabled={disabled} checked={value.projects.includes(project)} onChange={event=>choose(project,event.target.checked)}/><span className="codex-path">{project}</span></label>):<>
        {(options?.sessions??[]).map(session=><label className="checkbox-field" key={session.id}><input type="checkbox" disabled={disabled} checked={value.sessions.includes(session.id)} onChange={event=>choose(session.id,event.target.checked)}/><span>{session.title}<small>{session.cwd} · {session.id}</small></span></label>)}
        {value.sessions.filter(id=>!options?.sessions.some(session=>session.id===id)).map(id=><label className="checkbox-field" key={id}><input type="checkbox" disabled={disabled} checked onChange={()=>choose(id,false)}/><span>{id}<small>已保存的会话；可能今天尚无活动。</small></span></label>)}
      </>}
      {!options&&!value[scopeType].length&&<p className="quiet-label">点击上方按钮读取列表，再选择需要汇总的范围。</p>}
      {options&&!options.sessions.length&&<p className="quiet-label">今天没有本机可选会话；请在 Codex 中使用项目后刷新列表。</p>}
      {options?.truncated&&<p className="field-note">列表扫描已达上限，部分会话未列出。</p>}
    </fieldset>
    <label className="field"><span>每天运行时间（北京时间）</span><input type="time" required value={value.time} disabled={disabled} onChange={event=>change({...value,time:event.target.value})}/><small>读取运行当天 00:00 起已保存的对话。电脑和助手需保持运行；当天错过的时间会在恢复后补跑一次，更早日期不自动补跑。保存时若已过今天的时间，从明天起生效；可手动立即运行。</small></label>
    <label className="field"><span>日报交付</span><select value={value.delivery} disabled={disabled} onChange={event=>{change({...value,delivery:event.target.value as Config['delivery']});setConsent(false);}}><option value="none">仅保存在 Loom 交付物</option><option value="feishu">发送报告文件到机器人私聊</option><option value="default">沿用当前“产物交付”设置（可含已授权邮箱）</option></select><small>Codex 日报不发到群聊。邮箱仍使用已有的本人邮箱授权；也可在具体任务中调整交付方式。</small></label>
    <label className="checkbox-field codex-consent"><input type="checkbox" required checked={consent} disabled={disabled} onChange={event=>setConsent(event.target.checked)}/><span>授权持续读取所选范围内的当天对话，用于生成日报<small>文字会提供给 Loom 当前配置的模型，并作为本任务的来源快照与报告保存在本机；内部推理、工具输出和附件正文被过滤。暂停停止后续读取与执行，历史任务和产物保留；更改资料范围后旧范围的读取入口失效。</small></span></label>
  </>;
}
