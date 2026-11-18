# B 包收尾：异常恢复、附件与 AI 盒子验收

日期：2026-11-12。承接 B1/B3/B4/B5。目标仍是既有 Ubuntu ARM AI 盒子上的受控办公服务，不包含 C 包的 Runner、任意远程目录或跨集群容灾。

状态：本轮完成限定范围内的异常恢复、原生附件、部署工具和 AI 盒子隔离验收。正式来源切换与企业 OAuth/真实飞书重启交付仍属于上线验收，未执行；不将隔离测试记为正式实例已迁移。

后续更新：用户于同日明确授权切换，盒子已经运行 SQL/native 外置状态；当前工作台使用受限 SSH 管理员登录，飞书 OAuth 仍后置。真实无 @ 群消息已生成稳定任务、Word v1 并发回原线程，实际下载哈希与 OOXML R1/R2 内容核对通过。首轮暴露独立配置目录下的 rc.3 子 preset 依赖解析问题，已修复并重评原 trigger，失败 Decision 保留。实际版本、切换、修复与当前访问步骤见 [部署记录](../SERVER_DEPLOYMENT.md)。本文此前“尚未切换”段落保留为阶段记录，现行状态以该部署记录为准；新版录音和执行中控制仍须单独复验。

## 异常中断如何恢复

`src/dsh-state/compute.ts` 保存 Linux machine-id 的摘要、boot ID、PID namespace、PID、进程 start ticks 和 UID。只有同一主机/服务身份能够核验的进程退出、PID 已重用或整机已重启，才构成退出证据。SIGSTOP、仍运行的进程、其他主机、不同 PID namespace、无权读取的身份均不被当作“已退出”。新容器/其他机器需要受信宿主监督协议，当前保持挂起。

`src/dsh-state/recovery.ts` 重新验证 SQL 日志连续性与摘要、固定输入内容及其消费证据、未完成工具的类别。验证成功后写 `native-recovered/<session>/<epoch>`，记录实际已持久前缀和退出身份摘要；**它不是** graceful `native-quiescent`，不声称崩溃前未刷盘的尾部已经保存。释放租约时仍比较原 owner/epoch，不释放新 owner 的租约。

公司服务启动前及单任务恢复检查通过 `NativeOfficeBackend.recover` 核对当前来源、主人、任务/Assignment、控制版本、暂停与未确认操作，只恢复原稳定 requestId 对应的文本作业。录音转写、未知外部写入、已失败/完成的报告和人工控制不被自动重放。失效的 job claim 仍按数据库的代次/令牌和超时收敛，不强行抢占并发槽。

workspace domain 和 Router 的旧进程也登记身份；确认已退出后才可提前释放旧租约并从数据库重载。租约自然过期仍提供元数据 fencing，但不能替代任务执行所需的物理退出证据。

Loom 任务进展显示具体恢复阻碍。公司工作台的管理者可用“检查恢复”，调用 `POST /tasks/:id/recovery` 再次核验；接口不接受客户端提交“旧进程已死”的声明，也不会杀进程。人工暂停、接管和 unknown 保持原来的处理方式。

## 附件和旧工作目录

复用 rc.3 `LocalAttachmentStore` 的内容寻址、图片标准化、文件字节和读取校验。部署时把 `attachment-local.config.dshHome` 指向独立持久 home，例如 `/var/lib/loom/native`；不要指向可删除的计算 scratch。company 私有配置中的 `attachmentHome` 必须与实际挂载吻合，未开放任意文件工具。

归档 v2 在原生事件旁保留被引用的图片/文件 ref 和原字节，`src/dsh-state/attachments.ts` 校验范围、类型、规范 base64、长度、摘要及引用完整性。未引用附件不被夹带；v1 继续只接受文字。单附件≤20MiB，归档≤100MB，附件引用≤5000。实际图片解码与宽高/媒体类型由锁定的 rc.3 codec 在私有暂存目录复核；任何失败都不能让 native-import 进入 ready。

`scripts/native-attachment-io.mjs` 只操作明确配置的私有目录，拒绝符号链接和逃逸硬链接。DSH 文件对象自身使用内部硬链接，因此只在确认整个链接集合均在同一选定附件树内时接受。导出始终读取冻结私有副本；目标对象不可变、复制可续传，恢复不会重写历史事件或附件 ID。

冻结源映射可增加 `attachmentHome`，仅读取该 home 下的 `attachments`，不读凭据文件。目标 company.json 增加 `harnessRoot` 和 `attachmentHome`。`dsh-state:admin export/dry-run/import` 使用同一校验；A 的 `state:admin export/restore` 同时保存/恢复 native 附件，缺少附件适配器时明确拒绝产生不完整备份。普通业务产物继续使用原有 BlobStore。

历史 Session 的 header/cwd 不改写。只有操作者明确配置 `legacyWorkspaceRoots`、实际目录仍存在、根目录私有、路径无符号链接且由服务账号拥有时，才允许旧办公会话在兼容执行池接续。新任务继续创建可重建 scratch。目录内容不复制，不能将此功能解释为 C 包的跨设备环境迁移。

## 完整角色配置的能力边界

`scripts/smoke-dsh-office.mjs --profile-file /private/effective.yml --deny-probe` 读取明确指定的实际 rc.3 有效配置，保留真实角色预设与核心服务，替换 SQL/附件/模型测试路由，关闭原来源和额外标题模型；Harness Web 仅绑定随机回环端口，禁止打开浏览器或打印 token。

实际角色中的 scoped 子 Agent 工具不一定被 inherited tool restriction 隐藏。因此在原有执行 guard 之外，增加模型请求前的工具列表过滤，只有当前任务的受控工具能出现在请求中。越权调用探针实际返回 `subagent` 请求，必须得到失败结果且不能创建子 Session。公司 Worker 的原生写句柄也拒绝在未借用应用租约时被原始 Harness API 接管。

## AI 盒子实施顺序

1. 在独立目录与测试数据库跑 ARM 的编译产物、真实角色配置、异常恢复、附件迁移和备份回滚，不与原机器人争抢监听。
2. 核对实际未完成任务与在途操作；停止来源/消费者/Agent 并确认实际服务进程退出，冻结 SQLite、原生日志、workspace、附件和对象。模型与机器人密钥独立保留，不进入发行包。
3. 显式生成旧空间/主人/安装映射，先 dry-run 再导入 A/B 状态；保留任务 ID、全部版本、原 Session header/事件、附件及 unknown。迁移目标保持暂停，先核对只读结果。
4. 验证离线备份能恢复到空库且默认暂停，保存新旧 release、配置与数据备份；不把旧文件库当成切换后的最新状态。
5. 只启用一个来源消费者，在既有群和权限内验收任务、人工控制、同 Session 接续及固定版本交付。回滚前保留新库增量，禁止新旧 provider 同时写同一会话。

验收证据、是否切换和剩余事项在完成上述步骤后追加。本包不承诺通用文件格式处理、跨主机自动死亡认定、远程写入或第三方插件任意兼容。

## 可重复部署的入口

`pnpm company:prepare --config /etc/loom/company.json --effective /private/rc3-effective.yml --contract /etc/loom/dsh-environment.json --output /etc/loom/company-profile.json` 将操作者明确指定的 rc.3 effective 配置转换为私有 JSON profile。先构建，将配置输出目录设为服务账号可读的 `0700`、输入/输出文件 `0600`；已有输出拒绝覆盖。私有配置必须包含 `nativeState: external`、`harnessRoot`、`attachmentHome` 和稳定的独立 scratch。实际 ID 不符合脚本的已核对 profile 时应先审查适配，不猜测挂载位置。

转换器保留真实角色，锁定全部 preset composition 的摘要和模型清单；关闭旧 Runtime/来源/JSONL 和额外标题模型，workspace 路由到 SQL，附件指向持久 home，非权威 JSON 缓存放在可重建目录。Harness Web 仅回环随机端口、不打印管理 URL，产品端口独立。模型 refs 和凭据引用保持原有机制；部署者在独立 DSH_HOME/服务环境准备密钥，脚本不迁移凭据。源/目标 contract 摘要必须一致；变更角色或模型目录须先显式迁移，不能静默覆盖数据库中的环境契约。

`pnpm company:start --profile /etc/loom/company-profile.json --harness-root /absolute/rc3/dsh` 使用锁定 Harness 的官方 boot，并在退出时先停止产品来源/消费者/Agent，再卸载元数据和 SQL provider。对应 [systemd 模板](../../examples/loom-company.service) 使用独立公司 DSH_HOME，默认只允许 `/var/lib/loom` 可写；按实际部署路径修改。模板不是自动上线许可，也不会配置 PostgreSQL、HTTPS 或飞书回调。

## 2026-11-12 验收记录

本地全量：**107 个文件、1634 项通过、4 项跳过**，包含专用 PostgreSQL 16 的契约和故障测试。TypeScript、编译、Loom 类型/15 项前端测试/构建通过。退出身份识别用真实 Linux 子进程，SIGSTOP 不作死亡证据，SIGKILL 后仅恢复已提交前缀。归档测试覆盖 none/zstd；实际 rc.3 codec 检验文件与生成的 PNG，旧附件目录删除后新进程仍可读。

AI 盒子：Ubuntu 22.04 / aarch64，Node 24.21.0，Harness 0.2.1-rc.3；测试数据库仅回环 `15436`，与现行服务和数据库分离。原生附件/WorkspaceRegistry 两次启动、实际完整角色 profile 的越权子 Agent 探针及 SIGKILL 接续通过。模型为受控回环供应商，真实 AgentLoop 和持久层实际运行；真实模型另有 B5 的合成记录证据，不把本次受控模型称为真实模型验收。

旧服务停机快照实际耗时约 **0.4 秒**，随即恢复。完整原始快照留在盒子私有验收目录，未复制到本机或发行包。预检检测到 **2 条启用群模式前的来源消息**，拒绝混合导入；另存显式分区计划与摘要，在派生副本中排除这两条及其纯关联决策，保留原始快照。未将旧 Router 或普通个人 Session 混入群空间，只映射已有 3 个群任务对应的 Worker；旧会话仍保留在私有原始归档。

实际数据隔离导入/回读：**3 个任务、10 个产物版本、3 个 Worker Session、361 条原生事件**。保留任务 ID、控制、人工/AI 版本、全部正文与真实 Word 字节、原始 header/seq；不是只验证空库初始化。归档导入保持暂停。停止所有隔离消费者后导出完整外置备份，在另一空 PostgreSQL 数据库恢复，逐记录比较上述 families 的值和 revision；执行仍关闭、登录失效、作业 held。

证据索引：工作区 `.artifacts/dsh-state-b6-20261112/verification.json`；盒子 `/var/lib/loom/b6-acceptance/` 为 `0700` 私有验收目录。不得把其中 frozen 数据、原生归档或凭据随包分发。公司入口使用本次编译代码、完整 rc.3 角色与真实 bot 身份校验完成两次冷启动；来源持久禁用，readyz=paused；未登录的产品 API 均返回 401；SIGTERM 均正常退出 0。探针未调用企业 OAuth 交换或真实模型，也未发送消息。备份包含 1082 条记录及 12 个业务对象；恢复逐项值/revision 比对通过。

最终发行包 `20261112-b6-d8956bc0`（源码打包 108 文件；依赖为 43 个纯 JS 包，原生模块使用盒子既有 ARM 工具链）仅暂存到 `/opt/loom/releases`，没有改 current 链接。专用盒子 PostgreSQL 验收容器结束后停止，私有数据/回滚副本保留；本机专用测试容器移除，凭据不进仓库。完整代码/隔离证据不等于正式实例启用。

## 剩余上线与后续范围

本轮没有修改 `/opt/loom/current` 或正式来源。切换前须明确唯一来源、实际 HTTPS/OAuth 回调及服务凭据，重新获取当时的一致快照，不使用本轮隔离副本覆盖之后的新消息。真实飞书同任务重启交付和现有录音等连接器须按公司入口上线清单复验；原服务仍使用旧 provider。换言之，**B 的上述限定代码/隔离验收已落实，生产切换尚未完成，整体包不能标记为已上线**。

C 的网关/Runner、跨宿主/跨容器自动死亡裁定、通用第三方工具重放、目录内容迁移、任意插件兼容、整机高可用与容量压测不包含在本轮完成范围。来源禁用也会撤销相关历史读取权限；隔离验收的离线读回阶段临时保持来源配置授权但没有运行任何监听，启动探针前再持久禁用来源，未通过绕过鉴权读取业务数据。

2026-11-12 用户明确选择“没有域名，保留现行服务”。因此本轮止于代码与盒子隔离验收，不实施正式迁移。HTTPS 是当前公司网页登录入口的设计要求（Secure Cookie/同源校验）；`/auth/callback` 是用户完成飞书登录后，浏览器携授权码返回 Loom 的已登记地址，与飞书消息长连接不是同一接口。不需要为了目前的群机器人工作先购买域名，也不自动要求把服务开放到公网；后续可使用公司子域名或内网可达的可信 HTTPS 地址，另行配置证书、登录回调及真实入口验收。

用户后续确认：功能验收阶段先使用 AI 盒子的现有服务地址，域名上线和飞书重定向白名单后置。当前 Loom 为盒子回环 `127.0.0.1:3084`，盒子本机访问或通过既有 SSH 隧道访问，具体步骤见 [盒子部署](../SERVER_DEPLOYMENT.md)。2026-11-12 核对 `http://192.168.0.158/orchestrator/loom/` 实际跳转到该主机已有的 `/users/sign_in`，不是 Loom，不占用该服务或误记为已发布的工作台。此安排允许现行工作台及隔离功能验收继续；新公司入口仍保持已有 HTTPS/Cookie/OAuth 校验，真实飞书网页登录验收在白名单配置后补做，不能因此宣称新入口已切换或取消鉴权。
