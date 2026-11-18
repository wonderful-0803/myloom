# Superagent 个人助手

Loom 通过设备和飞书协助处理日常事务，默认面向个人；同一产品可选择群内共享模式，由一个机器人服务指定群的多位主人。

在 [wonderful-0803/dsh-superagent-prototype](https://github.com/wonderful-0803/dsh-superagent-prototype) 中，基于 [DeepSeek 开源研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype) 进行开发，沿用其 DeepSeek Harness 基础架构并扩展办公场景。

第一版聚焦：在已授权的飞书信息范围内静默发现需求，后台推进工作总结、数据汇总、资料查阅等任务，并让用户随时查看、调整方向、协作、暂停和接管。

## 当前状态

- 2026-11-13 用户进一步授权当前个人试点的局域网免登录工作台：显式绑定盒子 `192.168.0.158:3084` 的产品网关；后端保持回环与既有群／任务／产物 ACL、同源 CSRF，未开放 DSH 管理或公网。实现与实际验证见 [部署记录](SERVER_DEPLOYMENT.md)。
- 2026-11-16 修正公司 Worker 能力装配：公司场景不再把后台 Worker 限制为四个 Loom 办公工具；实际 DSH Worker 保留网页检索、文件／图片、Shell／后台作业、Skill、todo、PTC 和子任务插件，Loom 增加任务目录、权限 preset、连接器授权和研究证据验收。AI 盒子 release `20261116-worker-capabilities-9d74e67b` 已重启验证，详见 [Worker 能力装配](WORKER_CAPABILITIES.md)。
- 2026-11-13 按用户要求，当前 AI 盒子个人试点工作台取消登录，采用 `local-operator` 回环／SSH 入口；无密码／临时码／登录 Cookie，仍有自动 CSRF 与当前管理者、群／任务／产物 ACL。SQLite／PostgreSQL 全量 1697 项和实际 DSH 无登录双群隔离／重启、盒子无 Cookie 与真实浏览器直达“已连接”通过，原配置和历史保留。实现、访问和范围见 [部署记录](SERVER_DEPLOYMENT.md)。下条登录修复为此前阶段记录。

- 2026-11-13 修复公司工作台真实浏览器登录：受限 HTTP 表单使用 same-origin referrer 策略，保留严格来源拒绝；多标签页只复用已登记且有效的浏览器绑定，失败页可重新登录。`src/state/{auth,http}.ts`、SQLite／PostgreSQL 登录回归、全量 1695 项及实际浏览器进入原群“已连接”通过，已部署 AI 盒子；详见 [部署记录](SERVER_DEPLOYMENT.md)。

- 2026-11-12 用户授权增加一个机器人、多个独立授权群：新增持久群目录、可信 chat_id 单流分发、逐群 SQL/native provider 与实际 Harness root、共享容量和登录、每次访问核验及工作台管理。保留现行单群启动方式，不自动监听其他已加入群。SQLite／真实 PostgreSQL 和真实 rc.3 双群隔离与重启通过；AI 盒子现已切换，原群／4 主人／auto／4 任务／11 产物版本／5 原生会话及重启登录保留；第二个真实群与多群负载另验。实现、使用和证据见 [MULTI_GROUP.md](MULTI_GROUP.md)。

- 2026-11-12 C2 完成限定的端侧 Linux 文本只读核心：独立本机身份、审核公钥、显式版本化目录授权、fd 安全读取/枚举/字面检索、SQLite 先落账后执行、结果去重/保留期限、进程独占和崩溃 unknown 恢复。真实独立进程 SIGSTOP/SIGKILL 与编译 CLI 均用虚构文件验收，不读取个人资料、不改盒子运行服务。联网配对/设备网关/A-B 串联及两机仍待 C3/C4，见 [C2](work-packages/GATEWAY_RUNNER_C2.md)。
- 2026-11-17 C3/C4 继续补齐：设备登记、一次性配对消费和撤销状态通过 `StateGatewayDirectory` 写入 Loom `gateway-pairing:*`／`gateway-device:*` KV，网关请求账本通过 `StateGatewayLedgerBackend` 写入 `execution` family 的 SQLite/PostgreSQL CAS 状态；`src/execution/tls.ts` 实现 TLS 1.3 出站 Runner、Ed25519 握手、JSONL RPC、心跳确认和断线自动重连；`CompanyServer` 已支持可选 TLS Gateway 第二监听器和管理员配对/注册/列表/撤销 API。`CompanyRemoteExecution` 将新公司任务接到 `ExecutionRouter`，Worker 仅注册远程 read/glob/grep 工具。AI 盒子已配置证书/3443，真实虚构文件已通过 Gateway/TLS/Runner 读回，见 [C3](work-packages/GATEWAY_RUNNER_C3.md) 与 [C4](work-packages/GATEWAY_RUNNER_C4_ACCEPTANCE.md)。

- 2026-11-12 用户授权后，盒子切换新版公司入口（现行程序版本见部署记录）：独立 PostgreSQL/native 状态生效，3 任务/10 版本/3 Worker 历史保留，原群/4 主人/模型/auto 不变，真实 consumer ready。受限 SSH 工作台登录、实际页面、未登录拒绝和切换后重启验证通过；真实新群任务/Word 原线程交付和文件下载核对通过；域名/Feishu OAuth、新版录音与执行中控制复验保留，见 [部署记录](SERVER_DEPLOYMENT.md)。C1 协议/路由/内存模拟器开始落实，全量 1654 项通过，真实 Runner/网关未启用，见 [C1](work-packages/GATEWAY_RUNNER_C1.md)。下列 B6 旧“未切换”表述是此前阶段状态。

- 2026-11-12 B6 补齐：Linux 进程退出证据与原生前缀恢复、附件 v2/完整备份、真实角色装配的工具过滤及写句柄边界、公司 profile 转换/有序启动。全量 1634 项通过；既有 ARM AI 盒子完成隔离附件、完整角色越权探针和 SIGKILL 接续，以及真实 3 任务/10 版本/3 会话的派生分区导入与空库回滚。当前正式服务/provider 未切换，OAuth/真实群重启交付仍属上线验收，整个 B 包不记为已上线。实现与证据见 [B6](work-packages/DSH_STATE_B6.md)，下列 B1–B5 为各阶段记录。

- 2026-11-12 推进 B5 首批：`src/state/native.ts`、`consumer.ts` 区分有序停机与失权/未知故障，真实 drain/flush 后仅对仍获授权的文本任务保留 retry；模型选择直接从原生事件恢复，摆脱 UI Controller 投影依赖；结构化终态后结束实际循环。新增 `scripts/smoke-dsh-office.mjs`，以实际 rc.3 Loader/AgentLoop/权限/preset/pi-ai/SQL/公司服务检验独立进程接续、人工改稿与模型选择，受控和真实模型证据分别见 [B5 记录](work-packages/DSH_STATE_B5.md)。仍仅合成记录、飞书隔离传输；缺少停止证明的崩溃自动恢复、附件、完整生产环境及盒子切换未完成，整个 B 包保持未完成。

- 2026-11-12 推进 B4 首批：新增 `src/dsh-metadata.ts`、`src/dsh-state/{catalog,metadata,archive}.ts`，实现 DSH KV 后端、workspace 单 owner/重载/失权拒写、环境契约与当前 preset/model 门禁、冻结源只读导出/dry-run/可续传导入，保留原 Session ID/header/seq/fork 和 workspace 归属/排序/归档/置顶；schema 5 保留 1–4 升级数据，新 families 纳入停止后的备份/回滚。实际 rc.3 JSONL/JSON 生成合成源，经编译 CLI 导出/导入，在新进程以真实 WorkspaceRegistry 读回；未调用真实模型或飞书。实现、操作和证据见 [B4 记录](work-packages/DSH_STATE_B4.md)。仅文本历史＋workspace，结构化附件拒绝迁入；旧目录/凭据/进程不复制，无停止证据的任务仍 hold，完整模型接续及盒子切换仍待 B5 和独立验收，整个 B 包未完成。

- 2026-11-11 推进 B3 首批：`src/dsh-state/ownership.ts`、provider/handle 与 `src/state/native.ts` 统一公司任务和原生写入的同一 owner/epoch，使用真实 AgentHandle 生命周期，在发布前安装推理/工具守卫；输入固定快照与 flush 确认、当前暂停/来源/控制核验、产物和实际 drain 回执已连接。显式 `nativeState: external` 才接入 SQL，公司入口复用 provider 仓储；默认配置和 AI 盒子未切换。SQLite＋真实 PostgreSQL 通过共享租约、接管等待、旧轮次拒写、flush 故障及受控接续，并通过持久作业到原线程交付的隔离链；实际 rc.3 验证 idle Agent 创建/恢复/销毁，无真实模型调用。实现、证据和剩余边界见 [B3 记录](work-packages/DSH_STATE_B3.md)。无停止证据的崩溃任务仍 hold，元数据 backend/导入及完整模型任务恢复待 B4/B5；整个 B 包未完成。

- 2026-11-11 推进第二包 B1：新增 `src/dsh-state.ts`／`src/dsh-state/`，实现原生 SessionPersistence、独立 header／事件记录、连续性与摘要、实时路由／flush／关闭、A 同库租约和失权拒写；新增 SQL 备份的原生 writer 停止检查。SQLite＋真实 PostgreSQL 原生契约和两进程 SIGKILL／SIGSTOP 验证共 **28 项**，含备份与文档专项 **41 项**通过；实际安装的 DSH rc.3 使用编译产物两次独立启动，保留同 ID／header／输入与 fork。固定契约、元数据挂载清单和证据见 [B1 记录](work-packages/DSH_STATE_B1.md)。公司轮次租约与 provider 句柄租约尚待统一，元数据 backend、旧日志导入和完整 AgentLoop／模型接续尚待 B3–B5；未切换盒子或当前 provider，不将此项记为整个 B 包完成。

- 2026-11-11 补第一包剩余公司群实现：`src/company.ts`／`src/state/server.ts` 将独立产品 HTTP、当前飞书身份与安装映射、原生 Session 适配、群委托／成员、任务控制和实际进度、不可变报告／DOCX／录音转写及原线程附件接到同一外置数据库。新增只读迁移 dry-run、冻结旧库导入、未知结果核查、显式激活与携带 CAS／墓碑／作业序列的回滚；正文和文件不再以该入口的旧 KV 为权威。个人原 Runtime 和现行盒子均未切换，群范围不扩大到个人邮箱、Codex 或跨群。操作与实际验收条件见 [公司入口和迁移](work-packages/COMPANY_PRODUCT.md)。最终全量 **101 个文件、1534 项通过、4 项现有跳过**；状态专项 **12 个文件、112 项**在 SQLite＋真实 PostgreSQL 16 上通过，前端 **4 个文件、15 项**通过，类型检查／双端构建及编译后 PostgreSQL 管理命令演练通过。隔离浏览器已读回公司群、固定空间与 runtime/jobs/feishu ready；OAuth 与外部服务为夹具。脱敏记录在本机 `.artifacts/state-product-20261111/verification.json`。B 的原生 provider 和 Runner 仍待实现。

- 2026-11-10 已记录 [Router 对照实验结论](ROUTER_EXPERIMENTS.md)，保留单一逻辑 Router 作为基线，不把早期双分片的信息缺失归因为分片必然退化。按 A → B → 执行接口复核 → C 顺序开始开发，服务端仍为此前 AI 盒子。`src/state/` 首批实现异步 SQLite／PostgreSQL 仓储及接单、控制、文本 Outbox；第二批增加 `AsyncTaskRuntime`／`DurableConsumer`，打通独立异步内核的评估、Worker 回执、有序交付、认领续期、跨进程并发池和失败挂起。真实 PostgreSQL、断库及独立进程 SIGKILL 进入隔离验收，第二批整个工作区 **94 个文件、1490 项通过、4 项现有跳过**。完整 Runtime／正式来源身份／产品读模型、BlobStore、正式迁移、DSH provider 与 Runner 尚未接入，第一包仍未完成；边界和后续见 [分批实现说明](work-packages/STATE_STORAGE.md)。本轮没有切换现有实例，脱敏验证记录在本机 `.artifacts/state-runtime-20261110/`。

  本轮首批状态专项 49 项通过；全量回归 93 个文件、1470 项通过、4 项现有用例跳过，类型检查和构建通过。编译后的双适配器包入口读写通过。以上来自开发机专用测试库和合成来源／传输，未宣称盒子迁移、原生 DSH Session 恢复或真实设备工具已验收。

- 2026-11-09 完成执行接口抽象：`src/execution/port.ts` 统一本机任务准备、原生工具与子 Agent、后台作业和停止确认的目标绑定及调用边界；Runtime 共享端口。旧任务明确兼容本机，Runner／错误目标拒绝本地回退，远端 artifact_file 不读取服务器目录；结果未知保留操作记录并暂停。实现及专项测试见 [工作包入口](work-packages/README.md) 与 `tests/execution-port.spec.ts`。Loom／DSH 状态外置和网关／Runner 尚未实现，三个具体开发工作包已存入该目录，未切换正在运行的实例或扩大权限。

- 2026-11-06 补齐 DSH Worker 的受控 Word 输出：通过报告工具生成实际 `.docx`，固定二进制版本与哈希，复用 Loom 下载、飞书原线程和去重投递。明确 Word 请求不再默认发送 TXT；内部工具限制不再解释成飞书 scope 缺失。普通 Shell／任意文件未开放，PDF／表格等生成仍待接入；实现与验证见 [任务文档](DOCUMENT_ARTIFACTS.md)。真实一体机验收另记部署文档。

- 2026-11-06 新增群录音会议纪要持续委托：主人仅发录音时原线程询问，确认后通过受控转写工具进入同一任务与报告交付；支持暂停、取消、撤权及来源复核，未完整读取转写不能发布定稿。按用户选择优先接百炼 `qwen-audio-3.1-asr-flash-filetrans`，现有凭据及真实私有上传／识别已通过；Yoyo 实际上传 40 分 41 秒录音、登登原线程确认、转写、v1/v2 纪要附件已读回核验，见 [录音说明](MEETING_RECORDINGS.md)。

- 2026-11-06 已按用户提供的远程连接，在 Ubuntu 22.04 / aarch64 一体机部署同一 Loom 的独立服务。专用系统账号、独立数据、回环端口 3084、systemd 开机启动与异常恢复已实际验证，真实 Harness / 模型执行了 ARM 工具调用。采用用户指定的新机器人，旧个人实例不迁移；应用身份群成员权限已生效，已开启指定群、本人为唯一主人的共享模式与 auto；无 @ 接单、原线程附件、连续改稿及接管持久化已实际验收。过程、配置及真实验收边界见 [SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md)。

- 2026-11-06 用户确认保留同一套 Loom 产品，新增可选“群内共享”运行模式。已接入本机管理页的模式／群／实际成员选择、独立主人授权、静默接单与群上下文、共用任务控制及原线程报告。切换模式更换调度会话，个人历史不转入共享空间；移除主人阻止后续读取、报告、恢复和交付。共享模式只开放受控群文字工具，个人邮箱、设备同步和未经授权的文件／Shell 不接入。实现、隔离测试与公司部署前提见 [GROUP_MODE.md](GROUP_MODE.md)；录音链路已做双主人真实联调；文档／Base／内网连接器及更多多人撤权场景仍待完成；公司一体机部署进展见 [SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md)。本次是既有产品的受限模式，不另建团队产品或 A2A 系统。

- 2026-11-06 修复桌面独立助手在新 Linux 上无法生成同步二维码的初始化缺口：本人点击登录时，从当前实例已验证的应用文件引用建立独立用户配置，保留机器人严格身份；配置缺失、CLI 不存在和连接故障分别显示。`src/sync/feishu-config.ts` 与扩展的 CLI／API／页面用例验证，本机合成 CLI 子进程完成授权流程，真实同事机器仍待更新后复验。

- 2026-11-06 飞书同步默认方案已接入实际代码：`src/sync/feishu*.ts` 提供本人 CLI 设备码授权、专用云空间、不可变增量及上传读回、设备管理和复用的只读 MCP。默认页提供真实授权／连接按钮，自建同步仍在高级设置标注“待验证”。两个独立连接器往返及编译后真实 MCP 有隔离证据；真实飞书权限和双机仍待验收，不计为完成。当前复用已配置的同应用飞书 CLI，统一免配置发行授权服务尚未实现。范围及边界见 [跨设备方案](DEVICE_SYNC.md)。

- 2026-11-06 Linux 跨设备验收补充：新增 `pnpm sync:local` 私有本机服务引导、SSH 双机验收清单和实际服务重启／权限检查；修复未找到会话也显示上传成功的问题。全局暂停、部分上传重试与设备撤销增加回归。当前证据仍为本机隔离检查，真实第二台 Linux 和业务项目待按 [双机清单](DEVICE_SYNC_LINUX_ACCEPTANCE.md) 操作；记录见 [联调证据](PERSONAL_ACCEPTANCE.md)。

- 2026-11-06 按用户明确要求新增同一所有者的跨设备文字讨论接续：私人同步空间、一次性设备邀请、项目采集与 AI 读取独立授权、持久会话增量、本人方案/理由版本及只读 MCP。来源电脑成功上传后可离线，服务端需在线。实现与隔离联调见 [跨设备接续](DEVICE_SYNC.md)；真实双机、实际历史和公司 HTTPS 部署尚待配置后验收。远程控制其他机器的 Agent、自动总结认定决定、原生会话数据库迁移及团队共享不在本轮范围。

- 2026-11-05 桌面 0.4.1 修复启动失败后无法返回修改配置：安全停止当前本机实例后解锁向导，保留数据库并追加设置版本；兼容 Harness 改写的 YAML 凭据，防止以空 Key 重试。真实打包窗口和隔离 Harness 的失败／编辑／重启流程通过，证据见 [联调记录](PERSONAL_ACCEPTANCE.md)。

- 2026-11-05 按用户明确要求新增 Windows x64 原生版 0.4.0，使用 Windows 本机 Node 进程、命名管道、LocalAppData 和文件 ACL，不依赖 WSL／tmux／Python 控制脚本。已构建 exe／ZIP，实际验证原生窗口、22 项桌面测试、Windows 后端用例，以及真实 Harness 的独立初始化、工作空间连接和停止。飞书／模型接口联调使用隔离替身；真实账户和完整任务执行尚待配置后验收。使用与证据见 [桌面文档](DESKTOP.md) 和 [联调记录](PERSONAL_ACCEPTANCE.md)。

- 用户确认优先制作 Linux 桌面端。新增 `desktop/`，复用本机个人运行时，提供原生窗口、托盘、连接状态和安全生命周期管理。0.2.0 按用户要求增加独立首次配置：环境准备、模型校验、飞书机器人、本人及监听范围、确认启动；独立凭据与任务库，不自动继承原数据或中断旧监听。真实 Harness 启停和原生表单已验收，外部校验替身与真实凭据验收分别记录。后续 Mac／Windows 客户端与本段 Linux 原有验收分开记录；新机器一键依赖安装及云端尚未实现。说明见 [DESKTOP.md](DESKTOP.md)，验证证据独立记入联调记录。
- 2026-11-04 按用户要求新增 macOS 压缩包：0.3.0 补齐 Mac 启动、Homebrew 命令路径、菜单栏图标、首次配置引擎选择、双架构打包及原生 CI 验证。安装包是本机客户端，不包含他人凭据或完整 Harness／CLI 依赖；本地签名、Developer ID 与公证分开说明。实际构建／原生启动证据见 [桌面文档](DESKTOP.md) 与 [联调记录](PERSONAL_ACCEPTANCE.md)，完整 Mac 业务联调仍待配置后验收。
- 2026-11-04 按用户要求接入本机 Codex 会话的只读验证：Loom 新增“Codex 历史”，由本人确认日期后，通过 Codex CLI App Server 的列表／元数据／分页读取接口展示当天用户消息及助手回复。授权绑定单一所有者与上海日界线，此单日查看入口的正文不进入任务、草稿或自动投递；独立创建的日报委托另行授权来源快照用于汇总，不恢复 Codex 执行。实现与边界见 [LOOM_SETUP.md](LOOM_SETUP.md)；执行委派、跨实例 A2A 和远程读取仍待设计。
- 按用户 2026-11-04 要求新增报告交付设置：默认飞书文件，可仅在 Loom 保留或在核对本人邮箱后授权后续定稿自动发信；任务可覆盖默认。明确登记 `.md`／`.txt` 完整报告并固定版本，投递与完成状态分离，支持暂停／撤权／改稿失效和结果不明不重发。实现与限制见 [LOOM_SETUP.md](LOOM_SETUP.md)，外部发送自动化使用替身，真实部署验收另记联调记录。
- 2026-11-04 新增 Loom 个人工作空间，在同一本机服务中接入任务、草稿、版本、控制和邮件；复用既有记录及权限检查，原演示执行器保持隔离。说明见 [LOOM_SETUP.md](LOOM_SETUP.md)，部署证据与测试独立记入联调记录。
- Loom 新增“持续委托”：所有者设置常驻目标、指定已授权群与可选关键词，逐条选择自动执行或仅观察；保存、编辑和启停均有持久回执。匹配新消息后仍经目标／来源／交付物评估，再创建真实任务与 Worker。暂停或来源撤销会持有未完成的自动委托任务，历史交付物保留。同一表单现增加 Codex 会话日报：选择项目或会话、持续读取用途授权、北京时间每日运行及立即运行，复用真实 Harness 任务与交付物，默认仅本地，可选本人私聊／已有交付设置。仅为此日报接入时钟，文档评论、CI 和通用定时事件仍待接入；不因此扩大工具或邮件权限。实现与验收见 [LOOM_SETUP.md](LOOM_SETUP.md) 和 `tests/delegations.spec.ts`。
- 按用户 2026-11-04 的明确要求，将当前总结、数据汇总、资料查阅三条基础规则切为 auto，开始测试无 @ 自主执行；仍仅本人、既有测试群及现有工具权限。Loom 的概览、持续委托和连接设置页新增“自主处理”模式入口及基础规则开关，保存调用既有版本化设置服务；历史观察不重放，邮件仍须本人预览确认。接口与端到端任务验证见 `tests/loom.spec.ts`，真实验收见联调记录。
- 事件收件箱新增从消息到当前授权任务的关联、实时状态与详情入口；概览和任务明细共用单请求刷新，避免嵌入标签页可见性及慢请求导致旧数据长期保留，并显示最后同步时间。检索工具缺少访问凭据时仅显示固定安全原因，未配置或更换搜索服务。验证见 `tests/loom-live-sync.spec.ts`、`tests/loom.spec.ts`、`tests/task-progress.spec.ts`。
- 任务详情新增原生动作和耗时进展、模型重试及接管移交状态；只读查询不启动任务，不导出内部推理或原始日志，异步读取前后均核验来源。修正交还后的执行轮次被误记为服务重启的问题；办公 Skill 增加有边界的汇总及阶段上报指导，真实性能改进待下一轮测量。实现：`src/app/task-progress.ts`、`loom/src/client/live/Progress.tsx`；测试：`tests/task-progress.spec.ts`。

- 已 fork 上游原型并记录产品方向和待实现原则。
- 已支持仅飞书启动、办公任务技能、精确 CSV 汇总和受管任务的暂停／接管／交还。本机独立管理服务运行，百炼 `qwen3.8-flash` 已跑通真实飞书私聊工作总结、原线程交付和同任务追加要求；群聊与办公能力的实际验收见 [联调记录](PERSONAL_ACCEPTANCE.md)。
- 已部署所有者文字查询与控制入口；私聊任务列表、持久报告正文和真实 TXT 导出通过实际收取及飞书 API 读回。命令直接读取记录，不调用模型或唤醒任务。操作与边界见 [使用说明](FEISHU_ASSISTANT.md)。
- 本轮新增正文版本库、消息来源哈希、引用消息的自然控制与邮件确认、人工改稿冲突保护，以及没有工具的受控静默草稿箱。自动化验收与真实飞书验收分开记录；卡片后端已接通原生回调处理，但原应用发布审核锁定配置、尚未订阅卡片回调，实际按钮暂不启用。预算和范围见 [使用说明](FEISHU_ASSISTANT.md)。
- 接管覆盖受管工具、后台作业与交付队列，不等同于完整设备接管或 OS 隔离。163 邮件交付已通过飞书私聊预览、本人明确确认、实际 SMTP 提交和用户收件确认，限固定报告正文投递给本人；企业邮箱发信暂缓；按内容筛选的邮箱规则、完整文件产物索引、多人实时编辑及跨任务隐私网关仍待实现，飞书工作台暂缓。
- 第一版原定单人；2026-11-06 用户明确新增同一产品内的“指定群、多主人”模式。通用团队空间、跨群共享和跨独立 Agent 的 A2A 仍不在当前范围。
- 当前使用本机 Linux 与 `deepseek-v4.1-flash-1017`，沿用既有 `dashscope` 兼容接口及本机凭据；默认模型、接单评估、Worker／日报和静默草稿已切换，已有受管会话的后续选择同步更新。通过独立 Harness 会话完成真实工具调用及回答，未重跑历史任务，证据见 [联调记录](PERSONAL_ACCEPTANCE.md)。跨设备与推广部署仍待确定。交互以群内原线程为主、机器人私聊查询任务和产物为辅；暂缓飞书工作台，邮箱支持固定报告单次预览确认，以及本人在 Loom 明确保存的后续定稿交付授权，见 [飞书产品入口](FEISHU_PRODUCT.md)。

## 开发入口

- [待实现清单与原则](ROADMAP.md)：第一版范围、后续能力、触发条件和验收要求。
- [服务端架构实施方案](SERVER_ARCHITECTURE_IMPLEMENTATION.md)：飞书群聊／卡片／工作台入口、可选桌面端、DSH 计算与状态分离、服务端网关和端侧 Runner 的逐层改造及验收；当前为目标方案，未迁移或扩大现有运行权限。
- [开发约定](../AGENTS.md)：后续开发时如何查阅和落实这些原则。
- [上游项目说明](../README.md)：原型现有能力和文档入口。
- [个人助手运行说明](PERSONAL_SETUP.md)：当前代码能力、配置方式和验证边界。

## 设计参考

- [《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://www.bestblogs.dev/article/bdcf6ab3ac)
- [DeepSeek 开源研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)

在原型的事件驱动、Router/Worker、任务订阅和持久化机制上推进个人助手改造。文章描述的能力与开源实现存在差异，不能将设计愿景直接视为已实现功能。
