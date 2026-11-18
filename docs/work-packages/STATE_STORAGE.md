# Loom 状态外置：实现批次与接续

更新：2026-11-11。第三批已补公司群模式的产品服务、真实原生适配器、来源、产物与离线迁移；完整操作见 [公司入口与迁移](COMPANY_PRODUCT.md)。公司盒子真实切换和平台联调尚未执行，DSH provider 与 Runner 仍属后续工作包。

以下“第一／第二批”段落保留当时的实现与验收记录，当前代码以第三批为准。2026-11-10 对应 [工作包 A](LOOM_STATE.md) 的 A1 与 A2 两批实现，**不代表完整工作包完成**。第二批补齐独立异步任务内核的持续消费与领域回调；已有飞书、桌面与公司实例没有切换存储，B、C 尚未开始本轮开发。

## 部署目标：既有 AI 盒子

公司服务端继续使用此前的 Ubuntu / ARM64 AI 一体机，背景见 [实际部署记录](../SERVER_DEPLOYMENT.md)。这里的“服务端／云端计算”描述职责，不要求购买云服务器。

初期在盒子上分别运行 Loom／DSH 计算服务和 PostgreSQL，文件另放独立持久目录。数据库数据目录、文件目录与可替换的程序／计算缓存目录分开管理；备份数据库和文件，不能只备份程序。PostgreSQL 仅监听盒子回环地址或受控容器网络，不把数据库端口暴露给同事。飞书和可选客户端访问产品 API。

同机部署先分离职责和进程生命周期，不具备跨主机容灾：盒子整机离线时，计算和存储都会暂时不可用。

Agent Loop 在盒子上推进，模型推理仍使用现有配置的模型服务；本轮没有把模型权重部署到盒子或更换模型。需要个人电脑工具链时，再由后续 Runner 主动连接盒子。初期不以多台计算节点为上线目标，先验证进程可替换、控制不丢失和不重复交付。

本轮所有 PostgreSQL 验收在开发机独立 PostgreSQL 16 容器及随机 `_test` 数据库作用域进行，没有登录盒子、变更服务单元、复制真实历史或运行正式导入。

## 已落地的代码

| 实现 | 行为与约束 |
| --- | --- |
| `src/state/ports.ts` | Promise 仓储与事务、显式 tenantId／spaceId、记录 CAS、分页、作业、租约和变更游标 |
| `src/state/sqlite.ts` | 单连接异步回调完整等待；同文件进程内串行、跨进程 SQLite 锁；WAL／FULL；事务逃逸、遗漏 await 与嵌套拒绝；拒绝将旧 Loom 库当新库打开 |
| `src/state/postgres.ts` | 连接池、同连接短事务、按空间锁定；连接失败则命令失败；初始化／升级使用独立事务锁，不在每次打开时重复 DDL |
| `src/state/sql.ts` | 两适配器共享仓储语义；scope 组成主键；JSONB／TEXT 正文与关系／活动索引；单调记录版本与删除墓碑；事务内 schema 升级 |
| `src/state/application.ts` | 异步 receive／decide／assignmentStarted／report／reply／workerFact／candidateDelivered；分页时钟命令与即时授权候选读取；复用现有 Engine；命令、任务、作业与交付意图同事务提交 |
| `src/state/domain-unit.ts` | 每次短事务读取所涉及的聚合，运行纯领域逻辑后异步写回；命令结束即销毁，不维护全库内存权威副本；超过 1000 条聚合／历史则拒绝，不能截断后继续决策 |
| `src/state/controls.ts` | 控制 revision CAS、操作登记、未知结果、停止确认和人工核查；执行登记校验任务、Assignment、持久授权版本与同一 Session epoch |
| `src/state/outbox.ts` | pending → sending 先提交，再调用传输；回执另一次提交；同会话按持久 sequence 排序，前序 unknown 阻止后序；回执丢失禁止自动重发 |
| `src/state/consumer.ts` | 持续轮询、短事务认领、心跳续期、跨进程并发池；异常持久挂起；显式、安全的重试结果与人工恢复 CAS；实际 handler 返回前不因 AbortSignal 提前释放槽位 |
| `src/state/runtime.ts` | 可显式装配的 `AsyncTaskRuntime`：同一 StateStore 上驱动接收 → 评估 → 开工／输入 → 回执 → 有序交付；注入真正的 assessor／worker／stop／delivery 适配器 |
| `src/app/passes.ts`、`src/core/engine.ts` | 原有 Passes 同时支持同步与异步宿主，等待 receive／evaluateDue；Engine 增加单 Thread／Ticket 时钟命令，避免异步内核依赖全库缓存 |
| `src/state/kv.ts` | 从现有 KV 定义生成键族／组件归属名单；未知 KV 键不能直接写进新状态库。名单本身不代替个人／群资源授权 |
| `scripts/state-inventory.mjs` | 对冻结的旧库只读盘点；按 KV 键族统计，不输出记录正文、具体私有键或凭据；没有 apply／导入模式 |

包导出为 `dsh-superagent/state`，构建入口为 `lib/state.js`，包含 `AsyncTaskRuntime`／`DurableConsumer`。不会在原 Runtime 构造时自动开启 PostgreSQL。

异步命令必须由可信服务端提供 `authorize(tx, context)`，每次命令（包括幂等重放）重新核验当前身份／安装／权限并取得 Policy 与 SourceScope。模型参数、飞书正文和浏览器传入的 tenantId 不能直接构成这个回调。当前隔离验收使用固定作用域和持久主人名单；正式飞书身份映射尚待迁移。

`registerExecution` 返回 `{ created, entry }`。重放只能取已有账本，不能把 `created=false` 或旧的 registered 状态当作新的执行许可。真正工具分发还需要 B 的 Session 绑定和 C 的网关／设备授权再次复核。当前代码不会执行 Runner 工具。

`DurableOutbox` 目前只承载领域内文本消息；传输适配器必须实现事务内当前资源授权和事务外发送。未接入真实飞书或 SMTP，也未替代原附件／邮件服务。sending 期间的第二个调用只能等待；超过尝试期限且没有持久回执时进入 unknown。同一 `channel.source + channel.thread` 的前序待发送／sending／unknown 都会阻止后序发送。活动交付队列达到 1000 条时先拒绝发送，等待进一步分页实现，不截断后乱序发送。旧 intent 缺少 order 时须迁移补齐，不能猜测顺序。渠道核查由正式适配器实现，不宣称 exactly-once。

## 第二批：可运行的异步任务内核

`AsyncTaskRuntime` 只依赖所注入的 `StateStore`，所有持续作业都从该库恢复；模型、Worker、停止及渠道调用在事务外。接入的不是另一套领域规则：底层仍使用现有 Engine、Evals、Assignments、Replies 与 Passes。它目前是供服务端迁移使用的内核导出，**不是已经替换桌面、HTTP、工具或 CLI 消息监听器的完整 Runtime**。

装配者必须提供同一作用域的 `store / scope / actorId / authorize / assess / work / stop / delivery`。`actorId` 是服务端可信执行主体，每个命令及每次后台派发都通过 `authorize` 重新读取当前授权，不能用消息正文选择企业、主人或安装身份。`receive(identity, installationId, sourceEventId, trigger)` 必须由已验证来源身份的适配器调用。当前验证使用现有 `feishuTrigger` 归一化**虚构**群事件，没有新增生产监听器，也没有完成正式安装身份映射。

`start()` 启动持续队列和两秒领域时钟；`idle()` 请求一轮评估并等待当前可运行工作，未来到期／held 作业仍在库中；`stop()` 禁止新入口、发出取消信号并等待已启动 handler 实际返回，不负责关闭调用者持有的 StateStore。关闭期间仍给未返回的当前 handler 续期。进程被强杀后由数据库认领到期恢复，不能依靠进程内唤醒。

领域时钟每轮按活动索引各读至多 100 条 Thread／Ticket，游标走完后重新扫描；实际修改按单聚合短事务完成。候选已送达后才开始计超时，超时重排由现有 Evals 处理；旧 evalId 的迟到结果不能创建任务。该时钟不包含尚未迁移的持续委托、Codex 日报或会议采集调度器。

Worker 端口的 `work(request, context)` 必须等待实际一轮执行结束，不能启动一个后台进程就返回 done。`requestId` 由 kind／key／持久 sequence 构成，同一作业重放保持不变；新作业即使 generation 因上一条已完成而从 1 开始，也不会复用旧 requestId。端口需保存执行／输入回执，并在原生 Session 与工具入口复核授权、租约及控制版本；`context.assertCurrent()` 复核当前认领和控制，不能代替 B 的原生 Session 单写者或 C 的设备端执行账本。

`workerFact` 覆盖 inputsDelivered／inputsRead／turnEnded／deliveryFailed，连同 started／report 使用当前 Assignment、数据库 Session epoch 与控制 revision。回调幂等参数保留 Session ID／owner／epoch，排除会随续租变化的 until。DSH 的持久 Session 绑定及原生事件 provider 仍由 B 落实；本批注入的测试 Worker 不构成它的验收。

`stop` 适配器处理 domain.stop／control.stop，必须核实后端停止回执；内核不会凭取消信号自动调用 confirmDrained。后台队列健康与 Passes 健康分开保存，普通时钟成功不会清掉队列异常。

## schema 与并发选择

外置库使用 `loom_state_*` 独立表，不把旧 SQLite 的 schema 11 改写成新 schema。外置 schema 当前为 **5**：B4 增加 native-unit/native-record 逻辑 families，4→5 只提升版本门禁，不再执行旧 ALTER；schema 4 的时间分页索引与回填保留。前两批 1 → 2 增加记录墓碑，1／2 → 3 增加 held、独立认领账本与并发池表；1–4 升级均保留 revision、墓碑和活跃认领。删除后不能用 expected=0 或旧 revision 重新创建。未知未来 schema 拒绝打开。生产升级仍需停旧消费者并排空，不支持两代不同 schema 程序滚动混跑；旧认领没有新并发池信息，不能据此宣称混跑时已有全局总量保障。

记录使用 `tenant / space / family / id` 主键，正文为 JSONB（PostgreSQL）或 JSON 文本（SQLite）；关系键、活动标记、revision 为独立列。作业用 kind＋key 唯一，generation＋随机认领令牌防止旧消费者完成新版作业；认领使用数据库时间及 `FOR UPDATE SKIP LOCKED`。Session 租约由数据库时间决定，释放不删除 epoch，重新认领递增；不能用客户端时钟续命。

仍采用**空间内短事务串行**，长计算和发送均在事务外，不同空间可并发。第二批内核的 workers 池已按数据库活跃认领统一限流，默认为 2；另有 assessor／delivery／stop 池。池容量首次认领时持久保存，进程配置不一致会拒绝认领，不能靠新进程调大数字绕过总量。当前没有在线改容量 API，调整需先实现受控排空／修改。原 Runtime 的 WorkerSlots 仍是原来的本机实现，尚未切换。

`loom_state_claims` 独立于当前作业行：同 key 的新 generation 或删除作业不会抹掉旧的活跃槽位；同一 workers 池还跨 launch／input 按 Assignment key 互斥。旧 handler 返回时可释放自己的认领，但不能删除新作业。作业认领到期后允许恢复，**不保证物理后端已经停机**；必须由 B／C 的 epoch 与回执阻止过期执行，不能把队列租约当作分布式 exactly-once。

handler 抛错持久化为 held，默认不重试未知外部副作用；只有显式 `{ state: 'retry', delayMs }` 才自动延期重试。`jobs.resume(kind,key,generation)` 只是受信仓储 CAS，调用方必须先鉴权并核查回执，当前没有暴露成用户 HTTP 接口。Outbox 的 unknown 还需要其自身 reconcile，单独解除 job held 不会使未知邮件／消息重发。

## KV 与旧表盘点范围

只读 inventory 覆盖 `trigger / disposition / thread / ticket / decision / outbox / effect / trigger_thread` 的数量、字节和有序摘要，以及 `src/kv.ts` 定义的全部键族数量／字节。未知来源扩展键单列 `(unmapped)`，不能静默导入。

| 旧状态 | 后续搬迁原则；本轮尚未正式导入 |
| --- | --- |
| Settings／prompt 版本、block revision、master-id、Session prompt 版本 | 保留版本和稳定 ID；绑定明确企业／空间；提示词不保存凭据 |
| task-control、effect、outbox、result-receipt | 保留暂停、在途／unknown、generation、顺序及回执；先核对实际副作用，不能重置为待执行 |
| artifact-head／version／file | 正文、人工版本、来源关系与 DOCX base64 字节一起盘点；迁入 BlobStore 后校验长度／格式／哈希 |
| group-context-reads、meeting-recording／message、delegation-activity | 按现有群空间和资源授权迁移，保存来源与转写版本；不默认共享个人资料 |
| Codex 授权／日报、个人草稿、assistant focus、mail proposal、卡片许可 | 按所有者隔离；不把临时许可、个人授权或私人历史默认移入公司群；卡片等短期许可需失效／重新签发 |
| 飞书／GitHub 游标、topics／seen／labels | 按真实安装身份与接收范围映射；不能借迁移重放旧历史或串接不同应用的 Open ID |

盘点命令只针对**冻结备份副本**，报告文件必须尚不存在：

```sh
pnpm state:inventory --source /path/to/frozen-copy.sqlite --out /path/to/new-inventory.json
```

输出固定标记 `migrationReady=false`。它不是 dry-run 导入器，不校验真实所有者映射，也不意味着可以直接停旧库切换。

## 验证方法

```sh
pnpm typecheck
pnpm test:state
# 显式设置 LOOM_STATE_TEST_DATABASE_URL 后，同一套测试也跑真实 PostgreSQL。
# 必须为专用、可丢弃、数据库名以 _test 结尾的测试库；不读取 DATABASE_URL。
pnpm test
pnpm build
```

专项目录 `tests/state-contract/` 包括：异步回滚／事务逃逸／遗漏 await 后禁止晚到写入、作用域隔离、JSON 标量、CAS／删除重建、嵌套拒绝、作业争抢和旧 generation、租约 epoch、命令／来源去重、失效主人重放、接单失败回滚、暂停／接管、撤权、迟到报告、Outbox 回执丢失、只读盘点，以及 PostgreSQL 连接强制断开。

`crash.spec.ts` 在独立 Node 子进程提交前／提交后／消费者已认领后三个检查点 SIGKILL，再从数据库恢复，检查无半张任务、到期后同一 sequence 再认领、attempts 增长且仅一个有效令牌。这验证状态提交和作业恢复，不等于 DSH 原生 Session 或外部设备已从空白环境恢复。

未设置专用 PostgreSQL 地址时，PostgreSQL 用例明确跳过，不能把 SQLite 通过称为双适配器通过。本轮完整计数与回归结果会记入 [项目进度](../PROJECT.md)；脱敏原始日志位于本机 `.artifacts/implementation-20261110/`，测试数据库凭据不进仓库。

2026-11-10 首批验收结果：状态专项 **49 项**在真实 PostgreSQL 16 与 SQLite 的全量运行中通过；整个工作区 **93 个测试文件、1470 项通过、4 项现有用例跳过**，`pnpm typecheck` 与 `pnpm build` 通过。编译后 `dsh-superagent/state` 包导出也已实际连接两个适配器读写。有效租约互斥和过期后重新认领分开验证，不依赖并行负载下“15 毫秒内一定完成断言”的时序假设。

第二批已验证：独立适配器共享池限流及配置冲突、同 Assignment 跨 launch／input 互斥、新 generation 不释放旧槽位、长 handler 心跳、正常关闭期间等待实际返回、异常 held 重开后保留、授权撤销阻止 Worker、评估超时和迟到结果、有序交付与前序 unknown，以及虚构飞书事件经真实领域规则完成任务的链路。模型／Worker／渠道均为明确测试替身；两种 SQL 适配器都是真实数据库实现。

第二批最终验收：`tests/state-contract/` 共 **68 项**进入真实 PostgreSQL＋SQLite 验证；整个工作区 **94 个文件、1490 项通过、4 项现有跳过**。`pnpm typecheck`、`pnpm build` 与构建后双适配器消费者实测通过。脱敏记录位于本机 `.artifacts/state-runtime-20261110/verification.json` 及同目录日志；测试容器和临时凭据已清理。没有调用实际模型、发送飞书／邮件或连接公司业务数据库。

## 第三批 公司入口与迁移

新增 `src/company.ts`／`CompanyServer`：同一外置权威装配原生 DSH、飞书来源、文字查询／控制、任务和进度、群委托、实际成员名单、固定版本报告附件和录音纪要。产品页与授权 API 同进程独立端口；管理员配置与每位主人登录身份分开，普通主人不能保存管理员设置。工作空间固定在已授权群，不通过改页面模式将历史搬给另一群。

`DurableArtifacts` 与 `LocalBlobStore` 保存不可变正文和真实 Word；发布先保留写入预留、完成字节校验后提交 manifest。人工修改 CAS、来源摘要与当前资源授权、下载复核、孤儿回收均有契约测试。录音正文改存 BlobRef；百炼 checkpoint 改为可等待，在提交／轮询之前保证实际持久化。

`NativeOfficeBackend` 复用原生 SessionController、AgentDelivery 和角色模型，不用规则补丁冒充模型执行。工具等待输入已持久送达且进入 Session 后才可运行；只开放当前任务的受管工具，持久化经过裁剪的实际执行事件用于进度。丢失原生历史时拒绝盲重放；接管跨进程核验所有者／epoch 的实际停止和 flush 回执，缺席或租约过期不算确认。B 之前仍保留原生 provider；它没有实现 B 的空白计算恢复。

`DurableFeishuSource` 验证 bot、使用安装租约、提交恢复游标，并遵守 ready marker 和 UTF-8 流背压。公司群内普通成员仅作上下文；主人命令经过持久参数和回执，查询不会落入模型任务。既有持续委托映射成外置设置版本与领域策略；撤权在保存时持久暂停受影响任务，并排队更新评估，不因重新授权自动解除人工控制。

`migrate.ts` 提供只读 dry-run、来源与身份显式映射、空目标／同摘要续传、正文与 DOCX 校验、版本／回执保留和 staging 闭锁。旧 effect 进入隔离记录，旧不明发送保持 unknown；数据 ready 与执行激活分开。`backup.ts` 提供携带 CAS／墓碑／作业 sequence 的外置快照和跨适配器恢复，恢复默认 held、登录失效。它不是 schema 11 旧 Runtime 的自动降级器。

`state:admin` 提供显式初始化、盘点导入、检查、停止任务登记、Outbox 核查、激活和快照回滚；不会开启监听或发送。配置、模板、同机盒子部署和正式切换步骤见 [操作方案](COMPANY_PRODUCT.md)。默认 bundle、个人 Runtime 和现行盒子均未自动切换。

第三批的数据库、HTTP、文件与 NativeOfficeBackend 代码是真实现；验收中的模型、原生 Session 服务、OAuth、飞书和 ASR 网络端为夹具。最终计数见 `docs/PROJECT.md` 与本机 `.artifacts/state-product-20261111/verification.json`。企业实际登录／真实群及模型／盒子迁移继续按操作方案验收，再决定是否封板 A。随后推进 B，再复核执行端口，最后推进网关与 Runner。

第三批验收：全量 **101 个文件、1534 项通过、4 项现有跳过**；双数据库状态专项 **12 个文件、112 项通过**；Loom 前端 **4 个文件、15 项通过**，类型检查和双端构建通过。编译后的 state/company 入口、PostgreSQL 管理命令初始化／检查／导出／恢复／激活实际通过；隔离浏览器读回固定群空间与 ready 状态。凭据和测试服务已在本轮结束前清理。以上不扩大为真实飞书、模型或公司盒子已验收。
