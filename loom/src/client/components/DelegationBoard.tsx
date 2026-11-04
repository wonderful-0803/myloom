import React, { useState } from 'react';
import type { LoomDelegation } from '../../../../src/app/loom-types';
import { CodexDelegationFields } from './CodexDelegationFields';
import { Icon } from './Icon';
import { EmptyState, Modal, formatTime } from './UI';

export interface DelegationForm {
  title: string; description?: string; codex?:LoomDelegation['codex']; codexConsent?:boolean; chatIds: string[]; keywords: string[]; enabled: boolean; mode: 'auto'|'observe'; revision: number; requestId?: string;
}
interface Props {
  delegations: LoomDelegation[]; chats: {chatId:string;name:string;listen:string}[]; revision:number; disabled:boolean; compact?:boolean;
  save:(body:DelegationForm,id?:string)=>Promise<void>; toggle:(item:LoomDelegation,revision:number)=>Promise<void>;
  request:<T>(path:string,method?:string,body?:unknown)=>Promise<T>; runDaily:(item:LoomDelegation,revision:number)=>Promise<void>;
  showTasks:(id:string)=>void; showArtifacts:(id:string)=>void;
}
export function DelegationBoard({delegations,chats,revision,disabled,compact=false,save,toggle,request,runDaily,showTasks,showArtifacts}:Props){
  const [form,setForm]=useState<DelegationForm|null>(null),[editing,setEditing]=useState<string|undefined>(),[keywordText,setKeywordText]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[consent,setConsent]=useState(false);
  const available=chats.filter(chat=>chat.listen==='all');
  const open=(item?:LoomDelegation)=>{
    setError('');setConsent(false);setEditing(item?.id);setKeywordText(item?.keywords.join('，')??'');
    setForm({title:item?.title??'',description:item?.description??'',...(item?.codex?{codex:item.codex}:{}),chatIds:item?.chatIds??available.slice(0,1).map(chat=>chat.chatId),
      keywords:item?.keywords??[],enabled:item?.enabled??true,mode:item?.mode??'auto',revision,...!item?{requestId:crypto.randomUUID()}:{} });
  };
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!form||busy)return;setBusy(true);setError('');
    const keywords=form.codex?[]:[...new Set(keywordText.split(/[,，、\n]/).map(word=>word.trim()).filter(Boolean))];
    try{await save({...form,title:form.title.trim(),description:form.description?.trim()||undefined,keywords,...form.codex?{codexConsent:consent}:{}},editing);setForm(null);}
    catch(error){setError((error as Error).message);}finally{setBusy(false);}
  };
  const immediate=async(item:LoomDelegation)=>{setBusy(true);setError('');try{await runDaily(item,revision);}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  const switchItem=async(item:LoomDelegation)=>{setBusy(true);setError('');try{await toggle(item,revision);}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  return <section className="section-surface delegation-board">
    <div className="section-heading"><div><h2>持续委托 <span className="count">{delegations.length}</span></h2><p>设定一次，持续关注；匹配后按你的授权推进。</p></div><button type="button" className="text-button" disabled={disabled||busy} onClick={()=>open()}><Icon name="plus" size={15}/>新增委托</button></div>
    {error&&!form&&<div className="notice-banner" role="alert">{error}</div>}
    {!delegations.length?<EmptyState title="把持续要做的事，交代一次" icon="rules" action={<button className="btn-primary" disabled={disabled||busy} onClick={()=>open()}>创建持续委托</button>}>例如：看到本人发出的工作记录时，整理今日进展和下一步。具体事件匹配后再开任务。</EmptyState>:<div className="delegation-list">{(compact?delegations.slice(0,3):delegations).map((item,index)=><article className={'delegation-item '+(!item.enabled?'is-paused':'')} key={item.id}>
      <div className="delegation-heading"><span className="rule-number">{String(index+1).padStart(2,'0')}</span><div><h3>{item.title}</h3><span className="quiet-label">{!item.available?'来源范围已变更，当前不可用':!item.enabled?'已暂停':item.mode==='auto'?'已启用 · 匹配后自动执行':'已启用 · 仅观察'}</span></div><button type="button" className={'switch '+(item.enabled?'is-on':'')} role="switch" aria-checked={item.enabled} aria-label={(item.enabled?'暂停委托：':'启用委托：')+item.title} disabled={disabled||busy||!item.available&&!item.enabled} onClick={()=>void switchItem(item)}><span/></button></div>
      {!compact&&<><p className="delegation-description">{item.description}</p><div className="delegation-scope">{item.scopes.map(scope=><span className="small-label" key={scope.chatId}><Icon name="message" size={12}/>{scope.name}</span>)}<span className="small-label">{item.codex?'本机 Codex · '+item.codex.time+' 北京时间':'仅本人消息'}</span></div>{item.codex&&<p className="delegation-description codex-path">{item.codex.projects.length?'项目：'+item.codex.projects.join('、'):'会话：'+item.codex.sessions.join('、')}</p>}<p className="quiet-label">{item.codex?'每天汇总当天对话':item.keywords.length?'触发线索：'+item.keywords.join(' / '):'按委托目标评估群内消息'} · {formatTime(Date.parse(item.updatedAt),true)} 更新</p></>}
      {item.codex&&item.runs?.[0]&&<div className="codex-run-status" role="status"><strong>{item.runs[0].date} · {({queued:'等待读取',reading:'正在读取历史',started:'任务已创建',empty:'当天无可用记录',observed:'已观察 · 未执行',failed:'读取失败',cancelled:'授权已变化，已取消'} as Record<string,string>)[item.runs[0].status]??item.runs[0].status}</strong>{item.runs[0].messages!==undefined&&<span> {item.runs[0].sessions} 个会话 / {item.runs[0].messages} 条消息</span>}{item.runs[0].detail&&<p>{item.runs[0].detail}</p>}{!!item.runs[0].warnings?.length&&<p>资料存在读取限制，请查看任务与报告中的覆盖说明。</p>}</div>}
      <div className="delegation-actions">{item.codex&&<button type="button" className="text-button" disabled={disabled||busy||!item.enabled||!item.available} onClick={()=>void immediate(item)}>立即运行</button>}<button type="button" className="text-button" disabled={disabled||busy} onClick={()=>open(item)}>编辑委托</button><button type="button" className="text-button" onClick={()=>showTasks(item.id)}>查看任务（{item.taskIds.length}）</button><button type="button" className="text-button" onClick={()=>showArtifacts(item.id)}>查看交付物</button></div>
    </article>)}</div>}
    {form&&<Modal title={editing?'编辑持续委托':'新增持续委托'} onClose={()=>{if(!busy)setForm(null);}} footer={<><button className="btn-secondary" disabled={busy} onClick={()=>setForm(null)}>取消</button><button type="submit" form="delegation-form" className="btn-primary" disabled={busy||disabled||!form.title.trim()||(form.codex?!(form.codex.projects.length||form.codex.sessions.length)||!consent:!form.chatIds.length)}>{busy?'保存中…':editing?'保存修改':'保存委托'}</button></>}>
      <p className="form-intro">{form.codex?'保存一份常驻的日报授权。你可以随时暂停、调整范围，并从任务页查看进展或接管。':'写清希望持续处理的事项。保存后只处理所选群里本人之后发出的新消息；具体目标、依据和交付物仍需通过评估。'}</p>
      <form id="delegation-form" className="form-stack" onSubmit={submit}>
        <label className="field"><span>委托类型</span><select aria-label="委托类型" disabled={!!editing||busy} value={form.codex?'codex':'feishu'} onChange={event=>{setConsent(false);setKeywordText('');const {codex:_old,...base}=form;setForm(event.target.value==='codex'?{...base,chatIds:[],keywords:[],codex:{projects:[],sessions:[],time:'18:00',timezone:'Asia/Shanghai',delivery:'none'}}:{...base,chatIds:available.slice(0,1).map(chat=>chat.chatId),keywords:[]});}}><option value="feishu">飞书群消息</option><option value="codex">Codex 会话日报</option></select></label>
        <label className="field"><span>委托名称 <span className="required">*</span></span><input required maxLength={100} value={form.title} onChange={event=>setForm({...form,title:event.target.value})} placeholder="例如：整理我的工作记录"/></label>
        <label className="field"><span>具体目标与边界</span><textarea rows={4} maxLength={2000} value={form.description??''} onChange={event=>setForm({...form,description:event.target.value})} placeholder="何时介入、使用哪些资料、交付什么；例如仅根据本话题记录整理总结，不修改原始数据。"/><small>不填写时使用委托名称作为目标。不会因此扩大工具或资料权限。</small></label>
        {form.codex?<CodexDelegationFields value={form.codex} change={codex=>setForm({...form,codex})} request={request} disabled={busy} consent={consent} setConsent={setConsent}/>:<>
        <fieldset className="delegation-chats"><legend>关注的飞书群 <span className="required">*</span></legend>{available.length?available.map(chat=><label className="checkbox-field" key={chat.chatId}><input type="checkbox" checked={form.chatIds.includes(chat.chatId)} onChange={event=>setForm({...form,chatIds:event.target.checked?[...form.chatIds,chat.chatId]:form.chatIds.filter(id=>id!==chat.chatId)})}/><span>{chat.name}</span></label>):<p className="quiet-label">当前没有已授权接收全部消息的群。请先在本机配置监听范围。</p>}</fieldset>
        <label className="field"><span>触发关键词（选填）</span><input maxLength={500} value={keywordText} onChange={event=>setKeywordText(event.target.value)} placeholder="例如：工作记录，日报，进展"/><small>多个词用逗号分隔，出现任意一个即可进入该委托的评估；留空按目标进行语义评估。</small></label>
        </>}
        <label className="field"><span>{form.codex?'到点后的处理方式':'匹配后的处理方式'}</span><select value={form.mode} onChange={event=>setForm({...form,mode:event.target.value as 'auto'|'observe'})}><option value="auto">自动执行，创建任务并后台处理</option><option value="observe">仅观察，记录候选需求</option></select><small>只影响这条委托，不改变其他规则的模式。仅观察不会读取 Codex 正文或生成日报；邮箱交付遵循现有的独立授权。</small></label>
        <label className="checkbox-field"><input type="checkbox" checked={form.enabled} onChange={event=>setForm({...form,enabled:event.target.checked})}/><span>保存后启用<small>暂停会阻止新接单，并暂停尚未结束的自动委托任务；历史任务和交付物保留，重新启用不会自行恢复已暂停任务。</small></span></label>
        <p className="field-note">当前接入：飞书群消息、Codex 会话日报。Codex 日报支持每日定时及立即运行；其他事件来源尚未接入。</p>
        {error&&<p className="form-error" role="alert">{error}</p>}
      </form>
    </Modal>}
  </section>;
}
