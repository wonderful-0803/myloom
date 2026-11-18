# 一个机器人，多个独立群工作空间

2026-11-12 用户授权扩展。同一公司服务可登记多个群，每个群独立设置主人、规则、持续委托和自主处理方式，独立保存任务、DSH 会话、来源和交付记录。机器人仍只把结果交回各自原消息线程。现有个人桌面实例与单群启动方式保留。

这是明确授权群的并行处理，不是把机器人加入的所有群自动公开为团队空间，也不提供跨群检索、跨群分享或独立 Agent A2A。

## 如何使用

以下入口仅在以 `company-groups-server.mjs` 启动的公司服务中出现。旧单群入口没有多群管理按钮。

1. 把当前公司的同一个机器人加入目标群；管理者也必须是该群的实际成员。先确认应用已具有群消息、群信息和成员读取权限；代码不申请或扩大平台权限。
2. 打开公司 Loom，点击页面上方 **管理接入群**。点击 **读取机器人已加入的群**，选择目标群；也可手动输入其 `oc_…` 群 ID。
3. 点击 **核验群并选择主人**。服务端通过应用身份核验群信息和完整成员列表，再逐个勾选允许发起和控制本群任务的主人。管理者必须保留，最多二十人；普通群成员不会自动成为主人。
4. 选择 **仅观察**（默认）或 **自动执行**，点击 **确认接入这个群**。只有保存成功并显示监听就绪后才完成接入。创建失败显示错误，可在登记列表 **重试接入**，不会另建一个同名工作空间。
5. 页面上方 **当前工作群** 切换当前空间；概览、任务、来源、交付物、持续委托和设置只展示该群。进入该群的规则页可再独立调整模式和基础规则。旧群的自定义规则和业务历史不复制给新群。
6. 新消息可在各群分别测试。已授权主人在 auto 模式下不必 @ 机器人；observe 只观察。普通成员发言可成为本群资料，不能凭其发言发起、接续或控制任务。所有任务仍受规则、来源与工具边界约束，不保证每句讨论都接单。

**停用本群监听** 同时阻止该群后续资料读取并持久暂停任务，不改变其他群。恢复监听会将新消息起点推进至恢复时刻，停用期间的消息不补跑；不会自动解除人工暂停，需在该群明确恢复。历史任务和产物不删除，但来源停用时读取会被权限校验阻止。移除主人后的权限也按原有规则立即重新检查。

2026-11-13 按用户要求，当前本人试点工作台已取消登录，通过本机／SSH 回环端口直接进入，以服务器配置的管理者身份操作；其他主人继续在飞书原线程操作。企业共享浏览器入口仍需独立认证，不把个人免登录模式公开到网络。代码支持同一飞书身份登录后只列出其当前获授权的群，但真实企业 OAuth／域名白名单和不同实际成员登录仍需独立验收。

## 实现与隔离

| 层 | 实施位置 | 行为 |
| --- | --- | --- |
| 显式目录 | `src/state/company-groups.ts` | 主空间 `installation/group-directory` 保存登记意图与稳定 UUID；先落库再初始化，失败可重试；拒绝重复或损坏映射 |
| 消息分流 | `src/state/group-broker.ts` | 一个真实 CLI 长连接，通过可信 `chat_id` 只投递到已登记群；忽略未登记群和私聊；不按消息正文选择空间 |
| 群内处理 | `src/state/server.ts`、`feishu.ts`、`company.ts` | 每群复用既有 CompanyServer／AsyncTaskRuntime／来源水位线；嵌入模式不重复启动产品 HTTP 或飞书 CLI |
| DSH 计算与状态 | `scripts/company-groups-server.mjs` | 每群独立真实 Harness root、SQL SessionPersistence、工作空间元数据、附件 home 和临时计算目录；不共享 Router 或 Worker 的上下文 |
| 计算容量 | `src/state/company-capacity.ts` | 整个宿主最多两个 Worker、一条接单模型评估；容量满时任务留在持久队列重试，暂停／停止不等待 Worker 名额 |
| 产品入口 | `src/state/http.ts`、`auth.ts` | 一套登录与 HTTP，浏览器传 workspace 只表示选择，服务端每次验证目录映射、当前主人与该群资源授权 |
| 界面 | `loom/src/client/live/GroupSpaces.tsx`、`api.ts` | 群切换整页加载；每次请求绑定自己的空间，异步登录期间也不更换已发起操作的目的空间 |
| 停用与备份 | `src/state/product.ts`、`backup.ts` | 单群停用、恢复起点；在线 source 或 subscription 租约均阻止不一致快照 |

主群继续使用既有 tenantId、spaceId、任务、会话 ID 和附件位置。新群建立新的 SQL scope；原生会话 provider 固定绑定其 scope，不在模型调用时动态切换。共享对象目录的读取仍须包含完整 scope 和授权，知道其他群任务 ID 或对象哈希不能取得内容。

主群的原 `source/<installation>` 租约由全局 broker 持有，兼容旧单群消费者的互斥；各群使用本群 `subscription/<installation>` 租约。升级必须停掉旧服务，不能并行启动两个消费者。内存订阅队列每群上限 128 条；溢出只中断该群流，恢复后从该群持久历史水位线校对，不把内存排队当作可靠保存。断线恢复依赖飞书历史读取权限及可用性，失败显示非就绪且保留旧水位线，不伪造已同步。

当前最多二十个登记群，计算容量属于整个公司宿主，不是每群两名 Worker。此上限不代表已经测得 AI 盒子可以承载二十个活跃群；目前实际 Harness 隔离验收为两个群。未实现动态扩缩容、跨进程公平调度或多租户 SaaS。DSH `modules`／`client-hmr` 在私有执行 profile 副本禁用，产品前端只由 Loom HTTP 提供一次；原 profile 与 Agent preset、模型契约不改写。

## 网关与远程执行

多群宿主只保留一个 TLS Gateway 监听和一份已配对设备登记，由宿主按主群配置持有。`CompanyGatewayHost`（`src/state/server.ts`）在启动时创建一次 `TlsGatewayServer`、`DeviceGateway`、多作用域设备目录和请求账本；每个 `CompanyServer` 只把自己的 `StateScope` 注册进去，不再创建端口监听。`groupCompanyConfig`（`src/state/company-groups.ts`）在生成群配置时显式去掉 `gateway` 与 `remoteExecution`：

- 同一主机重复监听 `3443` 会让第二个群的 `CompanyServer.start()` 因端口占用失败，整群运行时不会启动；
- 把主群 Runner 的授权复制给其他群，会绕过「每群独立主人、上下文和权限」的范围，形成跨群资料读取路径。

因此群任务目前只使用该群的沙箱内工具，不会使用主群配对的 Runner。若要让某群使用远程只读执行，需要在该群作用域内补逐群显式授权和验收；共享 Gateway 已具备多作用域路由，但配置入口仍保持关闭，不能靠复制 `remoteExecution` 隐式开启。

2026-11-17 故障记录：第二个实际群 `AI-Native:AutoDebug` 登记成功，但运行时未启动，工作台显示「连接中断／正在连接本机助手…」。`GET /orchestrator/api/loom/workspaces` 对该群返回 `state: "error"`；选择该群的快照接口返回 409，后台原先把启动异常兜成通用 503。根因是每群启动器复制主群 `company.json` 后，各自尝试创建 `TlsGatewayServer` 并绑定 `192.168.0.158:3443`，第二个监听必然 `EADDRINUSE`，同时还会隐式继承主群 `remoteExecution`。现在由 `company-groups-server.mjs` 创建一个 `CompanyGatewayHost`，所有群只注册独立 StateStore scope；`groupCompanyConfig` 删除次群 `gateway`／`remoteExecution`；共享设备目录和请求账本按 `tenant/space` 路由。另修复共享事件流在历史恢复期间的实时／历史表示冲突，保留首个已提交来源而不让群进入错误状态。2026-11-17 部署最终版本 `2a42335a89dc` 在 AI 盒子上通过 `/readyz`，两个群均为 `state: "ready"`，`ss -ltnp` 只看到一个 `192.168.0.158:3443` 监听。

升级时生成配置采用精确比对，不会隐式覆盖：先停服务，保留 `groups/<UUID>/native`（原生会话与附件）和 `compute`，删除该群目录下由启动器生成的 `config.json`、`environment.json`、`profile.json` 三个文件，再启动服务并点击 **重试接入**。不要删除 `native` 目录来「解决」配置不一致。

## 升级现有公司服务

现行盒子版本与是否已切换，以 [部署记录](SERVER_DEPLOYMENT.md) 为准。代码构建或本机测试通过不代表盒子已经启用多群。2026-11-12 已在 AI 盒子切换为多群宿主，当前只登记原群；本轮不自动登记任何新的真实群。

1. 按公司入口升级流程准备新 release，安装已审核的 rc.3 依赖并构建根项目与 Loom 前端。确认新 release 的 profile 引用本 release 的 `lib/company.js`、`lib/dsh-state.js`、`lib/dsh-metadata.js`，不是旧 release 文件。私有 profile 同目录 `node_modules` 链接必须指向同一新应用依赖图。
2. 保留主群 SQL scope、数据库环境变量、对象目录、附件 home、模型/ASR 凭据引用及源配置。需要重新生成 profile 时使用 `company:prepare` 与已审核 effective 配置；不得重新初始化主群或把个人数据库导入公司服务。原生环境契约若变化，先按 B 包核验，不能绕过布局或模型检查。
3. 停止旧 `loom.service`，确认应用／原生 writer 已退出再做完整备份。为服务账号准备属于其自身的 0700 规范绝对目录，例如 `/var/lib/loom/company/groups`。
4. 将同一个服务的 ExecStart 改为以下形式，保留原有 EnvironmentFile、服务账号、DSH_HOME、ASR drop-in、回环端口和安全限制。此命令是部署模板，不会自动修改系统服务：

   ```sh
   /reviewed/node /reviewed/app/scripts/company-groups-server.mjs \
     --profile /private/config/profile.json \
     --harness-root /reviewed/rc3/dsh \
     --groups-home /var/lib/loom/company/groups
   ```

5. 启动后检查 `/readyz`（只返回连接状态，不返回业务内容）、管理员登录、原群任务和产物是否保留；确认只存在一个实际 CLI 事件消费者。原群模式与主人保持不变。新目录首次只收录原群，不遍历并监听其他已加入群。
6. 通过上述管理页面明确新增第二个测试群；分别发送不同虚构编号，确认任务／来源／交付只在对应群出现，再测停用和名单撤销。真实群验收由管理员指定目标群后进行。

所有输入 profile/config 必须为 0600 私有规范文件；groups-home 为当前服务账号拥有的 0700 目录。启动器对已有生成配置采用精确比对，发现变化拒绝隐式覆盖；后续升级变更 profile 或模型时，需要管理员停机检查并明确迁移这些生成配置，不删除 native 附件目录来“解决”配置不一致。

### 备份与回滚

停止整个多群宿主并确认所有 writer／job claim／source 和 subscription 租约均已释放。备份整个 PostgreSQL 数据库、对象目录、主群附件 home、每个群 `groups/<UUID>/native`、私有配置及审核的环境契约；凭据独立保管。使用现有 scoped 导出工具时必须逐群导出全部 scope，主群导出的目录清单不包含子群的业务数据，不能代替整机备份。

回滚旧单群启动器只恢复主群处理，其他群保持不被消费；数据库和各群持久目录不能删除。重新启用多群启动器后按保存的映射恢复。不得把不完整子群恢复解释为已完整同步，或重新登记生成另一个 UUID 来绕过丢失数据。

## 验收与证据

- `tests/state-contract/groups.spec.ts`：SQLite／真实 PostgreSQL，单事件连接、多群执行／原线程文件、不同主人、跨群任务和产物拒绝、仅属于第二群的登录、撤权、停用及恢复起点、失败登记重试、损坏映射拒绝、订阅溢出与旧消费者互斥、宿主容量。
- `tests/state-contract/backup.spec.ts`：在线 subscription 租约也阻止备份。
- `loom/src/client/live/GroupSpaces.test.tsx`、`api.test.ts`：显式核验和成员选择、保留管理者、非管理者限制、失败可见、异步请求空间固定；个人／单群页面不新增多群调用。
- `scripts/smoke-company-groups.mjs`：真实安装的 DSH 0.2.1-rc.3、编译产物、真实 PostgreSQL、两个独立 Loader/AgentLoop/preset/权限/原生 SQL provider；回环模型 SSE 和虚构 Feishu CLI 检查完整链路及正常重启。需要显式 `_test` 数据库与 profile-file；脚本只提取 profile 模块结构并替换模型配置，不复制真实凭据，不访问飞书网络。

2026-11-12 首轮实际 Harness 结果：2 个群，每群 2 个原生 Session，8 次回环模型调用，2 份原线程文件；跨群模型上下文隔离、跨群产物 403；重启保留登录且不重复交付。测试证据位于本机 `.artifacts/multi-group-20261112/`，不打入安装包。真实群平台权限、实际多成员和 AI 盒子多群负载验收单独记录，不能由这些虚构任务替代。

盒子首次切换发现既有图片历史回补问题：CLI 实时消息使用 `[Image: key]`，OpenAPI 历史使用 `{"image_key":"key"}`，同一图片被误判为内容变更。`src/state/feishu.ts` 仅在严格的一字段图片 JSON／完整图片标记指向同一 Key、其余 Trigger 字段完全相同时保留首个已存表示；不改原来源和报告哈希。`service.spec.ts` 在 SQLite／PostgreSQL 覆盖双向回补、不同 Key、附加正文和不同发送人仍拒绝；不忽略实际正文变更。

最终验收：根项目 112 个测试文件、1693 通过／4 跳过（实际 PostgreSQL 已启用；4 项 Windows 原生进程测试在 Linux 跳过）；前端 6 文件／19 通过；两端类型检查、构建、安装包检查和 `git diff --check` 通过。最终实际 rc.3 smoke 仍为 8 次虚构模型调用、两群各两个 native Session、两份文件和重启不重发。AI 盒子已完成原群不变的正式切换、工作台登录／目录／资源标记、历史哈希保留、单消费者和重启检查，详见 [部署记录](SERVER_DEPLOYMENT.md)。第二个真实群及多人／负载验收仍未完成。

2026-11-13 个人免登录模式：公司 `loginMode: local-operator`，`/auth/session` 自动返回当前配置管理者和防 CSRF 值，不创建浏览器登录会话。旧登录 GET 地址跳转工作台；页面、查询、下载和写入分别保持回环 Host、当前范围及同源防护。实际 Harness smoke 增加 `--local-console` 验证无 Cookie 双群与重启，当前盒子版本及验收见部署记录。
