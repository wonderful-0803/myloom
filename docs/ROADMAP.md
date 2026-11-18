# 待实现清单与设计原则

记录日期：2026-11-03。

本文记录已确定的方向和后续开发约束。未勾选条目待本项目适配、补齐或验收；上游已具备的机制需先核对和复用，不能据此认定需要全部重写。当前实现与联调边界见 [PERSONAL_SETUP.md](PERSONAL_SETUP.md)。

开发基线：[wonderful-0803/dsh-superagent-prototype](https://github.com/wonderful-0803/dsh-superagent-prototype)，fork 自 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，沿用 DeepSeek Harness 基础架构。项目定位见 [PROJECT.md](PROJECT.md)。

## 第一版范围

服务单个用户，通过设备与飞书协助处理个人日常事务。优先覆盖工作总结、数据汇总、资料查阅，并保留接入编码任务的扩展空间。

核心体验：在授权范围内静默发现需求并后台推进；任务始终可查；用户通过稳定的任务会话随时查看、调整方向、协作、暂停或接管。

第一版不包含团队协作、多用户共享和跨独立 Agent 的 A2A 协作。内部 Router/Worker 分工可按需要采用，不等同于跨权限边界的 A2A。

2026-11-06 范围补充：用户选择在同一 Loom 产品里新增可选“群内共享”模式，而非另建产品。当前限定一个群与显式多主人，复用现有执行、任务和交付；F1 在这一受限范围内同步落实。通用团队、多群共享、企业网页登录和 A2A 不随之默认引入，见 [GROUP_MODE.md](GROUP_MODE.md)。

设备平台与部署形态按下述目标架构规划；具体改造范围和模型配置需结合每项功能核对。

2026-11-09 目标架构补充：用户明确公司集中部署方向，飞书以群聊、卡片和工作台作为入口，桌面端为可选工作台／设备管家；Agent 计算和权威状态在公司服务端，环境适配与工具执行在目标机器的 Runner，服务端仅保留工具路由与设备网关。逐层方案、代码工作包与 M0–M4 放行条件见 [服务端架构实施方案](SERVER_ARCHITECTURE_IMPLEMENTATION.md)。2026-11-17 C3/C4 已将请求账本、设备登记、配对消费和撤销记录接入外部 StateStore，完成 TLS 1.3 出站 Runner、Ed25519 握手、心跳和自动重连，并把 TLS Gateway、受保护配对入口和 `CompanyRemoteExecution` 接入 CompanyServer；AI 盒子已完成 3443 部署，虚构远程文件读取已通过。证书轮换、剩余故障矩阵和更广泛的写/执行能力仍待实施。

## 第一版待实现

### P1：事件接入与静默发现

- [ ] 明确飞书监听范围、可读取资源及个人授权依据；无 @ 的发现能力依赖实际可接收的群消息范围。
- [ ] 结合连续讨论判断目标、对象、交付物及工作依据，检查已有任务，避免重复接单。
- [ ] 区分候选线索、明确请求和预授权规则；信息不足时保留线索，不擅自扩大工作范围。
- [x] 为主动规则提供观察模式，先记录拟执行的工作，再按配置启用自动执行。实现复用现有策略评估与规则；`tests/personal.spec.ts` 覆盖 observe/auto，真实测试群的无 @ 请求得到 `wouldAccept` 且无任务、无交付，见 `PERSONAL_ACCEPTANCE.md`。2026-11-04 按用户要求切为 auto，Loom 已提供模式及基础规则开关，范围与真实验收见 `PERSONAL_ACCEPTANCE.md`。
- [x] 本机所有者可在 Loom 创建和启停“持续委托”，为单条规则明确目标、群范围、可选关键词及观察／自动模式，关联其任务与交付物。实现：`src/app/delegations.ts`、`src/policy.ts`、`loom/src/client/live/Delegations.tsx`；`tests/delegations.spec.ts` 验证持久化、幂等、范围与消息新鲜度、真实任务／Worker／报告链路、停用及撤权后持有任务、恢复权限前拒绝继续。自动化测试中的模型判断及外部 API 使用替身，真实飞书自主接单质量仍须另行验收。基础规则可在 Loom 独立切换 observe／auto，不将创建回执伪装成群消息。新增 Codex 日报专用的定时／手动触发、项目／会话范围及持续读取用于汇总的独立授权，复用真实任务、受限 Worker 与现有报告交付；实现：`src/app/codex-daily.ts`、`src/codex-delegation.ts`；`tests/codex-daily.spec.ts` 与扩展 `tests/codex-history.spec.ts` 覆盖幂等、日界线、来源过滤和异步撤权，真实验收见 `PERSONAL_ACCEPTANCE.md`。文档评论、CI、通用时钟事件和逐委托执行预算仍未接入。
- [ ] 后台探索保持低打扰；主动通知以可用结果、必要决策或无法继续的问题为主。用户主动查询时可查看状态。
- [ ] 为后台探索设置可配置的时间、模型和工具使用预算，并提供取消入口。
  - 2026-11-18 首轮信号链路已接入 Feishu 消息、附件、线程跟进和已认证 Runner online/offline 的归一化、创建即不变审计、来源去重和两秒短窗口；未 @ 群消息会在同一 Thread 的窗口结束后一次评估，明确 @ 或私聊消息立即评估；工作台事件收件箱显示附件、话题回复和合并评估状态。实现：`src/state/signals.ts`、`src/state/feishu.ts`、`src/state/application.ts`、`src/core/{engine,intake,evals,model,part}.ts`、`src/execution/gateway.ts`、`src/state/product.ts`、`loom/src/client/live/Pages.tsx`；验证：`tests/state-contract/signals.spec.ts`、`tests/state-contract/service.spec.ts`、`tests/core-engine.spec.ts`、`tests/gateway.spec.ts`。短窗口不丢弃原始输入；持久队列 flush、调用预算和退避仍待实现。
  - 2026-11-06 ARM 公司试点：A1 无 @ 总结约 25 秒交付；A3 重启后跨线程总结约 151 秒，原生累计模型约 136 秒、工具约 205 毫秒。当前群分页召回会带入无关记录；线程限定、关联来源裁剪、推理／token 与墙钟预算、未接入媒介和闲聊轻量分流仍待补齐，不能用单条简单总结代表所有任务的性能。真实证据见 [SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md)。

### P2：稳定任务与办公执行

2026-11-06 文档产物补充：新增 DSH 报告工具的 Word 输出选项，受限 renderer、实际二进制版本、正文／文件哈希、生成期间要求与控制复核、损坏拒发及原线程去重同时落地。明确 Word 请求拒绝纯文本 ready，不再误报飞书权限不足。实现与专项测试见 [DOCUMENT_ARTIFACTS.md](DOCUMENT_ARTIFACTS.md)。仅 Word 和现有文本产物已接入；通用文件执行沙箱、任意文件产物及其他办公格式仍待实现，不据此勾选全部文件能力。

2026-11-06 录音纪要补充：`meetings.ts` 在当前共享群的录音持续委托下核验原消息，以原线程主人明确确认创建普通任务；`asr-bailian.ts` 提供私有上传、云任务接续及有界结果，`audio.ts` 保留可选本地连接器。单任务转写工具、分页全文门禁、音频／转写哈希、发送前来源复核与受管暂停同时落地。17 项后端专项与 2 项表单测试使用外部替身，百炼中文音频实际转写另有证据。Yoyo 上传、登登确认的真实飞书录音链路及原线程详版改稿已通过（两版附件哈希读回一致）；企业 OSS 留存、真实中途撤权及妙记仍待完成，不据此勾选全部会议与资源权限目标，见 [MEETING_RECORDINGS.md](MEETING_RECORDINGS.md)。

- [ ] 以稳定任务 ID 关联飞书消息、任务会话、执行记录、资料和产物；Worker 重启或替换不改变任务归属。
- [ ] 保存目标、要求、来源、当前进展、缺失信息、产物及人工干预记录。
  - `task-progress.ts` 与 Loom 任务详情已接入实际步骤、工具动作、耗时、阶段报告、重试及控制时间线，查询不启动模型／Worker；`tests/task-progress.spec.ts` 覆盖原始推理／命令过滤、继承上下文排除、接管在途状态、异步撤权及故障降级。完整需求版本和任意文件产物索引仍待实现。
- [ ] 明确区分飞书讨论串、面向用户的任务会话和底层执行 Session。
  - 2026-11-04 新增 Codex 本机会话只读入口，单独显示 Codex 原生会话 ID 和当天对话；单日查看不把它变成 Superagent Ticket，不调用 resume／turn；日报委托独立授权所选项目／会话的当天文字用于固定任务来源快照，不恢复 Codex 执行。`codex-history.ts`、`codex-rpc.ts` 及对应测试覆盖具体日期授权、分页、源类型、权限撤销和消息过滤；真实联调独立记入 `PERSONAL_ACCEPTANCE.md`。这不是 Codex 执行器或 A2A 协作，后续双向交互须落实 F2 的授权与生命周期要求。
- [ ] 支持工作总结：注明覆盖的时间和资料范围，区分事实、推断和缺失信息。
- [ ] 支持数据汇总：记录来源快照或版本、统计口径、计算步骤及完整性限制。
- [ ] 支持资料查阅：保留来源、引用和检索时间，使结论可复核。
  - 当前新增 CSV 精确汇总、口径与快照工具（`skills/dsh-superagent-office/aggregate.py`，`tests/office-data.spec.ts`）；真实群聊和检索证据逐项记入 `PERSONAL_ACCEPTANCE.md`。通用表格/飞书数据权限变化的验收仍未完成。
- [x] 办公任务的初始化、完成和验收独立于代码仓库或 PR，按产物定义完成条件。实现：`src/app/setup.ts`、`src/app/tools/executor.ts`、`skills/dsh-superagent-office/SKILL.md`；验证：`tests/personal.spec.ts` 的仅飞书启动、无 PR 完成及后续恢复测试。真实任务质量仍需联调。
- [ ] 配置持久化、重试与去重；恢复执行前检查已有外部结果，避免重复写入和交付。

### P3：用户介入与协同

2026-11-04 桌面首次配置补充：`desktop/onboarding.cjs` 与 `desktop/ui/onboarding.js` 提供独立环境、模型／机器人校验、唯一所有者、精确监听范围、观察／自动选择及最终确认启动。新配置不导入旧凭据或历史；重复或不明的旧机器人监听阻止新启动。`src/personal-setup.ts` 只初始化新任务库并记录真实版本化办公设置，拒绝覆盖旧库；凭据本机文件 0600、目录 0700，工作空间无原生 IPC。相关验收：`tests/personal-setup.spec.ts`、`desktop/test/onboarding.test.cjs`、`tests/service-script.spec.ts`，真实 Harness 启停与五步原生界面证据见 `PERSONAL_ACCEPTANCE.md`。云端身份和模型校验替身不计为新应用真实验收；新机器一键依赖安装、扫码建应用、OS 沙箱及正式迁移仍待实现。此处多个本机配置用于单人体验，不引入任务共享、团队或跨 Agent 委托。

2026-11-04 用户确认开发 Linux 桌面端。首版以现有本机个人助手为基础，复用同一执行与记录，增加原生窗口、托盘、连接检测、明确退出语义和受限 IPC；不据此扩大飞书权限或切为多人／云端。实现与验证见 `desktop/`、`DESKTOP.md` 及 `PERSONAL_ACCEPTANCE.md`。完整新设备免配置、开机自启、签名升级及其他系统仍待实现；后续 Mac 内测包另见下文。

2026-11-04 用户进一步要求制作 macOS 压缩包。新增本机 Mac 客户端适配、arm64／Intel ZIP 及独立 macOS 构建验证；CI 只使用源码和空白首次配置，不复制本机会话、模型／飞书凭据，不把个人助手迁到云端。签名、公证、完整设备依赖安装及 Mac 业务联调分别记录，具体证据见 `DESKTOP.md` 和 `PERSONAL_ACCEPTANCE.md`。

2026-11-05 用户要求制作原生 Windows 应用，明确不复用 WSL。0.4.0 新增 x64 exe／ZIP、Windows 原生依赖识别、私有命名管道后台控制、凭据目录 ACL、原生 CLI 与 PowerShell 工作目录准备，并修复首次启动中写死 Bash 工具的问题。真实 Windows 窗口及空白配置、实际 Harness 初始化／连接／安全停止已验收，外部接口使用隔离替身；完整真实模型和飞书任务、全新机器自动装依赖与发布者签名分别保留待验收，见 `DESKTOP.md` 和 `PERSONAL_ACCEPTANCE.md`。

2026-11-04 按用户新提供的 Loom 应用接入本机个人界面，挂载于现有管理服务而非飞书工作台；共用任务、草稿、产物版本及控制／邮件服务，不新建第二套飞书监听或执行状态。访问仅限本机个人管理，不能据此勾选跨设备、多用户或完整文件协作目标。实现与边界见 [LOOM_SETUP.md](LOOM_SETUP.md)。

2026-11-03 用户选择群内原线程为主、机器人私聊按需查询任务与产物，暂不推进飞书工作台。[飞书交互探索](FEISHU_INTERACTION.md) 记录职责、通知策略、状态语义及接入验收，并纳入总结／纪要的邮箱交付。可点击模拟原型不作为功能完成证据；新应用等待审批期间继续沿用原机器人。

当前进展：`src/app/feishu-assistant.ts` 已接入所有者专用文字查询和控制，私聊任务列表、持久报告及真实 TXT 导出通过操作者收取和飞书 API 读回，查询不新建或重启任务。原群线程暂停／状态查询／继续已由真实消息验收，接管／交还的飞书实测仍待补充。卡片、协同编辑与完整产物索引仍待实现，命令见 [使用说明](FEISHU_ASSISTANT.md)。本节保留完整目标的未勾选状态，不以部分交付替代其余验收。

2026-11-18 飞书工作台入口首版补齐身份层：`feishu-workbench` 复用 Feishu OAuth 取得可信 `open_id`，未获业务授权的 UID 可进入首次机器人绑定页，管理者可短时验证已有机器人、查看默认权限／事件清单并登记私有凭据引用。实现：`src/state/{auth,http,workbench,server}.ts`、`loom/src/client/live/WorkbenchSetup.tsx`、`docs/FEISHU_WORKBENCH.md`；隔离证据：`tests/state-contract/workbench.spec.ts`，并复跑产品／群授权契约。飞书平台创建、敏感权限审批、发布和新机器人运行时热切换仍待平台与部署验收，UID 不自动获得群、任务或产物权限。

- [ ] 通过飞书原话题、机器人私聊和任务工作台访问同一任务；单纯查看不暂停执行。
- [ ] 将用户的新要求保存为任务要求版本，确认受影响步骤，防止旧结果覆盖新要求下的产物。
- [ ] 支持人与 Agent 协同编辑，约定正在修改的对象或区域，展示冲突并保留人工修改。
- [ ] 暂停后阻止后续执行并保存进度；重启、自动反馈或新 Worker 不得自行解除暂停。
- [ ] 接管时由系统阻止相关排队写入，跟踪在途操作，确认控制权移交后再显示“已接管”。
- [ ] 接管可以作用于任务或具体产物；其他任务按各自控制状态运行。
- [ ] 交还 Agent 时重新读取人工修改、当前要求和权限，从现有成果继续。
- [ ] 停止、取消、暂停和接管具有明确语义；已发生的外部操作如实记录，不宣称自动撤销。
  - 已实现受管任务的持久控制状态、原生工具租约、后台作业停止、排队交付作废及在途交接（`src/app/task-control.ts`、`sessions.ts`、`outbox.ts`、`src/executor/dsh.ts`）；本机任务页和飞书明确文字命令提供控制入口，`tests/task-control.spec.ts`、`tests/panel-execution.spec.tsx` 与 `tests/feishu-assistant.spec.ts` 验证。未勾选的完整目标仍包含设备执行隔离、人工版本冲突保护、卡片及真实异常恢复验收。
- [ ] 支持工作总结、纪要等定稿产物的邮箱交付：所有者预设收件人和适用规则，固定产物版本，校验目的地，防止重复发送；区分任务完成与投递状态。改稿、暂停或规则撤销使旧投递失效，结果不明先核查。
  - 2026-11-04 新增 `result-delivery.ts` 与 Loom “产物交付”：默认飞书报告文件、仅本地、已验证本人邮箱；全局默认与任务覆盖使用版本检查，保存邮箱设置才产生常驻授权。`artifact_file` 明确登记任务内 `.md`／`.txt` 报告，旧任务可显式登记及投递，草稿不自动发布。`tests/result-delivery.spec.ts` 覆盖真实 ready 链路、目的地范围、不可变文件、暂停／改稿／撤权、幂等及邮箱授权异步撤销；`tests/smtp-mail.spec.ts` 验证固定文本附件。模型及外部发送使用替身；真实收件与完整文件索引、内容型规则仍须分别验收，见 `PERSONAL_ACCEPTANCE.md`。
  - `src/app/feishu-mail.ts` 已实现仅给自己的飞书企业邮箱桥接：固定报告预览、显式确认、创建草稿、发送、取消和回执查询；`tests/feishu-mail.spec.ts` 覆盖任务变化、撤权、取消及未知结果不重发。已通过用户身份与真实邮箱核验，当前仅授予邮箱地址读取和草稿权限，发送／回执两项尚未授予；未创建远端草稿或发送真实邮件。权限不足时仅预览，不提供发送许可，确认前再次核验权限。企业邮箱两条真实预览已读回，用户随后选择先改用 163，暂缓企业邮箱发信。新增 `scripts/personal-mail`：真实 TLS／SMTP 登录及所有者绑定已通过，凭据在本机输入；本人收件人、稳定 Message-ID、提交前持久去重和 SMTP 接收记录由 `tests/smtp-mail.spec.ts` 与邮件入口测试验证。163 的私聊预览／明确确认／实际提交已由飞书回执及 SMTP 记录核验，用户确认收到邮件；这只完成固定报告正文给本人的单次交付，自动规则、附件及其他目的地仍待实现。

### P4：个人场景的上下文、安全与隐私

2026-11-03 三组后续工作的首轮实现：

- `artifacts.ts` 保存不可变报告正文版本、作者、来源消息 SHA256 和要求指纹；历史任务只导入仍存在的报告，不补造历史。预览、历史、导出和邮件复核当前来源权限。文件级产物登记、完整引用权限网关及 OS 隔离仍未实现。
- 本人接管并等待在途归零后可编辑正文；Worker 须读取最新版本并提交 `artifact_version`，旧写入会被拒绝。邮件许可进一步绑定正文版本与哈希。此处是串行版本冲突保护，未实现多人实时合并。
- 自然文字通过引用原任务／助手消息选择任务；继续、交还与邮件确认使用那条回复保存的控制版本或发送许可，不自动使用当前最新许可。多候选时不猜测，普通查询不调用模型。
- Card 2.0 列表、状态、控制、邮件和编辑表单，以及独立 `card.action.trigger` 消费者已实现；服务端许可核验实际操作者、原消息／群、有效期、控制／产物版本与单次使用。原应用审核中，后台回调列表为空且“添加回调”禁用，真实按钮暂不启用，不把模拟回调当作飞书验收。
- `quiet-drafts.ts` 在 observe 结果之后增设独立预授权起草开关，仅指定群的本人纯文本总结／纪要；没有工具，不创建 Worker、不回复群、不自动发信。也支持私聊明确提出的起草请求。上海时区每日默认 3 次、单并发、6000 输入字符、900 输出 token、30 秒；权限／规则／配置撤销中止结果，失败计费尝试不盲目重放。草稿可确认、取消、编辑和导出。
- 自动化证据：`tests/artifacts.spec.ts`、`tests/quiet-drafts.spec.ts`、`tests/feishu-cards.spec.ts` 与扩展的助手、邮件测试。真实部署和消息验收独立写入 `PERSONAL_ACCEPTANCE.md`；未完成的完整目标保持未勾选。

这些要求在开发对应功能时落实，不随团队协作能力一起推迟。

- [ ] 明确任务上下文与个人长期记忆的边界，只注入当前工作所需的信息。
- [ ] 跨任务召回有明确用途和资源权限依据；引用、摘要、搜索索引、缓存和日志纳入同一隐私设计。
- [ ] 工具调用在后端检查实际身份、任务授权范围、资源和目的地，不能只依靠提示词。
- [ ] 保护凭据，优先通过受控工具或凭据代理使用，不将密钥注入模型上下文、产物或日志。
- [ ] 为执行器限制可接触的文件、服务和工具；独立目录和命令包装不作为完整隔离边界。
- [ ] 外部消息、文档、网页和 Agent 返回正文作为数据处理，不能据此改变授权或系统规则。
- [ ] 交付前检查产物中的信息及其目的地；个人助手也不能将私人资料默认发布到群聊。
- [ ] 操作入口和卡片回调核验实际操作者，不信任正文声称的身份。
- [ ] 权限撤销、任务取消、暂停和接管在后续工具调用及外部写入前生效，包括排队工作和恢复执行。
- [ ] 定义数据保留、删除、导出和日志脱敏策略，并记录用户可理解的关键活动。

本轮部分落实：飞书文字入口在后端核验实际人类操作者、名单、当前监听范围、任务来源归属、原群线程、控制消息时效与版本；发送前重新核验，列表剔除已撤销来源，导出只生成固定报告 TXT，不接受任意路径。邮件使用独立用户 CLI 或本机 SMTP 代理，核验实际所有者与邮箱，固定版本和收件人，发信前重新检查取消、暂停和授权，结果不明不盲目重发。实现及模拟异常验收见 `feishu-assistant.ts`、`feishu-mail.ts` 与对应测试。这些限制不替代通用资源沙箱或跨任务信息流网关。

## 后续扩展：上下文边界与 A2A

对应参考文章第 8.3 节。当前不实现团队协作或跨独立 Agent 协作；开发相关能力时纳入以下条目。

### F1：多用户与共享空间

服务器试点进展：2026-11-06 已在真实 Ubuntu ARM 一体机部署独立 Loom 服务，验证模型工具调用、回环管理限制及异常恢复；指定群单主人无 @ 任务、报告附件、连续改稿和控制持久化已完成实际验收；真实多人场景仍待参加者配置后验证，见 [SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md)。这不改变下列完整目标的未完成状态。

2026-11-06 本轮局部实现：`src/group-mode.ts` 与 `src/app/loom.ts` 提供模式与实际群成员选择，`feishu.ts`／`runtime.ts`／`policy.ts` 在后端识别主人并将普通讨论作为上下文；`artifacts.ts`、`resources.ts`、`sessions.ts` 和 `result-delivery.ts` 复核空间、来源、版本与原群目的地。共享 Router／Worker 不开放通用文件、CLI 或 Shell；模式切换更换调度会话，私人邮箱／同步／Codex 不进入共享群。`tests/group-mode.spec.ts` 和界面 `WorkspaceMode.test.tsx` 提供隔离链路证据。通用资源 ACL、行字段权限、跨来源信息流、留存管理及真实公司多人验收未完成，以下完整目标仍保持未勾选。

- [ ] 区分个人、项目和团队空间，并在空间内部继续按任务控制上下文。
- [ ] 共享空间成员身份不自动授予全部关联资源的权限；Router 按需接收获准共享的信息。
- [ ] 检索、缓存、摘要、产物预览和导出执行一致的权限规则。
- [ ] 跨边界生成的汇总结果保留来源与可见范围约束，防止通过摘要泄露受限内容。
- [ ] 为任务控制权、协同编辑和冲突处理定义负责人及可操作成员。

### F2：跨独立 Agent 委托

- [ ] 以明确委托交换必要信息，默认不传递完整会话、私人记忆或凭据。
- [ ] 委托记录请求方、代表用户、目标、授权依据、资源范围、允许动作、结果接收者和有效期。
- [ ] 接收方独立验证请求及本地权限；委托不得合并或扩大双方原有权限。
- [ ] 支持稳定请求 ID、去重、超时、取消、状态反馈和有限的重试及委派深度。
- [ ] 限制循环委派，保存来源与委派链；正文中的身份或授权声明不作为信任依据。
- [ ] 委托撤销后检查排队动作、在途操作和结果交付，清楚呈现实际状态。

## 后续扩展：跨设备与更广泛的安全边界

2026-11-06 新机器登录修复：桌面独立实例在显式登录操作时复用当前应用的文件凭据引用创建专用用户配置，不复制密钥正文、不导入其他用户或修改机器人 strict mode。`src/sync/feishu-config.ts`、`tests/feishu-config.spec.ts` 覆盖实例／所有者／应用核验、私有文件、旧登录保留及实际 CLI 子进程的二维码／完成流程；CLI／API／页面分别验证安全错误分类和重试。该修复不替代真实用户授权、完整新机器发行或双机验收。

2026-11-06 用户确认飞书同步作为默认方案，自建同步放入高级设置并标注“待验证”。后续按要求接入真实的用户 CLI 授权、专用云空间批次、来源／版本重建、设备记录、删除及 MCP。默认入口只检查身份，创建／连接云空间仍需本人同意，采集与 AI 读取各自授权；保留已有自建后台配置。实现于 `src/sync/feishu*.ts`，隔离用例为 `tests/feishu-sync.spec.ts`、`tests/feishu-drive.spec.ts`、扩展 API／前端测试及 `pnpm sync:smoke:feishu`。真实账户权限及用户双机未验收，以下完整条目继续保持未勾选，详见 [DEVICE_SYNC.md](DEVICE_SYNC.md)。

- [ ] 飞书用户授权与专用目录存储接入：最小读写权限、令牌续期、同一所有者和项目边界、客户端不分发 App Secret。
- [ ] 飞书批次同步与召回：不可变版本、来源哈希、分页、断线恢复、并发分支、配额及独立 AI 读取授权。
- [ ] 飞书同步的真实 Linux 双机验收：来源离线、原文及方案接续、去重、设备撤销、用户撤权和项目删除。

以上三项已有所述部分实现及隔离证据，真实接入／验收仍待完成；新电脑免配置授权服务尚待实现，受管设备撤销不替代飞书账号退出或企业设备管控。

2026-11-06 Linux 验收补充：`scripts/sync-local.mjs` 提供回环服务和私有凭据初始化，`scripts/smoke-sync-local.mjs` 实际验证权限、重启持久性与符号链接拒绝。`tests/device-sync.spec.ts` 补充空目录不伪造回执、全局暂停、部分上传恢复和设备撤销；页面单独显示检查时间及实际确认计数。双机 SSH 联调与完整通过条件见 [Linux 双机清单](DEVICE_SYNC_LINUX_ACCEPTANCE.md)，真实用户双机仍待执行，不将本机替身检查作为完成证据。

2026-11-06 用户授权将“同一人跨设备接续文字讨论”作为基础能力实现。新增独立数据同步服务、设备/空间身份与项目边界；不因此启用远程执行端或团队协作。`src/sync/`、本机 `loom/sync` 路由及跨设备页面已接入。采集和 AI 召回分别授权、分页检查点在持久回执后前进，来源离线后读服务端副本，分支与原始来源保留。`tests/device-sync*.spec.*` 和编译后 `pnpm sync:smoke` 提供隔离证据，详情与部署边界见 [DEVICE_SYNC.md](DEVICE_SYNC.md)。完整跨设备执行、安全沙箱、组织身份及真实用户双机验收继续单独保留。

对应参考文章第 8.4 节。具体能力是否进入第一版，由设备和部署方案决定；一旦引入，相关约束须同步落实。

2026-11-04 用户明确要求通过 ngrok 访问当前 Loom，先提供密码保护入口，随后按“取消账号密码、给领导看效果”的要求改为免登录只读展示。仅允许 Loom 页面和读取 API，禁止写操作、原始 Codex 历史及会话选项，校验浏览器来源后适配本机 Host／Origin，不开放原生 Harness、通用管理接口或远程执行端。公开链接允许访问者查看现有任务、事件及报告；本机原入口的完整操作、本机执行和飞书范围不变。关闭独立 `loom-ngrok` 后台会话即可撤销入口。实际外网验收见 `PERSONAL_ACCEPTANCE.md`，不据此勾选正式跨设备身份、云端执行或多人部署。

- [x] 抽出本机执行接口：任务／Session／轮次／目标／控制版本绑定，准备、原生工具／子 Agent、后台作业和停止确认统一经过端口；Runner 与错误目标禁止本机回退，unknown 保留并暂停。实现 `src/execution/port.ts`、`runtime.ts`、`sessions.ts`、`executor/dsh.ts`、`task-control.ts`，专项证据 `tests/execution-port.spec.ts`；此项仅为执行边界，不代表远程执行和外部状态已完成。
- [ ] 云端计算、持久状态和设备执行环境分别定义权限及生命周期。
  - 2026-11-09 已按现有代码整理 [Loom 状态外置](work-packages/LOOM_STATE.md)、[DSH 状态外置](work-packages/DSH_STATE.md)、[网关与 Runner](work-packages/GATEWAY_RUNNER.md) 的接口、依赖、实施步骤、迁移及故障验收；[共同交接说明](work-packages/README.md) 记录已接入的执行端口与未完成边界。文档不是三个工作包已经实现的证据。
  - 2026-11-10 按用户指定顺序开发 A 包，部署目标仍是既有 AI 盒子。`src/state/` 两批已实现异步双适配器、短事务命令、控制及文本 Outbox，以及独立 `AsyncTaskRuntime`／`DurableConsumer` 的后台评估、回执、持久并发池、心跳和有序交付；`tests/state-contract/` 验证真实 PostgreSQL、连接中断、提交前后／认领后 SIGKILL 和不明交付不重发。旧 Runtime／真实入口／全部 KV、产品读模型、BlobStore、正式迁移仍待接入；并发池不是 DSH 原生 Session 或设备端单写者验收，不据此勾选本目标。详见 [分批状态实现](work-packages/STATE_STORAGE.md)；此前实验结论见 [Router 实验记录](ROUTER_EXPERIMENTS.md)。
  - 2026-11-11 补公司群产品入口、原生执行适配、安装与浏览器授权、工作台／进度、群委托与录音、不可变正文／DOCX、只读迁移和回滚。实现 `src/company.ts`、`src/state/{server,product,auth,feishu,native,artifacts,meetings,migrate,backup,recovery}.ts`；新增产品／源／原生适配／录音／迁移／回滚契约与 SQLite＋真实 PostgreSQL 验证。执行、状态和设备分离的整体目标仍未勾选：实际平台登录、盒子切换及 B／C 尚待验收。详见 [公司入口操作方案](work-packages/COMPANY_PRODUCT.md)。
  - 2026-11-11 原生状态 B1 已通过 SQLite／真实 PostgreSQL 契约、两进程 writer 争抢、SIGKILL 恢复及旧进程恢复后拒写，实际 rc.3 运行库亦通过编译后 SessionStore／fork／二次启动验证。实现 `src/dsh-state.ts`、`src/dsh-state/{provider,handle,storage}.ts`；证据 `tests/dsh-state/`、`scripts/smoke-dsh-state.mjs` 和 [B1 记录](work-packages/DSH_STATE_B1.md)。此为会话存储基础，尚未统一公司原生租约、完整元数据／AgentLoop 恢复或设备 Runner，整体计算／状态／环境分离仍未完成。
  - 2026-11-11 B3 首批将公司执行和 SQL native provider 接到同一 Session owner/epoch，补齐发布前工具/推理守卫、输入持久屏障、全局暂停事务校验及实际 AgentHandle 销毁/flush 后的停止回执；SQLite＋真实 PostgreSQL 的公司/持久作业联调与实际 rc.3 idle Agent 生命周期见 [B3 记录](work-packages/DSH_STATE_B3.md)。无旧停止证明的崩溃任务仍挂起，不宣称元数据迁移、完整模型恢复、Runner 或盒子切换完成。
  - 2026-11-12 B4 首批补 SQL KV/workspace 单 owner、环境契约及当前 preset/model 门禁，格式4文本历史冻结导出/dry-run/可续传导入；schema 5 与 metadata 停止后备份/回滚已连接。实际 rc.3 JSONL/JSON→SQL→新 WorkspaceRegistry 进程验证保留原身份/谱系/排序，见 [B4 记录](work-packages/DSH_STATE_B4.md)。附件/旧目录、无停止证明崩溃恢复和完整模型任务仍未完成，盒子与现行配置未切换。
  - 2026-11-12 B5 首批补有序停机的实际 drain/flush 后接续、原生事件恢复模型选择和终态循环收敛；真实 rc.3 AgentLoop/公司服务的独立进程接续、人工版本、模型选择和不重复交付见 [B5 记录](work-packages/DSH_STATE_B5.md)。真实模型只接触合成记录，飞书为隔离传输；无停止证明的崩溃、结构化附件和生产切换仍保留，整体目标未勾选。
  - 2026-11-12 B6 在同一 Linux AI 盒子落实退出证明/原生前缀接续、file/image 字节归档、完整外置备份、实际角色工具过滤及公司 profile/启动入口；真实历史的隔离分区迁移与空库回滚见 [B6](work-packages/DSH_STATE_B6.md)。全量 1634 项通过。正式 provider 未切换，实际 OAuth/原线程重启交付仍需上线验收；跨宿主/容器认定与任意插件副作用重放不在当前承诺内，整体目标仍不勾选。
  - 2026-11-12 用户授权切换后，盒子已启用 SQL/native 外置公司入口，私有 SSH 工作台和重启持久性通过；修复独立配置目录的 rc.3 子 preset 依赖导入后，真实无 @ 群任务和 Word 原线程交付、附件下载哈希及 R1/R2 内容核对通过。首轮超时保留，域名/OAuth、新版录音与执行中控制复验分开记录，见 [部署记录](SERVER_DEPLOYMENT.md)。
- [ ] 远程设备执行端具有设备身份认证、连接保护、命令范围、撤销和执行记录。
  - 2026-11-12 C1 补严格只读 wire 协议、受信宿主注入的路由与内存模拟器，验证无本机回退、回执去重/冲突、权限复核与取消未知，见 [C1](work-packages/GATEWAY_RUNNER_C1.md)。真实设备身份/TLS/SQLite 回执和 A/B 网关串联仍待 C2–C4，未启用远程执行。
  - 2026-11-12 C2 落实本机 Linux 授权目录、真实文本只读能力、签名许可、持久回执/去重和进程独占；临时文件及独立 SIGSTOP/SIGKILL/编译 CLI 通过，见 [C2](work-packages/GATEWAY_RUNNER_C2.md)。在线配对/TLS、A/B 网关和真实两机仍待实现，不启用群任务的私人目录能力。
  - 2026-11-17 C3/C4 已完成 AI 盒子 TLS Gateway、设备配对/撤销和 `CompanyRemoteExecution`；真实虚构文件已通过 `ExecutionRouter → Gateway → TLS → Runner` 读回，Worker 只开放远程 read/glob/grep。剩余写/后台能力、离线等待和完整取消/unknown 矩阵继续保留。
- [ ] 设备离线时保留任务状态，清楚说明依赖设备的工作正在等待，防止重连后重复执行。
- [ ] 评估服务端或某台设备被攻破时的影响范围，避免一处失陷直接获得全部设备权限。
- [ ] 独立健康检查同时观察基础设施状态和任务进展，遵守人工暂停、停止及接管状态。

## 多群独立工作空间（2026-11-12 明确授权）

- [x] 一个机器人、多群显式登记、逐群主人／模式／规则／任务／会话／产物隔离；共享单个事件连接及宿主容量，保留单群入口。实现 `src/state/{company-groups,group-broker,company-capacity}.ts`、`scripts/company-groups-server.mjs`、`loom/src/client/live/GroupSpaces.tsx`；`tests/state-contract/groups.spec.ts` 与前端测试、真实 rc.3 双 Loader／SQL 会话／虚构任务文件交付及重启证据见 [MULTI_GROUP.md](MULTI_GROUP.md)。F1 的逐群访问、控制、导出与撤权同步落实；不提供跨群共享或 A2A。
- [x] AI 盒子切换多群宿主，保持原群配置与任务／产物哈希，核验工作台登录、原群真实消费者及重启。实际版本与证据见 [SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md)。
- [ ] 由管理员登记第二个实际群，完成平台权限、多成员、停用／撤权与多群负载验收。代码及替身测试不代替此项。

2026-11-13 用户要求当前个人试点取消登录：已明确切换回环限定的 `local-operator`，不要求密码或临时码；本机身份由当前安装管理者决定，仍逐次核验群／任务／产物权限及同源 CSRF。实现、SQLite／PostgreSQL／实际 DSH／盒子与浏览器证据见 [SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md)，此后用户明确追加局域网直达需求：以独立网关仅绑定盒子私有地址和实际 LAN 子网，保留上述授权与 CSRF，不暴露 DSH 管理或公网；实现与验收继续记录在同一部署文档。

## 功能触发与补齐要求

| 开发触发点 | 同步补齐的原则 | 最少验收场景 |
| --- | --- | --- |
| 飞书监听和主动发现 | P1、P4 的来源范围与授权 | 范围外消息不被用于启动工作，重放消息不重复接单 |
| 总结、数据、检索与记忆 | P2、P4 的来源与上下文规则 | 可追溯来源；权限变化后后续召回受控 |
| 新增工具、Skill 或执行器 | P2、P4 的执行与验收约束 | 外部文本不能扩大工具权限，失败恢复不重复写入 |
  - 2026-11-16 公司 Worker 能力装配修正：Worker 恢复 DSH 的网页搜索／抓取、文件读写／图片读取、glob/grep、Shell/job、todo、Skill 和 PTC 工具表面；工具按任务目录、当前权限 preset 与插件资源策略过滤，外部副作用必须有 connector policy 和可核对 operation receipt。研究任务提交 ready 前要求至少有真实外部读取证据；缺少能力只能 blocked/waiting。实现：`src/state/worker-capabilities.ts`、`src/state/worker-sandbox.ts`、`src/state/native.ts`；专项验证：`tests/state-contract/worker-capabilities.spec.ts`。实际盒子切换与联网调研复验待部署。
  - 2026-11-18 能力目录已增加版本、执行落点、资源标签、预算和授权标志，并通过 `orchestrator_capabilities` 返回声明目录；Runner 增加显式授权的 `fs.stat`，只读文件元数据。实现：`src/state/worker-capabilities.ts`、`src/execution/protocol.ts`、`src/execution/runner/files.ts`、`src/execution/company.ts`、`src/state/native.ts`；验证：`tests/state-contract/worker-capabilities.spec.ts`、`tests/runner.spec.ts`、`tests/execution-protocol.spec.ts`。该目录与元数据能力不等于新增写入或 Shell 权限。
| 编辑或发布文档、表格和消息 | P2、P3、P4 的版本及交付规则 | 旧产物不覆盖人工修改，结果不发往未授权目的地 |
| 暂停、接管和交还 | P3、P4 的控制权规则 | 排队写入被阻止，在途操作可见，重启后仍保持控制状态 |
| 多用户、项目或团队空间 | F1 | 越权用户无法通过正文、摘要、搜索或导出取得受限信息 |
| 跨独立 Agent 委托 | F2 | 超范围委托被拒绝，重复请求去重，取消和循环限制生效 |
| 远程设备或云端执行 | 跨设备与安全边界条目 | 设备可撤销；离线恢复不重复执行；人工停止持续生效 |

## 状态维护

- 未勾选表示待实现。
- 开始开发时可在条目下补充方案、范围和依赖。
- 完成时勾选，并附实现位置及必要验证证据。
- 当范围发生变化时更新本文与 `PROJECT.md`，按需更新根 README 的开发入口，不自动将全部后续能力纳入第一版。

## 参考

- [文章全文及第 8.3、8.4 节](https://www.bestblogs.dev/article/bdcf6ab3ac)
- [开源研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)
