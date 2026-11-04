import React from 'react';
import type { DemoTimelineStep } from '../../shared/types';
import { Icon } from './Icon';

const order: DemoTimelineStep['id'][] = ['inbound', 'ticket', 'patch', 'green', 'gallery'];
const labels = ['接收事件', '创建任务', '处理文件', '运行验证', '交付结果'];
interface Props {
  steps: DemoTimelineStep[]; visible: boolean; conclusion?: string | null; scene?: 'A' | 'B';
  onJump: (pane: DemoTimelineStep['pane'], refId?: string) => void;
  onExportAudit?: (format: 'json' | 'md') => void; progressHint?: string | null;
}
export function DemoTimeline({ steps, visible, conclusion, scene = 'A', onJump, onExportAudit, progressHint }: Props) {
  if (!visible) return null;
  const allDone = order.every((id) => steps.find((step) => step.id === id)?.status === 'done');
  return <section className={'run-timeline ' + (allDone ? 'is-complete' : '')} aria-label="本轮进度">
    <div className="timeline-heading"><span className={'run-indicator ' + (allDone ? 'done' : '')}><Icon name={allDone ? 'check' : 'play'} size={14} /></span><strong>{allDone ? '演示已完成' : '演示进行中'}</strong><span className="timeline-caption">{allDone ? '结果和处理记录已保存' : progressHint || '正在处理模拟事件'}</span><span className="small-label">场景 {scene}</span>{allDone && onExportAudit && <button type="button" className="text-button" onClick={() => onExportAudit('md')}><Icon name="download" size={14} />导出记录</button>}</div>
    <ol className="run-steps">{order.map((id, index) => {
      const step = steps.find((item) => item.id === id);
      const state = step?.status || 'pending';
      return <li key={id} className={state}><button type="button" onClick={() => step && onJump(step.pane, step.refId)} disabled={!step || state === 'pending'} title={step?.detail}><span className="run-step-number">{state === 'done' ? <Icon name="check" size={12} /> : index + 1}</span><span>{labels[index]}</span></button>{index !== 4 && <span className="run-step-line" />}</li>;
    })}</ol>
    {conclusion && <span className="sr-only" role="status">{conclusion}</span>}
  </section>;
}
