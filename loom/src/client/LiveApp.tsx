import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoomSnapshot } from '../../../src/app/loom-types';
import { startLiveSync } from './live-sync';
import { api, message, needsYou } from './live/api';
import { WorkspaceContext, type LibraryView, type Page, type TaskView, type View, type Workspace } from './live/context';
import { Codex } from './live/Codex';
import { Delegations } from './live/Delegations';
import { DocSheet, MailSheet, TaskSheet, type MailResult } from './live/Details';
import { Inbox, Library, Overview, Settings, Tasks } from './live/Pages';
import { Alert } from './live/ui';
import './live/live.css';

const pages: { id: Page; label: string; title: string; note: string }[] = [
  { id: 'overview', label: '概览', title: '今天的工作', note: '飞书里的事，在这里看进展、做决定' },
  { id: 'tasks', label: '任务', title: '任务', note: '和飞书共用同一份任务与控制状态' },
  { id: 'library', label: '交付物', title: '交付物', note: '报告与草稿，带版本和来源' },
  { id: 'inbox', label: '消息', title: '消息', note: '收到的本人消息和处理决定' },
  { id: 'delegations', label: '委托', title: '委托与自主处理', note: '交代一次，在授权范围内持续关注' },
  { id: 'codex', label: 'Codex', title: 'Codex 历史', note: '按日期查看本机 Codex 对话' },
  { id: 'settings', label: '设置', title: '连接与交付', note: '复用本机飞书、模型与邮箱配置' },
];
/** Old hash names keep working for existing bookmarks. */
const legacy: Record<string, Page> = { drafts: 'library', deliverables: 'library', events: 'inbox', rules: 'delegations', connection: 'settings' };
const pageFromHash = (): Page => {
  const hash = location.hash.slice(1);
  return pages.some(p => p.id === hash) ? hash as Page : legacy[hash] ?? 'overview';
};
const staleNotice = '同步中断，正在显示上次的数据并自动重试';

type Theme = 'system' | 'light' | 'dark';
function readTheme(): Theme { try { const v = localStorage.getItem('loom-live-theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } }

export function LiveApp() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [data, setData] = useState<LoomSnapshot | null>(null), [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false), [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [delegation, setDelegation] = useState<string | null>(null);
  // `nav` changes on every navigation so the target page remounts with the requested tab or filter.
  const [nav, setNav] = useState<{ view?: View; key: number }>({ key: 0 });
  const [task, setTask] = useState<string | null>(null), [doc, setDoc] = useState<{ subject: string; version?: number } | null>(null);
  const [mail, setMail] = useState<MailResult | null>(null), [theme, setTheme] = useState<Theme>(readTheme);
  const sync = useRef<ReturnType<typeof startLiveSync<LoomSnapshot>> | null>(null), toastTimer = useRef<number>();

  useEffect(() => {
    const live = startLiveSync({
      load: signal => api<LoomSnapshot>('', 'GET', undefined, signal),
      value: value => { setData(value); setOnline(true); },
      error: () => setOnline(false),
    });
    sync.current = live;
    return () => { sync.current = null; live.stop(); };
  }, []);
  useEffect(() => {
    // Back/forward and manually edited hashes; in-app navigation uses pushState and never fires these twice.
    const change = () => { setPage(pageFromHash()); setDelegation(null); setNav(n => ({ key: n.key + 1 })); };
    window.addEventListener('popstate', change);
    window.addEventListener('hashchange', change);
    return () => { window.removeEventListener('popstate', change); window.removeEventListener('hashchange', change); };
  }, []);
  const navigate = useCallback((next: Page, options: { view?: View; delegation?: string } = {}) => {
    if (location.hash.slice(1) !== next) history.pushState(null, '', '#' + next);
    setPage(next); setDelegation(options.delegation ?? null); setNav(n => ({ view: options.view, key: n.key + 1 }));
    setTask(null); setDoc(null);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = theme;
    try { localStorage.setItem('loom-live-theme', theme === 'system' ? '' : theme); } catch { /* per-viewer convenience only */ }
  }, [theme]);
  // Close details whose task or report disappeared from the authorized snapshot.
  useEffect(() => {
    if (!data) return;
    if (task && !data.tasks.some(t => t.id === task)) setTask(null);
    if (doc && !data.artifacts.some(a => a.subject === doc.subject)) setDoc(null);
    if (mail?.proposal && !data.tasks.some(t => t.id === mail.proposal!.ticketId)) setMail(null);
  }, [data, task, doc, mail]);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error }); window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 8000 : 4000);
  }, []);
  const refresh = useCallback(async () => { await sync.current?.refresh(); }, []);

  const workspace = useMemo<Workspace | null>(() => data && {
    data, locked: busy || !online, refresh, notify,
    run: async work => {
      if (busy) return false;
      setBusy(true);
      try { const done = await work(); if (done) notify(done); return true; }
      catch (error) { notify(message(error), true); return false; }
      finally { setBusy(false); await refresh(); }
    },
    go: navigate,
    openTask: id => { setDoc(null); setTask(id); },
    openDoc: (subject, version) => { setTask(null); setDoc({ subject, version }); },
  }, [data, busy, online, refresh, notify, navigate]);

  const heading = pages.find(p => p.id === page)!;
  const attention = data ? data.tasks.filter(needsYou).length + data.drafts.filter(d => d.status === 'ready').length : 0;
  const nextTheme: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

  return <div className="lv-app">
    <header className="lv-top">
      <div className="lv-top-in">
        <button type="button" className="lv-brand" onClick={() => navigate('overview')}>Loom<i>.</i></button>
        <nav className="lv-nav" aria-label="主导航">{pages.map(p =>
          <button type="button" key={p.id} aria-current={page === p.id ? 'page' : undefined} onClick={() => navigate(p.id)}>
            {p.label}{p.id === 'overview' && attention > 0 && <b>{attention}</b>}
          </button>)}</nav>
        <span className={'lv-sync' + (online ? '' : ' is-off')} title={data ? '上次同步 ' + new Date(data.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}>
          <i />{online ? '已连接' : '连接中断'}</span>
        <button type="button" className="lv-icon-btn" aria-label={'外观：' + { system: '跟随系统', light: '浅色', dark: '深色' }[theme]} onClick={() => setTheme(nextTheme[theme])}>
          <svg viewBox="0 0 24 24" width="18" height="18">{theme === 'light' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
            : theme === 'dark' ? <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /> : <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" /></>}</svg>
        </button>
      </div>
    </header>
    <main className="lv-main" id="main">
      <div className="lv-head">
        <div><h1>{heading.title}</h1><p>{heading.note}</p></div>
        <button type="button" className="lv-btn" onClick={() => void refresh()}>刷新</button>
      </div>
      {!online && data && <Alert tone="error">{staleNotice}</Alert>}
      {data?.paused && <Alert>后台执行已全局暂停，查看结果不会启动任务</Alert>}
      {!workspace ? <div className="lv-loading">{online ? '正在读取工作空间…' : '正在连接本机助手…'}</div>
        : <WorkspaceContext.Provider value={workspace}>
          {page === 'overview' && <Overview />}
          {page === 'tasks' && <Tasks key={nav.key} view={nav.view as TaskView | undefined} delegation={delegation} clearDelegation={() => setDelegation(null)} />}
          {page === 'library' && <Library key={nav.key} view={nav.view as LibraryView | undefined} delegation={delegation} clearDelegation={() => setDelegation(null)} />}
          {page === 'inbox' && <Inbox />}
          {page === 'delegations' && <Delegations />}
          {page === 'codex' && <Codex />}
          {page === 'settings' && <Settings />}
          {task && (() => { const value = workspace.data.tasks.find(t => t.id === task); return value ? <TaskSheet task={value} onClose={() => setTask(null)} /> : null; })()}
          {doc && <DocSheet subject={doc.subject} version={doc.version} onClose={() => setDoc(null)} onMail={result => { setDoc(null); setMail(result); }} />}
          {mail && <MailSheet result={mail} onChange={setMail} onClose={() => setMail(null)} />}
        </WorkspaceContext.Provider>}
    </main>
    {toast && <div className={'lv-toast' + (toast.error ? ' is-error' : '')} role={toast.error ? 'alert' : 'status'}>
      <span>{toast.text}</span><button type="button" className="lv-link" onClick={() => setToast(null)}>关闭</button></div>}
  </div>;
}
