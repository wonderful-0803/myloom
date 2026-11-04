import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LoomArtifact, LoomMail, LoomSnapshot, LoomTask, LoomProgress, LoomDeliverySetting, LoomResultReceipt } from '../../../src/app/loom-types';
import type { Artifact, Ticket } from '../shared/types';
import { AtelierFloor } from './components/AtelierFloor';
import { Gallery } from './components/Gallery';
import { Icon, LoomMark, type IconName } from './components/Icon';
import { Modal, EmptyState, formatTime, Status } from './components/UI';
import { Markdown } from './components/Markdown';
import { DelegationBoard, type DelegationForm } from './components/DelegationBoard';
import { AutomationPanel } from './components/AutomationPanel';
import { TaskProgressPanel } from './components/TaskProgressPanel';
import { DeliveryPanel } from './components/DeliveryPanel';
import { startLiveSync } from './live-sync';
import { CodexHistoryPanel } from './components/CodexHistoryPanel';
import type { LoomDelegation } from '../../../src/app/loom-types';
import './styles.css';
import './live.css';

type Page = 'overview' | 'tasks' | 'drafts' | 'deliverables' | 'events' | 'rules' | 'codex' | 'connection';
const pages: {id:Page; label:string; icon:IconName; subtitle:string}[] = [
  {id:'overview',label:'工作概览',icon:'overview',subtitle:'飞书里的工作，在这里接着推进。'},
  {id:'tasks',label:'任务',icon:'tasks',subtitle:'与飞书共用同一份任务、控制状态和处理记录。'},
  {id:'drafts',label:'草稿箱',icon:'file',subtitle:'安静地准备，等你查看；确认草稿不会自动发布。'},
  {id:'deliverables',label:'交付物',icon:'file',subtitle:'查看正文、来源和历史版本，继续编辑或取回文件。'},
  {id:'events',label:'事件收件箱',icon:'events',subtitle:'当前获授权的本人飞书消息与处理决定。'},
  {id:'rules',label:'持续委托',icon:'rules',subtitle:'把长期要做的事交代一次，让助手在指定范围内持续关注。'},
  {id:'codex',label:'Codex 历史',icon:'message',subtitle:'在本机查看你与 Codex 的对话，按日期打开原始消息。'},
  {id:'connection',label:'连接与设置',icon:'settings',subtitle:'复用本机飞书、模型和邮箱配置。'},
];
const controlName: Record<string,string> = {agent:'助手执行',pausing:'正在暂停',paused:'已暂停',taking_over:'正在移交',human:'本人已接管'};
const draftName: Record<string,string> = {ready:'待查看',confirmed:'已确认',queued:'排队中',running:'起草中',failed:'起草失败',interrupted:'已中断',budget:'已达预算上限'};
const mailName: Record<string,string> = {preview:'等待确认',cancelled:'已取消',submitted:'邮箱服务器已接收',delivered:'已送达',unknown:'结果待核查',sending:'正在提交',drafting:'正在准备',draft:'邮件草稿已创建',blocked:'提交受阻'};
const base = '/orchestrator/api/loom';
const syncError='工作状态同步未完成，当前显示上次同步数据；正在自动重试，也可点击刷新状态。';
async function api<T>(path='',method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(base+path,{method,signal,headers:{'x-orchestrator-request':'1',...(body!==undefined?{'content-type':'application/json'}:{})},
    ...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'请求未完成，请刷新后重试。');
  return data;
}
type VersionInfo = Pick<LoomArtifact,'version'|'author'|'hash'|'at'|'editedVia'>;
type ArtifactDetail = {artifact:LoomArtifact;versions:VersionInfo[]};
type MailResult = {message:string;proposal?:LoomMail};
function currentPage():Page{return pages.some(p=>p.id===location.hash.slice(1))?location.hash.slice(1) as Page:'overview';}

export function LiveApp(){
  const [page,setPage]=useState<Page>(currentPage),[snapshot,setSnapshot]=useState<LoomSnapshot|null>(null);
  const [online,setOnline]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState('');
  const [mobile,setMobile]=useState(false),[taskId,setTaskId]=useState<string|null>(null);
  const [detail,setDetail]=useState<ArtifactDetail|null>(null),[editor,setEditor]=useState<{subject:string;version:number;body:string}|null>(null);
  const [mail,setMail]=useState<MailResult|null>(null),[mailbox,setMailbox]=useState('');
  const [delegationFilter,setDelegationFilter]=useState<string|null>(null);
  const [taskDelivery,setTaskDelivery]=useState<{subject:string;setting:LoomDeliverySetting;receipts:LoomResultReceipt[]}|null>(null);
  const [reportFilename,setReportFilename]=useState('');
  const liveSync=useRef<ReturnType<typeof startLiveSync<LoomSnapshot>>|null>(null),artifactRequest=useRef(0);
  const readProgress=useCallback((id:string,signal?:AbortSignal)=>api<LoomProgress>(`/tasks/${encodeURIComponent(id)}/progress`,'GET',undefined,signal),[]);
  const refresh=useCallback(async()=>{await liveSync.current?.refresh();},[]);
  useEffect(()=>{
    const sync=startLiveSync({load:signal=>api<LoomSnapshot>('','GET',undefined,signal),value:value=>{setSnapshot(value);setOnline(true);setNotice(current=>current===syncError?'':current);},
      error:()=>{setOnline(false);setNotice(syncError);}});
    liveSync.current=sync;return()=>{liveSync.current=null;sync.stop();};
  },[]);
  useEffect(()=>{const change=()=>setPage(currentPage());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  useEffect(()=>{
    if(!snapshot)return;
    if(taskId&&!snapshot.tasks.some(t=>t.id===taskId))setTaskId(null);
    if(detail&&!snapshot.artifacts.some(a=>a.subject===detail.artifact.subject)){setDetail(null);setEditor(null);artifactRequest.current++;}
    if(mail?.proposal&&!snapshot.tasks.some(t=>t.id===mail.proposal!.ticketId))setMail(null);
  },[snapshot,taskId,detail,mail]);
  const deliverySubject=taskId??(detail?.artifact.kind==='task'?detail.artifact.subject:null);
  useEffect(()=>{if(!deliverySubject){setTaskDelivery(null);return;}let active=true;
    const load=()=>api<{setting:LoomDeliverySetting;receipts:LoomResultReceipt[]}>(`/tasks/${encodeURIComponent(deliverySubject)}/delivery`).then(value=>{if(active)setTaskDelivery({subject:deliverySubject,...value});}).catch(()=>{if(active)setTaskDelivery(null);});
    void load();const timer=setInterval(()=>{if(!document.hidden)void load();},3000);return()=>{active=false;clearInterval(timer);};
  },[deliverySubject]);
  const go=(id:Page)=>{setPage(id);location.hash=id;setMobile(false);void refresh();};
  const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setNotice('');try{await work();}catch(error){setNotice((error as Error).message);}finally{setBusy(false);await refresh();}};
  const openArtifact=async(subject:string,version?:number)=>{
    if(busy)return;
    const request=++artifactRequest.current;
    await run(async()=>{const value=await api<ArtifactDetail>(`/artifacts/${encodeURIComponent(subject)}${version?`?version=${version}`:''}`);
      if(request!==artifactRequest.current)return;setTaskId(null);setEditor(null);setDetail(value);setReportFilename('');});
  };
  const exportArtifact=async()=>{if(!detail)return;
    await run(async()=>{const value=await api<{filename:string;content:string}>(`/artifacts/${encodeURIComponent(detail.artifact.subject)}/export?version=${detail.artifact.version}`);
      const url=URL.createObjectURL(new Blob([value.content],{type:'text/plain;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download=value.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  };
  const control=async(action:'pause'|'resume'|'takeover'|'return',task:LoomTask)=>run(async()=>{
    await api(`/tasks/${task.id}/control`,'POST',{action,revision:task.control.revision});setNotice('已记录操作，请以当前控制状态为准。');
  });
  const saveEdit=async()=>{if(!editor)return;await run(async()=>{
    const value=await api<LoomArtifact>(`/artifacts/${editor.subject}`,'PUT',{version:editor.version,body:editor.body});
    const next=await api<ArtifactDetail>(`/artifacts/${value.subject}`);setDetail(next);setEditor(null);setNotice(`已保存 v${value.version}，旧版本保留。`);
  });};
  const draftChange=async(action:'confirm'|'discard')=>{if(!detail)return;await run(async()=>{
    const value=await api<{message:string}>(`/drafts/${detail.artifact.subject}`,'POST',{action,version:detail.artifact.version});
    setNotice(value.message);if(action==='discard'){setDetail(null);setEditor(null);}
  });};
  const previewMail=async(id:string)=>run(async()=>{
    const result=await api<MailResult>(`/tasks/${id}/mail`,'POST',{});setTaskId(null);setDetail(null);setEditor(null);setMail(result);
  });
  const changeMail=async(action:'confirm'|'cancel'|'status')=>{if(!mail?.proposal)return;await run(async()=>{
    setMail(await api<MailResult>(`/mail/${mail.proposal!.token}`,'POST',{action}));
  });};
  const registerReport=async()=>{if(!detail)return;await run(async()=>{
    const value=await api<LoomArtifact>(`/tasks/${detail.artifact.subject}/report-file`,'POST',{version:detail.artifact.version,filename:reportFilename});
    setDetail(await api<ArtifactDetail>(`/artifacts/${value.subject}`));setReportFilename('');setNotice('完整报告已登记为新版本；可按下方交付方式立即投递。');
  });};
  const data=snapshot;
  const search=query.trim().toLowerCase(),matches=(text:string)=>!search||text.toLowerCase().includes(search);
  const filteredDelegation=data?.delegations?.find(item=>item.id===delegationFilter);
  const activeFilter=(page==='tasks'||page==='deliverables')?delegationFilter:null;
  const tasks=(data?.tasks??[]).filter(t=>matches(t.title+' '+t.description)&&(!activeFilter||t.ruleIds?.includes(activeFilter)));
  const artifacts=(data?.artifacts??[]).filter(a=>a.kind==='task'&&matches(a.title+' '+a.body)&&(!activeFilter||data?.tasks.some(t=>t.id===a.subject&&t.ruleIds?.includes(activeFilter))));
  const drafts=(data?.drafts??[]).filter(d=>matches(d.title));
  const mappedTasks:Ticket[]=tasks.map(t=>({...t,mandateId:'personal'}));
  const mappedArtifacts:Artifact[]=artifacts.map(a=>({id:a.subject,ticketId:a.subject,type:'report',title:a.title,summary:`v${a.version} · ${a.author==='human'?'本人编辑':'助手生成'}`,content:a.body,createdAt:Date.parse(a.at)}));
  const selectedTask=data?.tasks.find(t=>t.id===taskId);
  const artifactTask=data?.tasks.find(t=>t.id===detail?.artifact.subject);
  const latest=data?.artifacts.find(a=>a.subject===detail?.artifact.subject);
  const readonly=busy||!online;
  const heading=pages.find(p=>p.id===page)!;
  const countOpen=data?.tasks.filter(t=>t.status==='open').length??0;
  const countBlocked=data?.tasks.filter(t=>t.status==='blocked'||t.control.mode==='human').length??0;
  const floor=(compact=false)=><AtelierFloor compact={compact} tickets={mappedTasks} artifacts={mappedArtifacts} routerLogs={[]} workerStates={[]} watchdogLogs={[]}
    onSelect={ticket=>{setDetail(null);setTaskId(ticket.id);}} onOpenArtifact={subject=>void openArtifact(subject)}/>;
  const gallery=(compact=false)=><Gallery compact={compact} artifacts={mappedArtifacts} tickets={mappedTasks} mandates={[]}
    onSelect={artifact=>void openArtifact(artifact.id)}/>;
  const showDelegation=(id:string,target:Page)=>{setDelegationFilter(id);setQuery('');go(target);};
  const saveDelegation=async(body:DelegationForm,id?:string)=>{
    setBusy(true);setNotice('');try{await api('/delegations'+(id?'/'+id:''),id?'PUT':'POST',body);setNotice('持续委托已保存，具体事件匹配后才会创建任务。');}
    finally{setBusy(false);await refresh();}
  };
  const toggleDelegation=async(item:LoomDelegation,revision:number)=>{
    setBusy(true);setNotice('');try{const result=await api<{message:string}>('/delegations/'+item.id,'PATCH',{enabled:!item.enabled,revision});setNotice(result.message);}
    finally{setBusy(false);await refresh();}
  };
  const board=(compact=false)=><DelegationBoard compact={compact} delegations={(data?.delegations??[]).filter(item=>matches(item.title+' '+item.description))} chats={data?.connection.chats??[]} revision={data?.policyRevision??0} disabled={readonly}
    request={api} runDaily={async(item,revision)=>{const result=await api<{message:string}>(`/delegations/${item.id}/run`,'POST',{revision});setNotice(result.message);await refresh();}} save={saveDelegation} toggle={toggleDelegation} showTasks={id=>showDelegation(id,'tasks')} showArtifacts={id=>showDelegation(id,'deliverables')}/>;
  const saveMode=async(mode:LoomSnapshot['mode'],revision:number)=>{
    setBusy(true);setNotice('');try{const result=await api<{message:string}>('/automation','PUT',{mode,revision});setNotice(result.message);}
    finally{setBusy(false);await refresh();}
  };
  const toggleRule=async(id:string,enabled:boolean,revision:number)=>{
    setBusy(true);setNotice('');try{const result=await api<{message:string}>('/rules/'+id,'PATCH',{enabled,revision});setNotice(result.message);}
    finally{setBusy(false);await refresh();}
  };
  const automation=(compact=false)=>data?<AutomationPanel data={data} compact={compact} disabled={readonly} saveMode={saveMode} toggleRule={toggleRule} showSettings={()=>go('rules')}/>:null;
  const checkDeliveryMailbox=()=>api<{address:string;key:string}>('/delivery/mailbox','POST',{});
  const deliveryPanel=(subject?:string,version?:number)=>{
    const value=subject?(taskDelivery?.subject===subject?taskDelivery:null):data?{setting:data.delivery,receipts:data.resultDeliveries}:null;
    return value?.setting?<DeliveryPanel key={subject??'default'} setting={value.setting} receipts={subject?value.receipts:[]} task={!!subject} version={version} disabled={readonly}
      mailbox={checkDeliveryMailbox} save={async(mode,revision,mailboxKey)=>{
        const input={mode,revision,...mailboxKey?{mailboxKey}:{}};
        if(subject){const next=await api<{setting:LoomDeliverySetting;receipts:LoomResultReceipt[]}>(`/tasks/${subject}/delivery`,'PUT',input);setTaskDelivery({subject,...next});}
        else await api<LoomDeliverySetting>('/delivery','PUT',input);
        await refresh();setNotice('交付方式已保存，历史任务不会自动补发。');
      }} sendNow={subject&&version?async()=>{const next=await api<{setting:LoomDeliverySetting;receipts:LoomResultReceipt[]}>(`/tasks/${subject}/delivery`,'POST',{version});setTaskDelivery({subject,...next});await refresh();setNotice('已记录投递请求，请查看下方实际状态。');}:undefined}/>:null;
  };
  const draftList=(compact=false)=><section className="section-surface"><div className="section-heading"><div><h2>草稿箱 <span className="count">{drafts.length}</span></h2><p>只在这里等待你查看，不自动发到群或邮箱。</p></div>{compact&&<button className="text-button" onClick={()=>go('drafts')}>查看全部<Icon name="arrow" size={14}/></button>}</div>
    {drafts.length===0?<EmptyState title="暂时没有草稿" icon="file">在授权群内发现适用需求后，草稿会出现在这里。</EmptyState>:<div className="deliverable-list">{(compact?drafts.slice(0,3):drafts).map(d=>{
      const value=data?.artifacts.find(a=>a.subject===d.id);
      return <div className="live-draft-item" key={d.id}><button type="button" className="deliverable-row" disabled={!value||readonly} onClick={()=>void openArtifact(d.id)}>
        <span className="document-icon brief"><Icon name="file" size={21}/></span><span className="deliverable-copy"><span className="deliverable-title">{d.title}</span><span className="deliverable-summary">{draftName[d.status]??d.status}{value?` · v${value.version} · ${value.author==='human'?'本人编辑':'助手生成'}`:''}</span><span className="deliverable-meta">{formatTime(Date.parse(d.at),true)}</span></span><Icon name="arrow" size={17}/>
      </button>{!value&&<button className="text-button live-draft-cancel" disabled={readonly} onClick={()=>void run(async()=>{
        const result=await api<{message:string}>(`/drafts/${d.id}`,'POST',{action:'discard'});setNotice(result.message);
      })}>{['queued','running'].includes(d.status)?'取消起草':'忽略'}</button>}</div>;
    })}</div>}</section>;
  return <div className="loom-app live-workspace">
    <a className="skip-link" href="#main-content">跳至主要内容</a>
    {mobile&&<button className="sidebar-backdrop" aria-label="关闭导航" onClick={()=>setMobile(false)}/>}
    <aside className={'sidebar '+(mobile?'is-open':'')} aria-label="主导航">
      <button className="brand" onClick={()=>go('overview')}><LoomMark/><span>Loom<span className="brand-period">.</span></span></button>
      <div className="workspace-label"><span className="workspace-monogram">L</span><div><strong>个人工作空间</strong><span>{data?'复用本机飞书助手':'正在核对连接'}</span></div></div>
      <span className="nav-caption">工作空间</span>
      <nav>{pages.filter(p=>p.id!=='connection').map(p=><button key={p.id} className={'nav-item '+(page===p.id?'is-active':'')} aria-current={page===p.id?'page':undefined} onClick={()=>go(p.id)}><Icon name={p.icon} size={18}/><span>{p.label}</span>{p.id==='drafts'&&!!drafts.length&&<span className="nav-count neutral">{drafts.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><button className={'nav-item '+(page==='connection'?'is-active':'')} onClick={()=>go('connection')}><Icon name="settings"/><span>连接与设置</span></button><div className="sidebar-foot"><span className={online?'is-connected':'is-disconnected'}><span className="status-dot"/>{online?'本机助手已连接':'助手连接中断'}</span><span>LIVE</span></div></div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-header"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={()=>setMobile(!mobile)}><Icon name="menu"/></button><div className="breadcrumbs"><span>工作空间</span><span className="breadcrumb-slash">/</span><strong>{heading.label}</strong></div><label className="workspace-search"><Icon name="search" size={16}/><input type="search" aria-label="搜索工作内容" placeholder="搜索工作内容…" value={query} onChange={e=>setQuery(e.target.value)}/></label><span className="user-avatar">L</span></header>
      <main id="main-content" className="page-content" tabIndex={-1}>
        <div className="page-heading"><div><span className="page-eyebrow">PERSONAL WORKSPACE</span><h1>{heading.label}</h1><p>{heading.subtitle}</p></div><div className="page-actions">{data&&<span className="quiet-label" role="status">{online?'已同步 '+new Date(data.at).toLocaleTimeString('zh-CN',{hour12:false}):'同步中断 · 显示上次数据'}</span>}<button className="btn-secondary" onClick={()=>void refresh()}>刷新状态</button><button className="btn-primary" onClick={()=>go('connection')}><Icon name="link" size={15}/>查看连接</button></div></div>
        {notice&&<div className="notice-banner" role="alert"><Icon name="alert" size={16}/><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>setNotice('')}><Icon name="close" size={15}/></button></div>}
        {!data?<EmptyState title={online?'正在读取工作空间':'正在连接本机助手'}>读取完成后将显示飞书中的真实任务和草稿。</EmptyState>:<>
          {filteredDelegation&&(page==='tasks'||page==='deliverables')&&<div className="notice-banner">来自持续委托：{filteredDelegation.title}<button className="text-button" onClick={()=>setDelegationFilter(null)}>显示全部</button></div>}
          {data.paused&&<div className="notice-banner">后台执行已全局暂停；查看已有结果不启动任务。</div>}
          {page==='overview'&&<>
            <div className="metric-strip">{[{label:'进行中',value:countOpen,detail:'保持原有任务会话'},{label:'需要处理',value:countBlocked,detail:'待查看或本人接管'},{label:'草稿箱',value:data.drafts.length,detail:'安静准备，按需查看'},{label:'已经交付',value:artifacts.length,detail:'版本与来源已保留'}].map(m=><div className="metric" key={m.label}><span className="metric-label">{m.label}</span><strong>{String(m.value).padStart(2,'0')}</strong><span className="metric-detail">{m.detail}</span></div>)}</div>
            <div className="overview-grid"><div className="overview-primary">{floor(true)}{gallery(true)}</div><div className="overview-secondary">{automation(true)}{board(true)}{draftList(true)}</div></div>
          </>}
          {page==='tasks'&&floor()}{page==='deliverables'&&<>{deliveryPanel()}{gallery()}</>}{page==='drafts'&&draftList()}
          {page==='events'&&<><div className="notice-banner">当前自主处理：{data.mode==='auto'?'自动执行':data.mode==='observe'?'仅观察':'基础规则发现已关闭'}。接单结果保留原记录，关联任务状态自动更新。<button className="text-button" onClick={()=>go('connection')}>切换模式</button></div><section className="section-surface"><div className="section-heading"><div><h2>最近收到的消息 <span className="count">{data.events.length}</span></h2><p>已接单的消息可直接打开任务查看实时进展；查询不启动模型或新任务。</p></div></div><div className="live-events">{data.events.filter(e=>matches(e.text)).map(e=>{
            const linked=(e.taskIds??[]).flatMap(id=>data.tasks.find(task=>task.id===id)??[]);
            const state=(task:LoomTask)=>task.control.mode!=='agent'?controlName[task.control.mode]:task.completed?'已完成':task.status==='blocked'?'需要处理':task.status==='ended'?'已结束':data.paused?'等待全局恢复':task.executionState==='queued'?'等待 Worker':task.executionState==='waiting'?'等待后续输入':'执行中';
            return <article key={e.id} className="live-event"><div><strong>{e.direct?'机器人私聊':e.chat}</strong><time>{formatTime(Date.parse(e.at),true)}</time></div><p>{e.text}</p><span className="small-label">{e.system?'委托配置回执':e.action?`助手指令 · ${e.action}`:e.observed?'当时仅观察 · 未执行':linked.length?'已关联任务':e.processing==='evaluating'?'正在评估需求':e.processing==='queued'?'等待评估':e.decision?({accept:'已接受',ignore:'已观察',unavailable:'评估未完成',stop:'停止'} as Record<string,string>)[e.decision]??e.decision:'已接收'}</span>
              {linked.map(task=><div className="event-task" key={task.id}><div><strong>{task.title}</strong><span className="small-label">{state(task)}</span></div><button className="text-button" type="button" onClick={()=>{setDetail(null);setTaskId(task.id);}}>查看实时进展<Icon name="chevron" size={14}/></button>{data.artifacts.some(a=>a.subject===task.id)&&<button className="text-button" type="button" disabled={busy} onClick={()=>void openArtifact(task.id)}>查看交付物</button>}</div>)}
            </article>;
          })}</div></section></>}
          {page==='rules'&&<>{automation()}{board()}</>}
          {page==='codex'&&<CodexHistoryPanel request={api}/>}
          {page==='connection'&&<>
            {automation()}
            {deliveryPanel()}
            <section className="section-surface"><div className="section-heading"><div><h2>当前连接</h2><p>使用现有长连接接收飞书事件，无需在 Loom 重新填写密钥。</p></div></div><dl className="detail-facts"><div><dt>飞书机器人</dt><dd>{data.connection.name}</dd></div><div><dt>App ID</dt><dd>{data.connection.appId}</dd></div><div><dt>执行模型</dt><dd>{data.model}</dd></div><div><dt>邮件服务</dt><dd>{data.connection.mailProvider==='163'?'163 邮箱':'飞书企业邮箱'}</dd></div><div><dt>受控起草</dt><dd>{data.connection.draftsEnabled?'已启用':'未启用'}</dd></div><div><dt>飞书卡片按钮</dt><dd>{data.connection.cardsEnabled?'已启用':'尚未启用，文字入口可用'}</dd></div></dl><button className="btn-secondary" disabled={readonly} onClick={()=>void run(async()=>setMailbox((await api<{message:string}>('/mail/connection','POST',{})).message))}>验证邮箱连接</button>{mailbox&&<p className="live-mailbox">{mailbox}</p>}</section>
            <section className="section-surface"><div className="section-heading"><div><h2>监听范围与服务状态</h2></div></div><div className="live-events">{data.connection.chats.map(chat=><article className="live-event" key={chat.chatId}><strong>{chat.name}</strong><p>{chat.listen==='all'?'接收已授权群消息':'仅处理提及机器人消息'}</p></article>)}<div className="live-health">{data.connection.health.map(h=><span className="small-label" key={h.id}>{h.id} · {h.state}</span>)}</div></div></section>
            <section className="section-surface"><div className="section-heading"><div><h2>最近飞书交互回执</h2></div></div><div className="live-events">{data.deliveries.slice(0,10).map(d=><div key={d.id} className="live-receipt"><span>{d.action}</span><span>{d.status==='sent'?'已发送':d.status}</span><time>{formatTime(Date.parse(d.at),true)}</time></div>)}</div></section>
          </>}
        </>}
      </main>
    </div>
    {selectedTask&&<Modal title="任务详情" className="task-modal" onClose={()=>setTaskId(null)} footer={<><span className="quiet-label">{controlName[selectedTask.control.mode]}</span><button className="btn-secondary" onClick={()=>setTaskId(null)}>关闭</button>{data?.artifacts.some(a=>a.subject===selectedTask.id)&&<button className="btn-primary" disabled={readonly} onClick={()=>void openArtifact(selectedTask.id)}>查看交付物</button>}</>}>
      {notice&&<div className="notice-banner" role="status">{notice}</div>}
      <div className="detail-title"><Status state={selectedTask.status}/><h3>{selectedTask.title}</h3>{selectedTask.description!==selectedTask.title&&<p>{selectedTask.description}</p>}</div><details className="technical-details"><summary>任务时间与控制信息</summary><dl className="detail-facts"><div><dt>控制状态</dt><dd>{controlName[selectedTask.control.mode]}</dd></div><div><dt>在途操作</dt><dd>{selectedTask.control.pending}</dd></div><div><dt>创建时间</dt><dd>{formatTime(selectedTask.createdAt,true)}</dd></div><div><dt>最近更新</dt><dd>{formatTime(selectedTask.updatedAt,true)}</dd></div></dl></details>
      <div className="live-controls">{selectedTask.control.mode==='agent'&&<><button className="btn-secondary" disabled={readonly} onClick={()=>void control('pause',selectedTask)}>暂停</button><button className="btn-secondary" disabled={readonly} onClick={()=>void control('takeover',selectedTask)}>接管</button></>}{selectedTask.control.mode==='paused'&&<button className="btn-primary" disabled={readonly} onClick={()=>void control('resume',selectedTask)}>继续</button>}{selectedTask.control.mode==='human'&&<button className="btn-primary" disabled={readonly} onClick={()=>void control('return',selectedTask)}>交还助手</button>}</div>
      <p className="field-note">接管只作用于这个任务。移交完成后可编辑已保存的报告；任务目录文件的直接编辑目前仍在本机进行。交还后助手从现有成果继续。</p>
      <TaskProgressPanel task={selectedTask} load={readProgress}/>
      {deliveryPanel(selectedTask.id,selectedTask.completed?data?.artifacts.find(a=>a.subject===selectedTask.id)?.version:undefined)}
      {selectedTask.summary&&<div className="note-block"><Icon name="file"/><div><strong>最近报告</strong><p>{selectedTask.summary}</p></div></div>}
    </Modal>}
    {detail&&<Modal title={editor?'编辑产物':'产物详情'} className="artifact-modal" onClose={()=>{artifactRequest.current++;setDetail(null);setEditor(null);}} footer={<>
      <span className="quiet-label">v{detail.artifact.version} · {detail.artifact.author==='human'?detail.artifact.editedVia==='loom'?'本人在 Loom 编辑':'本人编辑':'助手生成'}</span>
      {editor?<><button className="btn-secondary" disabled={readonly} onClick={()=>setEditor(null)}>取消编辑</button><button className="btn-primary" disabled={readonly||!editor.body.trim()} onClick={()=>void saveEdit()}>保存新版本</button></>:<>
        <button className="btn-secondary" disabled={readonly} onClick={()=>void exportArtifact()}><Icon name="download" size={15}/>导出 TXT</button>
        {detail.artifact.kind==='draft'&&<><button className="btn-secondary" disabled={readonly} onClick={()=>void draftChange('discard')}>忽略</button><button className="btn-secondary" disabled={readonly||latest?.version!==detail.artifact.version} onClick={()=>void draftChange('confirm')}>确认草稿</button></>}
        {(detail.artifact.kind==='draft'||artifactTask?.control.mode==='human'&&!artifactTask.control.pending)&&<button className="btn-primary" disabled={readonly||latest?.version!==detail.artifact.version} onClick={()=>setEditor({subject:detail.artifact.subject,version:detail.artifact.version,body:detail.artifact.body})}>编辑正文</button>}
        {artifactTask?.completed&&artifactTask.control.mode==='agent'&&latest?.version===detail.artifact.version&&<button className="btn-primary" disabled={readonly} onClick={()=>void previewMail(artifactTask.id)}>邮件预览</button>}
      </>}
    </>}>
      {notice&&<div className="notice-banner" role="status">{notice}</div>}
      <div className="document-heading"><div className="document-eyebrow">{detail.artifact.kind==='draft'?'静默草稿':'任务报告'} · v{detail.artifact.version}</div><h3>{detail.artifact.title}</h3><p className="document-summary">{detail.artifact.kind==='draft'?'仅保存在草稿箱，未发布到群或邮箱。':'查看产物不会暂停任务；编辑前请先接管。'}</p></div>
      {latest&&latest.version!==detail.artifact.version&&<div className="notice-banner">正在查看旧版 v{detail.artifact.version}，当前最新为 v{latest.version}。<button className="text-button" disabled={readonly} onClick={()=>void openArtifact(detail.artifact.subject)}>查看最新版</button></div>}
      {editor?<label className="live-editor">新版正文（保存后保留旧版）<textarea rows={14} maxLength={40000} value={editor.body} onChange={e=>setEditor({...editor,body:e.target.value})}/></label>:<Markdown content={detail.artifact.body}/>}
      {!editor&&artifactTask&&latest?.version===detail.artifact.version&&deliveryPanel(artifactTask.id,artifactTask.completed?detail.artifact.version:undefined)}
      {!editor&&artifactTask?.completed&&artifactTask.control.mode==='agent'&&detail.artifact.author==='agent'&&!detail.artifact.filename&&<details className="technical-details"><summary>补充任务目录里的完整报告</summary><p className="field-note">旧任务可能只保存了摘要。指定该任务已生成的报告文件，登记为新版本；不会重新执行或自动补发。</p><label className="field">报告文件名（相对于这个任务目录，支持 .md / .txt）<input value={reportFilename} maxLength={240} placeholder="例如：summary.md" onChange={event=>setReportFilename(event.target.value)}/></label><button className="btn-secondary" disabled={readonly||!reportFilename.trim()} onClick={()=>void registerReport()}>登记完整报告</button></details>}
      {!editor&&<details className="technical-details"><summary>来源与版本记录</summary><div className="live-provenance"><label>查看版本<select aria-label="产物历史版本" value={detail.artifact.version} disabled={readonly} onChange={e=>void openArtifact(detail.artifact.subject,Number(e.target.value))}>{detail.versions.map(v=><option value={v.version} key={v.version}>v{v.version} · {v.author==='human'?'本人编辑':'助手生成'} · {formatTime(Date.parse(v.at),true)}</option>)}</select></label><p>SHA256：<code>{detail.artifact.hash}</code></p>{detail.artifact.sources.map(s=><p key={s.triggerId}>消息 {s.triggerId}<br/><code>{s.hash}</code></p>)}</div></details>}
    </Modal>}
    {mail&&<Modal title="邮件预览与投递" className="artifact-modal" onClose={()=>setMail(null)} footer={<>
      <button className="btn-secondary" onClick={()=>setMail(null)}>关闭</button>{mail.proposal&&['preview','draft'].includes(mail.proposal.status)&&<><button className="btn-secondary" disabled={readonly} onClick={()=>void changeMail('cancel')}>取消发送</button><button className="btn-primary" disabled={readonly} onClick={()=>void changeMail('confirm')}>确认发送这版</button></>}{mail.proposal&&!['preview','cancelled'].includes(mail.proposal.status)&&<button className="btn-secondary" disabled={readonly} onClick={()=>void changeMail('status')}>查询投递状态</button>}
    </>}>
      {notice&&<div className="notice-banner" role="status">{notice}</div>}
      {mail.proposal?<><div className="document-heading"><div className="document-eyebrow">{mailName[mail.proposal.status]??mail.proposal.status}</div><h3>{mail.proposal.subject}</h3></div><dl className="detail-facts"><div><dt>收件人</dt><dd>{mail.proposal.to}</dd></div><div><dt>固定产物</dt><dd>v{mail.proposal.artifactVersion}</dd></div></dl><Markdown content={mail.proposal.body}/></>:null}<p className="live-mailbox">{mail.message}</p>
    </Modal>}
  </div>;
}
