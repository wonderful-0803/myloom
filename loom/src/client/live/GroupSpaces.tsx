import { requestId as newRequestId } from './request-id';
import React, { useEffect, useState } from 'react';
import { api, enc, message, modeName } from './api';
type Group = { spaceId: string; chatId: string; name: string; enabled: boolean; mode: 'observe' | 'auto' | 'off'; revision: number; state: string; canManage: boolean };
type Directory = { groups: Group[]; canManage: boolean; maxGroups: number; operator: string };
const enabled = () => document.querySelector('meta[name="loom-multiple-groups"]') !== null;
export function GroupSpaces() {
  const [directory, setDirectory] = useState<Directory | null>(null), [error, setError] = useState(''), [manage, setManage] = useState(false), [busy, setBusy] = useState(false);
  const [chats, setChats] = useState<{ chatId: string; name: string }[]>([]), [chat, setChat] = useState(''), [members, setMembers] = useState<{ id: string; name?: string }[] | null>(null), [masters, setMasters] = useState<string[]>([]), [mode, setMode] = useState<'observe' | 'auto'>('observe');
  const [requestId, setRequestId] = useState(() => newRequestId());
  const selected = new URLSearchParams(location.search).get('workspace');
  const refresh = async () => { const next = await api<Directory>('/workspaces'); setDirectory(next); return next; };
  const switchTo = (spaceId: string) => { const url = new URL(location.href); url.searchParams.set('workspace', spaceId); url.hash = 'overview'; location.assign(url.href); };
  useEffect(() => {
    if (!enabled()) return;
    const controller = new AbortController();
    void api<Directory>('/workspaces', 'GET', undefined, controller.signal).then(value => {
      setDirectory(value);
      if (!selected && value.groups[0]) { const url = new URL(location.href); url.searchParams.set('workspace', value.groups[0].spaceId); location.replace(url.href); }
    }).catch(value => { if (!controller.signal.aborted) setError(message(value)); });
    let polling = false;
    const timer = setInterval(() => {
      if (polling || document.hidden) return;
      polling = true;
      void api<Directory>('/workspaces', 'GET', undefined, controller.signal).then(setDirectory)
        .catch(value => { if (!controller.signal.aborted) setError(message(value)); }).finally(() => { polling = false; });
    }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  if (!enabled()) return null;
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (value) { setError(message(value)); } finally { setBusy(false); } };
  const current = directory?.groups.find(group => group.spaceId === selected);
  return <section className="lv-group-spaces" aria-label="群工作空间">
    <div className="lv-actions"><label className="lv-field"><span>当前工作群</span><select className="lv-input" aria-label="切换群工作空间" value={selected ?? ''} disabled={busy || !directory} onChange={event => switchTo(event.target.value)}>
      {!current && <option value="">选择有权访问的群</option>}{directory?.groups.map(group => <option key={group.spaceId} value={group.spaceId}>{group.name} · {group.enabled ? modeName[group.mode] : '监听已停用'}</option>)}
    </select></label>{directory?.canManage && <button className="lv-btn" type="button" onClick={() => setManage(value => !value)}>{manage ? '收起群管理' : '管理接入群'}</button>}</div>
    {manage && directory?.canManage && <div className="lv-panel">
      <h2>接入更多群</h2><p className="lv-fine">先把同一个机器人加入目标群，再在这里明确接入。每群单独设置主人、规则和上下文，结果回各自原线程。</p>
      <div className="lv-actions"><button type="button" className="lv-btn" disabled={busy} onClick={() => void act(async () => { setChats((await api<{ chats: typeof chats }>('/workspaces/chats')).chats); })}>读取机器人已加入的群</button></div>
      <label className="lv-field"><span>目标群</span><select className="lv-input" aria-label="目标群" value={chat} disabled={busy} onChange={event => { setChat(event.target.value); setMembers(null); setMasters([]); setRequestId(newRequestId()); }}><option value="">请选择群，或在下方输入群 ID</option>{chats.filter(group => !directory.groups.some(item => item.chatId === group.chatId)).map(group => <option key={group.chatId} value={group.chatId}>{group.name}</option>)}</select></label>
      <label className="lv-field"><span>群 ID</span><input className="lv-input" value={chat} disabled={busy} placeholder="oc_…" onChange={event => { setChat(event.target.value); setMembers(null); setMasters([]); setRequestId(newRequestId()); }} /></label>
      <button type="button" className="lv-btn" disabled={busy || !chat} onClick={() => void act(async () => { const value = await api<{ members: { id: string; name?: string }[] }>(`/workspaces/members?chatId=${enc(chat)}`); setMembers(value.members); setMasters([directory.operator]); })}>核验群并选择主人</button>
      {members && <fieldset className="lv-checks"><legend>允许发起和控制本群任务的人</legend>{members.map(person => <label className="lv-check" key={person.id}><input type="checkbox" checked={masters.includes(person.id)} disabled={busy || person.id === directory.operator} onChange={event => { setMasters(event.target.checked ? [...masters, person.id] : masters.filter(id => id !== person.id)); setRequestId(newRequestId()); }} /><span>{person.name || person.id}{person.id === directory.operator ? '（管理者，始终保留）' : ''}</span></label>)}</fieldset>}
      <label className="lv-field"><span>新群的自主处理方式</span><select className="lv-input" value={mode} disabled={busy} onChange={event => { setMode(event.target.value as 'observe' | 'auto'); setRequestId(newRequestId()); }}><option value="observe">仅观察</option><option value="auto">自动执行</option></select></label>
      <p className="lv-fine">接入前的群历史不会回填为新任务；已有群的主人、委托和报告不会复制到新群。所有群共享服务器执行容量。</p>
      <button type="button" className="lv-btn is-primary" disabled={busy || !members || !masters.length || directory.groups.length >= directory.maxGroups} onClick={() => void act(async () => { const result = await api<{ spaceId: string }>('/workspaces', 'POST', { chatId: chat, masters, mode, requestId }); await refresh(); switchTo(result.spaceId); })}>{busy ? '处理中…' : '确认接入这个群'}</button>
      <h3>已登记的群</h3>{directory.groups.map(group => <div className="lv-actions" key={group.spaceId}><span>{group.name} · {group.enabled ? modeName[group.mode] : '监听已停用'} · {({ ready: '监听就绪', starting: '正在连接', paused: '已停用', error: '需要检查' } as Record<string, string>)[group.state] ?? group.state}</span>
        {group.state === 'error' && <button className="lv-btn" disabled={busy} onClick={() => void act(async () => { await api(`/workspaces/${enc(group.spaceId)}/retry`, 'POST', {}); await refresh(); })}>重试接入</button>}
        <button className="lv-btn" disabled={busy || group.revision === 0} onClick={() => void act(async () => { await api(`/workspace/source?workspace=${enc(group.spaceId)}`, 'PUT', { enabled: !group.enabled, revision: group.revision }); await refresh(); })}>{group.enabled ? '停用本群监听' : '恢复本群监听'}</button>
      </div>)}<p className="lv-fine">停用会阻止后续资料读取并暂停任务；重新启用不会解除人工暂停。历史任务与产物保留。</p>
    </div>}
    {error && <p className="lv-error" role="alert">{error}</p>}
  </section>;
}
