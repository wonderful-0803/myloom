import React from 'react';
import { Icon } from './Icon';
import { Modal } from './UI';

interface Props { open: boolean; onClose: () => void; onStartTrial: () => void; onOpenConnect: () => void }
export function Onboarding({ open, onClose, onStartTrial, onOpenConnect }: Props) {
  if (!open) return null;
  return <Modal title="认识你的 Loom 工作台" className="onboarding-modal" onClose={onClose} footer={<><button className="btn-secondary" type="button" onClick={() => { onClose(); onOpenConnect(); }}>连接飞书</button><button className="btn-primary" type="button" onClick={() => { onClose(); onStartTrial(); }}><Icon name="play" size={15} />运行本地演示</button></>}>
    <div className="onboarding-intro"><span className="onboarding-wordmark">Loom.</span><p>把反复跟进的工作，交给一套持续运行的处理流程。</p></div>
    <ol className="onboarding-steps">{[
      ['设置工作规则', '告诉 Loom 哪些事项值得处理。规则持续生效，不需要反复开启对话。'],
      ['接收并处理事件', '群消息、文档评论与日程提醒进入事件收件箱，再形成独立任务。'],
      ['查看交付与记录', '从任务进入交付物，阅读补丁说明与简报，按需导出处理记录。'],
    ].map(([title, text], index) => <li key={title}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
    <p className="field-note">当前版本使用本地规则执行器。无需飞书账号或模型密钥即可体验演示。</p>
  </Modal>;
}
