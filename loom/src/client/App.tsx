import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Mandate, Trigger, Ticket, Artifact, RouterLog, WatchdogLog, WorkerState, EvalDecision, FeishuAck, DemoTimelineStep, FeishuSettingsPublic, WSEvent } from '../shared/types';
import { IntentBoard } from './components/IntentBoard';
import { WorldBus } from './components/WorldBus';
import { AtelierFloor } from './components/AtelierFloor';
import { Gallery } from './components/Gallery';
import { DemoModePanel } from './components/DemoModePanel';
import { Onboarding } from './components/Onboarding';
import { SettingsDrawer } from './components/SettingsDrawer';
import { DemoTimeline } from './components/DemoTimeline';
import { Icon, LoomMark, type IconName } from './components/Icon';
import { Modal, request, triggerText } from './components/UI';
import './styles.css';

type FeishuMeta = FeishuSettingsPublic & { webhookUrl?: string; webhookHint?: string };
type View = 'overview' | 'tasks' | 'events' | 'rules' | 'deliverables' | 'demo' | 'help';
const navigation: Array<{ id: View; label: string; icon: IconName }> = [
  { id: 'overview', label: '工作概览', icon: 'overview' },
  { id: 'tasks', label: '任务', icon: 'tasks' },
  { id: 'events', label: '事件收件箱', icon: 'events' },
  { id: 'deliverables', label: '交付物', icon: 'file' },
  { id: 'rules', label: '工作规则', icon: 'rules' },
];
const headings: Record<View, { title: string; subtitle: string }> = {
  overview: { title: '工作概览', subtitle: '掌握正在推进的工作，把注意力留给需要你的地方。' },
  tasks: { title: '任务', subtitle: '每件事独立推进，每一步都有记录。' },
  events: { title: '事件收件箱', subtitle: '来自工作环境的消息，在这里汇集。' },
  rules: { title: '工作规则', subtitle: '把需要反复交代的事，变成持续有效的规则。' },
  deliverables: { title: '交付物', subtitle: '查看已经完成的工作与验证结果。' },
  demo: { title: '演示实验室', subtitle: '从一条模拟消息开始，走完事件到交付的全过程。' },
  help: { title: '使用指南', subtitle: '关于这张工作台，你需要知道的几件事。' },
};
const viewFromHash = (): View => {
  const hash = window.location.hash.slice(1) as View;
  return Object.hasOwn(headings, hash) ? hash : 'overview';
};
const upsert = <T extends { id: string }>(items: T[], value: T, limit = 100) => [value, ...items.filter((item) => item.id !== value.id)].slice(0, limit);

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState('');
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [evalDecisions, setEvalDecisions] = useState<EvalDecision[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [routerLogs, setRouterLogs] = useState<RouterLog[]>([]);
  const [workerStates, setWorkerStates] = useState<WorkerState[]>([]);
  const [watchdogLogs, setWatchdogLogs] = useState<WatchdogLog[]>([]);
  const [feishuAcks, setFeishuAcks] = useState<FeishuAck[]>([]);
  const [timelineSteps, setTimelineSteps] = useState<DemoTimelineStep[]>([]);
  const [timelineConclusion, setTimelineConclusion] = useState<string | null>(null);
  const [primaryArtifactId, setPrimaryArtifactId] = useState<string | null>(null);
  const [primaryTicketId, setPrimaryTicketId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feishuMeta, setFeishuMeta] = useState<FeishuMeta | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoScene, setDemoScene] = useState<'A' | 'B'>('A');
  const [trialPhase, setTrialPhase] = useState<string | null>(null);
  const [focusArtifactId, setFocusArtifactId] = useState<string | null>(null);
  const [focusTicketId, setFocusTicketId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [confirmAction, setConfirmAction] = useState<'reset' | 'blocked' | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const go = useCallback((next: View) => { setView(next); window.location.hash = next; setMobileNav(false); setQuery(''); }, []);
  const refreshMeta = useCallback(() => {
    request<FeishuMeta>('/api/settings/feishu').then(setFeishuMeta).catch(() => { /* Reconnecting also refreshes settings. */ });
  }, []);
  useEffect(() => { refreshMeta(); }, [refreshMeta]);
  useEffect(() => {
    const hashChanged = () => { setView(viewFromHash()); setMobileNav(false); setQuery(''); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNav(false);
      if (event.key === '/' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement)?.isContentEditable)) { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('hashchange', hashChanged); window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('hashchange', hashChanged); window.removeEventListener('keydown', keydown); };
  }, []);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket((window.location.protocol === 'https:' ? 'wss' : 'ws') + '://' + window.location.host + '/ws');
      socket.onopen = () => { if (disposed) return; setConnected(true); retry = 0; refreshMeta(); };
      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const incoming = JSON.parse(String(event.data));
          if (incoming.type === 'init') {
            const data = incoming.data;
            setMandates(data.mandates || []); setTriggers(data.triggers || []);
            setTickets(data.tickets || []); setArtifacts(data.artifacts || []);
            setRouterLogs(data.routerLogs || []); setWatchdogLogs(data.watchdogLogs || []);
            setFeishuAcks(data.feishuAcks || []); setEvalDecisions(data.evalDecisions || []);
            setWorkerStates(data.workerStates || []);
            if (data.feishuSettings) setFeishuMeta((previous) => ({ ...previous, ...data.feishuSettings }));
            const timeline = data.demoTimeline;
            setTimelineSteps(timeline?.steps || []); setTimelineConclusion(timeline?.conclusion || null);
            setPrimaryArtifactId(timeline?.primaryArtifactId || null); setPrimaryTicketId(timeline?.primaryTicketId || null);
            setDemoRunning(Boolean(data.demoLock));
            if (data.demoScene === 'A' || data.demoScene === 'B') setDemoScene(data.demoScene);
            return;
          }
          const message = incoming as WSEvent;
          switch (message.type) {
            case 'mandate_added': case 'mandate_updated': setMandates((previous) => upsert(previous, message.data)); break;
            case 'trigger_created': setTriggers((previous) => upsert(previous, message.data, 100)); break;
            case 'eval_decision': setEvalDecisions((previous) => upsert(previous, message.data, 200)); break;
            case 'ticket_created': case 'ticket_updated': setTickets((previous) => upsert(previous, message.data)); break;
            case 'artifact_created': setArtifacts((previous) => upsert(previous, message.data)); break;
            case 'router_log': setRouterLogs((previous) => upsert(previous, message.data)); break;
            case 'worker_state': setWorkerStates((previous) => upsert(previous, message.data)); break;
            case 'watchdog_log': setWatchdogLogs((previous) => upsert(previous, message.data, 50)); break;
            case 'feishu_ack': setFeishuAcks((previous) => upsert(previous, message.data, 50)); break;
            case 'demo_timeline':
              setTimelineSteps(message.data.steps || []);
              if (message.data.conclusion !== undefined) setTimelineConclusion(message.data.conclusion || null);
              if (message.data.primaryArtifactId) setPrimaryArtifactId(message.data.primaryArtifactId);
              if (message.data.primaryTicketId) setPrimaryTicketId(message.data.primaryTicketId);
              break;
            case 'demo_complete':
              setPrimaryArtifactId(message.data.primaryArtifactId);
              setTimelineConclusion(message.data.conclusion); setDemoScene(message.data.scene);
              setTrialPhase('演示已完成'); break;
            case 'demo_lock':
              setDemoRunning(message.data.locked);
              if (message.data.scene) setDemoScene(message.data.scene);
              break;
            case 'demo_reset':
              setTriggers([]); setTickets([]); setArtifacts([]); setRouterLogs([]); setWatchdogLogs([]);
              setWorkerStates([]); setEvalDecisions([]); setFeishuAcks([]); setTimelineSteps([]);
              setTimelineConclusion(null); setPrimaryArtifactId(null); setPrimaryTicketId(null);
              setFocusArtifactId(null); setFocusTicketId(null); setTrialPhase(null); break;
          }
        } catch (error) { console.error('Unable to read workspace update', error); }
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        reconnectTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { disposed = true; clearTimeout(reconnectTimer); socket?.close(); };
  }, [refreshMeta]);

  const runDemo = useCallback(async (scene: 'A' | 'B') => {
    setNotice(''); setDemoRunning(true); setDemoScene(scene); setTrialPhase('正在接收模拟事件');
    setTimelineConclusion(null);
    try { await request('/api/demo/feishu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true, scene }) }); }
    catch (error) { setDemoRunning(false); setTrialPhase(null); setNotice((error as Error).message); }
  }, []);
  const resetDemo = async () => {
    setNotice('');
    try { await request('/api/demo/reset', { method: 'POST' }); setDemoRunning(false); setTrialPhase(null); }
    catch (error) { setNotice((error as Error).message); }
  };
  const runBlockedDemo = async () => {
    setNotice(''); setDemoRunning(true); setTrialPhase('正在验证阻塞路径');
    try { await request('/api/demo/blocked', { method: 'POST' }); }
    catch (error) { setDemoRunning(false); setNotice((error as Error).message); }
  };
  const exportAudit = async (format: 'json' | 'md') => {
    try {
      const response = await fetch('/api/demo/audit?format=' + format);
      if (!response.ok) throw new Error('导出失败，请先运行演示。');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const filename = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'loom-record.' + format;
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setNotice((error as Error).message); }
  };
  const openArtifact = useCallback((id: string) => { go('deliverables'); setFocusArtifactId(id); }, [go]);
  const artifactFocused = useCallback(() => setFocusArtifactId(null), []);
  const jump = (pane: DemoTimelineStep['pane'], refId?: string) => {
    if (pane === 'gallery') { go('deliverables'); if (refId || primaryArtifactId) openArtifact(refId || primaryArtifactId!); }
    else if (pane === 'atelier') { go('tasks'); setFocusTicketId(refId || primaryTicketId); }
    else go(pane === 'world' ? 'events' : 'rules');
  };

  const search = query.trim().toLowerCase();
  const matches = (text: string) => !search || text.toLowerCase().includes(search);
  const filteredTickets = tickets.filter((item) => matches(item.title + ' ' + item.description));
  const filteredArtifacts = artifacts.filter((item) => matches(item.title + ' ' + item.summary));
  const filteredMandates = mandates.filter((item) => matches(item.title + ' ' + item.description));
  const filteredTriggers = triggers.filter((item) => matches(triggerText(item.payload)));
  const openCount = tickets.filter((item) => item.status === 'open').length;
  const blockedCount = tickets.filter((item) => item.status === 'blocked').length;
  const activeRules = mandates.filter((item) => item.active).length;
  const configured = Boolean(feishuMeta?.configured);
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const floor = (compact = false) => <AtelierFloor compact={compact} routerLogs={routerLogs} workerStates={workerStates} watchdogLogs={watchdogLogs} tickets={filteredTickets} artifacts={artifacts} focusTicketId={focusTicketId} primaryTicketId={primaryTicketId} onOpenArtifact={openArtifact} />;
  const gallery = (compact = false) => <Gallery compact={compact} artifacts={filteredArtifacts} tickets={tickets} mandates={mandates} focusArtifactId={focusArtifactId} primaryArtifactId={primaryArtifactId} onFocused={artifactFocused} />;
  const events = (compact = false) => <WorldBus compact={compact} triggers={filteredTriggers} evalDecisions={evalDecisions} feishuAcks={feishuAcks} feishuConfigured={configured} />;

  return <div className="loom-app">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳至主要内容</a>
    {mobileNav && <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <aside className={'sidebar ' + (mobileNav ? 'is-open' : '')} aria-label="主导航">
      <button type="button" className="brand" onClick={() => go('overview')} aria-label="Loom 工作概览"><LoomMark /><span>Loom<span className="brand-period">.</span></span></button>
      <div className="workspace-label"><span className="workspace-monogram">L</span><div><strong>本地工作空间</strong><span>个人工作台</span></div></div>
      <span className="nav-caption">工作空间</span>
      <nav>{navigation.map((item) => <button type="button" key={item.id} className={'nav-item ' + (view === item.id ? 'is-active' : '')} onClick={() => go(item.id)} aria-current={view === item.id ? 'page' : undefined}><Icon name={item.icon} size={18} /><span>{item.label}</span>{item.id === 'tasks' && blockedCount > 0 && <span className="nav-count">{blockedCount}</span>}{item.id === 'deliverables' && artifacts.length > 0 && <span className="nav-count neutral">{artifacts.length}</span>}</button>)}</nav>
      <div className="nav-secondary"><span className="nav-caption">工具</span><button type="button" className={'nav-item ' + (view === 'demo' ? 'is-active' : '')} onClick={() => go('demo')} aria-current={view === 'demo' ? 'page' : undefined}><Icon name="code" /><span>演示实验室</span><span className="nav-lab">LAB</span></button></div>
      <div className="sidebar-bottom"><button type="button" className={'nav-item ' + (view === 'help' ? 'is-active' : '')} onClick={() => go('help')}><Icon name="help" /><span>使用指南</span></button><button type="button" className="nav-item" onClick={() => setSettingsOpen(true)}><Icon name="settings" /><span>连接与设置</span></button><div className="sidebar-foot"><span className={connected ? 'is-connected' : 'is-disconnected'}><span className="status-dot" />{connected ? '本地服务已连接' : '正在连接服务'}</span><span>R10</span></div></div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-header"><button type="button" className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={mobileNav} onClick={() => setMobileNav(!mobileNav)}><Icon name="menu" /></button><div className="breadcrumbs"><span>工作空间</span><span className="breadcrumb-slash">/</span><strong>{headings[view].title}</strong></div><label className="workspace-search"><Icon name="search" size={16} /><input ref={searchRef} type="search" aria-label="搜索任务、事件或交付物" placeholder="搜索工作内容…" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></label><span className="user-avatar" title="本地工作空间">L</span></header>
      <main id="main-content" className="page-content" tabIndex={-1}>
        <div className="page-heading"><div><span className="page-eyebrow">{view === 'overview' ? date : 'LOOM WORKSPACE'}</span><h1>{headings[view].title}</h1><p>{headings[view].subtitle}</p></div><div className="page-actions">{view !== 'demo' && <button type="button" className="btn-primary" id="primary-cta" disabled={demoRunning || !connected} onClick={() => runDemo('A')}><Icon name="play" size={15} />{demoRunning ? '演示运行中…' : '运行演示'}</button>}<button type="button" className="btn-secondary connect-button" onClick={() => setSettingsOpen(true)}><Icon name="link" size={15} />{configured ? '连接设置' : '连接飞书'}</button></div></div>
        {notice && <div className="notice-banner" role="alert"><Icon name="alert" size={16} /><span>{notice}</span><button type="button" className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示"><Icon name="close" size={15} /></button></div>}
        <DemoTimeline steps={timelineSteps} visible={timelineSteps.length > 0} conclusion={timelineConclusion} scene={demoScene} onJump={jump} onExportAudit={exportAudit} progressHint={trialPhase} />
        {view === 'overview' && <>
          <div className="metric-strip" aria-label="工作状态概览">{[
            { label: '进行中', value: openCount, detail: '任务独立推进', icon: 'clock' as const },
            { label: '需要处理', value: blockedCount, detail: blockedCount ? '有事项等待你查看' : '暂时没有阻塞事项', icon: 'alert' as const },
            { label: '已经交付', value: artifacts.length, detail: '结果与记录已保留', icon: 'file' as const },
            { label: '生效规则', value: activeRules, detail: '持续观察工作事件', icon: 'rules' as const },
          ].map((metric) => <div className="metric" key={metric.label}><span className="metric-label"><Icon name={metric.icon} size={15} />{metric.label}</span><strong className={metric.label === '需要处理' && blockedCount ? 'needs-attention' : ''}>{String(metric.value).padStart(2, '0')}</strong><span className="metric-detail">{metric.detail}</span></div>)}</div>
          <div className="overview-grid"><div className="overview-primary"><div data-tour="atelier">{floor(true)}</div><div data-tour="gallery">{gallery(true)}</div><div className="overview-footer"><span className="status-dot" /><p>{blockedCount ? blockedCount + ' 个任务需要进一步查看。' : '工作有条不紊，无需一直守在这里。'}</p><button type="button" className="text-button" onClick={() => go('tasks')}>查看全部任务<Icon name="arrow" size={14} /></button></div></div><div className="overview-secondary"><section className="workspace-note"><div className="note-eyebrow"><span className="status-dot" />{configured ? '飞书已配置' : '本地演示模式'}</div><h2>让工作自然衔接。</h2><p>{configured ? '工作事件进入收件箱，处理结果留在任务与交付物中。' : '先用模拟事件试一次。看清处理过程，再连接你的真实工作环境。'}</p><button type="button" className="text-button" onClick={() => configured ? setSettingsOpen(true) : go('demo')}>{configured ? '查看连接' : '了解演示场景'}<Icon name="arrow" size={14} /></button><span className="note-number" aria-hidden="true">L/01</span></section><div data-tour="world">{events(true)}</div><div data-tour="intent"><IntentBoard compact mandates={filteredMandates} /></div></div></div>
        </>}
        {view === 'tasks' && <div data-tour="atelier">{floor()}</div>}
        {view === 'events' && <div data-tour="world">{events()}</div>}
        {view === 'rules' && <div data-tour="intent"><IntentBoard mandates={filteredMandates} /></div>}
        {view === 'deliverables' && <div data-tour="gallery">{gallery()}</div>}
        {view === 'demo' && <DemoModePanel onRunFeishuDemo={runDemo} onRunBlockedDemo={async () => setConfirmAction('blocked')} onReset={async () => setConfirmAction('reset')} demoRunning={demoRunning} demoScene={demoScene} onExportAudit={exportAudit} />}
        {view === 'help' && <div className="help-layout"><section className="help-editorial"><span className="help-index">01 — 工作方式</span><h2>交代一次，<br />持续向前。</h2><p>Loom 将工作规则、环境事件和独立任务连接起来。你可以按需查看进展，在结果就绪后阅读交付物。</p><button type="button" className="btn-primary" onClick={() => setOnboardingOpen(true)}>快速上手<Icon name="arrow" size={15} /></button></section><section className="section-surface help-questions">{[
          ['从哪里开始？', '点击「运行演示」，模拟飞书报障会创建任务、修改示例文件、运行真实测试并生成补丁说明。'],
          ['日常需要关注什么？', '工作概览会展示进行中任务、需要处理的事项以及最近交付。完整输入与回执可以在事件收件箱中查看。'],
          ['可以处理任意项目吗？', '当前版本是流程演示。执行器通过预设规则处理示例目录，简报由模板生成；通用模型执行与生产授权仍需完善。'],
          ['如何连接飞书？', '打开「连接与设置」，填写应用凭证，再按接入检查配置事件订阅、可访问地址和机器人。'],
          ['数据保存在什么地方？', '任务、规则和结果保存在运行服务的本地数据库中。交付物可以下载为 Markdown，演示记录支持 JSON 导出。'],
        ].map(([title, text]) => <details key={title}><summary>{title}<Icon name="plus" size={16} /></summary><p>{text}</p></details>)}</section></div>}
        <footer className="page-footer"><span>Loom · 织机</span><span>{configured ? '飞书连接已配置' : '本地演示'}<span className="separator">/</span>规则执行器</span></footer>
      </main>
    </div>
    <Onboarding open={onboardingOpen} onClose={() => setOnboardingOpen(false)} onStartTrial={() => runDemo('A')} onOpenConnect={() => setSettingsOpen(true)} />
    <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} initial={feishuMeta} onSaved={(settings) => { setFeishuMeta(settings); refreshMeta(); }} />
    {confirmAction && <Modal title={confirmAction === 'reset' ? '重置本地演示？' : '运行阻塞路径？'} onClose={() => setConfirmAction(null)} footer={<><button type="button" className="btn-secondary" onClick={() => setConfirmAction(null)}>取消</button><button type="button" className="btn-primary" onClick={() => { const action = confirmAction; setConfirmAction(null); if (action === 'reset') void resetDemo(); else void runBlockedDemo(); }}>{confirmAction === 'reset' ? '重置演示' : '运行测试'}</button></>}><p className="form-intro">这会清空本轮演示任务与交付物，并还原示例文件。工作规则与连接配置会保留。</p></Modal>}
  </div>;
}
