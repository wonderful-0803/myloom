import React, { useEffect, useState } from 'react';
import type { Artifact, Ticket, Mandate } from '../../shared/types';
import { Icon } from './Icon';
import { EmptyState, Modal, downloadText, formatTime } from './UI';
import { Markdown } from './Markdown';

interface Props {
  artifacts: Artifact[]; tickets: Ticket[]; mandates: Mandate[]; compact?: boolean;
  focusArtifactId?: string | null; primaryArtifactId?: string | null; onFocused?: () => void;
  onRunFeishuDemo?: () => void; demoRunning?: boolean;
  onSelect?: (artifact: Artifact) => void;
}
const typeName = (type: Artifact['type']) => ({ report: '处理报告', pr_note: '补丁说明', brief: '工作简报' })[type];

export function Gallery({ artifacts, tickets, mandates, compact = false, focusArtifactId, primaryArtifactId, onFocused, onSelect }: Props) {
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    if (!focusArtifactId) return;
    const artifact = artifacts.find((item) => item.id === focusArtifactId);
    if (artifact) { setSelected(artifact); onFocused?.(); }
  }, [focusArtifactId, artifacts, onFocused]);
  const sorted = [...artifacts].filter((artifact) => filter === 'all' || artifact.type === filter).sort((a, b) => Number(b.id === primaryArtifactId) - Number(a.id === primaryArtifactId) || b.createdAt - a.createdAt);
  const ticket = tickets.find((item) => item.id === selected?.ticketId);
  const mandate = mandates.find((item) => item.id === ticket?.mandateId);
  return <section className={'section-surface gallery ' + (compact ? 'compact' : '')}>
    <div className="section-heading"><div><h2>{compact ? '最近交付' : '交付物'} <span className="count">{artifacts.length}</span></h2>{!compact && <p>每一份结果，都可以追溯到来源任务。</p>}</div>{compact ? <span className="quiet-label">处理完成后会出现在这里</span> : <label className="inline-select"><span className="sr-only">交付物类型</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部类型</option><option value="pr_note">补丁说明</option><option value="brief">工作简报</option><option value="report">处理报告</option></select></label>}</div>
    {sorted.length === 0 ? <EmptyState icon="file" title={artifacts.length ? '没有这个类型的交付物' : '好结果，值得留下来'}>{artifacts.length ? '选择其他类型查看已有结果。' : '任务完成后，补丁说明、简报与处理报告会汇集于此。'}</EmptyState> :
      <div className="deliverable-list">{(compact ? sorted.slice(0, 3) : sorted).map((artifact) => <button type="button" className="deliverable-row" id={'artifact-' + artifact.id} key={artifact.id} onClick={() => onSelect ? onSelect(artifact) : setSelected(artifact)}>
        <span className={'document-icon ' + artifact.type}><Icon name={artifact.type === 'pr_note' ? 'code' : 'file'} size={21} /></span>
        <span className="deliverable-copy"><span className="deliverable-title">{artifact.title.replace(/（真实\s*sandbox\s*规则补丁）/gi, '')}{artifact.id === primaryArtifactId && <span className="small-label">本轮结果</span>}</span><span className="deliverable-summary">{artifact.summary.split(/\x60{3}/)[0].replace(/\*\*/g, '').replace(/^旁路\s*·\s*/, '').replace(/\s*·\s*非 LLM/g, '').replace(/模板(?!生成)/g, '模板生成')}</span><span className="deliverable-meta">{typeName(artifact.type)}<span className="separator">·</span>{formatTime(artifact.createdAt, true)}</span></span>
        <Icon name="arrow" size={17} />
      </button>)}</div>}
    {selected && <Modal title="交付物详情" className="artifact-modal" onClose={() => setSelected(null)} footer={<><span className="quiet-label">由本地规则执行器生成</span><button type="button" className="btn-secondary" onClick={() => downloadText(selected.title.replace(/[\\/:*?"<>|]/g, '-') + '.md', selected.content)}><Icon name="download" size={15} />下载 Markdown</button></>}>
      <div className="document-heading"><div className="document-eyebrow">{typeName(selected.type)}<span className="separator">/</span><time>{formatTime(selected.createdAt, true)}</time></div><h3>{selected.title.replace(/（真实\s*sandbox\s*规则补丁）/gi, '')}</h3>{selected.summary && <p className="document-summary">{selected.summary}</p>}</div>
      {(ticket || mandate) && <dl className="document-trail">{ticket && <div><dt>来源任务</dt><dd>{ticket.title}</dd></div>}{mandate && <div><dt>工作规则</dt><dd>{mandate.title}</dd></div>}</dl>}
      <Markdown content={selected.content} />
    </Modal>}
  </section>;
}
