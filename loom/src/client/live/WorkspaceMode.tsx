import React, { useState } from 'react';
import { api, enc, message } from './api';
import { useWorkspace } from './context';
import { Panel, Pill } from './ui';

/** Same product and runtime; changes require the local management identity and fresh membership verification. */
export function WorkspaceMode() {
  const { data, locked, run } = useWorkspace();
  const workspace = data.workspace, shared = workspace?.mode === 'group';
  const managementLocked = locked || workspace?.canManage === false;
  const [revision, setRevision] = useState(data.policyRevision);
  const [mode, setMode] = useState<'personal' | 'group'>(shared ? 'group' : 'personal');
  const [chat, setChat] = useState(workspace?.group?.chatId ?? data.connection.chats[0]?.chatId ?? '');
  const [members, setMembers] = useState<{ id: string; name?: string }[] | null>(null);
  const [selected, setSelected] = useState<string[]>(workspace?.group?.masters.map(person => person.id) ?? (workspace?.operator ? [workspace.operator] : []));
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const load = async () => {
    setLoading(true); setError('');
    try { setMembers((await api<{ members: { id: string; name: string }[] }>(`/workspace/members?chatId=${enc(chat)}`)).members); }
    catch (value) { setError(message(value)); } finally { setLoading(false); }
  };
  return <Panel title="运行模式" note="同一套 Loom，按使用场景选择服务对象">
    <Pill tone={shared ? 'run' : 'off'}>{shared ? '群内共享' : '个人模式'}</Pill>
    {shared && <p className="lv-fine">{workspace?.group?.name} · 当前已生效的主人：{workspace?.group?.masters.map(person => person.name || person.id).join('、')}</p>}
    <fieldset className="lv-options" disabled={managementLocked || loading || workspace?.scopeFixed}>
      <legend className="lv-sr">选择运行模式</legend>
      <label><input type="radio" name="workspace-mode" checked={mode === 'personal'} onChange={() => setMode('personal')} /><span><strong>个人模式</strong><small>继续处理本人任务、邮箱和私人记录</small></span></label>
      <label><input type="radio" name="workspace-mode" checked={mode === 'group'} onChange={() => setMode('group')} /><span><strong>群内共享</strong><small>一个机器人服务一个群，只接受所选主人的工作要求</small></span></label>
    </fieldset>
    {workspace?.scopeFixed && <p className="lv-fine">公司服务固定在当前工作空间；切换群或个人模式需由管理员建立独立空间，避免混入历史资料。</p>}
    {mode === 'group' && <>
      <label className="lv-field"><span>工作群</span><select className="lv-input" value={chat} disabled={managementLocked || loading || workspace?.scopeFixed} onChange={event => { setChat(event.target.value); setMembers(null); setSelected(workspace?.operator ? [workspace.operator] : []); }}>
        {!chat && <option value="">请先配置监听群</option>}{data.connection.chats.map(group => <option key={group.chatId} value={group.chatId}>{group.name}</option>)}
      </select></label>
      <div className="lv-actions"><button className="lv-btn" type="button" disabled={managementLocked || loading || !chat} onClick={() => void load()}>{loading ? '读取中…' : '读取群成员，选择主人'}</button></div>
      {members && <fieldset className="lv-checks"><legend>允许发起和控制任务的主人</legend>{members.map(person => <label className="lv-check" key={person.id}>
        <input type="checkbox" checked={selected.includes(person.id)} disabled={managementLocked || person.id === workspace?.operator} onChange={event => setSelected(event.target.checked ? [...selected, person.id] : selected.filter(id => id !== person.id))} />
        <span>{person.name || person.id}{person.id === workspace?.operator ? '（管理者，始终保留）' : ''}</span>
      </label>)}</fieldset>}
      <p className="lv-fine">勾选并保存后，每位主人都可以在本群发起、补充和控制任务。“管理者”也是主人之一，负责维护配置，必须保留在名单内。</p>
      <p className="lv-fine">未勾选成员的讨论只作为本群资料，不触发任务。静默接单需在“委托”里开启自动执行，并具备群全部消息权限；识别为符合规则的需求后才会开工。观察模式只记录候选需求。</p>
      <p className="lv-note">支持群文字上下文、任务、接管和原线程报告。录音纪要需在“委托”中授权并配置转写服务；云文档、多维表格和内网资源连接器仍待接入。</p>
    </>}
    <div className="lv-actions"><button type="button" className="lv-btn is-primary" disabled={managementLocked || loading || !workspace || mode === 'group' && (!members || !selected.length)} onClick={() => void run(async () => {
      const result = await api<{ message: string; revision: number }>('/workspace', 'PUT', { mode, revision,
        ...(mode === 'group' ? { chatId: chat, masters: members!.filter(person => selected.includes(person.id)) } : {}) });
      setRevision(result.revision);
      return result.message;
    })}>保存运行模式{mode === 'group' ? '与主人名单' : ''}</button></div>
    <p className="lv-fine">{workspace?.scopeFixed ? '仅管理员可以保存主人名单；移除主人会重新核验相关任务授权。' : '切换模式会重启调度会话；历史不重放，个人资料不转入共享群。管理页面仍仅供本机或公司服务器管理员使用。'}</p>
    {error && <p className="lv-error" role="alert">{error}</p>}
  </Panel>;
}
