# 工作包 B：DSH 状态外置

部署位置补充（2026-11-10）：计算服务和 PostgreSQL 首期均位于既有 AI 盒子，各自独立进程与持久目录；不要求更换云服务器。本包基于 A 已实现的异步公司入口继续开发，实际盒子迁移另行验收；A 仓储租约不等于 DSH 原生 Session 已外置。实现进展见 [状态开发记录](STATE_STORAGE.md)。

状态：**B1/B3/B4/B5 与本轮 B6 的限定代码、实际 rc.3/ARM 隔离验收已落实；正式实例切换和真实飞书上线验收仍未完成，不标记整个 B 包已上线。** B6 补齐 Linux 退出证据及已持久前缀恢复、原生 file/image 归档与备份、完整角色的工具装配边界、公司配置生成/有序启动，并在既有 AI 盒子验证真实历史的隔离迁移与空库恢复。详情、实测范围及上线步骤见 [B6 记录](DSH_STATE_B6.md)。B1/B3/B4/B5 下文保留各阶段历史状态；其中“附件/崩溃待补”已由 B6 在限定范围内推进，通用目录/插件/跨宿主恢复不在本轮完成承诺中。当前正式 provider 未切换；C 的网关/Runner 尚未开始。

2026-11-12 后续：用户授权后已在盒子切换并验证实际 SQL/native 状态、私有工作台登录和重启；修复私有配置的子 preset 依赖路径后，真实无 @ 新群任务、Word v1 原线程交付及实际下载核对通过，见 [部署记录](../SERVER_DEPLOYMENT.md)。此后 current 已指向新版；OAuth 登录、新版录音和执行中控制复验分别保留。C1 协议/模拟路由已开始，真实 Runner 未启用。前文/各阶段文中的“未切换”按历史记录阅读。

## 目标与当前接缝

让一个稳定 Worker Session 的日志和恢复所需元数据存在公司持久存储。计算进程退出后，另一个进程从已 flush 的事件边界恢复同一 Session，而不是新开会话重新猜测。运行中的模型网络流和操作系统进程不在迁移承诺中。

当前代码的入口：

| 位置 | 现状／本包职责 |
| --- | --- |
| `src/app/sessions.ts` | 通过 `ctx.sessionController` 创建／恢复 Session、模型选择、工具／Skill／提示词装配；当前工作区由本机 registry 创建 |
| `src/app/delivery.ts` | `AgentDelivery` 用稳定 messageId、历史与 inbox 去重，flush 后确认输入；必须继续使用 |
| `src/executor/dsh.ts` | `workerSessionId(ticketId)` 保持稳定，恢复 Assignment 并限制并发；当前后台作业仍是本机 DSH registry |
| `src/app/task-progress.ts` | 读取 Session 投影；不得把完整推理或日志直接暴露到产品 API |
| DSH `@deepseek-ai/dsh-session-persistence` | 可替换 `SessionPersistence` 服务及 `SessionHandle`，应复用而不是另写一套聊天日志 |
| DSH `@deepseek-ai/dsh-storage`、`dsh-storage-domain` | workspace、标题、模型／preset 等元数据需要逐个核对实际存储 owner，不能只迁事件文件 |

开发类型是 `0.2.1-alpha.2`，公司运行工具链为 `0.2.1-rc.3`。B1 已将运行契约固定到 rc.3／Session format 4，记录五份公开持久化类型的摘要，并使用实际 rc.3 的 Cordis／SessionStore／持久化运行库验证；没有升级开发依赖或公司实例。B5 开始验证真实 AgentLoop 和受限办公 profile 的跨进程接续；完整生产 profile、第三方插件与盒子切换仍需独立验收。

B1 将独立插件落实为本包的 `dsh-superagent/dsh-state` 导出及 `src/dsh-state/` 模块，复用同一构建与 A 的事务／备份设施。原先拟议的 `packages/dsh-postgres/` 不再作为必须的新包路径；元数据 backend 和迁移仍待补。插件在 Harness 启动时显式替换存储服务，拒绝另一个 SessionPersistence 已挂载时启动；不能让每个业务 Runtime 各注册一个竞争的 provider。

## SessionPersistence 的具体实现

按锁定版本的上游类型实现以下完整接口，不只实现 append：

```ts
// 接口摘录；参数、错误类型及 branded types 以锁定 DSH 版本为准。
create(header, options?): Promise<SessionHandle>
open(sessionId, access: 'read' | 'write', options?): Promise<SessionHandle>
stat(sessionId, options?): Promise<SessionPersistenceSnapshot | undefined>
list(options?): Promise<readonly SessionPersistenceSnapshot[]>
flush(): Promise<void>
// handle: id/header/access/inheritedEventCount
// read(offset?, length?, options?), append(events, options?), flush(options?), close(), asyncDispose
```

建议表：

B1 实际使用 A 的通用记录表，以 `native-session`／`native-event` 两个独立 family 保存以下 header／事件内容，使用同一 SQL 租约。每事件独立行、create-only 写入、计数 CAS 和 epoch 校验均在同一事务完成，继承现有 tenant/space、关系索引和离线归档；不把整个日志塞成单个 JSON 对象。下表保留逻辑分解，非已创建的新物理表名称。未来若换专用物理表，须显式迁移，不改变原生契约。

| 表 | 内容和约束 |
| --- | --- |
| `dsh_sessions` | 归属、sessionId、不可变完整 header、格式版本、inheritedEventCount、nextSeq、durable revision／更新时间 |
| `dsh_session_events` | 同归属 sessionId＋seq 唯一；type、完整 payload、校验哈希；从 0 连续，不覆盖已提交事件 |
| `session_leases` | 使用 A 的共享表，不另造第二套 writer lease；owner、过期时间、epoch |
| `dsh_session_links` | ticketId、assignmentId、sessionId、场景／preset／prompt 版本引用；不以显示标题作身份 |

`create` 一次事务保存 header 和初始元数据，拒绝重复 ID，正确校验 isSeeded 与 inheritedEventCount。`open(read)` 不持有写租约，写入中的会话也可读到连续前缀；`open(write)` 原子取得单写者权限。错误用上游 `SessionAlreadyExistsError / SessionAlreadyOwnedError / SessionOwnershipLostError / SessionReadOnlyError / SessionFormatUnsupportedError` 等约定，不把格式损坏显示成“会话不存在”。

`append` 在事务中校验有效 epoch、租约、首 seq=nextSeq、批次内部连续和记录格式，然后插入并更新 nextSeq。按上游存储工具校验 header、事件词汇和 ownership state，不能只验证 JSON 能解析。对重复批次，仅在内容完全相同且符合接口契约时进行明确核对；相同 seq 不同内容必须拒绝并审计。

首版建议 append 直接提交到数据库，减少缓冲复杂度；即便如此，`flush` 仍要排空该句柄的事件写链并成为持久化屏障。只有 flush 成功，调用方才能向 Loom 确认已接收需恢复的输入。`SessionPersistence.flush()` 覆盖调用时所有活跃写句柄，一个失败时其余继续 flush 并汇总错误。`close` 幂等、不可取消，完成待写后释放所有权；read handle 的写操作拒绝。

`stat/list` 返回有效的 header／revision／格式分类，不触发模型或取得写权；revision 是同 provider 实例、同 Session 内的 opaque token，不是用来抢锁的全局序号。`read` 保证连续有效片段、同句柄不倒退，并保持上游 events 所有权／冻结约定。未知格式与损坏数据隔离；不把未知尾部当作有效内容吞掉。

## 实时事件和持久化生命周期

实现前核对默认持久化插件如何把活跃 Session 事件路由到 handle：不能只让 `create/open` 读写成功，却遗漏运行中新增事件。新插件负责接入实际版本的 `session/event`、`session/flush`、会话释放与服务 teardown，并为每个写句柄维护串行写链。不能与默认路由同时 append 同一条事件。

活跃计算中：接收持久输入 → 实际 Session 追加事件 → 串行 append → flush → 确认输入投递。停机：禁止新输入／工具 → drain 写链 → flush／close → 释放 lease → 进程退出。意外退出只恢复最后持久前缀，未确认输入由 A 按原 requestId 补投。

存储断连或失租约时，不继续分发工具、报告或确认交付；使 Session 停止推进并上报阻碍。不能依靠进程内取消阻止旧网络请求，网关也要在服务端拒绝旧 epoch。

## 单写者与 fencing

租约和 Job claim 是两件事：claim 作业并不代表取得 Session 写权。使用 A 提供的 lease store，以数据库时间维护 expiresAt；每次重新取得所有权增加 epoch，不复用旧代次。续租失败即撤销本进程推进权限。

每个 append／更新元数据／工具分发／报告提交均校验当前 epoch。检验与真正写入在同一短事务内完成；不以“刚才查过租约仍有效”替代条件写。旧进程即便网络恢复，也不能覆盖新 writer 的事件或对外执行。跨数据库时，由同一租约权威服务发放并校验能力，不能两边各自认定 writer。

恢复步骤：A 认领待运行任务 → B 取得 Session lease → 核对任务控制／来源授权 → 读取完整 header 与事件前缀 → 装配锁定版本的角色／场景能力 → 同 ID 恢复 Agent → 核对 pending 输入和执行账本 → 允许下一轮。没有取得写权时只读展示，不能另建一个同目标 Session 绕过租约。

Lease 失效后的 in-flight 外部执行不因租约失效自动回滚。由 C 的回执判断完成、取消或 unknown；未知写操作先核对，不让新 writer 重新发一次。恢复只读步骤也需要在相同资源授权下进行。

## DSH 元数据不能遗漏

盘点实际部署 profile 的存储挂载与 domain：workspace 记录、Session 标题／关系、preset、模型绑定、权限／提示词配置、附件引用、其他参与恢复的投影。逐项明确权威源、重建方式和归属，避免“日志已在 PostgreSQL，重启却找不到 workspace”。

`@deepseek-ai/dsh-storage` 的 KV backend 是另一条接口：`kv.open(descriptor)` 返回 unit，支持 `loadAll / putRecord / deleteRecord / setGlobal / close`，同时要处理版本、布局及坏记录拒绝语义。实施 backend 并注册对应挂载；不要把它误当作 SessionPersistence 服务。

`dsh-storage-domain` 当前是进程内读缓存＋写入链；单纯把 backend 换成共享数据库不会让其他进程自动刷新缓存。首轮为每个可写 domain 明确单 owner，切换 owner 时重新 load；其他节点通过只读产品投影查询。需要多写者的 domain 单独加版本／失效刷新机制并实际验收，不能直接运行多份原有 registry 写同一逻辑记录。

模型凭据和企业连接器密钥进入专门凭据系统，不嵌入 Session header、事件或迁移包。已有历史若包含敏感字段，迁移记录风险和隔离策略，保持事件审计语义，不能静默改写旧事件。

## 执行环境与计算目录

远端真实项目目录不存成计算主机必须存在的 cwd。需要与 C 定义 `environmentId / workspaceId / resourceGrant`，计算侧使用可重建 scratch workspace，既有任务的 `Execution.target` 是切入点。

新企业 Session 可以固定容器内 scratch 路径模板，例如 `/var/run/loom/workspaces/<sessionId的哈希>`；每个计算节点按同一模板重建空目录，从而保持 header 的 cwd 不变，但目录内容不是任务权威状态。真实文件一律通过 Runner 读取。旧 Session 的 cwd 不符合该策略时，先保留旧执行池或设计显式迁移，不能默认所有历史 Session 都可直接搬节点。

本轮 `Sessions.ensure` 明确拒绝 Runner 目标。C 完成代理工具、工作区解析和安全能力装配后，才能解除该门禁；不能单独删除错误提示就上线远程任务。本机目标仍使用原目录及验证。原生 Session header 的 cwd 兼容策略、workspace registry 重建与旧日志迁移需在锁定 DSH 版本上验证，不修改已有不可变 header 来伪造目录迁移。

DSH 必须运行的子 Agent 属于计算层，继续持有父任务的控制／场景／环境约束，事件也外置；实际进程和后台 job 属于执行环境，由 C 管理。首次恢复不恢复旧进程内 Job 对象，按执行回执重新关联。

## 分步落地与验收

1. **B1：版本与契约试验（已实现并隔离验证）。**rc.3 固定契约、可运行 SQL provider、创建／写入／flush／关闭／只读／fork 和元数据挂载清单见 [B1 记录](DSH_STATE_B1.md)。
2. **B2：事件后端（核心已有，整体连接待补）。**PostgreSQL provider、实时路由、句柄写链、格式／连续性校验、错误映射与两进程读写已随 B1 验证；生产 profile、更大日志规模及宿主故障收敛仍要结合 B3/B5 验收。
3. **B3：所有权与恢复（首批连接已实现）。**接 A 的同一 lease、固定输入账本、发布前守卫和实际停止回执，见 [B3 记录](DSH_STATE_B3.md)。缺少物理停止证明的崩溃任务保持 hold；C 的远程执行回执及完整故障恢复待补。
4. **B4：元数据与导入（首批已实现）。**SQL KV/workspace、环境契约、格式4文本历史的只读导出/dry-run/可续传导入及回滚见 [B4](DSH_STATE_B4.md)。保留 ID/seq/header/fork；附件、目录和真实旧部署迁移仍待单独补齐，不复制模型凭据。
5. **B5：真实 Harness 集成（首批已实现）。**不同空计算目录／进程恢复同一任务、接管与人工版本、模型选择、持久产物和交付；受控模型与真实模型验证分别记录于 [B5](DSH_STATE_B5.md)，实际盒子及完整连接器验收未完成。

6. **B6：收尾实现与 AI 盒子隔离验收。**真实角色、退出证据、原生附件、迁移/备份/恢复及部署入口见 [B6](DSH_STATE_B6.md)。正式切换、企业 OAuth 与真实飞书重启交付单独验收，不以测试替代。

| 验收故障 | 必须结果 |
| --- | --- |
| 同 Session 同时 open 两个 writer | 仅一个成功；读句柄仍可读取 |
| append 间隙／重复 seq 不同内容／未来格式 | 拒绝且不破坏已有有效前缀 |
| flush 后 SIGKILL 并更换计算目录 | 同 Session 恢复完整已确认前缀 |
| flush 前 SIGKILL | 未确认输入可按原 ID 重试，不重复已持久消息 |
| 创建空 Session 后 flush、fork 再恢复 | header、isSeeded、inheritedEventCount 与事件数一致 |
| 旧 writer 暂停、租约过期、新 writer 接手后旧 writer恢复 | 旧 append／工具／报告被拒绝 |
| 数据库故障、flush 失败 | 不确认持久成功、不继续新工具；控制台可见阻碍 |
| 人工接管后重启恢复 | 仍 held，Agent 不自动唤醒或覆盖人工版本 |
| 换计算节点读取元数据 | 模型／preset／workspace／title 与原记录一致，缓存无旧 owner 写入 |

本包新增 provider 契约、两进程争抢、故障注入及真实 Harness 启停测试；保留 `tests/runtime-concurrency.spec.ts`、`tests/task-control.spec.ts`、`tests/task-progress.spec.ts` 和输入投递相关回归。交付插件配置样例、固定版本记录、schema migration、dry-run 导入器、备份／恢复步骤及测试日志。

切换前暂停并 flush，备份旧状态，禁止新旧 provider 同时写同一会话。回滚必须含切换后的增量与 lease 代次；不能把旧文件副本重新设为最新状态。实际公司切换、部署和数据迁移是独立操作，不包含在编写本包代码的默认授权中。

## 与 A 包公司入口衔接

2026-11-11 的 `src/company.ts`／`src/state/native.ts` 支持两条显式路径：默认 configured 保留原生 SessionController/现行 provider；external 使用 SQL provider 的同库权威与受管 AgentRegistry 生命周期。B3 沿用同一公司 Runtime，不再启动第二套调度；现行部署未切换。

- 输入以持久作业 `kind/key/sequence` 形成稳定 requestId；`AgentDelivery` 的实际 message ID 由 `messageId(requestId)` 生成。`grant/native-input/<hash>` 保存内容哈希和投递阶段；SQL 新协议额外保存固定 payload/basis，原生 flush 后才确认消费。仅新协议未消费记录可按原 ID 补投；已消费但历史缺失或旧协议有歧义时拒绝盲重发。schema 11 旧输入还使用原调用方的 key，迁移须核对，不能假设二者一致。
- `grant/worker-binding/<ticket>/<assignment>` 保存当前 Session、owner、epoch 和主人，领域回调与公司产物发布同时核验。external 模式原生 provider 借用同一 lease；`native-task-owner/<ticket>` 跨 Assignment 核验上轮停止证明。configured 模式仍不能用 A 的 SQL 租约锁住旧文件 provider。
- `grant/native-quiescent/<session>/<epoch>` 是实际 idle、后台作业停止且 flush 后的回执，包含 owner／epoch。跨计算进程的控制消费者先核对它；租约过期或本进程没有 Agent 均不能确认停止。强杀后缺回执要由 B 的恢复协议处理，不能创建一张新租约冒充旧进程已停止。
- `progress` 仅存经过裁剪的动作、时间和用量，供 Loom 查询；不能当作原生完整 Session 日志。B 继续负责完整事件、元数据、checkpoint 及空白计算进程恢复，并在恢复后的任何推理／工具前安装当前授权与工具守卫。
- 当前公司群原生会话先禁用继承工具，再沿用既有受管权限预设；只注册当前任务的群文字、版本报告和已确认录音工具。原生恢复不能绕开这个次序。

B3 已同时运行 `tests/state-contract/service.spec.ts`、`native-stop.spec.ts`、`tests/dsh-state/company.spec.ts` 与原生 provider 契约，并增加实际 rc.3 idle Agent 生命周期冒烟；服务夹具不代表真实 DSH 元数据和完整模型任务的空白恢复已经通过。
