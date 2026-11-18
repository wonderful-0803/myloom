# Worker 能力装配

公司版的“办公场景”描述的是任务路由与交付方式，不是 DSH Worker 的工具上限。Worker 继续使用 DSH 的 AgentLoop 和已审核的 Worker preset；Loom 只在任务边界上增加授权、资源范围和结果验收。

当前 Worker preset 保留这些原生能力：

- `web_search`、`web_fetch`：公开资料检索与网页读取；
- `read`、`read_image`、`glob`、`grep`、`write`、`edit`：任务环境中的文件和图片处理；
- `bash`、`job_output`、`job_list`、`job_kill`：受 DSH sandbox 和任务目录限制的命令执行与后台作业；
- `skill`、`todo_write`、PTC 运行时和已登记的子任务控制工具；
- Loom 自己的 `orchestrator_read`、`orchestrator_artifact`、`orchestrator_report` 等任务工具。

## 能力目录

Worker 现在会为每项能力生成一份可审计的 manifest。旧配置只填写 `effect` 和 `description` 时仍然有效，解析后补齐以下字段：

- `version`：能力契约版本，当前内置能力为 `1`；
- `executor`：`native`、`runner` 或 `connector`，说明调用落点；
- `resources`：能力涉及的受控资源标签；
- `timeoutMs`、`maxOutputBytes`：可选的时间和结果预算；
- `requiresGrant`：是否需要额外资源／外部副作用授权。

Worker 调用 `orchestrator_capabilities` 时同时返回实际可见工具和完整声明目录。声明目录不等于授权，实际调用仍经过当前 preset、任务目录、连接器策略和租约检查。这样可以把“当前 Worker 会什么”和“本次任务能用什么”分开显示，也为后续按场景装配能力保留稳定契约。

`src/state/native.ts` 在 Worker 建立时装配 `WorkerCapabilities`。每次工具调用都要同时通过：当前 Agent 的 DSH 工具可见性、当前 permission preset、任务目录／读取根校验、Loom 任务授权和租约校验。外部写入类插件不能因为出现在 Skill 文本中就获得权限，必须提供 connector policy；调用会先写入 operation ledger，结果未知时任务保持核查状态，不自动重放。

本地文件和 Shell 使用任务专属工作目录，不能读取数据库、凭据或其他群的目录；`workspace-write` 仍由 DSH sandbox 执行，Loom 侧补充 canonical path 校验。网页检索不需要把联网权限误当成文件或外部写入权限。缺少网页、GitHub 或其他连接器时，Worker 必须提交 `blocked`／`waiting`，不能把“没有取得证据”的限制说明提交为 `ready`；研究类任务在完成前还要留下实际外部读取证据。

这轮实现位置：

- `src/state/worker-capabilities.ts`：原生能力清单、工具调用门禁、插件资源策略和研究证据；
- `src/state/worker-sandbox.ts`：任务路径 containment 和受限进程参数；
- `src/state/native.ts`：Worker preset 装配、工具执行回执和完成验收；
- `tests/state-contract/worker-capabilities.spec.ts`：能力表、路径逃逸、提权参数、外部连接器和 Linux sandbox 验收。

远程 Runner 的只读能力目录已增加 `fs.stat`。它只返回授权文件的相对路径、字节数和修改时间，不读取文件正文，也不改变现有 `fs.read`、`fs.glob`、`fs.grep` 的许可边界。实现位于 `src/execution/protocol.ts`、`src/execution/runner/files.ts`、`src/execution/company.ts` 和 `src/state/native.ts`，Runner grant 必须显式包含 `fs.stat`。

2026-11-16 AI 盒子部署 release `20261116-worker-capabilities-9d74e67b`。服务、Feishu consumer 和 LAN 工作台重启后就绪；实际 profile 检查确认 Worker preset 含网页、文件、Shell、job、Skill、todo、subagent 相关 DSH 插件。未发送新的群消息，原群／任务／产物记录保持不变。
