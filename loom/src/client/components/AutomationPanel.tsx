import React, { useState } from 'react';
import type { LoomSnapshot } from '../../../../src/app/loom-types';
import { Icon } from './Icon';

type Mode = LoomSnapshot['mode'];
const modeNames:Record<Mode,string>={auto:'自动执行',observe:'仅观察',off:'关闭基础规则发现'};
const ruleNames:Record<string,string>={'office-summary':'工作总结与纪要','office-data':'数据汇总','office-research':'资料查阅'};
interface Props {
  data:LoomSnapshot; disabled:boolean; compact?:boolean;
  saveMode:(mode:Mode,revision:number)=>Promise<void>;
  toggleRule:(id:string,enabled:boolean,revision:number)=>Promise<void>;
  showSettings:()=>void;
}
export function AutomationPanel({data,disabled,compact=false,saveMode,toggleRule,showSettings}:Props){
  const [proposal,setProposal]=useState<{mode:Mode;revision:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  if(!data.automation)return null;
  const submit=async()=>{if(!proposal||busy)return;setBusy(true);setError('');
    try{await saveMode(proposal.mode,proposal.revision);setProposal(null);}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  const toggle=async(id:string,enabled:boolean)=>{if(busy)return;setBusy(true);setError('');
    try{await toggleRule(id,enabled,data.policyRevision);}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  return <section className="section-surface automation-panel">
    <div className="section-heading"><div><h2>自主处理 <span className={'automation-status '+(data.mode==='auto'?'is-auto':'')}>{modeNames[data.mode]}</span></h2><p>识别到你的工作需求后，按已启用规则决定是否自动开工。</p></div>{compact&&<button className="text-button" onClick={showSettings}>管理规则<Icon name="arrow" size={14}/></button>}</div>
    <div className="automation-body">
      <label className="field"><span>基础规则处理模式</span><select aria-label="基础规则处理模式" disabled={disabled||busy} value={proposal?.mode??data.mode} onChange={event=>{setError('');setProposal({mode:event.target.value as Mode,revision:data.automation.revision});}}>
        <option value="auto">自动执行：识别后创建任务并后台处理</option><option value="observe">仅观察：记录候选需求，不自动接单</option><option value="off">关闭基础规则的主动发现</option>
      </select></label>
      {proposal&&<div className="automation-save"><button className="btn-primary" disabled={disabled||busy||proposal.mode===data.mode} onClick={()=>void submit()}>{busy?'保存中…':'切换为'+modeNames[proposal.mode]}</button><button className="text-button" disabled={busy} onClick={()=>{setProposal(null);setError('');}}>取消选择</button></div>}
      <p className="quiet-label">{data.mode==='auto'?'不用 @；目标、资料范围和交付物明确且符合规则时，自动创建任务。':data.mode==='observe'?'会识别和记录候选需求；符合受控起草条件的纯文本总结仍可进入草稿箱。':'基础规则停止主动发现；明确 @、私聊请求及单独启用的持续委托仍按各自授权处理。'}</p>
      <div className="automation-scope">{data.connection.chats.filter(chat=>chat.listen==='all').map(chat=><span className="small-label" key={chat.chatId}>{chat.name}</span>)}<span className="small-label">仅本人可触发</span><span className="small-label">最多 {data.automation.maxWorkers} 个 Worker</span></div>
      {!compact&&<div className="automation-rules">{data.rules.map(rule=><article className="automation-rule" key={rule.id}><div><strong>{ruleNames[rule.id]??rule.name}</strong><span className="quiet-label">{!rule.enabled?'已停用':data.mode==='auto'?'匹配后自动执行':data.mode==='observe'?'匹配后仅观察':'主动发现已关闭'}</span></div><button type="button" className={'switch '+(rule.enabled?'is-on':'')} role="switch" aria-checked={rule.enabled} aria-label={(rule.enabled?'停用基础规则：':'启用基础规则：')+(ruleNames[rule.id]??rule.name)} disabled={disabled||busy} onClick={()=>void toggle(rule.id,!rule.enabled)}><span/></button><details className="technical-details"><summary>查看适用范围</summary><p>{rule.text}</p></details></article>)}</div>}
      <p className="field-note">模式及规则开关影响后续接单，不重放历史候选。已开始的工作请在任务页暂停或接管。持续委托单独设置模式；邮件按“产物交付”设置或单次预览确认执行。</p>
      {data.paused&&<p className="notice-banner">后台处理已全局暂停；当前模式保存后，仍须恢复后台处理才能派发新任务。</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
  </section>;
}
