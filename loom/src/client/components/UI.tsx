import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

export function Modal({ title, children, onClose, footer, className = '' }: {
  title: string; children: React.ReactNode; onClose: () => void; footer?: React.ReactNode; className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || [])
        .filter((node) => node.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return createPortal(
    <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className={'modal-card ' + className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>, document.body
  );
}

export function EmptyState({ icon = 'tasks', title, children, action }: {
  icon?: IconName; title: string; children?: React.ReactNode; action?: React.ReactNode;
}) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={25} /></span><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

export function Status({ state }: { state: 'open' | 'ended' | 'blocked' | 'pending' | 'running' }) {
  const labels = { open: '进行中', ended: '已完成', blocked: '需处理', pending: '等待中', running: '执行中' };
  return <span className={'status-label status-' + state}><span className="status-dot" />{labels[state]}</span>;
}

export function formatTime(time: number, full = false) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
}

export function sourceName(kind: string) {
  return ({ 'feishu.message': '飞书群消息', 'feishu.doc_comment': '文档评论', 'feishu.calendar': '日历提醒', 'feishu.approval': '审批动态', 'sim-im': '模拟消息', 'sim-ci': '持续集成', 'sim-clock': '定时事件', 'intent-board': '工作规则' } as Record<string, string>)[kind] || kind;
}

export function sourceIcon(kind: string): IconName {
  if (/calendar|clock/.test(kind)) return 'calendar';
  if (/doc/.test(kind)) return 'file';
  if (/approval/.test(kind)) return 'check';
  if (/ci/.test(kind)) return 'code';
  return 'message';
}

export function triggerText(payload: Record<string, unknown>) {
  return String(payload.text || payload.message || payload.summary || payload.approval_name || payload.error || '收到一条新事件');
}

export async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw new Error(body?.error || '请求未成功，请重试');
  return body as T;
}

export function downloadText(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
