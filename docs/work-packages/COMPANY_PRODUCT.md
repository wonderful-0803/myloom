# 公司产品入口与状态迁移实施

更新：2026-11-11。目标服务器仍是既有 Ubuntu ARM64 AI 盒子。新增 `dsh-superagent/company` 是显式启用的公司入口：群事件、任务执行、工作台和交付共用外置状态；原个人 Runtime 和盒子现行实例不自动切换。

公司入口沿用已授权的一个群、一个机器人和 1–20 位主人。群外消息、私聊、个人草稿、私人 Codex、个人邮箱和跨设备私人同步继续受 [群模式边界](../GROUP_MODE.md) 限制。它没有新增这些群模式下本来不可用的能力。原个人客户端仍使用原 Runtime。不要将此入口当作通用多租户或所有个人功能的 PostgreSQL 版本。

2026-11-12 现行更新：用户明确授权后，AI 盒子已经切到 SQL/native 外置状态公司入口；工作台走受限 SSH 管理员登录。真实无 @ R1/R2 任务、Word 原线程交付与文件下载哈希核对已通过；首次评估暴露的私有 profile 子 preset 导入问题已修复并保留失败记录。当前版本和完整操作见 [部署记录](../SERVER_DEPLOYMENT.md)。下文首次实现时的“未切换”是历史说明；OAuth、新版录音与执行中控制仍须单独复验。

## 进程与数据

| 位置 | 内容 | 重建计算进程时 |
| --- | --- | --- |
| AI 盒子 PostgreSQL | 安装身份、设置历史、来源、任务／控制、作业与租约、输入和发送回执、进度、产物 manifest | 必须保留与备份 |
| AI 盒子独立持久目录 | UTF-8 报告、人工版本、真实 DOCX、录音转写；按空间隔离的不可变对象 | 必须保留与备份 |
| 计算进程与 scratch | DSH Agent Loop、临时工作目录、文件上传中间件、录音解码临时文件 | 可替换，不能作为 Loom 状态权威 |
| 现有 DSH Session provider | 原生 Session 历史、索引与恢复能力 | **B 包之前仍必须保留**；清空它不能宣称完整会话恢复 |
| 飞书应用 | 群入口、机器人原线程消息、打开工作台与身份登录 | 不存数据库密码或模型密钥 |

原生停止回执绑定 Session、所有者和 epoch，且须实际 idle／后台停止并 flush。停止作业被其他计算进程领取时等待该回执；本进程查不到 Session、租约到期或取消请求已发出，都不能确认接管。进程强杀后没有回执的在途原生任务保持待核查，须完成 B 的恢复或人工核对；不以数据库租约替代物理停止。

产品服务仅监听 `127.0.0.1:3085`。反向代理只能转发这个端口，不能转发 Harness 的 `3084`、数据库或命令接口。工作台路径 `/orchestrator/loom/`；飞书登录回调 `/auth/callback`。内置健康检查 `/healthz` 只说明进程在线，`/readyz` 还检查数据库和来源是否就绪。来源真正收到 CLI ready marker 后才显示 ready；待订阅期间是 starting。

先保持计算、PostgreSQL、文件在盒子同机独立管理；这解决进程生命周期耦合，不提供盒子整机故障时的高可用。

## 配置和启动

1. 构建 `pnpm check:loom`、`pnpm build`，保持已验证的 DSH／CLI 版本和原 worker/router presets。
2. 按 [配置模板](../../examples/loom-company.config.json) 准备 `/etc/loom/company.json`，权限 `0600`。模板全部为虚构身份；从公司现有记录核验实际 appId、botId、tenantKey、Open ID、群及空间 UUID，不能使用显示名推断。同步核对 `spaceId` 与已授权群空间一致。
3. 由服务管理器在私有环境文件中注入 `LOOM_STATE_DATABASE_URL` 和 `LOOM_FEISHU_APP_SECRET`。JSON 只保存环境变量名称。不可把密钥写到仓库、命令行参数、页面或日志。
4. 持久文件目录与 scratch 必须为独立绝对目录、不可互相包含；服务用户创建，目录 `0700`。若使用模板的 `/var/cache/loom/compute`，同时调整服务单元的写入白名单；现行 [loom-server.service](../../examples/loom-server.service) 只允许写 `/var/lib/loom`，不能原封不动启动新模板。
5. 在独立测试 profile 核对 [替换 patch](../../examples/loom-company.cordis.patch.yml)：停用原 `dsh-superagent`、GitHub 和 Feishu watcher，启用 `dsh-superagent/company`；保留 presets。旧 Runtime 与新来源不可并行监听同一真实应用。外置库租约只能排斥同样使用外置库的新来源，不能锁住旧 SQLite watcher。
6. 使用专用 bot-only strict CLI。启动核验 CLI 配置的 App ID、bot ready/verified 状态和 `/bot/v3/info` 返回的 bot ID，不回退用户身份。公司入口首版使用文字控制和工作台；旧卡片回调配置须关闭，历史卡片许可不迁为新许可。
7. 配好 HTTPS 域名和飞书网页授权回调。用户登录后从飞书返回的 open_id＋tenant_key 匹配安装与当前主人名单。浏览器只持 HttpOnly Cookie；写操作还需同源、CSRF 和请求 ID。成员撤权后旧 Cookie 立即失去资源权限。

网页授权依据飞书官方 [获取用户 access token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token) 和 [查询登录用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)。当前验证覆盖受控 OAuth 传输和浏览器回调，没有完成实际企业域名的飞书登录验收；发布前须核对该应用的回调白名单、可用范围及身份权限。

新建空实例使用 [初始化模板](../../examples/loom-company.initial.json)。它默认 observe 且全局暂停；真实管理员在工作台核对后恢复后台处理，再选择 auto。初始化不是导入，拒绝已有记录／墓碑／排队作业的空间。

```sh
pnpm state:admin --help
pnpm state:admin --config /etc/loom/company.json init --initial /private/verified-initial.json --apply
pnpm state:admin --config /etc/loom/company.json check --actor ou_verifiedOperator
```

## 旧实例离线迁移

只有指定实例的正式切换获得授权后，才执行以下操作。本轮没有在盒子执行。

1. 停止旧监听、新接单和发送；实际停止受管 Worker、后台作业和 ASR，flush DSH；记录未明确的外部结果。冻结 SQLite 备份，确认 checkpoint 完成且旁边无 WAL／SHM，计算备份 SHA256。源库仍是切换前唯一权威。
2. 准备私有 mapping JSON，结构为 `{ "scope": {"tenantId":"...","spaceId":"..."}, "installation": {...}, "frozenSha256":"64位摘要" }`。`installation.since` 设为本次新来源接收的起点。历史产物按原群空间授权读取；新来源不会因为恢复游标而对该起点前消息重新接单。
3. 运行 dry-run。它不打开目标数据库、不写源库，不输出正文／凭据；核验 schema 11、完整引用、版本链、来源与字节摘要、KV 归属、主人及空间映射。混合个人／群历史、私人邮箱绑定、未知键族或缺失文件会阻塞，而不是猜测归属。
4. 对空的目标 scope 执行 import。先标 staging，再写不可变对象与分批记录，逐项回读摘要，最后置 ready。中断可对相同源摘要与 mapping 续传；staging 期间产品读取与执行都拒绝。已激活的目标不允许重跑导入覆盖。
5. 导入保留原任务 ID、人工版本、来源、设置历史和发送回执。旧 effect 保存到 legacy，**不自动重放**。旧在途操作／不明确发送进入 unknown，活动原生执行转为待停止核查；邮件／卡片等旧临时许可不被重新授权。查看 check 输出，并按实际平台回执核对。

```sh
pnpm state:admin --config /etc/loom/company.json dry-run --source /private/frozen.sqlite --mapping /private/mapping.json
pnpm state:admin --config /etc/loom/company.json import --source /private/frozen.sqlite --mapping /private/mapping.json --apply
pnpm state:admin --config /etc/loom/company.json check --actor ou_verifiedOperator
```

`ready` 表示数据导入校验完成；`executionEnabled:false` 仍强制全局暂停。需要停止确认的任务可通过 `queue-stops --apply --actor ... --evidence /private/check.txt` 登记停止作业，再由新原生适配器实际取消、等待 idle／后台作业停止、flush 后写确认。停止回执不清除 unknown。

文本 Outbox 核查用 `reconcile-outbox --apply --actor ... --id ... --outcome sent|dropped --receipt ... --evidence /private/provider-check.txt`；sent 必须有已核对的渠道回执。附件／执行／带任务的回复及 legacy 操作，通过受鉴权的 `POST /orchestrator/api/loom/tasks/:id/reconcile` 核查，字段见 `Reconciliation`。必须携带当前控制 revision 和具体证据；成功也不自动继续任务。核查飞书或供应商真实结果依靠管理员或对应渠道查询，不能以“超时”推断未发送。

确认旧进程停写、原生 Session 可恢复、unknown 已逐项处理后，再显式激活：

```sh
pnpm state:admin --config /etc/loom/company.json activate --actor ou_verifiedOperator --evidence /private/cutover-check.txt --apply
```

最后从工作台刷新设置版本并恢复全局处理；人工暂停／接管仍需逐任务明确继续／交还。历史 effect 保留在审计区，不因 activate 重新执行。需要恢复某个旧任务时先核对原生会话，再使用现有任务控制或重试；不对旧 effect 表做批量盲重放。

## 回滚

切换前回滚可继续使用尚未被新系统写入的旧冻结库。切换后不能直接恢复旧 SQLite 丢弃新任务、人工编辑和交付回执。

先停止来源、所有消费者和原生计算，完成原生 flush，再导出**当前外置状态**与已引用对象。导出拒绝仍有效的来源租约或活跃认领；超过单次预算会拒绝，不截断成假备份。输出目录必须尚不存在，目录 `0700`、状态文件 `0600`。归档包含业务正文，按业务数据保护。

```sh
pnpm state:admin --config /etc/loom/company.json export --actor ou_verifiedOperator --directory /private/new-rollback
pnpm state:admin --config /etc/loom/empty-target.json restore --directory /private/new-rollback --apply
```

恢复需要相同显式 tenant／space、完整摘要、所有对象可读以及空目标。保留 CAS revision、墓碑、unknown、作业 sequence／generation；登录会话失效、作业全部 held、执行保持关闭。失败目标保持 staging；当前恢复不是可续传导入，排查后换空目标重试。之后核验当前原生 Session 和渠道回执，再明确激活与逐作业恢复。优先让旧兼容程序连接同一外置权威；此归档不是 schema 11 旧 Runtime 的自动降级导入器。

## 隔离验收与上线验收

`tests/state-contract/` 在 SQLite 与专用 PostgreSQL 16 上共用契约。产品专项包括真实 DOCX、人工版本 CAS、源撤权、浏览器一次性回调／CSRF、真实 HTTP、源租约／恢复游标、实际 NativeOfficeBackend 的输入确认时序与进度、固定版本线程交付、回执丢失不重发、录音显式确认及转写引用、跨适配器备份恢复。原有独立进程强杀、断库和并发池测试继续运行。

测试的数据库、HTTP、文件字节和原生适配器都是真实现；模型、原生 Session 服务、飞书、OAuth 交换和 ASR 网络服务是受控夹具。结果仅证明这些边界的集成，不等于企业 OAuth、真实模型长任务、实际群交付、AI 盒子迁移或 B 的空白计算环境恢复已经验收。

正式上线须在盒子的隔离新 profile 验证实际登录／撤权、原线程消息与 DOCX、录音确认／暂停、重启及未知发送核查；核对原模型路由和公司既有工具版本。完成后才更新部署记录。B 负责原生历史与元数据，网关与 Runner 负责个人设备执行。

2026-11-11 [B3 首批](DSH_STATE_B3.md) 增加公司私有配置 `nativeState: external`：必须显式挂载 SQL SessionPersistence，公司入口复用该 provider 的同一仓储/scope/租约，使用受管 AgentRegistry 生命周期；scope 不符、未挂载或混合配置均拒绝，不回退本地。默认 `configured` 与现行部署不变。后续 [B4 首批](DSH_STATE_B4.md) 已提供 SQL KV/workspace 和文本历史离线迁移，但附件、完整模型恢复和真实切换仍待验收，不能仅新增此字段就切换现行盒子。新的公司/SQL provider 集成使用真实数据库和持久作业，模型/AgentFactory/飞书为夹具；实际 rc.3 另有 idle Agent 创建/恢复/销毁验证，二者证据不可混称完整真实模型验收。

## B5 接续验收补充（2026-11-12）

SQL native 模式已连接有序停机的真实停止/刷盘证明与可恢复文本作业；模型选择无需依赖工作台 Controller 的投影注册。实际 rc.3 AgentLoop 与公司服务的独立进程、人工版本及不重复交付验收见 [B5](DSH_STATE_B5.md)。测试角色为空 composition，只装配受控办公工具，飞书传输为替身；不据此宣布真实平台、完整插件或盒子已迁移。

## B6 实施补充（2026-11-12）

B6 的实际完整角色配置、Linux SIGKILL 退出证据、原生附件、公司配置生成及有序启动、真实旧数据的隔离分区迁移/空库回滚和盒子公司入口双冷启动见 [B6](DSH_STATE_B6.md)。当前 3 任务、10 版本、3 Worker/361 事件的隔离副本已验收；原始全量快照保留且不混入旧个人/Router 会话。`scripts/company-server.mjs` 和 `examples/loom-company.service` 固定停止产品再停止原生持久服务。用户选择没有域名、保留现行服务，因此不切换 current/provider/真实来源。上文旧阶段的待办须结合 B6 阅读，企业 OAuth 与真实飞书上线验收仍待完成。

阶段部署安排：用户确认先使用 AI 盒子的现有服务做工作台/功能验收，域名和飞书 `/auth/callback` 重定向白名单待功能验收通过后配置。现行服务仍按 [部署记录](../SERVER_DEPLOYMENT.md) 使用盒子本机或 SSH 隧道的 `http://127.0.0.1:3084/orchestrator/loom/`；裸 IP 的 80 端口为主机既有其他服务。该安排没有放开新公司产品的 HTTP/OAuth 门禁；实际网页登录验收和正式切换继续独立记录。

## 2026-11-12 正式切换补充

用户随后明确授权盒子运行新版，取代此前“保留旧服务”的安排。实际切换、数据库/文件位置、当前 3084 工作台与一次性 SSH 管理员登录步骤见 [盒子部署](../SERVER_DEPLOYMENT.md)。`loginMode` 默认 `feishu`；无域名验收可显式选 `ssh-operator`，仅接受 `http://127.0.0.1:<port>`，不可用于 LAN/IP 公共登录。`scripts/company-login.mjs` 从受保护配置连接状态权威，为当前安装管理者生成短时单次码；仍复用 browser-bound state、HttpOnly Cookie、CSRF 和当前权限校验。域名/真实 OAuth 白名单仍后置，没有通过放开匿名产品接口来启用新版。

当前运行 release 为 `20261112-company-134b15a6`；实际 PostgreSQL/native 状态、4 位主人与源 ready、工作台实际登录/页面、切换后重启及 Cookie 接续通过。真实新消息任务/交付尚待用户验收；旧文中未切换表述是先前阶段记录，以本节和部署证据为准。
