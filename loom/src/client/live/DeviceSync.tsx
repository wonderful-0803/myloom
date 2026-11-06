import React, { useEffect, useId, useRef, useState } from 'react';
import type { DeviceSync as Connector } from '../../../../src/sync/client';
import type { FeishuSync } from '../../../../src/sync/feishu';
import type { Device, Project, Revision, SyncNote } from '../../../../src/sync/model';
import { Markdown } from '../components/Markdown';
import { api, message, when } from './api';
import { Alert, Empty, Panel, Pill } from './ui';
type Status = ReturnType<Connector['status']> & { account?: Awaited<ReturnType<FeishuSync['status']>>['account'] };
type ProjectView = { project: Project; sessions: (Omit<Revision, 'messages'> & { messages: number })[]; notes: SyncNote[] };

/** Feishu is the default cloud transport; the advanced self-hosted connector remains explicitly unverified. */
export function DeviceSync() {
  const [advanced, setAdvanced] = useState(false);
  const advancedId = useId();
  return <div className="lv-stack">
    <SyncControls cloud />
    <Panel title="高级设置" note="自建同步 · 待验证" aside={<button type="button" className="lv-btn" aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced(!advanced)}>{advanced ? '收起自建同步' : '展开自建同步'}</button>}>
      <p className="lv-fine">自建同步已完成本机隔离联调，真实跨设备使用仍待验证。</p>
      {advanced && <div id={advancedId} className="lv-stack">
        <Alert>自建同步（待验证）：需要自行准备同步服务、设备配对和项目授权。</Alert>
        <SyncControls />
      </div>}
    </Panel>
  </div>;
}

/** Existing paired-device controls, mounted only when advanced settings are expanded. */
function SyncControls({ cloud = false }: { cloud?: boolean }) {
  const root = cloud ? '/sync/feishu' : '/sync';
  const [status, setStatus] = useState<Status | null>(null), [projects, setProjects] = useState<Project[]>([]), [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState(''), [project, setProject] = useState<ProjectView | null>(null), [session, setSession] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'create' | 'join' | 'recover'>('join'), [url, setUrl] = useState(''), [deviceName, setDeviceName] = useState('');
  const [credential, setCredential] = useState(''), [space, setSpace] = useState(''), [spaceName, setSpaceName] = useState('我的 Loom');
  const [recovery, setRecovery] = useState(''), [invitation, setInvitation] = useState(''), [projectName, setProjectName] = useState('');
  const [cloudConsent, setCloudConsent] = useState(false), [authorization, setAuthorization] = useState<{url:string;qr:string;expires:number}|null>(null);
  const [cwd, setCwd] = useState(''), [consent, setConsent] = useState(false), [context, setContext] = useState(''), [mcp, setMcp] = useState('');
  const [note, setNote] = useState({ title: '', current: '', reasons: '', constraints: '', open: '', parent: '' });
  const generation = useRef(0), alive = useRef(true);
  const mapping = status?.mappings.find(m => m.project === selected), readable = status?.readProjects?.includes(selected);
  const heads = project?.notes.filter(n => !project.notes.some(other => other.parent === n.id)) ?? [];
  const load = async () => {
    const next = await api<Status>(root); if (!alive.current) return;
    setStatus(next);
    if (!next.connected) { setProjects([]); setDevices([]); setProject(null); setSession(null); setContext(''); return; }
    try {
      const [p, d] = await Promise.all([api<{ projects: Project[] }>(root + '/projects'), api<{ devices: Device[] }>(root + '/devices')]);
      if (alive.current) { setProjects(p.projects); setDevices(d.devices); }
    } catch (error) { setProjects([]); setDevices([]); setProject(null); setSession(null); setContext(''); throw error; }
  };
  const openProject = async (id: string) => {
    const gen = ++generation.current; setSelected(id); setProject(null); setSession(null); setContext(''); setConsent(false);
    setCwd(status?.mappings.find(m => m.project === id)?.cwd ?? '');
    if (!id) return;
    const next = await api<ProjectView>(root + '/projects/' + id);
    if (gen === generation.current && alive.current) { setProject(next); const heads = next.notes.filter(n => !next.notes.some(other => other.parent === n.id)); setNote({ title: '', current: '', reasons: '', constraints: '', open: '', parent: heads.length === 1 ? heads[0].id : '' }); }
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); if (alive.current) await load(); } catch (error) { if (alive.current) setError(message(error)); } finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true; void run(async () => {});
    const timer = setInterval(() => { void api<Status>(root).then(value => { if (alive.current) { setStatus(value); if (!value.connected) { setProject(null); setSession(null); setProjects([]); setContext(''); } } }).catch(() => {}); }, 5000);
    return () => { alive.current = false; generation.current++; clearInterval(timer); };
  }, []);
  const field = (label: string, value: string, change: (v: string) => void, secret = false) => <label className="lv-field">{label}<input className="lv-input" type={secret ? 'password' : 'text'} value={value} onChange={e => change(e.target.value)} disabled={busy} autoComplete="off" /></label>;

  return <div className="lv-stack">
    {error && <Alert tone="error">{error}</Alert>}{notice && <Alert>{notice}</Alert>}
    {status?.lastError && <Alert tone="error">{status.lastError}</Alert>}
    {cloud && <Panel title="飞书同步" note="通过同一飞书账号，在不同电脑接续授权项目的讨论与方案依据。" aside={<Pill tone="accent">默认方案</Pill>}>
      <p>{!status ? '正在检查飞书授权…' : status.account?.state === 'ready' ? `已授权：${status.account.name}。${status.connected ? '已连接你的飞书同步空间。' : '连接后再选择允许同步的项目。'}` : status.account?.message || '请先完成飞书用户授权。'}</p>
      <p className="lv-fine">记录保存在飞书云空间的专用目录。项目上传与本机 AI 读取分别授权，不读取其他项目。</p>
      {status?.account?.state !== 'ready' && <button type="button" className="lv-btn is-primary" disabled={busy || !status} onClick={() => void run(async () => { setAuthorization(await api(root + '/auth/start', 'POST', {})); })}>{authorization ? '重新生成授权二维码' : '登录飞书并授权同步'}</button>}
      {authorization && <div className="lv-stack"><p><a href={authorization.url} target="_blank" rel="noreferrer">打开飞书授权页</a></p><img src={authorization.qr} alt="飞书同步授权二维码" width={256} height={256} /><p className="lv-fine">请用本机所有者的飞书账号完成授权；二维码过期后可重新生成。</p><button type="button" className="lv-btn" disabled={busy} onClick={() => void run(async () => { const value = await api<Status>(root + '/auth/finish', 'POST', {}); setStatus(value); if (value.account?.state === 'ready') { setAuthorization(null); setNotice('飞书授权已完成，请连接同步空间。'); } })}>我已完成授权</button></div>}
    </Panel>}
    {!status ? <p>正在读取同步设置…</p> : !status.connected ? cloud ? <Panel title="连接你的飞书同步空间" note="第一台电脑会创建专用目录；其他电脑登录同一账号后会自动找到它。">
      <form className="lv-stack" onSubmit={e => { e.preventDefault(); void run(async () => { setStatus(await api<Status>(root + '/connect', 'POST', { deviceName, consent: true })); setCloudConsent(false); setNotice('已连接飞书同步。请选择项目，并分别确认采集和 AI 读取。'); }); }}>
        {field('这台设备的名称', deviceName, setDeviceName)}
        <label><input type="checkbox" checked={cloudConsent} onChange={e => setCloudConsent(e.target.checked)} /> 我同意在本人飞书云空间创建或连接 Loom 专用同步目录。</label>
        <button className="lv-btn is-primary" type="submit" disabled={busy || !deviceName.trim() || !cloudConsent || status.account?.state !== 'ready'}>连接飞书</button>
      </form>
    </Panel> : <Panel title="连接你的同步空间" note="用一次性邀请配对设备，各电脑保留自己的 Codex 登录。请选择你或公司管理的可信服务，当前服务端可读取同步内容。">
      <form className="lv-stack" onSubmit={e => { e.preventDefault(); void run(async () => {
        const result = await api<Status & { recovery?: string }>(root + '/connect', 'POST', { url, mode, deviceName, ...(mode === 'create' ? { name: spaceName, bootstrap: credential } : mode === 'join' ? { invitation: credential } : { space, recovery: credential }) });
        setStatus(result); setRecovery(result.recovery ?? ''); setCredential(''); setNotice('设备已绑定。请选择项目，并分别授权本机采集和 AI 读取。');
      }); }}>
        <label className="lv-field">连接方式<select className="lv-input" value={mode} onChange={e => { setMode(e.target.value as typeof mode); setCredential(''); }}><option value="join">加入已有空间</option><option value="create">创建私人空间</option><option value="recover">使用恢复凭据</option></select></label>
        {field('同步服务地址（HTTPS）', url, setUrl)}{field('这台设备的名称', deviceName, setDeviceName)}
        {mode === 'create' && field('空间名称', spaceName, setSpaceName)}{mode === 'recover' && field('空间标识', space, setSpace)}
        {field(mode === 'create' ? '服务管理员提供的初始化凭据' : mode === 'join' ? '一次性配对邀请' : '恢复凭据', credential, setCredential, true)}
        <button className="lv-btn is-primary" disabled={busy || !url || !deviceName || !credential} type="submit">{busy ? '正在连接…' : '连接空间'}</button>
      </form>
    </Panel> : <>
      <Panel title={status.device?.name} note={cloud ? '已连接 · 飞书云空间' : `已配对 · ${status.url}`} aside={<Pill tone={status.enabled ? 'done' : 'wait'}>{status.enabled ? '自动同步已开启' : '自动同步暂停'}</Pill>}>
        <p className="lv-fine">空间标识：{status.space}。来源电脑离线后，仍可从同步服务读取已上传的记录。</p>
        <div className="lv-toolbar">
          <button className="lv-btn" disabled={busy} onClick={() => void run(async () => { await api(root + '/connection', 'PUT', { enabled: !status.enabled, revision: status.revision }); })}>{status.enabled ? '暂停自动同步' : '开启自动同步'}</button>
          <button className="lv-btn" disabled={busy || !status.enabled} onClick={() => void run(async () => { const value = await api<Status>(root + '/run', 'POST', {}); setStatus(value); setNotice(value.mappings.some(m => m.lastError) ? '部分项目未完成，请查看项目同步状态。' : '本轮同步已结束，请核对项目回执。'); })}>立即同步</button>
          <button className="lv-btn" disabled={busy} onClick={() => void run(async () => {})}>刷新</button>
          <button className="lv-btn" disabled={busy} onClick={() => { if (confirm('断开本机与此空间的连接？服务器已有记录保留。')) void run(async () => { await api(root + '/connection', 'DELETE'); setRecovery(''); setInvitation(''); }); }}>断开本机</button>
        </div>
        {recovery && <Alert><div><strong>恢复凭据仅本次显示，请与空间标识一起妥善保存</strong><p style={{ overflowWrap: 'anywhere' }}>{recovery}</p><button className="lv-link" onClick={() => setRecovery('')}>我已保存，隐藏</button></div></Alert>}
      </Panel>
      <Panel title="项目与本机授权" note="只采集你明确选择的本机项目；同一项目在两台电脑上的路径可以不同。">
        {status.device?.admin && <form className="lv-toolbar" onSubmit={e => { e.preventDefault(); void run(async () => { const p = await api<Project>(root + '/projects', 'POST', { name: projectName }); setProjectName(''); await openProject(p.id); }); }}>
          <label>新项目名称<input className="lv-input" value={projectName} onChange={e => setProjectName(e.target.value)} maxLength={120} /></label><button className="lv-btn" disabled={busy || !projectName.trim()}>创建项目</button>
        </form>}
        <label className="lv-field">选择要继续的事情<select className="lv-input" value={selected} disabled={busy} onChange={e => void run(() => openProject(e.target.value))}><option value="">选择项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {selected && <div className="lv-stack" style={{ marginTop: 16 }}>
          {field('本机 Codex 项目绝对路径（精确匹配目录）', cwd, setCwd)}
          <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> 我允许持续读取并上传这个目录下已有及后续的 Codex 文字讨论到此同步空间。</label>
          <div className="lv-toolbar"><button className="lv-btn" disabled={busy || !cwd || !consent} onClick={() => void run(async () => { await api(root + `/projects/${selected}/mapping`, 'PUT', { cwd, enabled: true, consent: true, revision: mapping?.revision ?? 0 }); setConsent(false); })}>保存本机采集授权</button>
            {mapping?.enabled && <button className="lv-btn" disabled={busy} onClick={() => void run(async () => { await api(root + `/projects/${selected}/mapping`, 'PUT', { cwd: mapping.cwd, enabled: false, consent: true, revision: mapping.revision }); })}>停止采集此项目</button>}
            <button className="lv-btn" disabled={busy} onClick={() => void run(async () => { await api(root + `/projects/${selected}/ai`, 'PUT', { enabled: !readable, consent: true }); setContext(''); })}>{readable ? '撤销本机 AI 读取' : '允许本机 AI 读取此项目'}</button></div>
          <p className="lv-fine">{mapping?.lastSuccess ? `最近一次服务端确认：${when(mapping.lastSuccess)}` : '尚无成功上传回执'}{mapping?.lastError && ` · ${mapping.lastError}`}</p>
          {mapping?.lastChecked && <p className="lv-fine">最近检查：{when(mapping.lastChecked)}{mapping.lastRun && ` · 本轮确认 ${mapping.lastRun.sessions} 个会话、${mapping.lastRun.messages} 条文字`}</p>}
          {mapping?.warnings.map(w => <p className="lv-fine" key={w}>{w}</p>)}
          {status.device?.admin && <>{!cloud && <button className="lv-btn" disabled={busy} onClick={() => void run(async () => { const result = await api<{ invitation: string; expires: number }>(root + '/invitations', 'POST', { projects: [selected], hours: 24 }); setInvitation(result.invitation); setNotice('此邀请仅授予当前项目，24小时内有效，使用一次即失效。'); })}>为此项目添加另一台设备</button>}
            <button className="lv-btn" disabled={busy} onClick={() => { if (confirm(cloud ? `将“${project?.project.name || selected}”的飞书同步文件夹移至回收站并停止此项目接续？原生会话及已下载内容保留。` : '永久删除服务器上此项目的会话、方案和依据？原电脑的原生会话、其他设备已下载内容不会被删除。')) void run(async () => { await api(root + `/projects/${selected}`, 'DELETE'); setInvitation(''); await openProject(''); }); }}>{cloud ? '删除飞书项目记录' : '删除服务器项目记录'}</button>
            {invitation && <Alert><div><p>在另一台 Loom 选择“加入已有空间”，使用相同服务地址和以下邀请：</p><p style={{ overflowWrap: 'anywhere' }}>{invitation}</p><button className="lv-link" onClick={() => setInvitation('')}>隐藏邀请</button></div></Alert>}</>}
        </div>}
      </Panel>
      {project && <Panel title={project.project.name} note="同步记录保留来源设备和原生会话；查看不会启动或接管 Codex。">
        <div className="lv-toolbar"><button className="lv-btn" disabled={busy} onClick={() => void run(() => openProject(selected))}>更新项目记录</button><button className="lv-btn" disabled={busy || !readable} onClick={() => void run(async () => { const c = await api<{ text: string }>(root + `/projects/${selected}/context`); setContext(c.text); })}>查看接续上下文</button></div>
        {!project.sessions.length ? <Empty title="尚无上传的会话" /> : project.sessions.map(s => <button key={s.device + s.session} className="lv-row" disabled={busy} onClick={() => void run(async () => { setSession(await api<Revision>(root + `/projects/${selected}/sessions/${s.device}/${s.session}`)); })}>
          <span className="lv-row-main"><strong>{s.title}</strong><span>{devices.find(d => d.id === s.device)?.name ?? '来源设备'} · {s.messages}条文字 · {s.coverage}</span></span><time>{when(s.at)}</time></button>)}
        {session && <div className="lv-chat">{session.messages.map(m => <article key={m.id} className={'is-' + m.role}><header><strong>{m.role === 'user' ? '你' : 'AI'}</strong><time>{when(m.at)}</time></header><Markdown content={m.text} />{(m.truncated || m.omittedAttachments) && <p className="lv-fine">{m.truncated && '长文字有截断。'}{m.omittedAttachments && '附件正文未同步。'}</p>}</article>)}</div>}
        {context && <label>供下一次讨论使用的上下文<textarea className="lv-input" readOnly rows={12} value={context} /><button className="lv-btn" onClick={() => void run(async () => { await navigator.clipboard.writeText(context); setNotice('上下文已复制。'); })}>复制上下文</button></label>}
      </Panel>}
      {project && <Panel title="保存这次形成的理解" note="由你确认当前方案及修改理由。原讨论仍保留，多个分支会同时显示。">
        {heads.length > 1 && <Alert>当前有多个方案分支，请核对依据后选择继承哪一版。</Alert>}
        <form className="lv-stack" onSubmit={e => { e.preventDefault(); void run(async () => { await api(root + `/projects/${selected}/notes`, 'POST', { ...note, parent: note.parent || null, references: session ? [`${session.device}/${session.session}`] : [] }); await openProject(selected); }); }}>
          <label>继承的方案<select className="lv-input" value={note.parent} onChange={e => setNote({ ...note, parent: e.target.value })}><option value="">独立方案／新分支</option>{project.notes.map(n => <option key={n.id} value={n.id}>{n.title} · {when(n.at)}</option>)}</select></label>
          {field('这一版的名称', note.title, v => setNote({ ...note, title: v }))}
          {(['current', 'reasons', 'constraints', 'open'] as const).map((key, i) => <label key={key}>{['当前方案', '为什么修改／选择它', '继续沿用的约束', '尚未确定的问题'][i]}<textarea className="lv-input" rows={3} maxLength={12_000} value={note[key]} onChange={e => setNote({ ...note, [key]: e.target.value })} /></label>)}
          <p className="lv-fine">{session ? `将引用当前查看的会话：${session.title}` : '可先查看一段会话，为这次记录附上来源。'}</p><button className="lv-btn" disabled={busy || !note.title.trim() || !note.current.trim()}>保存方案和依据</button>
        </form>
        {project.notes.map(n => <details key={n.id}><summary>{n.title} · {when(n.at)}</summary><Markdown content={`当前方案：${n.current}\n\n修改理由：${n.reasons || '未明确'}\n\n沿用约束：${n.constraints}\n\n未决问题：${n.open}`} /></details>)}
      </Panel>}
      <Panel title="让当前电脑的 AI 接着讨论" note="一次性配置只读 MCP，并授权上面的项目。AI 可以查询原始记录与方案依据。">
        <button className="lv-btn" disabled={busy} onClick={() => void run(async () => { setMcp((await api<{ config: string }>(root + '/mcp-config')).config); })}>显示 Codex MCP 配置</button>
        {mcp && <><p className="lv-fine">将以下内容合并到 Codex 配置，重新连接 MCP 后，可让 AI“从 Loom 接着讨论这个项目”。</p><textarea className="lv-input" rows={6} readOnly value={mcp} /></>}
      </Panel>
      <Panel title={cloud ? '已连接设备' : '已配对设备'}>
        {devices.map(d => <div className="lv-row" key={d.id}><span className="lv-row-main"><strong>{d.name}</strong><span>{d.admin ? '空间管理设备' : '仅获邀项目'} · {d.revoked ? '已撤销' : '已配对'}</span></span>{status.device?.admin && d.id !== status.device.id && !d.revoked && <button className="lv-btn" disabled={busy} onClick={() => { if (confirm(`撤销“${d.name}”的后续同步权限？已下载内容无法远程收回。`)) void run(async () => { await api(root + '/devices/' + d.id, 'DELETE'); }); }}>撤销</button>}</div>)}
      </Panel>
    </>}
  </div>;
}
