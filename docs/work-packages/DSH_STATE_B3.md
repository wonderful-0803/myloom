# B3 首批：公司执行与原生 Session 统一所有权

日期：2026-11-11。前置：[B1 SQL provider](DSH_STATE_B1.md)、[A 公司入口](COMPANY_PRODUCT.md)。部署目标仍是既有 AI 盒子；本轮只修改仓库和隔离验证，**没有切换现行服务、迁移真实历史或扩大飞书权限**。

## 本批完成范围

公司任务和原生 Session 不再分别取得两份租约。`NativeOfficeBackend` 在 A 的事务中取得一次 Session lease，将同一个 tenant/space、Session ID、owner、epoch 交给 SQL provider。原生事件、业务工具、输入确认、报告和产物围绕这一权威检查；作业 claim 仍只表示调度权，不替代 Session lease。

原生 Agent 使用 `AgentRegistry.create/resume` 的 `setup` 接缝，在发布和启动前安装当前工具守卫、推理请求守卫与模型选择；持有实际 `AgentHandle`，结束时负责销毁。已存在的另一活跃 Agent 不被直接收养。

本批实现受控的有序关闭、重开与输入核对。**不包含强杀后任务自动接续、完整元数据 backend、旧日志导入或生产 profile 切换**；B 包整体仍未完成。

## 实现位置

| 位置 | 实际职责 |
| --- | --- |
| `src/dsh-state/ownership.ts` | `NativeWriterBinding`：宿主内部借用现有 lease，续租、故障信号及本 Session 的 flush/close；不新增 lease 或释放应用租约 |
| `src/dsh-state/provider.ts` | `useLease` 的异步作用域；核验同 provider/Session；每 owner/epoch 的原生写句柄排他；关闭时先通知宿主并保留最终事件路由，等待排空 |
| `src/dsh-state/handle.ts` | append 同事务校验应用 lease 和原生句柄 token；借用模式不自行续租或释放 lease；旧 close 不释放新 owner |
| `src/state/native.ts` | Router/Worker 受管创建和恢复、推理前门禁、固定输入账本、工具授权、物理 drain 回执和停止消费者 |
| `src/app/delivery.ts` | 可传入每 Session 的持久屏障，保留稳定 messageId 与历史/inbox 去重，避免无关故障会话阻塞当前任务 |
| `src/state/controls.ts` | `requireAgent` 同事务检查全局暂停，和现有控制版本、人工接管及在途限制共同保护报告/产物 |
| `src/company.ts` | 显式 `nativeState: external` 才采用 SQL provider，复用其相同仓储实例与 scope，拒绝混合模式和本地降级 |

`grant/native-writer/<Session哈希>` 是应用 lease 内的**写句柄声明**，记录 owner/epoch/token/active，不是独立租约，也没有第二个过期时钟。即便错误地把同一宿主能力交给第二 provider，它也不能再开一个活跃原生写句柄。生产能力只在宿主代码中传递，不进入模型工具参数或客户端。

## 一轮执行的顺序

1. A 校验当前主人、来源、控制版本和全局暂停。Worker 核查 `native-task-owner/<ticket>` 指向的上一轮：必须已有匹配的实际停止回执，不能通过换 Assignment 绕过。
2. 原子取得 Session lease，将相同 owner/epoch 保存到 `worker-binding/<ticket>/<assignment>` 和任务 owner 指针。
3. `provider.useLease` 借用这一 lease，启动唯一续租链；每次 create/open 的 native handle 校验该能力并登记排他 token。
4. 按固定 scratch 路径检查原 header 的 cwd/preset。创建或恢复真实 Agent 时，先禁用继承工具并安装守卫，再挂载角色 preset、模型选择及既有权限预设。缺少 preset/模型投影、目录不符或陌生 inbox 均拒绝推进。
5. 安装本轮来源、报告等受控工具，投递稳定 requestId 的输入。恢复的推理请求在输入账本及当前轮次事实确认之前等待，不提前触发模型。每次推理和工具前后再查 job、租约、来源、委托与控制。
6. 原生输入 flush 成功后才写入消费确认；输入未到达/读入、新需求未送达时，不能提交完成报告。报告与产物事务继续检查当前 lease、Assignment、控制和暂停，保留人工版本约束。
7. 结束或取消时停止 Agent 与后台工作，等待 idle/停止确认，销毁所属 `AgentHandle`，排空并关闭 native handles。随后在同一事务核验 lease、保存 `native-quiescent/<session>/<epoch>`，最后释放租约。

SQL Router 也复用此受管生命周期与请求门禁；它只提交结构化判断，不获办公执行工具。Router 的租约保护判断提交，不能将模型请求计费宣称为 exactly-once。

## 输入重试与恢复边界

SQL 模式输入账本使用 `protocol: sql-lease-v1`，记录 `delivering → queued → consumed`、原始固定 payload、摘要、来源 basis、actor 和 Session。basis 排除投递/阅读时间等可变事实，但保留任务、Assignment、委托和原始输入。重试重新验证授权后使用相同快照；同 requestId 换内容、主人或原始要求被拒绝。

- 已持久的原始 messageId 不再追加第二遍。
- 新协议的 delivering/queued 若在历史和 inbox 均缺失，可按原 ID 重新排队；旧协议或 consumed 却没有原生日志时要求显式核对。
- 已消费输入不会唤醒恢复后的 idle Agent。此时新增 `<requestId>/recovery/<epoch>` 的可审计恢复通知，引用原历史，要求核对现有产物及未知执行；通知不冒充第二条人工需求。
- flush 回执失败不会确认消费，也不会继续工具。故障收敛时，只有实际销毁与最终 drain 成功才保存停止回执。

固定 payload 是私有业务正文，位于受 tenant/space 保护的状态库和备份中；不得通过日志、进度投影或无授权 API 暴露。其清理须遵循任务/原生历史的统一保留策略，不能单独删除去重事实再盲重放。

接管请求先撤销业务推进，停止消费者等本轮 lifecycle 的真实回执。另一个计算进程仍持有有效租约时重试；租约已过期而缺少回执时 **hold**。SIGKILL、主机失联和外部操作 unknown 仍需后续恢复协议或有证据的人工核对，不能伪造旧进程已经停止。B1 的日志级 SIGKILL 恢复不等于这里的整个业务任务可自动恢复。

## 配置接入约束

当前默认仍为 `nativeState: configured`，使用原先安装的 provider。新的公司配置选项是：

```json
{
  "nativeState": "external"
}
```

这是私有公司配置的新增字段示意，不能作为完整配置文件使用。运维须在隔离 profile 显式关闭默认 SessionPersistence，挂载 `dsh-superagent/dsh-state`，并使用一致 tenantId/spaceId 和数据库凭据引用。公司入口直接复用 provider 的仓储对象，不另开第二权威；未挂载正确 provider 或 scope 不匹配则启动失败，禁止降级。配置中 `databaseUrlEnv` 仍为显式 `LOOM_*` 引用，建议与 provider 相同；真实凭据不进入仓库。

本轮未交付生产自动切换补丁。现有 workspace/会话目录、preset 定义、模型连接器配置和 KV domain 尚未完整外置，仍需当前受管 profile。旧 header 的 cwd/preset 不符时必须迁移或保留兼容执行池，不能修改不可变 header 来伪装恢复。

## 验证与复现

`tests/dsh-state/company.spec.ts` 在 SQLite 和真实 PostgreSQL 上验证：Router 关闭；共用 owner/epoch；受控工具与产物；接管等待真实 dispose；旧 epoch 工具/报告拒绝及新 lease 不被释放；全局暂停；flush 回执丢失后原输入去重；关闭并删除计算目录后的同 ID 接续。AgentFactory/模型为合成夹具，SessionStore、SQL provider、状态事务和公司适配器为真实实现。

`tests/state-contract/service.spec.ts` 另外把 SQL provider 接入真实 CompanyServer/持久作业守卫、输入事实、产物和原线程交付链；Feishu/OAuth/模型为替身，不向真实群发送。

`scripts/fixtures/dsh-managed.mjs` 通过编译产物和实际安装的 **DSH 0.2.1-rc.3 AgentRegistry/AgentLoop**，在两个独立进程、不同空计算 cwd 上创建、恢复和销毁同 ID Agent。验证 setup 发生在发布前、借用 lease 不额外递增 epoch、实际 Agent 销毁后才释放应用 lease。模型调用被替身明确拒绝，因此这项是**真实 idle Agent 生命周期验证**，不冒充真实模型任务接续。

```sh
pnpm typecheck
pnpm build
pnpm test:dsh-state
pnpm exec vitest run tests/state-contract/service.spec.ts tests/state-contract/native-stop.spec.ts
pnpm dsh-state:smoke:managed --harness-root /absolute/path/to/@deepseek-ai/dsh
```

双数据库测试需在安全终端设置 `LOOM_STATE_TEST_DATABASE_URL`，rc.3 冒烟需设置 `LOOM_DSH_B1_DATABASE_URL`。均只用数据库名以 `_test` 结尾的专用测试库；不要填入生产 URL。测试使用随机隔离 scope，无真实业务历史、模型或飞书调用。脱敏日志保存在本机 `.artifacts/dsh-state-b3-20261111/`；最终结果见其中 `verification.json`。

最终验证：全量 **104 个文件、1584 项通过、4 项现有跳过**，包含 SQLite 与真实 PostgreSQL 16；类型检查、编译、最新编译产物的普通 rc.3 SessionStore 冒烟与受管 idle Agent 两进程冒烟均通过。四项跳过保留现有测试声明，不作为已验收证据。测试 PostgreSQL 是本次临时容器，验证后删除，不连接 AI 盒子或真实业务库。

## 后续工作

以下为 B3 交付时的待办；2026-11-12 元数据/workspace 和文本历史迁移已随 [B4 首批](DSH_STATE_B4.md) 实现，附件与完整恢复仍待后续。

1. **B4 元数据及迁移**：SQL KV backend、domain 单 owner/缓存失效、workspace/title/preset 配置版本、附件资源、旧日志 dry-run/import/回滚，不迁移密钥。
2. **B3 剩余故障恢复**：在有外部执行/网关回执后，设计缺少停止证据的崩溃恢复与 unknown 核对；先保持 hold，禁止盲重做。
3. **B5 完整场景**：隔离的真实模型/完整 Harness/公司入口，在新计算进程接续、暂停/接管/交还、交付、撤权及迁移回滚。之后独立审批盒子实际切换。
4. **C 网关与 Runner**：设备身份、请求账本、远程取消和回执。本轮 Runner 仍被明确拒绝，不把公司服务器本地目录当作个人设备的替代环境。
