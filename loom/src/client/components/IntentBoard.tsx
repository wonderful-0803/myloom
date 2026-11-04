import React, { useState } from 'react';
import type { Mandate } from '../../shared/types';
import { Icon } from './Icon';
import { EmptyState, Modal, request } from './UI';

interface Props { mandates: Mandate[]; compact?: boolean }

export function IntentBoard({ mandates, compact = false }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('general');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy('new'); setError('');
    try {
      await request('/api/mandates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), description: description.trim(), scope }) });
      setTitle(''); setDescription(''); setScope('general'); setShowForm(false);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  };
  const toggle = async (mandate: Mandate) => {
    setBusy(mandate.id); setError('');
    try { await request('/api/mandates/' + encodeURIComponent(mandate.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !mandate.active }) }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  };
  const scopeLabel = (value: string) => ({ bugfix: '缺陷处理', reporting: '简报与说明', general: '通用' } as Record<string, string>)[value] || value;

  return <section className={'section-surface intent-board ' + (compact ? 'compact' : '')}>
    <div className="section-heading"><div><h2>工作规则 <span className="count">{mandates.length}</span></h2>{!compact && <p>定义持续生效的工作方向，随时启用或暂停。</p>}</div><button type="button" className="text-button" onClick={() => { setError(''); setShowForm(true); }}><Icon name="plus" size={15} />新增规则</button></div>
    {error && !showForm && <p className="form-error" role="alert">{error}</p>}
    {mandates.length === 0 ? <EmptyState icon="rules" title="还没有工作规则">运行演示会自动创建示例规则，也可以手动添加。</EmptyState> :
      <div className="rules-list">{(compact ? mandates.slice(0, 3) : mandates).map((mandate, index) => <div className={'rule-row ' + (!mandate.active ? 'is-paused' : '')} key={mandate.id}>
        <span className="rule-number">{String(index + 1).padStart(2, '0')}</span>
        <div className="rule-copy"><h3>{mandate.title}</h3>{mandate.description && !compact && <p>{mandate.description}</p>}<span className="rule-scope">{scopeLabel(mandate.scope)}<span className="separator">·</span>{mandate.active ? '已启用' : '已暂停'}</span></div>
        <button type="button" className={'switch ' + (mandate.active ? 'is-on' : '')} role="switch" aria-checked={mandate.active} aria-label={(mandate.active ? '暂停规则：' : '启用规则：') + mandate.title} disabled={busy === mandate.id} onClick={() => toggle(mandate)}><span /></button>
      </div>)}</div>}
    {showForm && <Modal title="新增工作规则" onClose={() => setShowForm(false)} footer={<><button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>取消</button><button type="submit" form="rule-form" className="btn-primary" disabled={busy === 'new' || !title.trim()}>{busy === 'new' ? '保存中…' : '创建规则'}</button></>}>
      <p className="form-intro">描述希望持续处理的事项。规则保存后立即生效。</p>
      <form id="rule-form" className="form-stack" onSubmit={submit}>
        <label className="field"><span>规则名称 <span className="required">*</span></span><input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：复现并修复简单缺陷" /></label>
        <label className="field"><span>处理范围</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="general">通用</option><option value="bugfix">缺陷处理</option><option value="reporting">简报与说明</option></select><small>当前演示执行器支持缺陷补丁和简报模板。</small></label>
        <label className="field"><span>具体说明</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="什么情况下介入，期望交付什么结果…" /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </Modal>}
  </section>;
}
