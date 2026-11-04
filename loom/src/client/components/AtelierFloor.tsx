import React, { useEffect, useMemo, useState } from 'react';
import type { RouterLog, WorkerState, WatchdogLog, Ticket, Artifact } from '../../shared/types';
import { Icon } from './Icon';
import { EmptyState, formatTime, Modal, Status } from './UI';

interface Props {
  routerLogs: RouterLog[]; workerStates: WorkerState[]; watchdogLogs: WatchdogLog[];
  tickets: Ticket[]; artifacts: Artifact[]; openTicketCount?: number; compact?: boolean;
  onOpenArtifact?: (artifactId: string) => void; focusTicketId?: string | null; primaryTicketId?: string | null;
  onSelect?: (ticket: Ticket) => void;
}

export function AtelierFloor({ routerLogs, workerStates, watchdogLogs, tickets, artifacts, compact = false, onOpenArtifact, focusTicketId, onSelect }: Props) {
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Ticket | null>(null);
  const ordered = useMemo(() => [...tickets].filter((ticket) => filter === 'all' || ticket.status === filter).sort((a, b) => {
    const rank = { blocked: 0, open: 1, ended: 2 };
    return rank[a.status] - rank[b.status] || b.createdAt - a.createdAt;
  }), [tickets, filter]);
  const workers = workerStates.filter((worker) => worker.status !== 'ended');
  useEffect(() => {
    if (focusTicketId) { setFilter('all'); document.getElementById('ticket-' + focusTicketId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }, [focusTicketId]);
  const selectedLive = selected ? tickets.find((ticket) => ticket.id === selected.id) || selected : null;
  const selectedArtifact = artifacts.find((artifact) => artifact.ticketId === selectedLive?.id);
  return <section className={'section-surface atelier-floor ' + (compact ? 'compact' : '')}>
    <div className="section-heading"><div><h2>{compact ? '最近任务' : '任务列表'} <span className="count">{tickets.length}</span></h2>{!compact && <p>查看执行状态、处理记录和对应交付物。</p>}</div><span className="quiet-label">{onSelect ? '与飞书任务同步' : workers.length > 0 ? workers.length + ' 个任务正在执行' : '暂无执行中的任务'}</span></div>
    {!compact && <div className="filter-tabs" aria-label="任务状态">{[['all', '全部任务'], ['open', '进行中'], ['blocked', '需处理'], ['ended', '已完成']].map(([value, label]) => <button type="button" className={filter === value ? 'is-selected' : ''} key={value} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>)}</div>}
    {ordered.length === 0 ? <EmptyState icon="tasks" title={tickets.length ? '没有符合条件的任务' : '准备好接手下一件事'}>{tickets.length ? '试试切换状态或调整搜索词。' : onSelect ? '在飞书向助手提出需求，获授权的任务会同步到这里。' : '运行一次演示，查看接收事件、处理任务与交付结果的完整过程。'}</EmptyState> :
      <div className="task-table"><div className="task-table-head"><span>任务 / 事项</span><span>状态</span><span>更新时间</span><span /></div>{(compact ? ordered.slice(0, 5) : ordered).map((ticket) => {
        const artifact = artifacts.find((item) => item.ticketId === ticket.id);
        return <button type="button" id={'ticket-' + ticket.id} key={ticket.id} className={'task-row ' + (focusTicketId === ticket.id ? 'flash-focus' : '')} onClick={() => onSelect ? onSelect(ticket) : setSelected(ticket)}>
          <span className="task-name"><span className={'task-symbol ' + ticket.status}><Icon name={ticket.status === 'blocked' ? 'alert' : ticket.status === 'ended' ? 'check' : 'clock'} size={16} /></span><span><strong>{ticket.title}</strong><small>{artifact ? '交付物已就绪' : ticket.status === 'blocked' ? '需要查看处理记录' : ticket.status === 'ended' ? '任务已结束' : onSelect ? '查看任务当前进展' : '规则执行器正在处理'}</small></span></span>
          <Status state={ticket.status} /><time dateTime={new Date(ticket.updatedAt).toISOString()}>{formatTime(ticket.updatedAt)}</time><Icon name="chevron" size={15} />
        </button>;
      })}</div>}
    {!compact && !onSelect && <>
      {workers.length > 0 && <div className="execution-strip">{workers.map((worker) => <div key={worker.id}><span className="status-dot" /><strong>规则执行器</strong><span>{worker.progress}</span><time>{formatTime(worker.lastHeartbeat)}</time></div>)}</div>}
      <details className="technical-details"><summary><Icon name="code" size={15} />运行记录<span className="count">{routerLogs.length + watchdogLogs.length}</span><Icon name="down" size={14} /></summary><div className="log-list">{routerLogs.length === 0 && watchdogLogs.length === 0 ? <p className="quiet-label">事件处理后，运行记录会显示在这里。</p> : [...routerLogs, ...watchdogLogs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40).map((log) => <div className="log-row" key={log.id}><time>{formatTime(log.createdAt)}</time><p>{'message' in log ? log.message : log.details}</p></div>)}</div></details>
    </>}
    {selectedLive && <Modal title="任务详情" className="task-modal" onClose={() => setSelected(null)} footer={<><span className="quiet-label">#{selectedLive.id.slice(0, 8)}</span><button type="button" className="btn-secondary" onClick={() => setSelected(null)}>关闭</button>{selectedArtifact && <button type="button" className="btn-primary" onClick={() => { setSelected(null); onOpenArtifact?.(selectedArtifact.id); }}>查看交付物<Icon name="arrow" size={15} /></button>}</>}>
      <div className="detail-title"><Status state={selectedLive.status} /><h3>{selectedLive.title}</h3><p>{selectedLive.description}</p></div>
      <dl className="detail-facts"><div><dt>创建时间</dt><dd>{formatTime(selectedLive.createdAt, true)}</dd></div><div><dt>最近更新</dt><dd>{formatTime(selectedLive.updatedAt, true)}</dd></div><div><dt>执行方式</dt><dd>规则补丁 / 模板生成</dd></div><div><dt>交付状态</dt><dd>{selectedArtifact ? '已生成交付物' : '尚未生成'}</dd></div></dl>
      {selectedArtifact && <div className="note-block"><Icon name="file" /><div><strong>{selectedArtifact.title}</strong><p>{selectedArtifact.summary}</p></div></div>}
    </Modal>}
  </section>;
}
