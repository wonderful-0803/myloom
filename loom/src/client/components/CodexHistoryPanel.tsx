import React, { useEffect, useRef, useState } from 'react';
import type { LoomCodexAccess, LoomCodexMessages, LoomCodexSessions, LoomCodexSession } from '../../../../src/app/loom-types';
import { Markdown } from './Markdown';
import { EmptyState } from './UI';
import { Icon } from './Icon';

interface Props { request:<T>(path:string,method?:string,body?:unknown)=>Promise<T> }
const time=(at:number)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(at);
export function CodexHistoryPanel({request}:Props){
  const [access,setAccess]=useState<LoomCodexAccess|null>(null),[date,setDate]=useState('');
  const [list,setList]=useState<LoomCodexSessions|null>(null),[selected,setSelected]=useState<LoomCodexSession|null>(null),[history,setHistory]=useState<LoomCodexMessages|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const operation=useRef(0);
  const clear=()=>{setList(null);setSelected(null);setHistory(null);};
  const loadList=async(day:string,id:number)=>{
    const value=await request<LoomCodexSessions>('/codex/sessions?date='+day);
    if(id===operation.current)setList(value);
  };
  useEffect(()=>{const id=++operation.current;setBusy(true);
    void request<LoomCodexAccess>('/codex/access').then(async value=>{
      if(id!==operation.current)return;setAccess(value);setDate(value.date);
      if(value.enabled)await loadList(value.date,id);
    }).catch(error=>{if(id===operation.current)setError((error as Error).message);}).finally(()=>{if(id===operation.current)setBusy(false);});
    return()=>{operation.current++;};
  },[]);
  const enable=async()=>{
    if(!access||busy)return;const id=++operation.current;setBusy(true);setError('');clear();
    try{const value=await request<LoomCodexAccess>('/codex/access','PUT',{enabled:true,date,revision:access.revision});
      if(id!==operation.current)return;setAccess(value);await loadList(value.date,id);
    }catch(error){if(id===operation.current)setError((error as Error).message);}finally{if(id===operation.current)setBusy(false);}
  };
  const revoke=async()=>{
    if(!access)return;const id=++operation.current;setBusy(true);setError('');clear();
    try{const value=await request<LoomCodexAccess>('/codex/access','PUT',{enabled:false,date:access.date,revision:access.revision});if(id===operation.current)setAccess(value);}
    catch(error){if(id===operation.current)setError((error as Error).message);}finally{if(id===operation.current)setBusy(false);}
  };
  const open=async(session:LoomCodexSession,older=false)=>{
    if(!access?.enabled||busy)return;const id=++operation.current;setBusy(true);setError('');setSelected(session);if(!older)setHistory(null);
    try{const cursor=older&&history?.nextCursor?'&cursor='+encodeURIComponent(history.nextCursor):'';
      const value=await request<LoomCodexMessages>('/codex/sessions/'+session.id+'?date='+access.date+cursor);
      if(id!==operation.current)return;
      setHistory(previous=>older&&previous?{...value,skippedUndated:previous.skippedUndated+value.skippedUndated,
        messages:[...new Map([...value.messages,...previous.messages].map(message=>[message.id,message])).values()].sort((a,b)=>a.at-b.at)}:value);
    }catch(error){if(id===operation.current)setError((error as Error).message);}finally{if(id===operation.current)setBusy(false);}
  };
  return <div className="codex-history">
    <section className="section-surface"><div className="section-heading"><div><h2>本机 Codex 对话 <span className="small-label">只读连接</span></h2><p>查看指定日期的用户消息与助手回复，按上海时区筛选。</p></div></div>
      <div className="codex-access"><label className="field">读取日期<input aria-label="Codex 历史日期" type="date" value={date} disabled={busy||!access} onChange={event=>setDate(event.target.value)}/></label>
        <button className="btn-primary" disabled={busy||!access||!date} onClick={()=>void enable()}><Icon name="message" size={16}/>{busy?'读取中…':access?.enabled&&access.date===date?'刷新会话':'授权读取这一天'}</button>
        {access?.enabled&&<button className="text-button" onClick={()=>void revoke()}>断开历史读取</button>}
      </div>
      <p className="field-note">{access?.enabled?`当前授权：${access.date} 00:00–24:00（Asia/Shanghai）。`:'首次使用需确认读取日期。'}此页日期授权用于查看；日报读取需在持续委托中单独授权。内部推理、工具输出及附件正文在本机过滤，不返回页面。</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
    </section>
    {list&&<div className="codex-columns">
      <section className="section-surface codex-sessions"><div className="section-heading"><div><h2>相关会话 <span className="count">{list.sessions.length}</span></h2><p>{list.date} · 按更新时间筛选，打开后只显示所选日正文。</p></div></div>
        {!list.sessions.length?<EmptyState title="这一天没有本机会话" icon="message">这里只包含本机 Codex 已保存的历史。</EmptyState>:<div className="codex-session-list">{list.sessions.map(session=><button type="button" key={session.id} className={'codex-session '+(selected?.id===session.id?'is-selected':'')} disabled={busy} onClick={()=>void open(session)}>
          <strong>{session.title}</strong><span>{session.cwd}</span><small>{time(session.updatedAt)}{session.archived?' · 已归档':''}</small>
        </button>)}</div>}
        {list.truncated&&<p className="field-note">达到本次会话扫描上限，列表可能不完整。</p>}
      </section>
      <section className="section-surface codex-conversation" aria-label="Codex 对话内容">
        {!selected?<EmptyState title="选择一段会话" icon="message">打开后显示这一天的对话正文；查看不会唤醒 Codex 执行任务。</EmptyState>:<>
          <div className="section-heading"><div><h2>{selected.title}</h2><p>{selected.cwd}</p></div><span className="small-label">{list.date}</span></div>
          {busy&&!history?<p className="quiet-label" role="status">正在读取本机会话…</p>:history&&<>
            {history.nextCursor&&<button className="btn-secondary codex-load-older" disabled={busy} onClick={()=>void open(selected,true)}>{busy?'读取中…':'加载更早的当天对话'}</button>}
            {!history.messages.length&&<p className="quiet-label">这一页没有该日期的对话正文。{history.nextCursor?'可继续加载更早记录。':'会话活动时间也可能来自执行或元数据更新。'}</p>}
            {!!history.skippedUndated&&<p className="field-note">有 {history.skippedUndated} 条正文缺少原生时间，未纳入当天记录。</p>}
            {history.limited&&<p className="field-note">本次执行记录扫描已达上限，可继续分页读取。</p>}
            <div className="codex-messages">{history.messages.map(message=><article className={'codex-message '+message.role} key={message.id}>
              <header><strong>{message.role==='user'?'你':'Codex'}{message.phase==='commentary'?' · 过程说明':''}</strong><time dateTime={new Date(message.at).toISOString()}>{time(message.at)}</time></header>
              <Markdown content={message.text}/>
              {message.omittedAttachments&&<p className="field-note">此消息含附件或结构化输入，仅展示文字。</p>}
              {message.truncated&&<p className="field-note">长消息超过 40000 字符，当前已截断；完整内容请在 Codex 查看。</p>}
            </article>)}</div>
            <p className="field-note">已显示 {history.messages.length} 条正文。{history.nextCursor?'仍有更早记录可加载。':'已读到当天记录的起点。'}当前执行中的输出需重新打开会话刷新。</p>
          </>}
        </>}
      </section>
    </div>}
  </div>;
}
