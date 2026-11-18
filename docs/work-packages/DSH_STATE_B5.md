# B5：真实 AgentLoop 的任务接续与控制验收

日期：2026-11-12。承接 [B4](DSH_STATE_B4.md)。部署目标仍是既有 AI 盒子，本轮开发与验证不切换盒子、现行个人实例或飞书监听。

## 本批实现

`src/state/native.ts` 的 SQL 公司执行路径继续使用真实 AgentFactory、稳定 Session ID 和同一应用/native owner/epoch。本批补齐：

1. **有序停机后的文本任务接续。**`DurableConsumer.stop()` 以内部 `ConsumerStopping` 原因取消。公司 Worker 等待实际 Agent 退出、写链 flush/close，并保存本 owner/epoch 的 `native-quiescent` 证明后，才能把当前作业留为 retry。恢复沿用原 requestId、固定输入快照和 Session ID。取消不再被误报成“执行结束但未提交结构化报告”。
2. **接续的保守条件。**同一事务复核主人/来源、授权、当前控制版本、全局暂停、任务及 Assignment 状态和未确认操作。人工接管、暂停、unknown、录音转写或授权不再有效时不自动恢复。有序停机标记不是通用异常重试许可；claim 丢失、旧进程没有物理停止证明、写入结果不明仍按既有流程 hold。
3. **计算独立恢复模型选择。**从原生 `model/selection`、`request/header` 事件重建 pending selection；匹配的实际请求消耗该 pending，后续使用最新 request header。SQL 路径不再依赖 UI SessionController 才能注册的 modelSelection 投影。复用原生 `installModelSelection`，每次推理前仍核对环境契约、preset、模型路由、来源和租约，不回退默认模型绕过校验。
4. **结构化报告后的实际收敛。**Router 保存 assessment 后、Worker 保存终态 report 后，通过本 Agent 的 `agent/pre-step` 结束循环，保留已完成工具结果，避免再发一次无意义模型请求。办公 Router 明确沿用 schema 的 `implementation_requested` 表示请求制作明确的交付物，并不限于写代码；规则、目标和授权检查仍然生效。Worker 明确先读当前任务及获准 origin，再提交完整报告。

`src/company.ts` 额外导出 `NativeOfficeBackend` 供编译产物联调；纯状态入口 `dsh-superagent/state` 不因该导出依赖原生能力装配。

## 验证形态与边界

入口：`scripts/smoke-dsh-office.mjs`，子进程与 profile：`scripts/fixtures/dsh-office.mjs`、`b5-presets.mjs`、`b5-deny-shell.mjs`。

- 固定实际安装的 **Harness 0.2.1-rc.3**；经真实 Loader 启动 registry、SessionStore、SessionProjections、preset registry、权限服务、SystemPrompt、Tools、AgentLoop、LlmRuntime、pi-ai HTTP/SSE adapter、SQL Session provider 和 workspace domain。没有用合成 AgentFactory 替代模型循环。
- 每个场景使用独立 SQL scope，三次独立 Node 进程与不同空 cwd。中途删除可重建的 scratch，按同一路径模板恢复，持久对象目录保留。不是把旧进程内存传给新进程，也不承诺任意改写 Session cwd。
- 默认模式用回环 OpenAI SSE 受控响应，使故障停点可复现；真实模型模式通过同一 adapter 转发已有模型服务。所有输入均为虚构 R1/R2，人工修改仅为 H1。没有读取真实群或个人历史，没有真实飞书消息/附件发送。
- 角色 preset 是通过真实 registry 注册的、审核过的空 composition，办公工具由真实公司执行适配器按任务挂载。测试环境没有可执行 shell；权限服务所需的 shell 默认声明来自拒绝执行的 fixture。这不是完整第三方插件、OS 沙箱、公司网络和端侧工具链验收。
- 飞书收发为隔离传输替身；产品任务、控制、版本、Blob、Outbox/交付和恢复均使用实际公司服务代码及 PostgreSQL。断点在 Worker 实际读过 ticket 和 origin 后、下一次模型请求发出时设置，随后等待取消与真实排空。

| 场景 | 验收事实 |
| --- | --- |
| `restart` | 执行到一半有序停机 → 新进程同 Session 接续 → 生成 R1/R2 报告 → 原消息线程目的地交付；原输入不重复，header 不变 |
| `takeover` | 同一停点由主人接管 → 等待真实 drained → 保存人工 v1/H1 → 新进程仍保持 human、会话无新事件 → 显式交还 → AI v2 保留人工内容 |
| `selection` | 中途持久化尚未使用的模型选择 → 重启后首个/后续请求使用获准的新模型 → 最新原生 request header 可复核 |
| 每场景第三次启动 | 已完成任务不再次运行、不再次发文件；原生事件数不变，持久对象中的报告仍能读取 |

单元/契约测试继续覆盖 SQLite 和真实 PostgreSQL：有序排空可 retry、无虚假失败报告、原输入去重、暂停/unknown 不能自动 retry、claim-loss 不能冒充有序停机、人工接管/旧 epoch 拒写以及未 flush 输入恢复。执行位置：`tests/dsh-state/company.spec.ts`、`tests/state-contract/runtime.spec.ts`、`service.spec.ts`、`native-stop.spec.ts`。模型循环语义由上述真实 rc.3 脚本单独验证，不将 fixture 的模拟循环视为 AgentLoop 证据。

## 复现

只使用可销毁、库名以 `_test` 结尾的 PostgreSQL；不要把生产连接填进该命令。数据库与模型密钥通过私有终端环境配置，不放在命令行参数、日志或仓库中。

```sh
pnpm typecheck
pnpm build
# 本机终端先设置 LOOM_DSH_B5_DATABASE_URL
pnpm dsh-state:smoke:office --harness-root /absolute/path/to/@deepseek-ai/dsh
```

默认执行三个受控模型场景；`--live` 默认只执行 restart 和 takeover，selection 保留给双回环模型。`--scenario restart|takeover|selection` 仅运行指定场景。默认脚本不发现个人账户或读取模型凭据。

真实模型另外显式设置 `LOOM_B5_LIVE_URL`（OpenAI 兼容 baseURL）、`LOOM_B5_LIVE_KEY`、`LOOM_B5_LIVE_MODEL`，再运行：

```sh
pnpm dsh-state:smoke:office --harness-root /absolute/path/to/@deepseek-ai/dsh \
  --live --scenario restart
```

真实模型的任务理解和工具顺序不保证和受控模型一致；如果没有实际完成要求，不输出通过。每次脚本最多 80 次回环模型请求、真实转发最多 30 次、单次上游请求超时 45 秒；每个计算子进程超时 120 秒。子进程只收到回环测试 key，真实模型密钥仅在父进程的私有环境中供转发使用。脚本清理自己的临时目录，不删除测试数据库；数据库容器由操作者单独销毁。

## 尚未覆盖

无停止证明的 SIGKILL 自动恢复、结构化附件/文件目录迁移、全 profile 的第三方插件兼容、生产容量/高可用、盒子正式切换、真实飞书重启交付和网关/Runner 仍未完成。B1 的原生日志故障测试不等于已验证任意外部副作用可安全重放；当前面对该情况保留 hold，需操作证据及后续执行账本。不能据本批宣布整个 B 包完成。

本轮实测结果与脱敏证据：见工作区 `.artifacts/dsh-state-b5-20261112/verification.json`；该目录不进入发布包。实际数据库凭据文件在验收后删除，专用测试容器销毁。最终验证如下：

- `pnpm typecheck`、`pnpm build` 通过；全量 **106 个测试文件、1619 项通过、4 项跳过**，包含真实 PostgreSQL。
- 实际 rc.3 Session/fork、managed lifecycle、workspace 文本归档迁移（none/zstd）四项编译后回归通过。
- 受控模型三场景共 9 个独立计算进程、16 次回环模型请求通过；最终工具结果持久化，终态由 pre-step 正常收敛。
- 真实 `deepseek-v4.1-flash-1017` 两场景共 6 个独立计算进程、10 次真实模型调用通过：有序重启后交付实际 Word 文件；人工接管/修改后保持 human，交还后 AI v2 保留 H1，原人工 v1 不变；每场景第三次启动均无新会话事件或重复文件。交付仅到隔离 FeishuWire，不是实际飞书发送。
- 对保留的真实模型 SQL 事件独立复核：末轮为 pre-step 拒绝后的 `blocked` 正常结束，而非后续推理失败；最终 report 的成功 tool/result 已刷盘，人工 v1 字节摘要仍吻合。
- `npm pack --dry-run` 验证新脚本、fixture 和本说明均纳入包，`.artifacts/` 未纳入；`git diff --check` 通过。
- 本轮没有改变现行 provider/模型/飞书配置，没有提交或推送代码。
