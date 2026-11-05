import React, { useEffect, useRef, useState } from 'react';
import type { LoomCodexAccess, LoomCodexMessages, LoomCodexSession, LoomCodexSessions } from '../../../../src/app/loom-types';
import { Markdown } from '../components/Markdown';
import { api, message } from './api';
import { Empty, Panel } from './ui';

const time = (at: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(at);

/** Read-only, day-scoped view of local Codex conversations. Viewing never resumes Codex. */
export function Codex() {
  const [access, setAccess] = useState<LoomCodexAccess | null>(null), [date, setDate] = useState('');
  const [list, setList] = useState<LoomCodexSessions | null>(null), [selected, setSelected] = useState<LoomCodexSession | null>(null);
  const [history, setHistory] = useState<LoomCodexMessages | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const op = useRef(0);
  const guard = async (work: (id: number) => Promise<void>) => {
    const id = ++op.current; setBusy(true); setError('');
    try { await work(id); } catch (value) { if (id === op.current) setError(message(value)); } finally { if (id === op.current) setBusy(false); }
  };
  const loadList = async (day: string, id: number) => { const value = await api<LoomCodexSessions>('/codex/sessions?date=' + day); if (id === op.current) setList(value); };
  const reset = () => { setList(null); setSelected(null); setHistory(null); };
  useEffect(() => {
    void guard(async id => {
      const value = await api<LoomCodexAccess>('/codex/access');
      if (id !== op.current) return;
      setAccess(value); setDate(value.date);
      if (value.enabled) await loadList(value.date, id);
    });
    return () => { op.current++; };
  }, []);
  const setEnabled = (enabled: boolean) => access && guard(async id => {
    reset();
    const value = await api<LoomCodexAccess>('/codex/access', 'PUT', { enabled, date: enabled ? date : access.date, revision: access.revision });
    if (id !== op.current) return;
    setAccess(value);
    if (enabled) await loadList(value.date, id);
  });
  const open = (session: LoomCodexSession, older = false) => access?.enabled && guard(async id => {
    setSelected(session); if (!older) setHistory(null);
    const cursor = older && history?.nextCursor ? '&cursor=' + encodeURIComponent(history.nextCursor) : '';
    const value = await api<LoomCodexMessages>(`/codex/sessions/${session.id}?date=${access.date}${cursor}`);
    if (id !== op.current) return;
    setHistory(previous => older && previous ? {
      ...value, skippedUndated: previous.skippedUndated + value.skippedUndated,
      messages: [...new Map([...value.messages, ...previous.messages].map(m => [m.id, m])).values()].sort((a, b) => a.at - b.at),
    } : value);
  });

  return <div className="lv-stack">
    <Panel title="本机 Codex 对话" note="按上海时区查看某一天的用户消息与助手回复，只读，不会唤醒 Codex">
      <div className="lv-inline">
        <input className="lv-input" type="date" aria-label="日期" value={date} disabled={busy || !access} onChange={event => setDate(event.target.value)} />
        <button type="button" className="lv-btn is-primary" disabled={busy || !access || !date} onClick={() => void setEnabled(true)}>
          {busy ? '读取中…' : access?.enabled && access.date === date ? '刷新会话' : '授权读取这一天'}</button>
        {access?.enabled && <button type="button" className="lv-link" onClick={() => void setEnabled(false)}>断开</button>}
      </div>
      <p className="lv-fine">{access?.enabled ? `当前授权 ${access.date} 全天。` : '首次使用需要确认读取日期。'}日报的读取授权在委托里单独设置；内部推理、工具输出和附件正文在本机过滤。</p>
      {error && <p className="lv-error" role="alert">{error}</p>}
    </Panel>
    {list && <div className="lv-split is-codex">
      <Panel title={<>会话 <span className="lv-count">{list.sessions.length}</span></>}>
        {list.sessions.length ? <div className="lv-list">{list.sessions.map(s =>
          <button type="button" key={s.id} className={'lv-row' + (selected?.id === s.id ? ' is-selected' : '')} disabled={busy} onClick={() => void open(s)}>
            <span className="lv-row-main"><strong>{s.title}</strong><span>{s.cwd}</span></span><time>{time(s.updatedAt)}</time>
          </button>)}</div> : <Empty title="这一天没有本机会话" />}
        {list.truncated && <p className="lv-fine">已达扫描上限，列表可能不完整</p>}
      </Panel>
      <Panel title={selected?.title ?? '对话'} note={selected?.cwd}>
        {!selected ? <Empty title="选择左侧的一段会话" /> : !history ? <p className="lv-muted">正在读取…</p> : <>
          {history.nextCursor && <button type="button" className="lv-btn" disabled={busy} onClick={() => void open(selected, true)}>加载更早的对话</button>}
          {!history.messages.length && <p className="lv-muted">这一页没有当天的正文</p>}
          {history.skippedUndated > 0 && <p className="lv-fine">{history.skippedUndated} 条正文缺少时间，未纳入</p>}
          <div className="lv-chat">{history.messages.map(m => <article key={m.id} className={'is-' + m.role}>
            <header><strong>{m.role === 'user' ? '你' : 'Codex'}{m.phase === 'commentary' ? ' · 过程说明' : ''}</strong><time>{time(m.at)}</time></header>
            <Markdown content={m.text} />
            {m.omittedAttachments && <p className="lv-fine">含附件，仅显示文字</p>}
            {m.truncated && <p className="lv-fine">超过 40000 字已截断</p>}
          </article>)}</div>
        </>}
      </Panel>
    </div>}
  </div>;
}
