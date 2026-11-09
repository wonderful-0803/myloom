# 工作包 A：Loom 状态外置

状态：待实现。以 [共同接口与依赖](README.md) 为前提，本包负责 Loom 产品与编排状态，不负责 DSH 事件格式或端侧命令实现。

## 目标和交付边界

把当前 `orchestrator.sqlite` 中的权威状态迁入可独立部署的 PostgreSQL，把文件字节迁入独立 BlobStore。个人模式保留 SQLite 适配器。计算进程不靠自身目录保存任务、控制权或发送回执；删除并重建计算容器后可以从外部状态恢复。

先支持一个企业实例和现有空间边界，不把存储外置当作通用多租户产品已经完成。数据库凭据由服务端持有，飞书页面和桌面工作台只访问产品 API。

## 现状与改动地图

| 当前代码 | 应落实的改动 |
| --- | --- |
| `src/core/ports.ts` 的 `Repositories`、`src/core/engine.ts` | 同步仓储／命令改为异步事务调用链；不能在同步 API 背后启动未等待的网络写入 |
| `src/app/store.ts`、`store-read.ts`、`versions.ts`、`src/kv.ts` | 拆出仓储、读模型、设置版本及 KV 端口；保留 SQLite 实现，新增 PostgreSQL 实现 |
| `src/app/effects.ts` | 移除直接 `store.db.prepare`，改持久作业仓储；generation、顺序及撤销语义保留 |
| `src/app/task-control.ts` | 原子 CAS 控制版本和操作记录；跨进程新分发与暂停互斥，未知结果持久化 |
| `src/app/outbox.ts`、`result-delivery.ts`、`feishu-mail.ts` | 意图先落库，提交后发送；固定产物版本、目的地、权限与未知状态处理 |
| `src/app/artifacts.ts` | 报告／人工版本／来源关系与字节分离。当前 DOCX 字节也存于 KV 的 base64，不能只搬目录 |
| `src/app/runtime.ts`、`passes.ts`、`src/app/tools/`、`src/app/http.ts`、`src/sources/` | 仓储注入、异步命令与读模型、提交后唤醒；数据库故障时停止新执行 |

建议新增目录 `src/state/`：`ports.ts`、`sqlite.ts`、`postgres.ts`、`jobs.ts`、`leases.ts`、`blob-store.ts`、`migrations/`。这些是本包拟建文件；当前并未实现。通过 `rg '\.db\.|new Store|\.atomic\(' src` 找齐直连点，不能只修改 Runtime 的构造行。

## 事务端口和调用方式

先建立独立异步端口，迁移一个完整命令链后再推广。接口草案如下，方法名称可在首个接口评审中定稿：

```ts
interface StateStore {
  transaction<T>(work: (tx: StateTransaction) => Promise<T>): Promise<T>
  close(): Promise<void>
}
interface StateTransaction {
  tickets: AsyncTicketRepository
  controls: AsyncControlRepository
  jobs: AsyncJobRepository
  outbox: AsyncOutboxRepository
  idempotency: AsyncIdempotencyRepository
}
```

事务内的仓储共享同一连接和权限上下文；禁止事务回调逃逸后继续使用连接。业务命令变为 Promise，HTTP、工具、事件入口与测试全部等待提交。SQLite 适配器继续使用本地同步 SQL，但 `transaction` 必须等待完整异步回调，串行保护同连接，不能沿用当前 `Store.atomic` 直接接收 async 回调的方式。

典型接单在一个事务内完成：核验来源与主人 → 来源事件去重 → 保存 Trigger／Decision／Ticket／Assignment → 写 launch 作业 → 保存命令幂等响应。提交后唤醒调度器。模型、文件上传、飞书 API、SMTP、设备执行不在该事务中。

保留 `afterCommit` 仅作可丢失的进程内唤醒；事务提交后立刻杀进程，未完成工作也必须由持久作业重新发现。不要用全量内存副本作权威数据库，也不要把所有 Session、文件和 SQL 装进一个长事务。

## 数据结构与并发

首轮允许聚合正文用 JSONB，常用过滤条件和唯一性用真实列／索引。核心表建议如下：

| 表组 | 必须保留的键与约束 |
| --- | --- |
| `source_events / triggers / trigger_threads` | 来源按 tenant＋installation＋sourceEventId 唯一；时间分页用 at＋id；消息正文是证据 |
| `threads / decisions / tickets / assignments / inputs` | 现有 ID 保留；scope 列必填；聚合 revision；同 Ticket 最多一个有效 Assignment；输入去重 |
| `settings_versions / delegations / kv` | 设置与委托版本不丢；KV 使用显式 scope／键族白名单，私人历史不默认迁入共享空间 |
| `task_controls / control_operations` | mode、revision、drained、history；operationId、requestId、状态与回执引用；unknown 不因重启消失 |
| `jobs` | kind＋key 唯一、generation、due、attempts、sequence、claimOwner、claimUntil、epoch；每次完成都比较 generation／认领令牌 |
| `session_leases` | sessionId、owner、expiresAt、单调 epoch；按企业／空间隔离，由 B 定义写入约束 |
| `execution_requests / execution_receipts` | requestId 唯一、参数哈希、控制版本、epoch、授权版本、状态；由 C 补字段和状态机 |
| `artifacts / artifact_versions / blob_refs / delivery_outbox` | 不可变 version、来源、人工作者、sha256、字节数、对象引用；同版本同目的地发送意图唯一 |
| `command_results / audit_events / change_log` | 幂等键＋命令类型＋操作者唯一；只保存必要审计字段，事件游标供页面断线补取 |

所有外键包含归属或受作用域约束，查询不接受任意租户 ID。内部试点的来源身份从已有可靠记录映射，缺映射记录进入人工待处理列表，不能猜测显示名归属。

更新 Ticket 时用预期 revision 的条件写，或在短事务中锁行。暂停／接管和新执行登记锁同一控制行：登记前校验 mode=agent、revision、任务有效性、授权版本与 Session epoch；插入执行请求后才提交。网关发送与实际执行仍须再次校验，事务本身无法撤回已经到设备的操作。

作业短事务用 `FOR UPDATE SKIP LOCKED` 认领并立即提交，长工作在事务外执行；续租也使用预期令牌。迟到的旧消费者不能删除新 generation 或覆盖新结果。严格顺序只在需要的流上实现，如同一 Session 的输入和同一会话的 Outbox；不能让不同任务共用一个全局长锁。

持久并发槽由服务端认领数／租约计算，现有内存 WorkerSlots 可作单进程限流，不能作为多计算节点的总上限。进程内通知仅用于减少延迟，断开后由作业扫描与 change_log 游标恢复。

## 控制权与外部发送

当前 `TaskControls.run` 同步登记操作再 await，这个不变量在异步版本中变为“登记事务提交后，才调用外部操作”。`pause` 持久提升控制 revision 并设为 pausing；停止确认与所有在途操作收敛后才进入 paused／human。取消响应不等于停止确认，unknown 必须说明实际副作用核查结果后显式解除。

跨 Loom 和 DSH 的两次提交采用 durable intent，不追求分布式长事务：先记录待投递输入与稳定 requestId；B 按相同 ID 投递并 flush；A 收到持久确认后更新输入状态。中间崩溃由同 ID 重试和 DSH 历史核对恢复。

飞书文件和邮件沿用固定产物、权限、目的地、控制版本。发送成功但回执落库失败时，记录 unknown，按渠道能力核对；不能声称所有外部 API 都提供 exactly-once。文件上传可以复用字节哈希，发送消息仍有独立的副作用账本。

## 文件存储

BlobStore 拟提供 `put / head / open / delete`，manifest 保存在关系库，服务端存放加密凭据。先支持独立持久目录后端，企业再接对象存储，二者执行同一契约测试。临时导出文件只作缓存。

发布顺序：生成到临时对象 → 校验真实类型、大小、sha256 → 事务登记不可变产物版本及引用 → 才允许交付。未登记孤儿对象延迟 GC；登记失败不显示“已生成”。相同哈希可复用物理字节，但 ACL 在引用上，不能跨空间通过哈希探知文件。下载每次重新鉴权，首版使用服务端代理；撤权后缓存及旧链接同样受控。

人工修改采用 expectedVersion；旧 Worker 的迟到报告不覆盖人工版本。DOCX 从 KV 搬迁时，按当前 `Artifacts.bytes` 的长度／哈希及真实格式校验后登记，正文、来源和作者链一起保留。

## 分步提交和迁移

1. **A1：端口与 SQLite 契约。**盘点所有表、KV 键族和直连 SQL；先迁移接单／控制／Outbox 一条端到端链，接着推广剩余命令、视图、来源和定时任务。保持所有现有 SQLite 用例通过。
2. **A2：PostgreSQL 与作业。**版本化 migration、连接池、事务／CAS／作业／租约实现，两个适配器跑同一套约束。测试使用一次性数据库，凭据从测试环境注入，不能连接业务库。
3. **A3：BlobStore。**清点并搬迁报告正文、KV 文件字节和来源快照；导出下载和原线程交付切到不可变引用。
4. **A4：受控迁移。**暂停监听和新工作、排空／标记在途结果、flush DSH、备份 SQLite 及相关文件；离线导入，保留原 ID 和 revision；比对数量、关键哈希、任务控制、Outbox 与权限。源库不再写，避免双主。
5. **A5：故障验收。**先隔离实例，再公司试点；只有核对通过才切入口。不自动导入私人历史到群空间。

回滚优先回到同一外部状态库上的旧兼容程序。若要回到旧 SQLite，必须先停止新写、导出切换后全部增量并核对，再指定唯一写入者；不能直接还原旧备份丢掉新控制和发送回执。任何导入器默认 dry-run，正式迁移需要独立操作授权。

## 验收与交接

| 故障／操作 | 必须观察到的结果 |
| --- | --- |
| 接单事务提交前断库 | 没有半张 Ticket、没有外部操作 |
| 提交后、通知前杀进程 | 新进程发现同一作业，仅一个有效 Assignment |
| 两个消费者抢同作业，旧消费者晚完成 | 一个有效令牌；新 generation 不被删除 |
| 暂停与工具登记竞争／重启 | 暂停生效后没有新授权操作；在途与 unknown 可查询 |
| DSH flush 前后分别杀进程 | 同一输入 requestId 恢复，不重复入 Session |
| 发送成功后落库失败 | unknown／核对状态，禁止盲目重发 |
| 人工 v2 后旧 Worker 提交 v1 | 409／版本冲突，v2 内容不变 |
| 文件上传后数据库失败 | 页面无可用产物，孤儿可回收；已发布对象重启后可读 |
| 两个身份换 URL／下载／游标 | 无越权正文、摘要、文件或事件 |

现有回归至少包括 `pnpm typecheck`、`pnpm test`、`pnpm build`。本包新增 `tests/state-contract/`（SQLite＋PostgreSQL 双适配器）、数据库进程故障集成测试、migration dry-run 和 blob 故障测试；新测试路径是交付要求，当前不存在。提交时提供 migration 清单、KV 映射、恢复脚本、样例脱敏验收记录以及 B／C 可直接调用的事务、控制、租约和执行账本接口。
