import { createContext, useContext, useEffect, useState } from 'react';
import type { LoomDeliverySetting, LoomResultReceipt, LoomSnapshot } from '../../../../src/app/loom-types';
import { api, enc } from './api';

export type Page = 'overview' | 'tasks' | 'library' | 'inbox' | 'delegations' | 'codex' | 'sync' | 'settings';
export type TaskView = 'all' | 'active' | 'attention' | 'done';
export type LibraryView = 'reports' | 'drafts';
export type View = TaskView | LibraryView;

export interface Workspace {
  data: LoomSnapshot;
  /** Disables writes while a request is running or the snapshot is stale. */
  locked: boolean;
  /** Runs one write, shows its error or the given confirmation, then refreshes the snapshot. */
  run: (work: () => Promise<string | void>) => Promise<boolean>;
  refresh: () => Promise<void>;
  notify: (text: string) => void;
  /** Switches page; `view` picks a tab or filter on that page, `delegation` narrows tasks/deliverables to one delegation. */
  go: (page: Page, options?: { view?: View; delegation?: string }) => void;
  openTask: (id: string) => void;
  openDoc: (subject: string, version?: number) => void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace context missing');
  return value;
}

export type TaskDelivery = { setting: LoomDeliverySetting; receipts: LoomResultReceipt[] };

/** Per-task delivery setting and receipts, refreshed every 3s while visible. */
export function useTaskDelivery(subject: string | undefined) {
  const [value, setValue] = useState<TaskDelivery | null>(null);
  useEffect(() => {
    setValue(null);
    if (!subject) return;
    let active = true;
    const load = () => api<TaskDelivery>(`/tasks/${enc(subject)}/delivery`).then(next => { if (active) setValue(next); }, () => { if (active) setValue(null); });
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [subject]);
  return [value, setValue] as const;
}
