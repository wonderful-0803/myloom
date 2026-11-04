import React, { useId, useState } from 'react';
import type { LoomDeliverySetting, LoomResultReceipt } from '../../../../src/app/loom-types';
import { formatTime } from './UI';

type Mode=LoomDeliverySetting['mode'];
const names:Record<Mode,string>={default:'跟随默认设置',feishu:'发回飞书机器人',none:'仅在 Loom 保留',mail:'发送到绑定邮箱'};
const statuses:Record<string,string>={queued:'等待投递',sending:'正在投递',sent:'文件已发到飞书',submitted:'邮箱服务器已接收',unknown:'投递结果待核查',cancelled:'原投递已取消',blocked:'投递受阻',local:'已保留在 Loom'};
interface Props {
  setting:LoomDeliverySetting; receipts:LoomResultReceipt[]; disabled:boolean; task?:boolean; version?:number;
  save:(mode:Mode,revision:number,mailboxKey?:string)=>Promise<void>;
  mailbox:()=>Promise<{address:string;key:string}>;
  sendNow?:()=>Promise<void>;
}
export function DeliveryPanel({setting,receipts,disabled,task=false,version,save,mailbox,sendNow}:Props){
  const name=useId(),[proposal,setProposal]=useState<{mode:Mode;revision:number}|null>(null);
  const [binding,setBinding]=useState<{address:string;key:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const check=async()=>{setBusy(true);setError('');setBinding(null);try{setBinding(await mailbox());}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  const select=(mode:Mode)=>{setProposal({mode,revision:setting.revision});setBinding(null);setError('');};
  const submit=async()=>{if(!proposal)return;setBusy(true);setError('');try{await save(proposal.mode,proposal.revision,binding?.key);setProposal(null);setBinding(null);}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  const send=async()=>{setBusy(true);setError('');try{await sendNow?.();}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  const shown=proposal?.mode??setting.mode, published=receipts.some(r=>r.version===version&&r.mode===setting.effectiveMode&&['queued','sending','sent','submitted','unknown','blocked'].includes(r.status));
  return <section className="section-surface delivery-panel">
    <div className="section-heading"><div><h2>{task?'这个任务的交付方式':'产物交付'}</h2><p>{task?'可单独调整；查看或保存设置不会补发历史文件。':'任务完成后，自动交付已保存的报告定稿。'}</p></div></div>
    <div className="automation-body">
      <fieldset className="delivery-options" disabled={disabled||busy}><legend className="sr-only">{task?'任务交付方式':'默认交付方式'}</legend>
        {(task?['default','feishu','none','mail']:['feishu','none','mail']).map(value=><label key={value} className={'delivery-option '+(shown===value?'is-selected':'')}>
          <input type="radio" name={name} value={value} checked={shown===value} onChange={()=>select(value as Mode)}/><span><strong>{names[value as Mode]}</strong><small>{value==='feishu'?'默认：附上报告文件，群任务回原线程；跨会话资料转私聊。':value==='none'?'飞书仍有完成摘要；报告文件按需在 Loom 查看或导出。':value==='mail'?'定稿发到已验证的本人邮箱，不向飞书附加文件。':`当前默认：${names[setting.effectiveMode]}`}</small></span>
        </label>)}
      </fieldset>
      {shown==='mail'&&<div className="delivery-mailbox"><p>{binding?`将发至：${binding.address}`:setting.address&&!proposal?`已授权收件人：${setting.address}`:'先核对绑定的本人邮箱，再保存授权。'}</p>{proposal&&<button className="btn-secondary" disabled={disabled||busy} onClick={()=>void check()}>核对绑定邮箱</button>}<p className="field-note">保存即授权按此方式自动投递后续定稿，无需逐次确认。邮箱换绑后须重新核对并保存。</p></div>}
      {proposal&&<div className="automation-save"><button className="btn-primary" disabled={disabled||busy||proposal.mode==='mail'&&!binding} onClick={()=>void submit()}>{busy?'保存中…':proposal.mode==='mail'?'授权并保存邮箱交付':'保存交付方式'}</button><button className="text-button" disabled={busy} onClick={()=>{setProposal(null);setBinding(null);setError('');}}>取消</button></div>}
      {!proposal&&<p className="quiet-label">当前生效：{names[setting.effectiveMode]}{setting.address?` · ${setting.address}`:''}</p>}
      <p className="field-note">设置影响后续定稿，不批量补发历史任务；静默草稿只留在草稿箱。暂停、接管、改稿或撤销授权会阻止旧版排队投递。</p>
      {sendNow&&version&&<div className="automation-save"><button className="btn-secondary" disabled={disabled||busy||!!proposal||published||setting.effectiveMode==='none'} onClick={()=>void send()}>{published?'这版已记录投递状态':`立即投递 v${version}`}</button><span className="quiet-label">按当前方式发送；相同版本和目的地不重复投递。</span></div>}
      {!!receipts.length&&<div className="delivery-receipts">{receipts.slice(0,5).map(receipt=><div key={receipt.id} className="delivery-receipt"><div><strong>v{receipt.version} · {statuses[receipt.status]??receipt.status}</strong><span>{receipt.destination} · {formatTime(Date.parse(receipt.updatedAt),true)}</span></div>{receipt.detail&&<p>{receipt.detail}</p>}</div>)}</div>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
  </section>;
}
