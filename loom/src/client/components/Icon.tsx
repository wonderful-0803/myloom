import React from 'react';

const paths = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  tasks: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="m8 9 1 1 2-2m3 1h3M8 15h3m3 0h3" /></>,
  events: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  rules: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 14h8m-8 3h5" /></>,
  settings: <><path d="m9 3-1 3-3 1v4l2 2-1 3 3 3 3-1 3 1 3-3-1-3 2-2V7l-3-1-1-3Z" /><circle cx="12" cy="11" r="3" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01" /></>,
  arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  play: <path d="m8 5 11 7-11 7Z" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v4m0 4h.01" /></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" /></>,
  message: <path d="M21 14a3 3 0 0 1-3 3H9l-6 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2" /></>,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" /></>,
  reset: <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" /></>,
  link: <><path d="m10 13 4-4m-7 6-1 1a4 4 0 0 0 6 6l4-4a4 4 0 0 0 0-6m1-3 1-1a4 4 0 0 0-6-6L8 6a4 4 0 0 0 0 6" transform="translate(0 -2)" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  leaf: <><path d="M20 3C8 2 3 7 4 14c1 6 7 7 11 4 4-3 5-8 5-15Z" /><path d="M4 21 15 9" /></>,
} satisfies Record<string, React.ReactNode>;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={'icon ' + className} aria-hidden="true">{paths[name]}</svg>;
}

export function LoomMark() {
  return <svg viewBox="0 0 32 32" fill="none" className="loom-mark" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" /><path d="M10 7v18m6-18v18m6-18v18M7 11h18M7 17h18M7 23h18" stroke="var(--logo-thread)" strokeWidth="1.3" /><path d="M16 11h6v6h-6Z" fill="var(--logo-thread)" /></svg>;
}
