import React, { useEffect, useRef, useState } from 'react';
import type { LoomCodexSessions, LoomDelegation, LoomSnapshot } from '../../../../src/app/loom-types';
import { api, enc, message, modeName, ruleName, when } from './api';
import { useWorkspace } from './context';
import { Empty, Panel, Pill, Sheet, Switch } from './ui';

type Mode = LoomSnapshot['mode'];
type Codex = NonNullable<LoomDelegation['codex']>;
interface Form {
  title: string; description?: string; codex?: Codex; codexConsent?: boolean; chatIds: string[]; keywords: string[];
  enabled: boolean; mode: 'auto' | 'observe'; revision: number; requestId?: string;
}
const runStatus: Record<string, string> = {
  queued: '等待读取', reading: '正在读取', started: '任务已创建', empty: '当天无记录', observed: '已观察 · 未执行', failed: '读取失败', cancelled: '授权变化，已取消',
};
const modeHint: Record<Mode, string> = {
  auto: '不用 @，目标、资料和交付物明确且符合规则时，自动创建任务',
  observe: '只记录候选需求，不自动接单；符合条件的纯文本总结会进草稿',
  off: '停止基础规则的主动发现；@、私聊和单独启用的委托照常处理',
};

/** Base-rule mode and switches. Each save carries its own revision so a stale page cannot overwrite newer settings. */
function Automation() {
  const { data, locked, run } = useWorkspace();
  const [pick, setPick] = useState<Mode | null>(null);
  const mode = pick ?? data.mode;
  return <Panel title="自主处理" note="识别到你的需求后，按启用的基础规则决定是否开工">
    <div className="lv-seg is-wide" role="radiogroup" aria-label="基础规则处理模式">
      {(['auto', 'observe', 'off'] as Mode[]).map(value =>
        <button type="button" role="radio" key={value} aria-checked={mode === value} disabled={locked} onClick={() => setPick(value === data.mode ? null : value)}>{modeName[value]}</button>)}
    </div>
    <p className="lv-fine">{modeHint[mode]}</p>
    {pick && <div className="lv-actions">
      <button type="button" className="lv-btn is-primary" disabled={locked} onClick={() => void run(async () => {
        const value = await api<{ message: string }>('/automation', 'PUT', { mode: pick, revision: data.automation.revision }); setPick(null); return value.message;
      })}>切换为{modeName[pick]}</button>
      <button type="button" className="lv-link" onClick={() => setPick(null)}>取消</button>
    </div>}
    <ul className="lv-rules">{data.rules.map(rule => <li key={rule.id}>
      <div><strong>{ruleName[rule.id] ?? rule.name}</strong><details><summary>适用范围</summary><p>{rule.text}</p></details></div>
      <Switch on={rule.enabled} label={(rule.enabled ? '停用' : '启用') + (ruleName[rule.id] ?? rule.name)} disabled={locked}
        onChange={() => void run(async () => (await api<{ message: string }>('/rules/' + enc(rule.id), 'PATCH', { enabled: !rule.enabled, revision: data.policyRevision })).message)} />
    </li>)}</ul>
    <p className="lv-fine">只影响之后的新消息，不重放历史；已开始的任务请在任务里暂停或接管。最多 {data.automation.maxWorkers} 个任务同时执行。</p>
    {data.paused && <p className="lv-note">后台处理已全局暂停，恢复后才会派发新任务。</p>}
  </Panel>;
}

function CodexFields({ value, change, consent, setConsent, disabled }: {
  value: Codex; change: (value: Codex) => void; consent: boolean; setConsent: (value: boolean) => void; disabled: boolean;
}) {
  const [options, setOptions] = useState<LoomCodexSessions | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [scope, setScope] = useState<'projects' | 'sessions'>(value.sessions.length ? 'sessions' : 'projects');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const load = async () => {
    const id = ++generation.current; setLoading(true); setError('');
    try { const result = await api<LoomCodexSessions>('/delegations/codex-options'); if (id === generation.current) setOptions(result); }
    catch (value) { if (id === generation.current) setError(message(value)); }
    finally { if (id === generation.current) setLoading(false); }
  };
  const choose = (id: string, on: boolean) => { const list = value[scope]; change({ ...value, [scope]: on ? [...list, id] : list.filter(item => item !== id) }); setConsent(false); };
  const projects = [...new Set([...(options?.sessions.map(s => s.cwd) ?? []), ...value.projects])].sort();
  return <>
    <p className="lv-note">读取所选范围当天的对话文字，由 Loom 当前模型汇总成日报，不启动 Codex 执行</p>
    <label className="lv-field"><span>资料范围</span>
      <select className="lv-input" value={scope} disabled={disabled} onChange={event => { setScope(event.target.value as typeof scope); change({ ...value, projects: [], sessions: [] }); setConsent(false); }}>
        <option value="projects">指定项目（含之后的新会话）</option><option value="sessions">指定会话</option>
      </select><small>项目路径精确匹配，最多 10 个项目或 20 个会话</small></label>
    <div className="lv-actions"><button type="button" className="lv-btn" disabled={disabled || loading} onClick={() => void load()}>{loading ? '读取中…' : '读取今天的会话列表'}</button>
      <span className="lv-fine">只读名称和路径，保存授权后才读正文</span></div>
    {error && <p className="lv-error" role="alert">{error}</p>}
    <fieldset className="lv-checks"><legend>{scope === 'projects' ? '选择项目' : '选择会话'}</legend>
      {scope === 'projects' ? projects.map(p => <label key={p} className="lv-check"><input type="checkbox" disabled={disabled} checked={value.projects.includes(p)} onChange={event => choose(p, event.target.checked)} /><code>{p}</code></label>)
        : <>{(options?.sessions ?? []).map(s => <label key={s.id} className="lv-check"><input type="checkbox" disabled={disabled} checked={value.sessions.includes(s.id)} onChange={event => choose(s.id, event.target.checked)} /><span>{s.title}<small>{s.cwd}</small></span></label>)}
          {value.sessions.filter(id => !options?.sessions.some(s => s.id === id)).map(id => <label key={id} className="lv-check"><input type="checkbox" checked disabled={disabled} onChange={() => choose(id, false)} /><span>{id}<small>已保存的会话</small></span></label>)}</>}
      {!options && !value[scope].length && <p className="lv-fine">先读取列表，再勾选范围</p>}
      {options && !options.sessions.length && <p className="lv-fine">今天没有本机会话</p>}
      {options?.truncated && <p className="lv-fine">列表已达扫描上限，部分会话未列出</p>}
    </fieldset>
    <div className="lv-grid2">
      <label className="lv-field"><span>每天运行（北京时间）</span><input className="lv-input" type="time" required disabled={disabled} value={value.time} onChange={event => change({ ...value, time: event.target.value })} /></label>
      <label className="lv-field"><span>日报交付</span>
        <select className="lv-input" disabled={disabled} value={value.delivery} onChange={event => { change({ ...value, delivery: event.target.value as Codex['delivery'] }); setConsent(false); }}>
          <option value="none">只留在 Loom</option><option value="feishu">发到机器人私聊</option><option value="default">沿用产物交付设置</option>
        </select></label>
    </div>
    <p className="lv-fine">电脑和助手需要保持运行；当天错过的时间恢复后补跑一次，更早的日期不补跑</p>
    <label className="lv-check is-consent"><input type="checkbox" required disabled={disabled} checked={consent} onChange={event => setConsent(event.target.checked)} />
      <span>授权每天读取所选范围的当天对话，用于生成日报<small>文字会交给当前模型，并作为来源快照保存在本机；内部推理、工具输出和附件正文会被过滤</small></span></label>
  </>;
}

function DelegationForm({ item, onClose }: { item?: LoomDelegation; onClose: () => void }) {
  const { data, locked, refresh, notify } = useWorkspace();
  const chats = data.connection.chats.filter(chat => chat.listen === 'all');
  const [form, setForm] = useState<Form>(() => ({
    title: item?.title ?? '', description: item?.description ?? '', ...(item?.codex ? { codex: item.codex } : {}),
    chatIds: item?.chatIds ?? chats.slice(0, 1).map(chat => chat.chatId), keywords: item?.keywords ?? [],
    enabled: item?.enabled ?? true, mode: item?.mode ?? 'auto', revision: data.policyRevision, ...(!item ? { requestId: crypto.randomUUID() } : {}),
  }));
  const [keywords, setKeywords] = useState(item?.keywords.join('，') ?? ''), [consent, setConsent] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const ready = form.title.trim() && (form.codex ? (form.codex.projects.length || form.codex.sessions.length) && consent : form.chatIds.length);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !ready) return;
    setBusy(true); setError('');
    const words = form.codex ? [] : [...new Set(keywords.split(/[,，、\n]/).map(word => word.trim()).filter(Boolean))];
    const body = { ...form, title: form.title.trim(), description: form.description?.trim() || undefined, keywords: words, ...(form.codex ? { codexConsent: consent } : {}) };
    try {
      await api('/delegations' + (item ? '/' + enc(item.id) : ''), item ? 'PUT' : 'POST', body);
      notify('委托已保存，之后匹配的新消息才会创建任务。');
      await refresh();
      onClose();
    } catch (value) { setError(message(value)); } finally { setBusy(false); }
  };
  const setKind = (codex: boolean) => {
    setConsent(false); setKeywords('');
    const { codex: _old, ...rest } = form;
    setForm(codex ? { ...rest, chatIds: [], keywords: [], codex: { projects: [], sessions: [], time: '18:00', timezone: 'Asia/Shanghai', delivery: 'none' } }
      : { ...rest, chatIds: chats.slice(0, 1).map(chat => chat.chatId), keywords: [] });
  };
  return <Sheet kind="dialog" title={item ? '编辑委托' : '新建委托'} onClose={() => { if (!busy) onClose(); }}
    actions={<><button type="button" className="lv-btn" disabled={busy} onClick={onClose}>取消</button><span className="lv-grow" />
      <button type="submit" form="lv-delegation" className="lv-btn is-primary" disabled={busy || locked || !ready}>{busy ? '保存中…' : '保存委托'}</button></>}>
    <form id="lv-delegation" className="lv-form" onSubmit={event => void submit(event)}>
      {!item && <div className="lv-seg is-wide" role="radiogroup" aria-label="委托类型">
        <button type="button" role="radio" aria-checked={!form.codex} onClick={() => setKind(false)}>飞书群消息</button>
        <button type="button" role="radio" aria-checked={!!form.codex} onClick={() => setKind(true)}>Codex 日报</button>
      </div>}
      <label className="lv-field"><span>名称</span><input className="lv-input" required maxLength={100} value={form.title} placeholder="例如：整理我的工作记录" onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label className="lv-field"><span>目标与边界</span><textarea className="lv-input" rows={3} maxLength={2000} value={form.description ?? ''} placeholder="何时介入、用哪些资料、交付什么" onChange={event => setForm({ ...form, description: event.target.value })} /><small>留空时用名称作为目标，不会因此扩大工具或资料权限</small></label>
      {form.codex ? <CodexFields value={form.codex} change={codex => setForm({ ...form, codex })} consent={consent} setConsent={setConsent} disabled={busy} /> : <>
        <fieldset className="lv-checks"><legend>关注的群</legend>
          {chats.length ? chats.map(chat => <label key={chat.chatId} className="lv-check"><input type="checkbox" checked={form.chatIds.includes(chat.chatId)}
            onChange={event => setForm({ ...form, chatIds: event.target.checked ? [...form.chatIds, chat.chatId] : form.chatIds.filter(id => id !== chat.chatId) })} /><span>{chat.name}</span></label>)
            : <p className="lv-fine">还没有接收全部消息的群，先在本机配置监听范围</p>}
        </fieldset>
        <label className="lv-field"><span>触发关键词（选填）</span><input className="lv-input" maxLength={500} value={keywords} placeholder="工作记录，日报" onChange={event => setKeywords(event.target.value)} /><small>出现任意一个就进入评估；留空则按目标判断</small></label>
      </>}
      <div className="lv-grid2">
        <label className="lv-field"><span>匹配后</span><select className="lv-input" value={form.mode} onChange={event => setForm({ ...form, mode: event.target.value as Form['mode'] })}>
          <option value="auto">自动执行</option><option value="observe">仅观察</option></select></label>
        <label className="lv-check is-pad"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /><span>保存后立即启用</span></label>
      </div>
      {error && <p className="lv-error" role="alert">{error}</p>}
    </form>
  </Sheet>;
}

export function Delegations() {
  const { data, locked, run, go } = useWorkspace();
  const [editing, setEditing] = useState<LoomDelegation | 'new' | null>(null);
  const toggle = (item: LoomDelegation) => run(async () => (await api<{ message: string }>('/delegations/' + enc(item.id), 'PATCH', { enabled: !item.enabled, revision: data.policyRevision })).message);
  const runNow = (item: LoomDelegation) => run(async () => (await api<{ message: string }>(`/delegations/${enc(item.id)}/run`, 'POST', { revision: data.policyRevision })).message);
  return <div className="lv-split is-wide-left">
    <Panel title={<>持续委托 <span className="lv-count">{data.delegations.length}</span></>} note="交代一次，之后匹配的新消息按你的授权推进"
      aside={<button type="button" className="lv-btn is-primary" disabled={locked} onClick={() => setEditing('new')}>新建委托</button>}>
      {data.delegations.length ? <div className="lv-cards">{data.delegations.map(item => {
        const last = item.runs?.[0];
        return <article key={item.id} className={'lv-card' + (item.enabled ? '' : ' is-off')}>
          <header>
            <div><strong>{item.title}</strong>
              <span>{!item.available ? '来源范围已变更，暂不可用' : !item.enabled ? '已暂停' : item.mode === 'auto' ? '匹配后自动执行' : '匹配后仅观察'}</span></div>
            <Switch on={item.enabled} label={(item.enabled ? '暂停' : '启用') + item.title} disabled={locked || (!item.available && !item.enabled)} onChange={() => void toggle(item)} />
          </header>
          {item.description && <p>{item.description}</p>}
          <div className="lv-tags">
            {item.codex ? <Pill>Codex 日报 · 每天 {item.codex.time}</Pill> : item.scopes.map(scope => <Pill key={scope.chatId}>{scope.name}</Pill>)}
            {!item.codex && item.keywords.length > 0 && <Pill>关键词 {item.keywords.join(' / ')}</Pill>}
          </div>
          {last && <p className="lv-fine">{last.date} · {runStatus[last.status] ?? last.status}{last.messages !== undefined ? ` · ${last.sessions} 个会话 / ${last.messages} 条消息` : ''}{last.detail ? ` · ${last.detail}` : ''}</p>}
          <footer>
            <button type="button" className="lv-link" onClick={() => go('tasks', { delegation: item.id })}>任务 {item.taskIds.length}</button>
            <button type="button" className="lv-link" onClick={() => go('library', { delegation: item.id })}>交付物</button>
            <span className="lv-grow" />
            {item.codex && <button type="button" className="lv-link" disabled={locked || !item.enabled || !item.available} onClick={() => void runNow(item)}>立即运行</button>}
            <button type="button" className="lv-link" disabled={locked} onClick={() => setEditing(item)}>编辑</button>
            <span className="lv-fine">{when(item.updatedAt)}</span>
          </footer>
        </article>;
      })}</div> : <Empty title="把常做的事交代一次" action={<button type="button" className="lv-btn is-primary" disabled={locked} onClick={() => setEditing('new')}>新建委托</button>}>
        比如：看到我发的工作记录时，整理今日进展和下一步</Empty>}
    </Panel>
    <Automation />
    {editing && <DelegationForm item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
  </div>;
}
