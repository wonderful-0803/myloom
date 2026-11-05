import React, { useEffect, useState } from 'react';
import type { LoomProgress, LoomTask } from '../../../../src/app/loom-types';
import { startLiveSync } from '../live-sync';
import { api, duration, enc, message, when } from './api';

const eventStatus = { running: '进行中', done: '已完成', failed: '工具报错', interrupted: '已中断' };

/** Polls the task's native activity every 3s; reading it never starts the task or a model call. */
export function Progress({ task }: { task: LoomTask }) {
  const [info, setInfo] = useState<LoomProgress | null>(null), [error, setError] = useState('');
  const [models, setModels] = useState(false), [all, setAll] = useState(false);
  useEffect(() => {
    setInfo(null); setError(''); setAll(false);
    const sync = startLiveSync({
      load: signal => api<LoomProgress>(`/tasks/${enc(task.id)}/progress`, 'GET', undefined, signal),
      value: value => { setInfo(value); setError(''); },
      error: value => setError(message(value)),
    });
    return () => sync.stop();
  }, [task.id, task.control.revision]);

  if (error) return <p className="lv-error" role="alert">执行进展读取失败：{error}</p>;
  if (!info) return <p className="lv-muted" role="status">正在读取执行进展…</p>;

  const events = info.events.filter(event => models || event.kind !== 'model');
  const shown = all ? events : events.slice(0, 20);
  const since = info.currentSince ? duration(Date.now() - Date.parse(info.currentSince)) : '';
  return <div className="lv-progress">
    <div className="lv-now" role="status">
      <i className={'lv-dot' + (info.phase === 'completed' ? ' is-done' : ' is-live')} />
      <div>
        <strong>{info.label}</strong>
        <span>{info.phase === 'model' && since ? `本次模型步骤已等待 ${since}` : info.lastActivityAt ? `最近活动 ${when(info.lastActivityAt)}` : '尚未取得执行记录'}</span>
      </div>
    </div>
    <div className="lv-metrics">
      {[['总用时', duration(info.elapsedMs)], ['模型', duration(info.modelMs)], ['工具', duration(info.toolMs)], ['步骤 / 动作', `${info.modelSteps} / ${info.toolCalls}`]]
        .map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
    {info.unavailable && <p className="lv-note">{info.unavailable}</p>}
    {info.control.mode !== 'agent' && <div className="lv-handover">
      <strong>{info.control.mode === 'human' ? '控制权在你手里' : info.control.mode === 'taking_over' ? '正在完成接管' : info.control.mode === 'paused' ? '任务保持暂停' : '正在安全停止'}</strong>
      <p>{info.control.mode === 'human' ? '助手不会自行推进。改完报告后点“交还助手”，它会读取你的修改再继续。'
        : info.control.mode === 'paused' ? '新消息和服务重启都不会解除暂停，点“继续”才恢复。'
          : info.control.pending.some(op => op.unknown) ? '有操作结果待核查，暂不能确认移交完成；已发生的外部动作不会自动撤回。'
            : '已阻止新的受管操作，正在等待在途工具与后台作业停止。'}</p>
      {info.control.pending.length > 0 && <ul>{info.control.pending.map(op =>
        <li key={op.id}>{op.label} · {op.unknown ? '结果待核查' : '在途'} · {when(op.startedAt)}</li>)}</ul>}
    </div>}
    <div className="lv-row-between">
      <h3>执行记录 <span className="lv-count">{events.length}</span></h3>
      <label className="lv-check"><input type="checkbox" checked={models} onChange={event => setModels(event.target.checked)} />显示模型步骤</label>
    </div>
    {events.length ? <ol className="lv-timeline">{shown.map(event =>
      <li key={event.id} className={'is-' + event.status}>
        <time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
        <div>
          <strong>{event.title}</strong>
          <span>{event.kind === 'control' ? '操作已记录' : event.kind === 'tool' && event.status === 'done' ? '已返回' : eventStatus[event.status]}{event.durationMs !== undefined ? ` · ${duration(event.durationMs)}` : ''}</span>
          {event.detail && <p>{event.detail}</p>}
        </div>
      </li>)}</ol> : <p className="lv-muted">还没有执行动作，任务可能在排队或等待模型。</p>}
    {!all && events.length > 20 && <button type="button" className="lv-link" onClick={() => setAll(true)}>展开其余 {events.length - 20} 条</button>}
    <p className="lv-fine">{info.failedTools ? `${info.failedTools} 次工具报错，任务是否完成以报告为准。` : ''}{info.truncated ? '只保留最近一段记录。' : ''}只展示动作与结果摘要，不展示模型内部推理或原始命令。</p>
  </div>;
}
