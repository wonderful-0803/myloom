# 计算、状态与执行环境分离：开发交接

更新：2026-11-09。本文与三个工作包基于当前工作区代码，不代表已经部署到公司服务器。总设计见 [服务端架构实施方案](../SERVER_ARCHITECTURE_IMPLEMENTATION.md)。

提交范围：执行接口和本目录文档独立提交。工作包提到的群模式、录音、Word 与公司试点背景来自现有工作区；它们的其他未提交实现不包含在本次执行接口提交中，须随各自功能另行合入。接手时先核对目标分支的实际模块与依赖，再落实涉及这些功能的改造点。

## 本轮已完成：执行接口抽象

这一步保留现有本机执行，把 DSH 的执行意图与本机实现之间的调用边界固定下来。

| 实现位置 | 本轮行为 |
| --- | --- |
| `src/core/model.ts` 的 `ExecutionTarget` | 新任务明确保存 `local`；旧任务没有 target 时明确按本机解释；预留 `runner` 的环境与工作空间 ID |
| `src/execution/port.ts` | `ExecutionPort`、带类型的操作请求、可信任务绑定、目标验证与 `LocalExecutionPort` |
| `src/app/runtime.ts` | Runtime 创建并共享同一个执行端口；构造参数允许受信宿主注入端口，网页和模型不能选择实现 |
| `src/executor/dsh.ts` | 目录准备、停止、停止确认、后台作业列表／收集／清理及空闲检查经过执行端口；准备前即检查目标 |
| `src/app/sessions.ts` | 原生工具和子 Agent 工具经过同一端口；绑定来源于当前任务，保留原生 DSH 返回结构及 AbortSignal |
| `src/app/task-control.ts` | 取消等待真实操作收敛；`ExecutionOutcomeUnknown` 留下 unknown 回执并暂停任务，不能直接交还 |
| `src/app/artifacts.ts` | 远程目标不能借 `artifact_file` 读取计算服务器上同名目录 |

本机工作区仍由现有准备命令和 `verifyDirectory` 管理。Loom 受控的 `orchestrator_*` 资源、报告与交付工具继续经过其现有服务和权限检查，不向设备发送报告、飞书凭据或邮件凭据。Router 的本机管理工具也没有变成设备工具。

当前端口明确拒绝所有 Runner 目标；DSH 的 workspace registry 同样拒绝为它创建真实目录。未提供网络传输、设备注册或远程执行配置入口。关闭桌面窗口后云端继续、计算容器任意替换等目标，仍需要下面的工作包。

### 接口约定

`ExecutionPort.run(request, options, local)` 是代码端口，**不是可直接上传的 RPC 格式**：

- `request` 含版本、requestId、operation、input，以及任务／轮次／实际 Session／主人／空间／目标／目录／控制版本绑定。
- `options.authorize()` 在实际分发前重新读取绑定及控制；延迟分发的适配器必须再次调用。任务切换目标或主人后，旧请求作废。
- `local(signal)` 仅封装本机原生实现；远程路由禁止调用该闭包作为失败回退，闭包也不能序列化。当前 `settle` 还包含 DSH 子 Agent 的计算侧等待，网关包必须拆出这一协调职责。
- 工具调用使用 DSH callId；本机生命周期调用使用新 UUID。这是关联标识，**尚未形成持久去重账本**。未来幂等键必须在首次持久建单时生成，重试沿用。
- `run` 不能用取消 Promise 提前宣布操作完成。取消成功、结果未知和设备离线必须分别处理。
- `directory` 当前是本机绝对路径。Runner 以资源句柄解析真实目录；不能把服务端准备命令、环境变量和路径原样传给设备。
- 现有 `tool` 同时经过文件、Shell、技能和子 Agent 等原生工具。远程上线前必须有完整的能力分类表；Agent／Skill 装配在计算侧，本地文件／进程／job 在环境侧，不能统一盲转发。

验证：`tests/execution-port.spec.ts` 覆盖本机真实目录准备、旧记录、原生结果、Runner／错误目标拒绝且不调用本机、子 Agent 绑定、延迟分发再核验、无法确认停止时不交接、unknown 暂停及真实操作生命周期。现有控制、运行时、并发和环境测试继续作为回归。

2026-11-09 本轮验证结果：专项 13 项通过；`pnpm typecheck` 通过；`pnpm test` 共 89 个文件通过、1421 项通过、4 项跳过；`pnpm build` 通过；工作包及项目文档的本地链接检查无缺失。以上为代码／隔离运行时证据，没有执行真实远程设备、公司数据迁移或服务切换。

提交前另将本包从其他未提交功能中拆出，在独立源码副本执行相同的 TypeScript、Vitest 与 tsdown 检查：85 个测试文件通过、1387 项通过、4 项跳过，类型检查及构建通过。本次远端提交以该独立版本为准；上段 1421 项是包含其余本地功能的工作区验证记录。

## 三个后续工作包

| 工作包 | 交付目标 | 可先独立开展的内容 |
| --- | --- | --- |
| [A：Loom 状态外置](LOOM_STATE.md) | 异步事务仓储、PostgreSQL、持久作业／控制／Outbox、外部文件存储 | 盘点 KV、异步仓储端口、SQLite 适配器契约测试、迁移工具 |
| [B：DSH 状态外置](DSH_STATE.md) | 外部 SessionPersistence、DSH 元数据、单写者租约与恢复 | 固定 DSH 版本、存储服务插件、句柄与事件持久化测试 |
| [C：网关与 Runner](GATEWAY_RUNNER.md) | 环境注册、授权路由、Linux Runner、执行回执与离线恢复 | 协议与模拟器、能力分类、本机资源授权、Runner 账本 |

建议顺序：A、B 可分别开发存储适配器；C 同时做协议及 Linux 隔离测试。A 先交付控制版本／持久执行账本和短事务，B 再接统一 Session 租约，C 才能开放真实远程任务。最终串联验收通过之前，生产仍使用现有本机端口。

共同主键先冻结为 `tenantId / spaceId / userId / ticketId / assignmentId / sessionId / environmentId / requestId`。这是目标协议；本轮代码仍使用现有 ActorRef、可选 loomSpace，尚无企业身份映射，不能把缺失 tenantId 解释成通配权限。首轮先一个企业实例、既有指定群与明确主人，不默认扩展跨群、私人资源共享或 A2A。

租约表与租约服务由 A 提供基础设施，B 定义 Session 单写者和 epoch 语义，C 在请求接受与执行前核验同一 epoch。三方不能分别维护互不关联的租约。外部发送仍由现有交付服务处理，不经 Runner 重复发送。

最终联合验收：同一任务由计算进程 A 推进，杀掉 A 后 B 从已提交状态恢复；主人暂停与人工版本保留；个人设备离线进入等待，重新上线先校验授权且不重复写入；关闭任一工作台不影响服务器任务。三个文档分别规定故障和迁移验收，不能以按钮或 mock 成功替代实测。
