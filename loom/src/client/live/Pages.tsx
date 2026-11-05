import React, { useState } from 'react';
import type { LoomSnapshot, LoomTask } from '../../../../src/app/loom-types';
import { api, decisionName, draftName, enc, modeName, needsYou, taskState, when } from './api';
import { useWorkspace, type LibraryView, type TaskView } from './context';
import { Delivery } from './Delivery';
import { Empty, Facts, Panel, Pill } from './ui';

type Event = LoomSnapshot['events'][number];

function TaskRow({ task }: { task: LoomTask }) {
  const { data, openTask } = useWorkspace();
  const state = taskState(task, data.paused);
  return <button type="button" className="lv-row" onClick={() => openTask(task.id)}>
    <span className="lv-row-main"><strong>{task.title}</strong>{task.summary && <span>{task.summary}</span>}</span>
    <Pill tone={state.tone}>{state.label}</Pill>
    <time>{when(task.updatedAt)}</time>
  </button>;
}

function eventLabel(event: Event, linked: boolean) {
  if (event.system) return '委托回执';
  if (event.action) return `助手指令 · ${event.action}`;
  if (event.observed) return '仅观察 · 未执行';
  if (linked) return '已关联任务';
  if (event.processing === 'evaluating') return '正在评估';
  if (event.processing === 'queued') return '等待评估';
  return event.decision ? decisionName[event.decision] ?? event.decision : '已接收';
}

function EventRow({ event }: { event: Event }) {
  const { data, openTask } = useWorkspace();
  const linked = (event.taskIds ?? []).flatMap(id => data.tasks.find(task => task.id === id) ?? []);
  return <article className="lv-event">
    <header><strong>{event.direct ? '机器人私聊' : event.chat}</strong><Pill tone={linked.length ? 'run' : event.decision === 'accept' ? 'run' : 'off'}>{eventLabel(event, linked.length > 0)}</Pill><time>{when(event.at)}</time></header>
    <p>{event.text}</p>
    {linked.map(task => <button type="button" key={task.id} className="lv-chip-link" onClick={() => openTask(task.id)}>
      {task.title} · {taskState(task, data.paused).label}<span aria-hidden="true">→</span>
    </button>)}
  </article>;
}

export function Overview() {
  const { data, go, openDoc } = useWorkspace();
  const open = data.tasks.filter(t => t.status === 'open' && !t.completed);
  const attention = data.tasks.filter(needsYou);
  const drafts = data.drafts.filter(d => d.status === 'ready');
  const reports = data.artifacts.filter(a => a.kind === 'task');
  const stats: [string, number, () => void][] = [
    ['进行中', open.length, () => go('tasks', { view: 'active' })], ['需要你处理', attention.length, () => go('tasks', { view: 'attention' })],
    ['待看草稿', drafts.length, () => go('library', { view: 'drafts' })], ['已交付报告', reports.length, () => go('library', { view: 'reports' })],
  ];
  return <>
    <div className="lv-stats">{stats.map(([label, value, action]) =>
      <button type="button" key={label} onClick={action} className={label === '需要你处理' && value ? 'is-hot' : ''}><span>{label}</span><strong>{value}</strong></button>)}</div>
    <div className="lv-split">
      <div className="lv-stack">
        {(attention.length > 0 || drafts.length > 0) && <Panel title="需要你处理">
          <div className="lv-list">
            {attention.map(task => <TaskRow key={task.id} task={task} />)}
            {drafts.map(d => <button type="button" key={d.id} className="lv-row" onClick={() => openDoc(d.id)}>
              <span className="lv-row-main"><strong>{d.title}</strong><span>静默草稿，等你查看</span></span><Pill tone="accent">待查看</Pill><time>{when(d.at)}</time>
            </button>)}
          </div>
        </Panel>}
        <Panel title="最近任务" aside={<button type="button" className="lv-link" onClick={() => go('tasks')}>全部任务</button>}>
          {data.tasks.length ? <div className="lv-list">{[...data.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6).map(task => <TaskRow key={task.id} task={task} />)}</div>
            : <Empty title="还没有任务">在飞书里私聊机器人提一个明确的需求，任务会出现在这里。</Empty>}
        </Panel>
      </div>
      <div className="lv-stack">
        <Panel title="自主处理" aside={<button type="button" className="lv-link" onClick={() => go('delegations')}>调整</button>}>
          <div className="lv-mode"><Pill tone={data.mode === 'auto' ? 'run' : 'off'}>{modeName[data.mode]}</Pill>
            <span>{data.rules.filter(r => r.enabled).length} 条规则启用 · {data.delegations.filter(d => d.enabled).length} 条委托生效</span></div>
          <p className="lv-fine">{data.connection.chats.length ? `监听 ${data.connection.chats.map(c => c.name).join('、')}，` : '只处理私聊，'}只有你本人能触发任务</p>
        </Panel>
        <Panel title="最近消息" aside={<button type="button" className="lv-link" onClick={() => go('inbox')}>全部消息</button>}>
          {data.events.length ? <div className="lv-events">{data.events.slice(0, 5).map(event => <EventRow key={event.id} event={event} />)}</div>
            : <Empty title="还没有收到消息" />}
        </Panel>
      </div>
    </div>
  </>;
}

const taskFilters: Record<TaskView, string> = { all: '全部', active: '进行中', attention: '需要处理', done: '已完成' };

export function Tasks({ view = 'all', delegation, clearDelegation }: { view?: TaskView; delegation: string | null; clearDelegation: () => void }) {
  const { data } = useWorkspace();
  const [filter, setFilter] = useState<TaskView>(view), [query, setQuery] = useState('');
  const source = data.delegations.find(d => d.id === delegation);
  const tasks = [...data.tasks].sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(t => !delegation || t.ruleIds.includes(delegation))
    .filter(t => !query.trim() || (t.title + t.description).toLowerCase().includes(query.trim().toLowerCase()))
    .filter(t => filter === 'all' || (filter === 'active' && t.status === 'open' && !t.completed && !needsYou(t)) || (filter === 'attention' && needsYou(t)) || (filter === 'done' && (t.completed || t.status === 'ended')));
  return <Panel>
    <div className="lv-toolbar">
      <div className="lv-seg" role="tablist">{(Object.keys(taskFilters) as TaskView[]).map(key =>
        <button type="button" role="tab" key={key} aria-selected={filter === key} onClick={() => setFilter(key)}>{taskFilters[key]}</button>)}</div>
      <input className="lv-input lv-search" type="search" aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    {source && <p className="lv-filter">来自委托：{source.title} <button type="button" className="lv-link" onClick={clearDelegation}>显示全部</button></p>}
    {tasks.length ? <div className="lv-list">{tasks.map(task => <TaskRow key={task.id} task={task} />)}</div> : <Empty title="没有符合条件的任务" />}
  </Panel>;
}

export function Library({ view = 'reports', delegation, clearDelegation }: { view?: LibraryView; delegation: string | null; clearDelegation: () => void }) {
  const { data, locked, run, openDoc } = useWorkspace();
  const [tab, setTab] = useState<LibraryView>(view);
  const source = data.delegations.find(d => d.id === delegation);
  const reports = data.artifacts.filter(a => a.kind === 'task' && (!delegation || data.tasks.some(t => t.id === a.subject && t.ruleIds.includes(delegation))))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const discard = (id: string) => run(async () => (await api<{ message: string }>(`/drafts/${enc(id)}`, 'POST', { action: 'discard' })).message);
  return <Panel>
    <div className="lv-toolbar">
      <div className="lv-seg" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'reports'} onClick={() => setTab('reports')}>报告 {reports.length}</button>
        <button type="button" role="tab" aria-selected={tab === 'drafts'} onClick={() => setTab('drafts')}>草稿 {data.drafts.length}</button>
      </div>
    </div>
    {source && tab === 'reports' && <p className="lv-filter">来自委托：{source.title} <button type="button" className="lv-link" onClick={clearDelegation}>显示全部</button></p>}
    {tab === 'reports' ? (reports.length ? <div className="lv-list">{reports.map(a =>
      <button type="button" key={a.subject} className="lv-row" onClick={() => openDoc(a.subject)}>
        <span className="lv-row-main"><strong>{a.title}</strong><span>v{a.version} · {a.author === 'human' ? '本人编辑' : '助手生成'}{a.filename ? ` · ${a.filename}` : ''}</span></span>
        <time>{when(a.at)}</time>
      </button>)}</div> : <Empty title="还没有报告">任务完成后，报告和它的历史版本会保存在这里。</Empty>)
      : (data.drafts.length ? <div className="lv-list">{data.drafts.map(d => {
        const ready = data.artifacts.some(a => a.subject === d.id);
        return <div className="lv-row is-static" key={d.id}>
          <span className="lv-row-main"><strong>{d.title}</strong><span>{draftName[d.status] ?? d.status}</span></span>
          {ready ? <button type="button" className="lv-btn" onClick={() => openDoc(d.id)}>查看</button>
            : <button type="button" className="lv-btn" disabled={locked} onClick={() => void discard(d.id)}>{['queued', 'running'].includes(d.status) ? '取消起草' : '忽略'}</button>}
          <time>{when(d.at)}</time>
        </div>;
      })}</div> : <Empty title="没有草稿">观察模式下发现的总结类需求，会先在这里起草，等你确认。</Empty>)}
  </Panel>;
}

export function Inbox() {
  const { data, go } = useWorkspace();
  const [query, setQuery] = useState('');
  const events = data.events.filter(e => !query.trim() || e.text.toLowerCase().includes(query.trim().toLowerCase()));
  return <Panel note={<>当前自主处理：{modeName[data.mode]}。查看消息不会启动模型或任务。<button type="button" className="lv-link" onClick={() => go('delegations')}>调整</button></>}
    aside={<input className="lv-input lv-search" type="search" aria-label="搜索消息" placeholder="搜索消息" value={query} onChange={event => setQuery(event.target.value)} />}>
    {events.length ? <div className="lv-events">{events.map(event => <EventRow key={event.id} event={event} />)}</div> : <Empty title="没有消息" />}
  </Panel>;
}

export function Settings() {
  const { data, locked, run, refresh } = useWorkspace();
  const [mailbox, setMailbox] = useState('');
  const c = data.connection;
  return <div className="lv-split">
    <div className="lv-stack">
      <Panel title="产物交付" note="任务完成后，已保存的报告定稿按这里的方式交付">
        <Delivery setting={data.delivery} disabled={locked} save={async (mode, revision, mailboxKey) => {
          await api('/delivery', 'PUT', { mode, revision, ...(mailboxKey ? { mailboxKey } : {}) }); await refresh();
        }} />
      </Panel>
      <Panel title="最近飞书回执">
        {data.deliveries.length ? <ul className="lv-receipts">{data.deliveries.slice(0, 10).map(d =>
          <li key={d.id}><strong>{d.action}</strong><span>{d.status === 'sent' ? '已发送' : d.status} · {when(d.at)}</span></li>)}</ul> : <Empty title="暂无回执" />}
      </Panel>
    </div>
    <div className="lv-stack">
      <Panel title="连接" note="复用本机的飞书机器人、模型和邮箱配置，不在这里填写密钥">
        <Facts items={[['飞书机器人', c.name], ['App ID', <code key="id">{c.appId}</code>], ['执行模型', data.model], ['邮件服务', c.mailProvider === '163' ? '163 邮箱' : '飞书企业邮箱'],
          ['受控起草', c.draftsEnabled ? '已启用' : '未启用'], ['卡片按钮', c.cardsEnabled ? '已启用' : '未启用，文字入口可用']]} />
        <div className="lv-actions">
          <button type="button" className="lv-btn" disabled={locked} onClick={() => void run(async () => { setMailbox((await api<{ message: string }>('/mail/connection', 'POST', {})).message); })}>验证邮箱连接</button>
          {mailbox && <span className="lv-fine">{mailbox}</span>}
        </div>
      </Panel>
      <Panel title="监听范围与服务">
        <ul className="lv-receipts">
          <li><strong>机器人私聊</strong><span>本人消息</span></li>
          {c.chats.map(chat => <li key={chat.chatId}><strong>{chat.name}</strong><span>{chat.listen === 'all' ? '接收全部消息' : '仅处理 @ 机器人'}</span></li>)}
        </ul>
        <div className="lv-health">{c.health.map(h => <Pill key={h.id} tone={h.state === 'ready' ? 'done' : h.state === 'error' ? 'attn' : 'off'}>{h.id} · {h.state}</Pill>)}</div>
      </Panel>
    </div>
  </div>;
}
