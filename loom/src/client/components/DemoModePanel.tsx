import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  onRunFeishuDemo: (scene: 'A' | 'B') => Promise<void>; onRunBlockedDemo?: () => Promise<void>;
  onReset: () => Promise<void>; demoRunning: boolean; demoScene: 'A' | 'B';
  onExportAudit?: (format: 'json' | 'md') => void;
}
export function DemoModePanel({ onRunFeishuDemo, onRunBlockedDemo, onReset, demoRunning, demoScene, onExportAudit }: Props) {
  const [scene, setScene] = useState<'A' | 'B'>(demoScene);
  useEffect(() => setScene(demoScene), [demoScene]);
  return <section className="section-surface demo-lab">
    <div className="section-heading"><div><h2>选择一个演示场景</h2><p>使用模拟飞书事件，验证本地任务处理与结果交付。</p></div><span className="small-label">本地环境</span></div>
    <div className="scenario-grid">{[
      { id: 'A' as const, title: '处理除零异常', file: 'calc.js', description: '值班群报告异常后，执行器复现问题、写入保护条件并运行测试。' },
      { id: 'B' as const, title: '处理空值输入', file: 'format.js', description: '为格式化函数补上空值保护，并生成带验证结果的处理说明。' },
    ].map((item) => <label className={'scenario-option ' + (scene === item.id ? 'is-selected' : '')} key={item.id}><input type="radio" name="loom-scene" checked={scene === item.id} disabled={demoRunning} onChange={() => setScene(item.id)} /><span className="scenario-letter">{item.id}</span><span><strong>{item.title}</strong><code>{item.file}</code><p>{item.description}</p></span></label>)}</div>
    <div className="lab-actions"><button type="button" className="btn-primary" disabled={demoRunning} onClick={() => onRunFeishuDemo(scene)}><Icon name="play" size={15} />{demoRunning ? '正在运行…' : '运行场景 ' + scene}</button><span className="quiet-label">重新运行会重置本地演示数据。</span></div>
    <div className="lab-note"><Icon name="code" size={18} /><p>当前执行器使用确定性规则修改示例文件，并运行真实测试。演示用于验证处理流程，尚未接入通用模型执行器。</p></div>
    <div className="lab-utilities"><div><strong>其他操作</strong><p>检查失败分支，或导出本轮完整记录。</p></div><div className="button-group">{onRunBlockedDemo && <button type="button" className="btn-secondary" disabled={demoRunning} onClick={() => onRunBlockedDemo()}>测试阻塞路径</button>}{onExportAudit && <button type="button" className="btn-secondary" disabled={demoRunning} onClick={() => onExportAudit('json')}><Icon name="download" size={15} />导出 JSON</button>}<button type="button" className="btn-ghost" disabled={demoRunning} onClick={() => onReset()}><Icon name="reset" size={15} />重置演示</button></div></div>
  </section>;
}
