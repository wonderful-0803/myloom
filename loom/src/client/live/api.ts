/** Workspace API client and shared labels for the live Loom page. Paths and payloads match src/app/loom.ts. */
import type { LoomTask } from '../../../../src/app/loom-types';

const base = '/orchestrator/api/loom';

export type Request = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;

export const api: Request = async <T,>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
  const response = await fetch(base + path, {
    method, signal,
    headers: { 'x-orchestrator-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求未完成，请刷新后重试。');
  return data as T;
};

export const enc = encodeURIComponent;

export const controlName: Record<LoomTask['control']['mode'], string> = {
  agent: '助手执行', pausing: '正在暂停', paused: '已暂停', taking_over: '正在移交', human: '本人已接管',
};
export const draftName: Record<string, string> = {
  ready: '待查看', confirmed: '已确认', queued: '排队中', running: '起草中', failed: '起草失败', interrupted: '已中断', budget: '已达预算上限',
};
export const mailName: Record<string, string> = {
  preview: '等待确认', cancelled: '已取消', submitted: '邮箱服务器已接收', delivered: '已送达', unknown: '结果待核查',
  sending: '正在提交', drafting: '正在准备', draft: '邮件草稿已创建', blocked: '提交受阻',
};
export const modeName = { auto: '自动执行', observe: '仅观察', off: '已关闭' } as const;
export const ruleName: Record<string, string> = { 'office-summary': '工作总结与纪要', 'office-data': '数据汇总', 'office-research': '资料查阅', 'quick-answer': '简短答复' };
export const decisionName: Record<string, string> = { accept: '已接单', ignore: '已观察', unavailable: '评估未完成', stop: '已停止' };

export type Tone = 'run' | 'wait' | 'attn' | 'done' | 'off';

/** One label per task, in the order a person cares about: control first, then outcome, then execution. */
export function taskState(task: LoomTask, paused: boolean): { label: string; tone: Tone } {
  if (task.control.mode !== 'agent') return { label: controlName[task.control.mode], tone: task.control.mode === 'human' ? 'attn' : 'wait' };
  if (task.completed) return { label: '已完成', tone: 'done' };
  if (task.status === 'blocked') return { label: '需要处理', tone: 'attn' };
  if (task.status === 'ended') return { label: '已结束', tone: 'off' };
  if (paused) return { label: '等待全局恢复', tone: 'wait' };
  if (task.executionState === 'queued') return { label: '等待 Worker', tone: 'wait' };
  if (task.executionState === 'waiting') return { label: '等待补充', tone: 'wait' };
  return { label: '执行中', tone: 'run' };
}

export function needsYou(task: LoomTask) {
  return task.status === 'blocked' || task.control.mode === 'human' || task.control.mode === 'taking_over';
}

export function when(at: number | string, full = true) {
  const value = typeof at === 'string' ? Date.parse(at) : at;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value);
}

export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(Math.max(0, ms))} 毫秒`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
