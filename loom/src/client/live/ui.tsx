import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Tone } from './api';

/** Side drawer (details) or centred dialog (forms, confirmations), with focus trap and Escape to close. */
export function Sheet({ title, eyebrow, kind = 'drawer', onClose, actions, children }: {
  title: string; eyebrow?: React.ReactNode; kind?: 'drawer' | 'dialog'; onClose: () => void; actions?: React.ReactNode; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null), close = useRef(onClose), titleId = useId();
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary') ?? [])
        .filter(node => node.getClientRects().length > 0);
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return createPortal(
    <div className={'lv-scrim is-' + kind} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className={'lv-sheet is-' + kind} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="lv-sheet-head">
          <div>{eyebrow && <span className="lv-eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2></div>
          <button type="button" className="lv-icon-btn" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="lv-sheet-body">{children}</div>
        {actions && <footer className="lv-sheet-foot">{actions}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Pill({ tone = 'off', children }: { tone?: Tone | 'accent'; children: React.ReactNode }) {
  return <span className={'lv-pill is-' + tone}>{children}</span>;
}

export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={'lv-switch' + (on ? ' is-on' : '')} disabled={disabled} onClick={onChange}><span /></button>;
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="lv-empty"><strong>{title}</strong>{children && <p>{children}</p>}{action}</div>;
}

export function Panel({ title, note, aside, children, className = '' }: {
  title?: React.ReactNode; note?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return <section className={'lv-panel ' + className}>
    {(title || aside) && <header className="lv-panel-head"><div>{title && <h2>{title}</h2>}{note && <p>{note}</p>}</div>{aside}</header>}
    {children}
  </section>;
}

export function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return <dl className="lv-facts">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function Alert({ children, onClose, tone = 'info' }: { children: React.ReactNode; onClose?: () => void; tone?: 'info' | 'error' }) {
  return <div className={'lv-alert is-' + tone} role={tone === 'error' ? 'alert' : 'status'}>
    <span>{children}</span>
    {onClose && <button type="button" className="lv-link" onClick={onClose}>关闭</button>}
  </div>;
}
