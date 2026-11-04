import React, { useState } from 'react';
import type { Trigger, EvalDecision, SourceKind, FeishuAck } from '../../shared/types';
import { Icon } from './Icon';
import { EmptyState, Modal, formatTime, sourceIcon, sourceName, triggerText, request } from './UI';

interface Props { triggers: Trigger[]; evalDecisions: EvalDecision[]; feishuAcks: FeishuAck[]; feishuConfigured?: boolean; compact?: boolean }
const presets = [
  { label: '群消息报障', scenario: 'group_bug_report', icon: 'message' as const },
  { label: '文档评论', scenario: 'doc_comment', icon: 'file' as const },
  { label: '日历提醒', scenario: 'calendar_brief', icon: 'calendar' as const },
  { label: '审批通过', scenario: 'approval_approved', icon: 'check' as const },
];
const scenarioMap: Record<string, string> = { 'feishu.message': 'group_bug_report', 'feishu.doc_comment': 'doc_comment', 'feishu.calendar': 'calendar_brief', 'feishu.approval': 'approval_approved' };

export function WorldBus({ triggers, evalDecisions, feishuAcks, feishuConfigured, compact = false }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [kind, setKind] = useState<SourceKind>('feishu.message');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (scenario?: string) => {
    setBusy(true); setError('');
    try {
      if (scenario || kind.startsWith('feishu')) {
        await request('/api/feishu/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: scenario || scenarioMap[kind], ...(!scenario && message.trim() ? { text: message.trim() } : {}) }) });
      } else {
        await request('/api/triggers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceKind: kind, type: kind === 'sim-ci' ? 'ci_failure' : kind === 'sim-clock' ? 'custom_timer' : 'im_message', payload: { message: message.trim(), error: kind === 'sim-ci' ? message.trim() : undefined, user: 'You', channel: '#dev-chat' }, threadTopics: [kind === 'sim-im' ? 'IM#dev-chat' : kind === 'sim-ci' ? 'CI#custom' : 'clock#custom'] }) });
      }
      setMessage(''); setShowForm(false);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const visible = [...triggers].filter((trigger) => filter === 'all' || trigger.sourceKind === filter).sort((a, b) => b.createdAt - a.createdAt);
  const decisions: Record<string, string> = { accept: '已接单', ignore: '已略过', stop: '已停止', unavailable: '待复核' };
  return <section className={'section-surface world-bus ' + (compact ? 'compact' : '')}>
    <div className="section-heading"><div><h2>{compact ? '最近事件' : '事件收件箱'} <span className="count">{triggers.length}</span></h2>{!compact && <p>查看外部输入、处理结果和机器人回执。</p>}</div>{!compact && <button type="button" className="btn-secondary" onClick={() => { setError(''); setShowForm(true); }}><Icon name="plus" size={15} />模拟事件</button>}</div>
    {!compact && <div className="filter-tabs event-filters" aria-label="事件来源">{[['all', '全部来源'], ['feishu.message', '群消息'], ['feishu.doc_comment', '文档'], ['feishu.calendar', '日历'], ['feishu.approval', '审批']].map(([value, label]) => <button type="button" key={value} className={filter === value ? 'is-selected' : ''} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>)}</div>}
    {visible.length === 0 ? <EmptyState icon="events" title={triggers.length ? '这个来源还没有事件' : '等待第一条事件'}>{triggers.length ? '可以切换来源查看其他事件。' : '模拟消息、文档评论和日程提醒会出现在这里。'}</EmptyState> :
      <div className="event-list">{(compact ? visible.slice(0, 5) : visible).map((trigger) => {
        const decision = evalDecisions.find((item) => item.triggerId === trigger.id);
        return <article className="event-row" key={trigger.id} data-trigger-id={trigger.id}>
          <span className="event-source-icon"><Icon name={sourceIcon(trigger.sourceKind)} size={17} /></span>
          <div className="event-copy"><div className="event-meta"><strong>{sourceName(trigger.sourceKind)}</strong><time dateTime={new Date(trigger.createdAt).toISOString()}>{formatTime(trigger.createdAt)}</time></div><p>{triggerText(trigger.payload)}</p>{!compact && <div className="event-decision">{decision ? <><span className={'decision-label ' + decision.decision}>{decisions[decision.decision]}</span><span>{decision.reason}</span></> : <span className="quiet-label">已接收 · 处理状态随事件更新</span>}</div>}</div>
        </article>;
      })}</div>}
    {!compact && feishuAcks.length > 0 && <details className="technical-details receipt-details" id="feishu-ack-panel" open><summary><Icon name="message" size={15} />机器人回执 <span className="count">{feishuAcks.length}</span><Icon name="down" size={14} /></summary><div className="receipts-list">{feishuAcks.slice(0, 20).map((ack) => <article className="receipt-row" key={ack.id}><div className="event-meta"><strong>{ack.chatName}</strong><span className={'delivery-label ' + (ack.delivery || 'sim')}>{ack.delivery === 'feishu' ? '已送达飞书' : ack.delivery === 'feishu_failed' ? '送达失败 · 已保留记录' : '本地模拟'}</span><time>{formatTime(ack.createdAt)}</time></div><p>{ack.text}</p></article>)}</div></details>}
    {showForm && <Modal title="发送模拟事件" onClose={() => setShowForm(false)} footer={<><button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>取消</button><button type="submit" form="event-form" className="btn-primary" disabled={busy || !message.trim()}>{busy ? '发送中…' : '发送事件'}<Icon name="arrow" size={15} /></button></>}>
      <p className="form-intro">{feishuConfigured ? '使用示例检查已配置的处理流程；回执的实际送达状态会单独标明。' : '在本地模拟飞书输入，无需连接真实工作群。'}</p>
      <div className="preset-grid">{presets.map((preset) => <button className="preset-button" type="button" key={preset.scenario} disabled={busy} onClick={() => send(preset.scenario)}><Icon name={preset.icon} /><span>{preset.label}</span><Icon name="arrow" size={14} /></button>)}</div>
      <div className="form-divider"><span>或自定义内容</span></div>
      <form id="event-form" className="form-stack" onSubmit={(event) => { event.preventDefault(); if (message.trim()) void send(); }}>
        <label className="field"><span>事件来源</span><select value={kind} onChange={(event) => setKind(event.target.value as SourceKind)}>{['feishu.message', 'feishu.doc_comment', 'feishu.calendar', 'feishu.approval', 'sim-im', 'sim-ci', 'sim-clock'].map((value) => <option key={value} value={value}>{sourceName(value)}</option>)}</select></label>
        <label className="field"><span>事件内容</span><textarea required rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="输入需要处理的消息…" /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </Modal>}
  </section>;
}
