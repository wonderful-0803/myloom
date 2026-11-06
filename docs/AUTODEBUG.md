# AutoDebug：在飞书群里跟踪 BugFixer 修复

2026-11-05 按用户要求接入。Loom 在本人明确要求时启动、跟踪或停止本机 BugFixer（AI-Native: AutoDebug）的一轮自动修复，每张 Bug 出结果时在群里单独发一条，整轮结束单独发汇总。BugFixer 自身的接票、修复、审查、验证、Gitee 草稿 PR 和飞书 Bug 表回写规则不变；Loom 不直接接触飞书 Bug 表、Gitee 或其凭据。

## 怎么用

在已监听的群（当前为「AI-Native:AutoDebug」）或机器人私聊里，由本人明确提出：

- 「Shannon 跑一轮自动修复」：没有在跑的轮次时启动一轮，并跟到结束。
- 「Shannon 盯一下这轮修复」：跟踪已经在跑的轮次（包括命令行启动的）。
- 「Shannon 修复进行到哪了」：读取状态并回答。
- 「Shannon 停止自动修复」：打开 BugFixer 的停止开关。

播报只有三类：开始（几张票、顺序）、每张票的结果（开出草稿 PR 附链接，或转人工附原因）、结束汇总。修复中、验证中等中间状态不播报。开始、每张票的结果和结束汇总都以群里的单独新消息发出（不回复原消息、不进话题）；只有确认收到仍回复在原消息下。

## 范围与权限

| 项目 | 约定 |
| --- | --- |
| 触发 | 规则 `autodebug`：仅本人明确请求；推断的意图和他人的消息不启动、不停止修复 |
| 可执行命令 | `integrations/autodebug/autodebug.py` 的 `status`、`start`、`stop`、`watch`；`start --resume` 仅在本人明确要求恢复时使用 |
| 不允许 | 修改 BugFixer 配置、`.env` 或代码；其他 `bugfixer.cli` 命令（publish、pilot、batch、`run --new-session`、recover、notify）；git push、调用 Gitee、改飞书 Bug 表、合并或批准 PR |
| 读取范围 | BugFixer 的 `.local/pilot-runs/automatic-*/`（`active.json`、`snapshot.json`、`report.json`、`final-report.json`）、`.local/state.db` 停止开关（只读）、`/proc` 中的 `bugfixer.cli run` 进程 |
| 写入 | `start` 在 BugFixer 的 `.local/service-runs/<时间>/` 写日志与进程信息并更新 `latest.json`；任务目录内的 `autodebug-state.json` 记录已播报事件 |
| 产物 | 群内每条播报经 Loom 的回复出口发送，有发送回执；结束汇总是任务的就绪结果 |

启动的轮次独立于 Loom 任务进程：暂停或接管 Loom 任务只停止跟踪，不会中断 BugFixer；要停止修复须明确说「停止」。BugFixer 的停止开关打开后，`start` 会拒绝，须本人明确要求恢复。

## 实现

- 阶段结果（milestone）报告：Worker 用 `orchestrator_report` 的 `milestone: true` 报告一项可处理的结果，主会话用回复用途 `milestone` 在原会话发一条；同一报告重试或改写措辞只发一次，任务结束后不再允许。阶段结果标为 `standalone`，发过阶段结果的任务，其最终结果也标为 `standalone`（`Ticket.milestones` 计数）；飞书用 `+messages-send` 发到会话本身而不是回复原消息。其他任务的结果仍是回复（`src/core/ports.ts`、`src/sources/feishu-channel.ts`，`tests/registry.spec.ts`）。实现：`src/core/assignments.ts`、`src/core/replies.ts`、`src/core/model.ts`、`src/app/notices.ts`、`src/app/tools/executor.ts`、`src/app/tools/main.ts`、`prompts/replies.md`、`prompts/work.md`。普通进展仍只留在内部，其他任务行为不变。
- BugFixer 桥接：`integrations/autodebug/autodebug.py`（只用标准库）；Skill 原文 `integrations/autodebug/SKILL.md`，以团队 Skill `autodebug` 通过提示词配置接口登记（提示词版本 2）；规则 `autodebug` 通过设置接口保存（policy revision 5）。
- 提示词与工具总长度预算因阶段结果说明上调：主会话 59000→59200、Worker 40500→40900（`tests/model-surface.spec.ts`）。

## 验证

- `tests/core-engine.spec.ts`：阶段结果每份报告只发一次（改写措辞复用同一消息）、普通进展和已结束任务被拒绝、阶段结果不能同时是就绪、阻塞、提问或回答，任务在阶段结果后继续运行。
- `tests/runtime-concurrency.spec.ts`：阶段结果报告转给主会话，普通进展仍不转。
- `tests/autodebug.spec.ts`：模拟一轮三张票，开始、逐张结果、结束各只报告一次，中间状态不报告；任务首次跟踪时旧轮次记为已读、不重放；停止开关打开时拒绝启动。
- 全量 `pnpm check`（C 语言环境）1343 项通过。
- 对真实 BugFixer 目录只读运行 `status`、`watch`：正确读出 2026-11-05 15:24 那一轮 16 张票（0 张开出 PR、16 张转人工），首次跟踪未重放。
- 飞书群实测（2026-11-05）：本人在「AI-Native:AutoDebug」群发「Shannon 修复进行到哪了」，按规则 `autodebug` 接单，只读回答当前轮次（17:08 由命令行启动、6 张票）与上一轮汇总，未启动或停止修复。随后发「Shannon 盯一下这轮修复」，任务 `92e9dc2a` 在 17:16–17:40 间逐张播报 6 条阶段结果（BUG-0010、0003、0022、0002 开出草稿 PR `pulls/11`；BUG-0006 候选引入回归失败、BUG-0019 补丁为空或文件数超限，转人工），17:40 发出结束汇总，任务以 completed 结束。各条与 BugFixer 的 `report.json`、`final-report.json` 一致，无重复播报。
- 偏差：跟进已在运行的轮次时，Worker 没有发送开始播报；逐张结果和汇总不受影响。
- 尚未验证：由 Loom 启动一轮（`start`）及停止（`stop`）的真实路径；两者会改飞书 Bug 表状态或停止开关，须本人明确发起。
