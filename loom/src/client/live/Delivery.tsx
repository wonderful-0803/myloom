import React, { useId, useState } from 'react';
import type { LoomDeliverySetting, LoomResultReceipt } from '../../../../src/app/loom-types';
import { api, message, when } from './api';

type Mode = LoomDeliverySetting['mode'];
const names: Record<Mode, string> = { default: '跟随默认', feishu: '发回飞书', none: '只留在 Loom', mail: '发到绑定邮箱' };
const hints: Record<Mode, string> = {
  default: '使用全局的产物交付设置',
  feishu: '附上报告文件，群任务回原线程，跨会话资料转私聊',
  none: '飞书只收文字摘要，报告在 Loom 查看或导出',
  mail: '定稿发到已核对的本人邮箱',
};
const statuses: Record<string, string> = {
  queued: '等待投递', sending: '正在投递', sent: '已发到飞书', submitted: '邮箱服务器已接收', unknown: '结果待核查',
  cancelled: '已取消', blocked: '投递受阻', local: '已保留在 Loom',
};

/** Default or per-task delivery. Saving only affects later finals; "send now" publishes one fixed version once. */
export function Delivery({ setting, receipts = [], task, version, disabled, save, sendNow }: {
  setting: LoomDeliverySetting; receipts?: LoomResultReceipt[]; task?: boolean; version?: number; disabled: boolean;
  save: (mode: Mode, revision: number, mailboxKey?: string) => Promise<void>; sendNow?: () => Promise<void>;
}) {
  const group = useId();
  const [pick, setPick] = useState<Mode | null>(null), [mailbox, setMailbox] = useState<{ address: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempt = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (value) { setError(message(value)); } finally { setBusy(false); }
  };
  const shown = pick ?? setting.mode;
  const options: Mode[] = task ? ['default', 'feishu', 'none', 'mail'] : ['feishu', 'none', 'mail'];
  const sent = receipts.some(r => r.version === version && r.mode === setting.effectiveMode && ['queued', 'sending', 'sent', 'submitted', 'unknown', 'blocked'].includes(r.status));

  return <div className="lv-delivery">
    <fieldset className="lv-options" disabled={disabled || busy}>
      <legend className="lv-sr">{task ? '这个任务的交付方式' : '默认交付方式'}</legend>
      {options.map(mode => <label key={mode} className={shown === mode ? 'is-on' : ''}>
        <input type="radio" name={group} checked={shown === mode} onChange={() => { setPick(mode); setMailbox(null); setError(''); }} />
        <span><strong>{names[mode]}</strong><small>{mode === 'default' ? `当前默认：${names[setting.effectiveMode]}` : hints[mode]}</small></span>
      </label>)}
    </fieldset>
    {shown === 'mail' && <p className="lv-muted">
      {mailbox ? `将发至 ${mailbox.address}` : setting.address && !pick ? `已授权收件人 ${setting.address}` : '先核对绑定的本人邮箱，再保存授权。'}
      {pick && <button type="button" className="lv-link" disabled={busy} onClick={() => void attempt(async () => setMailbox(await api('/delivery/mailbox', 'POST', {})))}>核对绑定邮箱</button>}
    </p>}
    {pick && (pick !== setting.mode || pick === 'mail') && <div className="lv-actions">
      <button type="button" className="lv-btn is-primary" disabled={disabled || busy || (pick === 'mail' && !mailbox)}
        onClick={() => void attempt(async () => { await save(pick, setting.revision, mailbox?.key); setPick(null); setMailbox(null); })}>
        {busy ? '保存中…' : pick === 'mail' ? '授权并保存' : '保存'}
      </button>
      <button type="button" className="lv-link" onClick={() => { setPick(null); setMailbox(null); }}>取消</button>
    </div>}
    {sendNow && version && <div className="lv-actions">
      <button type="button" className="lv-btn" disabled={disabled || busy || !!pick || sent || setting.effectiveMode === 'none'} onClick={() => void attempt(sendNow)}>
        {sent ? '这一版已投递' : `立即投递 v${version}`}
      </button>
      <span className="lv-fine">同一版本和目的地不会重复投递</span>
    </div>}
    {receipts.length > 0 && <ul className="lv-receipts">{receipts.slice(0, 5).map(r =>
      <li key={r.id}><strong>v{r.version} · {statuses[r.status] ?? r.status}</strong><span>{r.destination} · {when(r.updatedAt)}</span>{r.detail && <p>{r.detail}</p>}</li>)}</ul>}
    <p className="lv-fine">设置只影响之后的定稿，不补发历史；暂停、接管、改稿或撤销授权会让旧的排队投递失效。</p>
    {error && <p className="lv-error" role="alert">{error}</p>}
  </div>;
}
