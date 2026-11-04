/**
 * Human-readable Ticket titles/descriptions (R2)
 * Avoid raw "feishu_im_message - feishu#运维值班群" + JSON dumps.
 */
import type { Trigger, Thread } from '../shared/types.js';

export function humanTicketCopy(
  trigger: Trigger,
  thread: Thread
): { title: string; description: string } {
  const p = (trigger.payload || {}) as Record<string, any>;
  const text = String(p.text || p.message || p.summary || p.error || '').trim();

  if (trigger.sourceKind === 'feishu.message' || trigger.type === 'feishu_im_message') {
    const chat = String(p.chat_name || thread.topic.replace(/^feishu#/, '') || '飞书群');
    const sender = p.sender?.name || p.sender || '同事';
    let title: string;
    if (/formatPercent|format\.js|null.*toFixed|场景\s*B/i.test(text)) {
      title = `${chat}报障：formatPercent null`;
    } else if (/divide|Infinity|除零|除以零/i.test(text)) {
      title = `${chat}报障：divide 除零`;
    } else if (/bug|崩溃|报障|缺陷|错误/i.test(text)) {
      const short = text.replace(/@\S+\s*/g, '').slice(0, 28);
      title = `${chat}报障：${short || '缺陷'}`;
    } else {
      title = `${chat}消息：${text.slice(0, 28) || '群消息'}`;
    }
    return {
      title,
      description: `${sender} 在「${chat}」：${text || '(无正文)'}`,
    };
  }

  if (trigger.sourceKind === 'feishu.doc_comment' || trigger.type === 'feishu_doc_comment') {
    const doc = String(p.doc_title || '云文档');
    const who = String(p.commenter || '评论者');
    const short = text.slice(0, 28) || '文档评论';
    return {
      title: `文档评论「${doc}」：${short}`,
      description: `${who} 评论「${doc}」：${text}`,
    };
  }

  if (trigger.sourceKind === 'feishu.calendar' || trigger.type === 'feishu_calendar_reminder') {
    const summary = String(p.summary || '日历提醒');
    return {
      title: `日历提醒：${summary}`,
      description: `飞书日历触发「${summary}」${p.start_time ? `（${p.start_time}）` : ''}`,
    };
  }

  if (trigger.sourceKind === 'feishu.approval' || trigger.type === 'feishu_approval') {
    const name = String(p.approval_name || '审批');
    const status = String(p.status || '').toUpperCase() || 'UPDATED';
    const applicant = String(p.applicant || '');
    return {
      title: `审批${status === 'APPROVED' ? '通过' : status}：${name}`,
      description: `${applicant ? applicant + ' 的' : ''}「${name}」状态 ${status}`,
    };
  }

  if (trigger.type === 'ci_failure') {
    return {
      title: `CI 失败：${p.build || 'build'}`,
      description: String(p.error || text || 'CI failure'),
    };
  }

  if (trigger.sourceKind === 'intent-board') {
    return {
      title: `意图钉板：${p.title || '新 Mandate'}`,
      description: String(p.title || 'mandate_created'),
    };
  }

  return {
    title: text.slice(0, 40) || `${trigger.type} · ${thread.topic}`,
    description: text || `来自 ${thread.topic}`,
  };
}

export function feishuChatName(trigger: Trigger, thread?: Thread): string {
  const p = (trigger.payload || {}) as Record<string, any>;
  if (p.chat_name) return String(p.chat_name);
  if (p.doc_title) return `文档·${p.doc_title}`;
  if (p.summary) return `日历·${p.summary}`;
  if (p.approval_name) return `审批·${p.approval_name}`;
  if (thread?.topic) return thread.topic.replace(/^feishu(#|-)/, '');
  return '飞书';
}
