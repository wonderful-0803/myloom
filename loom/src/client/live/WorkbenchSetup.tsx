import { useEffect, useMemo, useState } from 'react';
import { api, message } from './api';
import { Alert, Facts, Panel, Pill } from './ui';

export interface WorkbenchCapability { id: string; name: string; required: boolean; scopes: string[]; events: string[]; status: string }
export interface WorkbenchBotView {
  status: 'unconfigured' | 'pending-permissions' | 'verified'
  appId?: string; botId?: string; name?: string; tenantKey?: string; boundBy?: string; boundAt?: string
  requiresRestart: boolean; requiredScopes: string[]; requiredEvents: string[]; requestedOptional: string[]; missingScopes: string[]
}
export interface WorkbenchStatus { uid: string; tenantKey: string; authorized: boolean; canManage: boolean; bot: WorkbenchBotView }

export function WorkbenchSetup({ initial, full = false, onReady }: { initial: WorkbenchStatus; full?: boolean; onReady?: () => void }) {
  const [status, setStatus] = useState(initial), [capabilities, setCapabilities] = useState<WorkbenchCapability[]>([]);
  const [appId, setAppId] = useState(''), [secret, setSecret] = useState(''), [optional, setOptional] = useState<string[]>([]);
  const [customScopes, setCustomScopes] = useState('');
  const [verification, setVerification] = useState<{ botId: string; name: string; missingScopes: string[] } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const current = status.bot;
  useEffect(() => { setStatus(initial); }, [initial]);
  useEffect(() => { void api<{ capabilities: WorkbenchCapability[] }>('/workbench/capabilities').then(value => setCapabilities(value.capabilities), () => undefined); }, []);
  const optionalCapabilities = useMemo(() => capabilities.filter(value => !value.required), [capabilities]);
  const selectedScopes = useMemo(() => optionalCapabilities.filter(value => optional.includes(value.id)).flatMap(value => value.scopes), [optional, optionalCapabilities]);
  const requestedScopes = useMemo(() => [...new Set([...selectedScopes, ...customScopes.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)])], [customScopes, selectedScopes]);
  const missing = verification?.missingScopes ?? current.missingScopes;
  const permissionUrl = (verification?.botId || current.appId) && missing.length ? `https://open.feishu.cn/app/${encodeURIComponent(appId || current.appId!)}/auth?q=${encodeURIComponent(missing[0]!)}&op_from=openapi` : 'https://open.feishu.cn/app';
  const verify = async () => {
    setError(''); setNotice(''); setVerification(null); setBusy(true);
    try {
      const value = await api<{ botId: string; name: string; missingScopes: string[] }>('/workbench/verify', 'POST', { appId, appSecret: secret, optionalScopes: requestedScopes });
      setVerification(value); setNotice('凭据和机器人身份已验证。权限清单仍需在飞书开放平台确认。');
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const bind = async () => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const value = await api<WorkbenchBotView & { message: string }>('/workbench/bind', 'POST', { appId, appSecret: secret, optionalScopes: requestedScopes });
      setStatus(current => ({ ...current, bot: value })); setSecret(''); setVerification(null); setNotice(value.message); onReady?.();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const quickCreate = async () => {
    setError('');
    try { const value = await api<{ consoleUrl: string; message: string }>('/workbench/quick-create'); window.open(value.consoleUrl, '_blank', 'noopener,noreferrer'); setNotice(value.message); }
    catch (cause) { setError(message(cause)); }
  };
  return <div className={full ? 'lv-workbench-setup is-full' : 'lv-workbench-setup'}>
    <Panel title={full ? '欢迎使用 Loom' : '飞书机器人绑定'} note={full ? '使用飞书身份进入，不设置 Loom 独立密码。' : '先验证机器人身份，再由管理员确认平台权限和发布状态。'}>
      <Facts items={[['飞书 UID', <code key="uid">{status.uid}</code>], ['租户', <code key="tenant">{status.tenantKey}</code>], ['当前业务授权', status.authorized ? '已授权' : '待管理员加入主人名单']]} />
      {!status.canManage && !status.authorized && <Alert tone="error">当前 UID 已被可信识别，但还没有任务、群和产物权限。请让 Loom 管理者把你加入对应群的主人名单。</Alert>}
      {!status.canManage && status.authorized && <Alert>当前 UID 可以使用已授权工作空间，但机器人运行连接只允许安装管理者登记和切换。</Alert>}
      {current.status !== 'unconfigured' && <div className="lv-stack-sm"><div className="lv-health"><Pill tone={current.status === 'verified' ? 'done' : 'attn'}>{current.status === 'verified' ? '机器人已验证' : '等待平台权限确认'}</Pill>{current.requiresRestart && <Pill>重启后切换运行来源</Pill>}</div><p className="lv-fine">{current.name} · <code>{current.appId}</code></p></div>}
      <div className="lv-actions"><button type="button" className="lv-btn" onClick={() => void quickCreate()} disabled={busy}>创建新的飞书智能体应用</button><span className="lv-fine">平台创建和审批仍由飞书完成</span></div>
      <div className="lv-form">
        <label className="lv-field"><span>已有机器人 App ID</span><input className="lv-input" value={appId} onChange={event => setAppId(event.target.value)} placeholder="cli_…" autoComplete="off" /></label>
        <label className="lv-field"><span>App Secret</span><input className="lv-input" type="password" value={secret} onChange={event => setSecret(event.target.value)} placeholder="只提交到 Loom 服务，不写入状态库" autoComplete="new-password" /></label>
      </div>
      {optionalCapabilities.length > 0 && <fieldset className="lv-checks"><legend>可选能力</legend>{optionalCapabilities.map(value => <label key={value.id}><input type="checkbox" checked={optional.includes(value.id)} onChange={event => setOptional(current => event.target.checked ? [...current, value.id] : current.filter(id => id !== value.id))} />{value.name}</label>)}</fieldset>}
      <label className="lv-field"><span>额外权限 scope（可选，用空格或逗号分隔）</span><input className="lv-input" value={customScopes} onChange={event => setCustomScopes(event.target.value)} placeholder="例如 drive:file:readonly" autoComplete="off" /></label>
      <div className="lv-actions"><button type="button" className="lv-btn" onClick={() => void verify()} disabled={busy || !appId || !secret}>验证机器人</button><button type="button" className="lv-btn is-primary" onClick={() => void bind()} disabled={busy || !verification || !status.canManage}>登记并绑定</button></div>
      {verification && <div className="lv-verification"><strong>{verification.name}</strong><span>机器人 ID：<code>{verification.botId}</code></span><span>待确认权限：{verification.missingScopes.length} 项</span>{verification.missingScopes.length > 0 && <a href={permissionUrl} target="_blank" rel="noreferrer">打开飞书权限页</a>}</div>}
      {!verification && current.status === 'pending-permissions' && <div className="lv-verification"><span>登记记录中有 {missing.length} 项待确认权限。</span><a href={permissionUrl} target="_blank" rel="noreferrer">打开飞书权限页</a></div>}
      {error && <Alert tone="error">{error}</Alert>}{notice && <Alert>{notice}</Alert>}
      <details className="lv-details"><summary>默认权限与事件清单</summary><p className="lv-fine">群消息、私聊、原线程回复、附件、群成员核验，以及 <code>im.message.receive_v1</code>。可选资料查阅和表格读取只在勾选后加入清单。</p><p className="lv-fine">飞书平台的审核、发布和敏感权限审批结果不会由 Loom 猜测。未确认前不会把绑定记录当成可用连接。</p></details>
    </Panel>
  </div>;
}
