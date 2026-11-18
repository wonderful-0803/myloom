# B1：DSH 原生持久化契约与可运行后端

2026-11-11。部署目标仍为既有 AI 盒子；本轮在开发机隔离验证，未修改盒子配置、旧实例、模型或飞书监听。

## 已实现的范围

`src/dsh-state.ts` 导出独立的 `dsh-superagent/dsh-state` 插件及 `SqlSessionPersistence`。它实现原生 `SessionPersistence` 的 create、open(read/write)、stat、list、flush 及全部句柄方法，接入真实 `session/event`、`session/flush`、`session/disposed`。未挂载 AgentFactory、模型、业务工具或第二套 Loom Runtime。

目标运行版本固定为 **DSH 0.2.1-rc.3**，Session 格式为 **4**。仓库的开发依赖仍保持 `0.2.1-alpha.2`，没有顺带升级。已逐字节比较两版 `index / handle / storage-contract / errors / revision` 五份公开类型，结果一致；并将编译产物复制到临时目录，显式使用实际 rc.3 的 Cordis、SessionStore 和 SessionPersistence 运行两次独立进程。类型摘要见 [固定契约](DSH_STATE_B1_CONTRACT.json)。这不是完整模型、AgentLoop 或公司 profile 的兼容性证明。

## 存储与生命周期

为复用 A 的事务、备份和租约权威，首版使用 `loom_state_records` 中两个独立 family，而不是再建立第二套连接／租约系统：

| family | 键与数据 | 不变量 |
| --- | --- | --- |
| `native-session` | 完整 Session ID；不可变 header、header SHA256、精确 inheritedEventCount、eventCount、provider 格式 | tenant/space 隔离；header 不改写；计数通过 CAS 更新 |
| `native-event` | SHA256(Session ID)/16 位补零 seq；完整原生事件和 SHA256 | 每事件独立记录；只使用 create-only 插入；批次与计数在同一事务提交 |
| A 的 `loom_state_leases` | 同 scope 下的原生 Session ID | 数据库时间、每次取得新 epoch、owner 唯一；事件写入与校验在同一短事务 |

`create` 立即提交空 header 和租约；`append` 立即提交连续事件，`flush` 等待当前句柄写链及实时缓冲并校验写权。revision 是同 provider、同 Session 内的 opaque token；换 writer 不修改日志 revision。所有权丢失后句柄永久拒绝写入，不能自行重抢。

header／事件以独立 JSON 文本字段放在存储 envelope 内，再计算逻辑内容摘要；这保留了 PostgreSQL JSONB 无法直接表示的 NUL、孤立 UTF-16 等合法 JSON 字符串。逻辑 Session ID 作为 SQL／租约键，首版明确限制为 1–2000 字符、非空白、有效 Unicode 且不含 NUL；非法 ID 直接拒绝，不作有损编码。当前 Loom 生成的 Router／Worker ID 满足该约束。

实时事件按 10ms 窗口合批，默认单句柄最多缓冲 16MiB；超限或非法事件使后续 flush 失败，不能把丢失记录当成功。写失败保留原批次，自动路径暂停，显式 flush/close 才重试。COMMIT 回执不明时，仅对该句柄实际尝试过的同一批次核对完整事件内容及计数；普通重复 append 仍拒绝。新事件不得越过失败批次。

header 使用上游 lossless JSON 快照与版本检查；事件使用上游快照／词汇／数据校验，并补足固定 envelope 校验。读取校验 seq、来源 Session、摘要和连续记录；损坏、缺失或多出的已提交尾部不作静默修复。未来必需事件拒绝；明确 ignorable 的记录仍保留原文。读结果携带 `detached`，外层和非消息数据由读者独立持有，不冒称全部已深冻结。

句柄关闭会排空已接收写链和缓冲，再条件释放自己的 owner/epoch；关闭幂等且不可取消。服务级 flush 对全部活跃 writer 执行，单个失败不阻止其余 writer，最终汇总错误。dispose 等待进行中的创建／打开，再关闭全部句柄；依赖存储最后关闭。

原生构造／恢复可能生成 `session/end-seed`，它不通过发布后的 `session/event` 再发一次。AgentFactory 必须在发布前经 handle.append 保存构造后缀，之后才接实时事件；验证夹具遵循同一顺序，不能把这个后缀漏掉或重复入库。

## 元数据挂载盘点：B4 的输入

以下基于实际安装的 rc.3 模块，不把它们都误称为 KV，也不将 profile 配置直接复制进 Session：

| 对象 | rc.3 权威源／模块 | 后续处理 |
| --- | --- | --- |
| 完整会话和 lineage | `dsh-session-persistence`；header + events | 本轮 provider 已能保存；旧 JSONL 离线导入器待 B4 |
| workspace、排序、归档、置顶、会话归属 | `dsh-workspace` 的 `workspace` domain **v2**；global 和 workspaces 表 | 实现 `dsh-storage` KV backend，明确单 owner／重新 load；不能仅靠日志恢复全部 workspace 状态 |
| 会话标题 | `dsh-session-title` 的 `session/title` 事件 | 随原生日志保存；只读标题投影可重建，不另造标题权威表 |
| 模型选择与已组装请求 | `model/selection`、`request/header` 事件；连接器配置仍在 profile | 事件随日志；运行端仍需配置可用模型和凭据引用，不能从历史恢复密钥 |
| preset | header.agentPreset、`agent-preset/selected`；定义／挂载由 `dsh-agent-preset-registry` 和 profile 管理 | 保存绑定事实和固定定义版本；新节点先具备相同配置再恢复 |
| 权限预设 | `permission/preset` 等事件及权限 projection；预设定义由 `dsh-permission-presets` 提供 | 恢复历史不等于恢复授权；先装当前任务工具守卫，再允许推进 |
| Session 派生缓存 | `dsh-session-projection-cache` 的 `session_projcache` domain **v7**，per-record | 可从已验证原生日志重建；拒绝把缓存当授权或完整日志 |
| Harness 原生定时任务（若启用） | `dsh-schedule` 的 `schedule` domain **v1** | 独立 owner／触发幂等；与 Loom 持续委托区分，首期不默认启用 |
| 可变设置、模型／工具／提示词配置 | `dsh-settings` 通过 ConfigEditor 修改 profile entry；并非上述 domain | 固定部署配置与版本；敏感值留凭据系统；不能声称换 KV 即已外置 |
| 附件与本地文件引用 | 原生事件中的引用及实际 `dsh-attachment-local`／本地文件 | B4 逐项判断持久 Blob 或执行环境资源；只保存日志不等于文件已复制 |
| 原生作业／子 Agent | `dsh-jobs-local` 进程内作业；子 Agent 各自有原生 Session | 日志可以独立持久；运行中 OS 进程、网络流和 job 对象不迁移 |

2026-11-12 [B4 首批](DSH_STATE_B4.md) 已落实 SQL KV/workspace 和文本历史迁移，上表仍保留 B1 时的挂载盘点；附件、schedule 和完整模型接续未随之完成。

首期不运行多个进程共享写同一个既有 `dsh-storage-domain` 缓存。B1 的 Session 单写者测试不能替代 domain 缓存所有权设计。

## 复现验证

先安装本仓库锁定依赖并构建：

```sh
pnpm typecheck
pnpm build
pnpm test:dsh-state
```

不提供数据库时，上述契约只跑 SQLite，并明确跳过 PostgreSQL。要跑双适配器和独立进程测试，在自己的安全终端把专用测试数据库 URL 放到 `LOOM_STATE_TEST_DATABASE_URL`，数据库名必须以 `_test` 结尾，再执行 `pnpm test:dsh-state`。不读取通用 `DATABASE_URL`，不导入真实 Session。

实际 rc.3 冒烟需将同一专用测试库配置到 `LOOM_DSH_B1_DATABASE_URL`，然后执行：

```sh
pnpm dsh-state:smoke --harness-root /absolute/path/to/@deepseek-ai/dsh
```

脚本严格核验 Harness 包名和 rc.3 版本，复制编译产物到临时目录并使用 rc.3 的真实依赖；两个计算进程各有不同空 cwd，通过同一测试库保存／恢复合成会话、固定输入 ID 和 fork。恢复后输入仅出现一次，原 header 保持不变。无模型、飞书、邮箱或业务文件访问。数据写入随机隔离 scope，测试库由操作者销毁；临时代码目录由脚本删除。

可编程接入时，`new SqlSessionPersistence(ctx, { store, scope })` 支持 A 的 SQLite／PostgreSQL 适配器。Cordis 插件 `apply(ctx, { tenantId, spaceId, databaseUrlEnv })` 只接受显式 `LOOM_*` 环境变量名，并拒绝与另一 SessionPersistence 同时挂载。当前不给生产 profile 自动替换补丁。

## 验收证据与边界

`tests/dsh-state/provider.spec.ts` 覆盖完整方法、fork、原生事件、分页、作用域、只读、取消、非法格式、数据损坏、提交回执不明、缓冲预算、关闭和租约。`process.spec.ts` 使用真实独立进程验证：

- 一个 writer 在运行时，另一进程写打开被拒绝，读打开仍可用。
- flush 后 SIGKILL，等待旧租约失效，从空计算目录恢复原 ID、header 和已确认前缀，再保存原生恢复后缀及新事件。
- SIGSTOP 旧进程、租约过期、新进程取得写权、SIGCONT 后旧 append 被拒绝；旧 close 不能释放新 writer。

A 的导出会包含 native family，但要求先关闭原生 writer；恢复后作业仍 held、执行仍关闭。`tests/state-contract/backup.spec.ts` 校验原生日志随停止后的归档读回。完整历史导入、跨库切换增量和最终生产回滚仍待 B4，不能用这个基础归档替代迁移方案。

本机脱敏记录目录：`.artifacts/dsh-state-b1-20261111/`。最终结果写入 `verification.json`，rc.3 构建后运行记录为 `rc3-smoke.log`。真实 AI 盒子尚未切换。

最终验证：双数据库原生／进程专项 **28 项**；含备份及文档检查 **41 项**；全量 **103 个文件、1564 项通过、4 项现有跳过**。类型检查、编译和最新编译产物的 rc.3 两进程验证通过。没有前端改动；未增加飞书或模型联调的完成声明。

## 下一批必须补的连接

以下是 B1 交付时的待办快照。公司所有权、受管生命周期、输入屏障及停止连接已在 [B3 首批](DSH_STATE_B3.md) 落实；完整元数据、旧日志、无停止证据的崩溃恢复及真实模型接续仍未完成。B1 的验证数字保留为该批次历史证据。

1. **公司 Session 所有权统一。**`src/state/native.ts` 仍按工作轮次取得 A 租约；本 provider 持有句柄生命周期的租约。B3 必须把它们统一成一个 owner/epoch，不能直接同时开启、更不能各加一张租约表绕开冲突。
2. **计算与业务工具同时 fencing。**当前事件写入已受数据库 epoch 保护；`onFailure` 可通知宿主，但 B3 尚未把失租约与公司 Agent 的取消、输入确认、工具守卫、产物和物理停止证明整体连接。旧 append 被拒绝不等于旧 OS 进程已停止，也不保证在途外部请求回滚。
3. **空白完整 Harness 恢复。**本轮仅验证原生 SessionStore/持久化，不包含完整 AgentLoop 的模型继续执行、元数据重新挂载及任务交付。需在 B4/B5 与 A 的真实原生适配、稳定输入账本、暂停／接管共同验收。
4. **元数据／旧日志迁移。**实现上述 workspace KV 和 profile 重建策略、旧文件只读 dry-run、精确 fork 及来源核验，不迁移密钥。当前插件不读取旧个人会话或现行盒子日志。

因此 B1 可作为后续实现的真实后端基础，**整个 B 包仍未完成，也尚未实现生产任务的无状态计算接续或远程设备执行**。
