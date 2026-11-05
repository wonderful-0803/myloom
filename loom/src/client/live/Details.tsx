import React, { useEffect, useRef, useState } from 'react';
import type { LoomArtifact, LoomMail, LoomTask } from '../../../../src/app/loom-types';
import { Markdown } from '../components/Markdown';
import { api, controlName, enc, mailName, message, taskState, when } from './api';
import { useTaskDelivery, useWorkspace, type TaskDelivery } from './context';
import { Delivery } from './Delivery';
import { Progress } from './Progress';
import { Alert, Facts, Pill, Sheet } from './ui';

type Control = 'pause' | 'resume' | 'takeover' | 'return';
type Version = Pick<LoomArtifact, 'version' | 'author' | 'hash' | 'at' | 'editedVia'>;
type Doc = { artifact: LoomArtifact; versions: Version[] };
export type MailResult = { message: string; proposal?: LoomMail };

function TaskDeliveryBlock({ task, version }: { task: LoomTask; version?: number }) {
  const { locked, refresh } = useWorkspace();
  const [delivery, setDelivery] = useTaskDelivery(task.id);
  if (!delivery) return null;
  const update = async (path: string, method: string, body: unknown, done: (next: TaskDelivery) => void) => {
    const next = await api<TaskDelivery>(path, method, body);
    setDelivery(next); done(next); await refresh();
  };
  return <section className="lv-block">
    <h3>交付方式</h3>
    <Delivery task setting={delivery.setting} receipts={delivery.receipts} version={version} disabled={locked}
      save={(mode, revision, mailboxKey) => update(`/tasks/${enc(task.id)}/delivery`, 'PUT', { mode, revision, ...(mailboxKey ? { mailboxKey } : {}) }, () => {})}
      sendNow={version ? () => update(`/tasks/${enc(task.id)}/delivery`, 'POST', { version }, () => {}) : undefined} />
  </section>;
}

/** Task drawer: state and controls first, then live progress, then the report and its delivery. */
export function TaskSheet({ task, onClose }: { task: LoomTask; onClose: () => void }) {
  const { data, locked, run, openDoc } = useWorkspace();
  const state = taskState(task, data.paused);
  const report = data.artifacts.find(a => a.subject === task.id);
  const control = (action: Control) => run(async () => {
    await api(`/tasks/${enc(task.id)}/control`, 'POST', { action, revision: task.control.revision });
    return '操作已记录，请以当前控制状态为准。';
  });
  const buttons: [Control, string, boolean][] = task.control.mode === 'agent' ? [['pause', '暂停', false], ['takeover', '接管', false]]
    : task.control.mode === 'paused' ? [['resume', '继续', true]] : task.control.mode === 'human' ? [['return', '交还助手', true]] : [];
  return <Sheet title={task.title} eyebrow={<Pill tone={state.tone}>{state.label}</Pill>} onClose={onClose}
    actions={<>
      {buttons.map(([action, label, primary]) => <button key={action} type="button" className={'lv-btn' + (primary ? ' is-primary' : '')} disabled={locked} onClick={() => void control(action)}>{label}</button>)}
      <span className="lv-grow" />
      {report && <button type="button" className="lv-btn" onClick={() => openDoc(task.id)}>打开报告</button>}
    </>}>
    {task.description && task.description !== task.title && <p className="lv-lede">{task.description}</p>}
    <Facts items={[['控制', controlName[task.control.mode]], ['在途操作', task.control.pending], ['创建', when(task.createdAt)], ['更新', when(task.updatedAt)]]} />
    <p className="lv-fine">暂停和接管只作用于这个任务。接管完成后可以编辑已保存的报告，交还后助手从现有成果继续。</p>
    <section className="lv-block"><h3>执行进展</h3><Progress task={task} /></section>
    {task.summary && <section className="lv-block"><h3>最近报告</h3><p className="lv-quote">{task.summary}</p></section>}
    <TaskDeliveryBlock task={task} version={task.completed ? report?.version : undefined} />
  </Sheet>;
}

/** Document drawer for a task report or quiet draft: read, edit as a new version, export, confirm, mail. */
export function DocSheet({ subject, version, onClose, onMail }: { subject: string; version?: number; onClose: () => void; onMail: (result: MailResult) => void }) {
  const { data, locked, run, openDoc } = useWorkspace();
  const [doc, setDoc] = useState<Doc | null>(null), [error, setError] = useState('');
  const [draft, setDraft] = useState<string | null>(null), [file, setFile] = useState('');
  const request = useRef(0);
  const load = async (at?: number) => {
    const id = ++request.current;
    try {
      const value = await api<Doc>(`/artifacts/${enc(subject)}${at ? `?version=${at}` : ''}`);
      if (id === request.current) { setDoc(value); setError(''); }
    } catch (value) { if (id === request.current) setError(message(value)); }
  };
  useEffect(() => { setDoc(null); setDraft(null); void load(version); return () => { request.current++; }; }, [subject, version]);

  const latest = data.artifacts.find(a => a.subject === subject);
  const task = data.tasks.find(t => t.id === subject);
  if (error) return <Sheet title="无法打开" onClose={onClose}><Alert tone="error">{error}</Alert></Sheet>;
  if (!doc) return <Sheet title="正在打开…" onClose={onClose}><p className="lv-muted">正在读取正文与版本记录…</p></Sheet>;

  const a = doc.artifact, current = latest?.version === a.version;
  const editable = current && (a.kind === 'draft' || (task?.control.mode === 'human' && !task.control.pending));
  const author = a.author === 'human' ? (a.editedVia === 'loom' ? '本人在 Loom 编辑' : '本人编辑') : '助手生成';
  const exportText = () => run(async () => {
    const value = await api<{ filename: string; content: string }>(`/artifacts/${enc(subject)}/export?version=${a.version}`);
    const url = URL.createObjectURL(new Blob([value.content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = value.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const save = () => run(async () => {
    const value = await api<LoomArtifact>(`/artifacts/${enc(subject)}`, 'PUT', { version: a.version, body: draft });
    setDraft(null); await load();
    return `已保存为 v${value.version}，旧版本保留。`;
  });
  const decide = (action: 'confirm' | 'discard') => run(async () => {
    const value = await api<{ message: string }>(`/drafts/${enc(subject)}`, 'POST', { action, version: a.version });
    if (action === 'discard') onClose(); else await load();
    return value.message;
  });
  const mail = () => run(async () => { onMail(await api<MailResult>(`/tasks/${enc(subject)}/mail`, 'POST', {})); });
  const register = () => run(async () => {
    await api<LoomArtifact>(`/tasks/${enc(subject)}/report-file`, 'POST', { version: a.version, filename: file });
    setFile(''); await load();
    return '完整报告已登记为新版本，可按交付方式立即投递。';
  });

  return <Sheet title={a.title} eyebrow={`${a.kind === 'draft' ? '静默草稿' : '任务报告'} · v${a.version} · ${author}`} onClose={onClose}
    actions={draft !== null ? <>
      <button type="button" className="lv-btn" onClick={() => setDraft(null)}>取消编辑</button>
      <span className="lv-grow" />
      <button type="button" className="lv-btn is-primary" disabled={locked || !draft.trim()} onClick={() => void save()}>保存为新版本</button>
    </> : <>
      <button type="button" className="lv-btn" disabled={locked} onClick={() => void exportText()}>导出 TXT</button>
      {editable && <button type="button" className="lv-btn" disabled={locked} onClick={() => setDraft(a.body)}>编辑正文</button>}
      <span className="lv-grow" />
      {a.kind === 'draft' && <>
        <button type="button" className="lv-btn" disabled={locked} onClick={() => void decide('discard')}>忽略</button>
        <button type="button" className="lv-btn is-primary" disabled={locked || !current} onClick={() => void decide('confirm')}>确认草稿</button>
      </>}
      {task?.completed && task.control.mode === 'agent' && current && <button type="button" className="lv-btn is-primary" disabled={locked} onClick={() => void mail()}>邮件预览</button>}
    </>}>
    <p className="lv-fine">{a.kind === 'draft' ? '草稿只保存在这里，确认后也不会自动发到群或邮箱。' : '查看报告不会暂停任务；编辑前需要先接管任务。'}</p>
    {!current && latest && <Alert>正在查看旧版 v{a.version}，最新是 v{latest.version}。<button type="button" className="lv-link" onClick={() => openDoc(subject)}>看最新版</button></Alert>}
    {draft !== null
      ? <label className="lv-field"><span>新版正文，保存后旧版保留</span><textarea rows={18} maxLength={40000} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      : <article className="lv-doc"><Markdown content={a.body} /></article>}
    {draft === null && task && current && <TaskDeliveryBlock task={task} version={task.completed ? a.version : undefined} />}
    {draft === null && task?.completed && task.control.mode === 'agent' && a.author === 'agent' && !a.filename && <details className="lv-more">
      <summary>登记任务目录里的完整报告</summary>
      <p className="lv-fine">旧任务可能只存了摘要。填写任务目录里已生成的 .md 或 .txt 文件，登记为新版本，不会重新执行或自动补发。</p>
      <div className="lv-inline"><input className="lv-input" value={file} maxLength={240} placeholder="例如 summary.md" onChange={event => setFile(event.target.value)} />
        <button type="button" className="lv-btn" disabled={locked || !file.trim()} onClick={() => void register()}>登记</button></div>
    </details>}
    {draft === null && <details className="lv-more">
      <summary>版本与来源</summary>
      <label className="lv-field"><span>查看版本</span>
        <select className="lv-input" value={a.version} onChange={event => openDoc(subject, Number(event.target.value))}>
          {doc.versions.map(v => <option key={v.version} value={v.version}>v{v.version} · {v.author === 'human' ? '本人编辑' : '助手生成'} · {when(v.at)}</option>)}
        </select>
      </label>
      <p className="lv-hash">SHA256 <code>{a.hash}</code></p>
      {a.sources.map(s => <p className="lv-hash" key={s.triggerId}>消息 {s.triggerId} <code>{s.hash}</code></p>)}
    </details>}
  </Sheet>;
}

/** Mail goes out only after the person confirms this exact preview. */
export function MailSheet({ result, onChange, onClose }: { result: MailResult; onChange: (result: MailResult) => void; onClose: () => void }) {
  const { locked, run } = useWorkspace();
  const p = result.proposal;
  const act = (action: 'confirm' | 'cancel' | 'status') => run(async () => { if (p) onChange(await api<MailResult>(`/mail/${enc(p.token)}`, 'POST', { action })); });
  return <Sheet kind="dialog" title={p?.subject ?? '邮件预览'} eyebrow={p ? mailName[p.status] ?? p.status : undefined} onClose={onClose}
    actions={<>
      {p && ['preview', 'draft'].includes(p.status) && <>
        <button type="button" className="lv-btn" disabled={locked} onClick={() => void act('cancel')}>取消发送</button>
        <span className="lv-grow" />
        <button type="button" className="lv-btn is-primary" disabled={locked} onClick={() => void act('confirm')}>确认发送这一版</button>
      </>}
      {p && !['preview', 'cancelled'].includes(p.status) && <button type="button" className="lv-btn" disabled={locked} onClick={() => void act('status')}>查询投递状态</button>}
    </>}>
    {p && <><Facts items={[['收件人', p.to], ['固定版本', `v${p.artifactVersion ?? '-'}`]]} /><article className="lv-doc"><Markdown content={p.body} /></article></>}
    <Alert>{result.message}</Alert>
  </Sheet>;
}
