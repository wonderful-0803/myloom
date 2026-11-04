import React, { useEffect, useState } from 'react';
import type { FeishuSettingsPublic } from '../../shared/types';
import { Icon } from './Icon';
import { Modal, request } from './UI';

type SettingsResp = FeishuSettingsPublic & { webhookUrl?: string; webhookHint?: string };
interface Props { open: boolean; onClose: () => void; onSaved: (settings: SettingsResp) => void; initial?: SettingsResp | null }
const initialForm = { appId: '', appSecret: '', verifyToken: '', encryptKey: '', enforceSign: false };
const checklist = [
  { id: 'tunnel', title: '准备可访问的服务地址', detail: '将本地服务映射到 HTTPS 地址，或部署到可访问的服务器。' },
  { id: 'openplat', title: '配置事件订阅', detail: '在飞书开放平台填写服务地址，路径为 /api/feishu/webhook。' },
  { id: 'challenge', title: '完成地址验证', detail: '等待开放平台返回 URL 验证成功。' },
  { id: 'bot', title: '添加机器人并订阅消息', detail: '将机器人加入工作群，订阅 im.message.receive_v1。' },
];
const checklistKey = 'loom-p08-checklist-v8';

export function SettingsDrawer({ open, onClose, onSaved, initial }: Props) {
  const [form, setForm] = useState(initialForm);
  const [meta, setMeta] = useState<SettingsResp | null>(initial || null);
  const [tab, setTab] = useState('connection');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(''); setSaved(false); setLoading(true);
    try { setChecks(JSON.parse(localStorage.getItem(checklistKey) || '{}')); } catch { setChecks({}); }
    let cancelled = false;
    request<SettingsResp>('/api/settings/feishu').then((data) => {
      if (cancelled) return;
      setMeta(data); setForm({ ...initialForm, appId: data.appId || '', enforceSign: Boolean(data.enforceSign) });
    }).catch((error: Error) => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);
  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const body: Record<string, unknown> = { appId: form.appId.trim(), enforceSign: form.enforceSign };
      for (const key of ['appSecret', 'verifyToken', 'encryptKey'] as const) if (form[key]) body[key] = form[key];
      const data = await request<SettingsResp>('/api/settings/feishu', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setMeta(data); setForm((previous) => ({ ...previous, appSecret: '', verifyToken: '', encryptKey: '' })); setSaved(true); onSaved(data);
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  };
  const toggle = (id: string) => {
    const next = { ...checks, [id]: !checks[id] }; setChecks(next);
    try { localStorage.setItem(checklistKey, JSON.stringify(next)); } catch { /* This checklist also works without storage. */ }
  };
  if (!open) return null;
  return <Modal title="连接飞书" className="settings-modal" onClose={onClose} footer={<><span className="save-status" role="status">{saved ? <><Icon name="check" size={15} />配置已保存</> : '密钥仅保存在服务端'}</span><button className="btn-secondary" type="button" onClick={onClose}>关闭</button><button className="btn-primary" type="button" onClick={save} disabled={saving || loading}>{saving ? '保存中…' : '保存配置'}</button></>}>
    <div className="connection-status"><span className={'connection-glyph ' + (meta?.configured ? 'is-ready' : '')}><Icon name="link" size={21} /></span><div><strong>{meta?.connectionStatus === 'receiving' ? '已收到飞书事件' : meta?.configured ? '凭证已保存，等待事件' : '尚未连接飞书'}</strong><p>{meta?.configured ? '回执会尝试发送到飞书，送达结果会保留在事件记录中。' : '当前使用本地模拟，可以先体验完整处理流程。'}</p></div></div>
    <div className="filter-tabs settings-tabs" aria-label="连接设置分类">{[['connection', '应用凭证'], ['checklist', '接入检查']].map(([value, label]) => <button key={value} className={tab === value ? 'is-selected' : ''} type="button" onClick={() => setTab(value)} aria-pressed={tab === value}>{label}{value === 'checklist' && <span className="count">{checklist.filter((step) => checks[step.id]).length}/4</span>}</button>)}</div>
    {tab === 'connection' ? <div className="form-stack">
      <label className="field"><span>App ID</span><input value={form.appId} disabled={loading} onChange={(event) => { setForm({ ...form, appId: event.target.value }); setSaved(false); }} placeholder="cli_…" autoComplete="off" spellCheck={false} /></label>
      <label className="field"><span>App Secret{meta?.hasAppSecret && <span className="field-saved">已保存</span>}</span><input type="password" value={form.appSecret} disabled={loading} onChange={(event) => { setForm({ ...form, appSecret: event.target.value }); setSaved(false); }} placeholder={meta?.hasAppSecret ? '留空以保留现有密钥' : '输入应用密钥'} autoComplete="new-password" /></label>
      <div className="form-columns">
        <label className="field"><span>Verification Token</span><input type="password" value={form.verifyToken} disabled={loading} onChange={(event) => { setForm({ ...form, verifyToken: event.target.value }); setSaved(false); }} placeholder={meta?.hasVerifyToken ? '已保存，留空保留' : '可选'} autoComplete="new-password" /></label>
        <label className="field"><span>Encrypt Key</span><input type="password" value={form.encryptKey} disabled={loading} onChange={(event) => { setForm({ ...form, encryptKey: event.target.value }); setSaved(false); }} placeholder={meta?.hasEncryptKey ? '已保存，留空保留' : '加密事件推送时填写'} autoComplete="new-password" /></label>
      </div>
      <label className="checkbox-field"><input type="checkbox" checked={form.enforceSign} disabled={loading} onChange={(event) => { setForm({ ...form, enforceSign: event.target.checked }); setSaved(false); }} /><span>校验事件签名<small>连接真实工作群时使用签名校验。</small></span></label>
      <div className="webhook-box"><span className="field-label">事件接收地址</span><code>{meta?.webhookUrl || 'http://localhost:4567/api/feishu/webhook'}</code><p>飞书服务器需要能访问此地址，localhost 仅供本机测试。</p></div>
    </div> : <div className="connection-checklist"><p className="form-intro">完成应用配置后，按顺序检查以下事项。</p>{checklist.map((step, index) => <label className={'checklist-item ' + (checks[step.id] ? 'is-done' : '')} key={step.id}><input type="checkbox" checked={Boolean(checks[step.id])} onChange={() => toggle(step.id)} data-p08-step={step.id} /><span className="checklist-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{step.title}</strong><small>{step.detail}</small></span></label>)}<p className="field-note">勾选仅记录在当前浏览器中，不代表服务已通过连接验证。</p></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>;
}
