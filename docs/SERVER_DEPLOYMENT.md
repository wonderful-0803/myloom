# Loom 公司一体机试点部署

## 2026-11-18：飞书工作台入口首版部署

AI 盒子已部署 release `20261118-workbench-6a52bbd5`，`/opt/loom/current` 已切换到该版本，旧 release `20261117-gateway-2a42335a89dc` 保留。多群服务、PostgreSQL、现有 Feishu 消费者、任务和产物状态保持不变；`readyz`、工作台快照、`workbench/status` 和能力清单接口已读回验证。部署证据保存在盒子 `/var/lib/loom/company/backups/workbench-deploy-20261118/verification.json`。

当前工作台已切换为盒子 IP 的 HTTPS 入口 `https://192.168.0.158:3444`，`loom-lan-gateway.service` 使用盒子 IP SAN 证书并代理到 `http://127.0.0.1:3084`。公司配置的 `origin` 为 `https://192.168.0.158:3444`，`loginMode` 为 `feishu-workbench`。Feishu OAuth 回调固定为 `https://192.168.0.158:3444/auth/callback`。证书为局域网自签证书，使用浏览器和飞书工作台前需在体验设备信任该证书；后续有域名时再替换证书、origin 和回调白名单。

## 2026-11-17：TLS Gateway 与远程只读 Runner

公司服务现在支持可选的 `gateway` 配置块：CompanyServer 会在产品 HTTP 服务之外启动独立 TLS Gateway，使用同一 PostgreSQL/StateStore 保存设备登记、配对和撤销记录。管理员配对入口位于现有产品 API `/orchestrator/api/loom/gateway/*`，复用当前身份、同源校验和 CSRF；不会新增匿名管理端口。配置模板和第二台 Linux 的 systemd/验收步骤见 [C3](work-packages/GATEWAY_RUNNER_C3.md) 与 [C4 清单](work-packages/GATEWAY_RUNNER_C4_ACCEPTANCE.md)。

AI 盒子已配置 TLS 证书、固定 Gateway identity key 和 `3443` 私网监听；当前 Linux Runner 已完成配对并保持在线。生产服务不会因为代码默认值自动打开远程执行，必须显式增加 `remoteExecution` profile（environment/workspace/grant/revision）后才会让新公司任务使用远程只读工具。

远程 profile 示例：

```json
"remoteExecution": {
  "environmentId": "linux-local-acceptance-final",
  "workspaceId": "linux-local-workspace",
  "resourceGrantId": "company-remote-read",
  "grantRevision": 1,
  "requestTtlMs": 30000
}
```

该 profile 只允许 `fs.read`、`fs.glob`、`fs.grep`，并要求 Worker 通过 `ExecutionRouter` 取得短期 permit；远程目标不能调用服务端本机回调。真实读取验收脚本见 `scripts/smoke-company-remote-read.mjs`。

## 2026-11-13 局域网免登录入口（当前方案）

用户进一步明确要求其他局域网电脑直接访问 AI 盒子工作台，保留免登录。工作台地址为 `http://192.168.0.158:3084/orchestrator/loom/`，同一局域网直接打开，不需要 SSH 隧道、密码或临时码。此入口仍代表当前安装的管理者，并非每位员工独立身份登录；正式多用户入口另行验收。

实施分为两个独立服务：

- `loom.service` 的产品后端继续只监听 `127.0.0.1:3084`，保留 `local-operator`、当前管理者核验、逐群／任务／产物 ACL 和 CSRF。DSH 管理端口仍为回环。
- `loom-lan-gateway.service` 只监听盒子的 `192.168.0.158:3084`，只允许实际网络 `192.168.0.0/21` 内的来源。仅代理工作台、产品 API、会话信息与健康检查。先核验外部准确 Host、Origin 和写请求同源，再将合法请求转给回环后端；CSRF、幂等键与群选择照常送后端验证。不代理 Harness 管理、任意目标、跨站读写或公网。
- `loom/src/client/live/request-id.ts` 兼容普通 HTTP 局域网浏览器缺少 `crypto.randomUUID` 的情况，用 `crypto.getRandomValues` 生成 v4 UUID，避免群选择器白屏及写操作失败。

仓库入口为 `scripts/company-lan-gateway.mjs`，systemd 模板为 `examples/loom-lan-gateway.service`。服务参数显式指定 `--origin http://192.168.0.158:3084 --upstream http://127.0.0.1:3084 --subnet 192.168.0.0/21`；换网段或盒子 IP 时对应修改，而非监听 `0.0.0.0`。停用局域网入口只需 `sudo systemctl disable --now loom-lan-gateway.service`，不会停止后台飞书任务或删除任何状态。

实际验收：当前 release `20261113-lan-console-cba1fc1d`（包 SHA-256 `cba1fc1d0e86fb916b1540f64fadcfe9ae5a0ba96c40badf62919283bb8d119a`）。独立 Linux 电脑经真实 LAN 访问 HTML、会话、快照和报告下载均为 200，浏览器显示“已连接”，没有登录界面；4 个任务、11 个产物版本及其历史哈希、1 个群、4 位主人和 auto 模式保留。伪造 Host、跨站 Origin、缺失 CSRF 和越权产物均为 403；携合法 CSRF 的空群登记请求进入参数校验后返回 400，未登记新群或产生任务；Harness 路径返回 404。后端与网关均 active，网关 enabled，systemd 配置校验和网关重启后就绪通过。新网关／文档专项 9 项、前端 21 项、类型检查、构建和打包通过。开发机证据位于 `.artifacts/lan-console-20261113/`，包含 `verification.json`、`service-verification.log`、实际浏览器截图与部署前后历史核验。没有用网关放宽应用身份或发送飞书测试消息。

本节地址不表示已经完成企业 OAuth、HTTPS 域名或公网部署。

## 2026-11-13 取消当前试点工作台登录（此前阶段）

按当时用户要求，此前 AI 盒子 release 为 `20261113-local-console-d4fd0487`，公司配置的 `loginMode` 为 `local-operator`。直接打开 `http://127.0.0.1:3084/orchestrator/loom/`，不需要密码、扫码、临时码或登录 Cookie；原 `/auth/login`、`/auth/operator` GET 入口直接跳转工作台，旧登录表单 POST 不再接收。旧的生成登录码命令在这个模式下停用。下面的登录修复与 SSH 临时码步骤保留为历史记录，不是当前使用要求。

当时入口只绑定 `127.0.0.1:3084`，沿用原 SSH 隧道；当前新增局域网入口见上节。这个模式把能够访问该本机端口／隧道的人视为服务器当前配置的管理者，适用于本人试点；不用于共享 LAN／公网反向代理。浏览器不能指定 actor 或跳过已登记群的授权。写请求继续核验同源和自动取得的 CSRF 值；该值为防跨站令牌，无登录界面，且重启后保持有效。当前管理者、安装状态和逐群资源权限每次重新检查；公司源、主人、任务和报告权限不扩大。

实现：`src/state/auth.ts` 的 `localOperator()`、`src/state/http.ts` 的明确本机模式及停用旧登录路由、`src/state/server.ts`／`src/company.ts` 和多群启动器的模式装配。模式仅可使用 HTTP IPv4 回环 origin，仍拒绝伪造 Host、跨站读取／写入、缺少或无效 CSRF、范围外任务及产物。默认企业认证模式继续独立保留，当前个人试点明确切换后不再走认证。

2026-11-13 验收：112 文件／1697 项通过，4 项 Windows 原生进程测试在 Linux 跳过，SQLite 与真实 PostgreSQL 已启用；类型检查、构建、安装包及文档／差异检查通过。`scripts/smoke-company-groups.mjs --local-console` 在实际 DSH rc.3 上无登录／无 Cookie 完成两群任务、文件和重启，保留跨群 403、模型上下文隔离与防重复交付。盒子上无 Cookie 的页面／API／已有报告下载均 200，外部 Origin、伪造 Host、无 CSRF 写入及其他任务仍拒绝。切换前后 1 群／4 主人／auto／4 任务／11 产物版本及记录哈希不变，重启仍直接访问。用户原浏览器标签页访问旧登录入口后直接进入工作台，显示“已连接”。脱敏证据与截图在本机 `.artifacts/local-console-20261113/`。

## 2026-11-13 工作台浏览器登录修复（历史版本）

当前 release：`20261113-login-94b22690`；之前的 `20261112-multigroup-52a12c8e` 与私有 profile 备份保留。公司入口、模型、群目录、主人及业务权限不变。

真实浏览器复现：HTTP 登录表单使用全局 `Referrer-Policy: no-referrer` 时，Chromium 的非 CORS 表单 POST 携带 `Origin: null`，被既有同源校验拒绝；此前直接 HTTP 联调手动填入 Origin，未覆盖此差异。`src/state/http.ts` 仅为受限 SSH 登录表单使用 `same-origin` 策略，浏览器因此保留同源来源信息；其他页面继续使用 no-referrer，外部来源与 null Origin 仍然 403，不放宽 Host、回环、Cookie、一次性码或当前主人校验。

同时修复同一浏览器多个登录标签页覆盖校验 Cookie：`ProductSessions.begin()` 仅复用与当前安装、仍有效且未使用的服务端登录状态匹配的浏览器 nonce；不接受未登记或已过期的 nonce。失败页面现在提供明确原因、诊断编号和“重新打开登录页”入口，不再把页面过期／Cookie／来源失败统称为主人权限不足。

验证：全量 1695 通过、4 项 Windows 原生进程测试在 Linux 跳过，SQLite 与实际 PostgreSQL 已启用；类型检查、构建、打包和差异检查通过。盒子切换及重启后，4 任务／11 产物版本的记录哈希、1 个群／4 位主人／auto 保留。原用户浏览器标签页已用新的一次性码实际进入工作台，显示“已连接”、原群和 4 份已交付报告；截图和脱敏证据在本机 `.artifacts/operator-login-20261113/`。没有向飞书发送消息。

日常重新登录时，先打开 `http://127.0.0.1:3084/auth/login` 获取新表单，再运行已有 SSH 命令生成临时码，只复制 JSON 的 `code` 值。页面与码均限五分钟、码仅用一次；错误后点击重新打开登录页。不要从浏览器历史直接复用 `/auth/operator` 的旧提交页面。终端生成码无需发送到聊天。

## 2026-11-12 多群入口切换（历史版本）

当前 release：`20261112-multigroup-52a12c8e`，保留上一版本 `20261112-company-dd75f89c` 与停机备份。新增 systemd drop-in `/etc/systemd/system/loom.service.d/95-multiple-groups.conf`，启动 `scripts/company-groups-server.mjs`；私有 profile `/var/lib/loom/company/multigroup-config/profile.json`，群运行目录 `/var/lib/loom/company/groups`。数据库、主群 scope、附件、对象、模型／ASR 凭据引用与 SSH 管理员登录不变。

2026-11-12 18:57（上海时间）实际核验：`loom.service` active、`/readyz` 显示 `ready=true, source=ready, botConnected=true`；一个实际 `lark-cli` 事件消费者（其 Node 启动包装进程不另计）；工作台 HTML 已包含多群管理标记，目录目前仅原群。4 位主人、auto、4 个任务、11 个产物版本、5 个 native Session 保留；任务及产物记录哈希与切换前一致，重启保留浏览器登录，匿名 API 401。未自动加入／登记新群，也未发送真实群测试消息。

首次切换因图片实时标记与历史 JSON 的同一资源被误判为内容变化而回退；已补相同图片 Key、其余字段一致时保留原始来源表示的严格兼容和 SQLite／PostgreSQL 回归。部署校验还分别修正了多 Set-Cookie 的首项读取、Node 包装器与 CLI 实体消费者的重复计数，保护性回退记录保留。最终验证来自未注入诊断代码的打包产物。实际第二群、多位用户和多群负载仍待管理员指定群后验收。

使用公司原来的 `3084` 工作台地址，登录后点击页面上方 **管理接入群**，核验目标群和主人并明确保存；仅把机器人拉进群不会开启监听。步骤、隔离和多群备份要求见 [MULTI_GROUP.md](MULTI_GROUP.md)。本机开发者的 `3082` 个人实例不因此变成公司多群入口。


2026-11-06：按用户授权，将同一套 Loom 部署到 Ubuntu 22.04.4 / aarch64 一体机。它运行独立的 Harness profile，不依赖个人电脑保持开机；群成员仍在飞书操作。管理页在一体机本机直接访问，其他电脑通过 SSH 隧道访问。群内共享的产品边界见 [GROUP_MODE.md](GROUP_MODE.md)。

## 2026-11-12：公司新版已切换

此为多群切换前的公司入口记录。用户明确授权后，服务曾切到公司入口；修复子 preset 导入后，程序为 `20261112-company-dd75f89c`（初次切换版 `20261112-company-134b15a6`）。以下初始部署章节保留历史背景；当前以本节为准。

- `loom.service` 使用 `scripts/company-server.mjs`，公司产品、Loom 状态、DSH 原生 Session/workspace 共用外置 PostgreSQL 权威；进程和存储独立。
- PostgreSQL 为独立 `loom-company-postgres` 容器，仅回环 `15435`，数据位于 `/var/lib/loom/company-postgres`，由 `loom-company-postgres.service` 管理启动依赖。
- 公司配置与环境契约在 `/var/lib/loom/company/config`；独立持久对象/native 附件和可重建 compute 在 `/var/lib/loom/company/` 的分离子目录。模型凭据仍是盒子上的私有引用，不进入源码或归档。
- 保留原群、4 位主人、模型、auto 模式与未暂停状态。当前已导入 3 个任务、10 个产物版本、3 个 Worker/361 条原生事件。排除两条群模式前消息的显式分区计划保留；旧 Router 和普通 Session 未混入群空间。
- 新版产品仍仅监听 `127.0.0.1:3084`，真实 Feishu consumer 已 ready，只有新版监听。既有服务的 ASR drop-in 保留。Harness 管理 Web 为另外的随机回环端口，不对外代理。
- 切换后实际重启，当前任务与工作台 Cookie 登录仍可读；匿名产品 API 返回 401。用户无 @ 发送 R1/R2 总结验收后，新任务 `5c3c9bd8e73ca017a1f06194fa5c01e0` 完成真实模型执行并在原线程交付 Word v1；已从飞书实际下载，文件与存储哈希一致，OOXML 正文含两组和 R1/R2。不是用 consumer ready 代替任务验收。
- C1 协议和路由为可选开发模块，真实 Runner 尚未启用。

### 暂无域名的工作台访问

采用明确配置的 `loginMode: ssh-operator`，只接受 HTTP IPv4 回环 origin、匹配的 Host/连接。使用原 SSH 隧道及 3084 地址；不能通过裸 IP 的 80 端口进入 Loom（该端口属于主机其他业务）。

```sh
ssh -N -L 127.0.0.1:3084:127.0.0.1:3084 skysi@192.168.0.158
```

另开自己的终端生成一次性登录码：

```sh
ssh -t skysi@192.168.0.158 'sudo /opt/loom/bin/loom-workbench-login'
```

打开 `http://127.0.0.1:3084/orchestrator/loom/`，填入终端中的 `code`。码五分钟内有效、单次使用，不能发送到群或聊天；浏览器登录一小时，仍需当前主人/安装授权，每次写操作继续检查同源/CSRF。登录码只由本机 OS 管理员 CLI 签发，HTTP 无签发接口，不允许浏览器选择 actor。私有网页鉴权不是生产 Feishu OAuth 验收；上线域名后切回默认 `feishu` 并完成白名单/身份联调。

### 切换证据与回滚

最新一致快照、旧服务文件与分区/导入记录在 `/var/lib/loom/company/backups/cutover`，完整旧 SQLite/原生日志保留。`/var/lib/loom/company/cutover-verification.json` 与开发机 `.artifacts/loom-cutover-c1-20261112/box-cutover-verification.json` 保存脱敏证据。当前发行包摘要 `dd75f89c31a5a81ebd8153159b2bfb8b907c79772e687cc7d140d7112a7b8a42`；后续程序修复与重启证据在 `/var/lib/loom/company/preset-fix-verification.json`，开发机同目录的 `box-preset-fix-verification.json` 保存脱敏副本。

激活后外置库是唯一最新权威，不能直接恢复旧 SQLite 丢弃切换后的消息/任务。回滚先暂停来源/消费者，导出当前 SQL/对象/native 附件，再让兼容程序连接同一状态或恢复到空库；操作步骤见 [公司状态维护](work-packages/COMPANY_PRODUCT.md)。旧 release 只是程序回滚点，不是激活后的最新数据。

### 真实任务暴露的问题与修复

首条验收消息在 Router 初始化阶段失败：rc.3 的根配置 import 覆盖没有传递到子 preset；独立私有配置目录旁缺少 `node_modules`，因此子插件停在 `never started`，评估最终超时。之前仅做 HTTP 启动的探针没有创建 Agent，完整角色探针又恰好把配置和依赖放在一起，均未覆盖这个部署布局。

现已在私有配置旁显式关联所审核 release 的依赖图；`company-profile-modules.mjs` 由配置生成器创建该链接，由 launcher 在监听前校验，并递归核对启用 preset 的 Harness 模块是否与锁定 rc.3 一致。已有其他链接/目录不会被覆盖。ARM 上实际执行新生成器成功，生成的角色/模型/环境契约与当前契约完全一致。没有改写 preset 内容或绕过 SQL 的角色摘要校验。修复后通过授权命令重新评估原 trigger，保留超时 Decision，原消息只生成一个任务与一个附件。

本次 Word 为 `report.docx`，9526 字节，SHA-256 `fb0362bb5e9b8457fd8cf68d9c397de08a356cea7937d3aa98c1b8d3e4e0000d`；飞书消息 `om_x100b606381e6e8acb4a67b6dd5b605d`。脱敏证据在盒子 `/var/lib/loom/company/live-task-acceptance/verification.json`，开发机 `.artifacts/loom-cutover-c1-20261112/box-live-task-verification.json` 留存副本。回执和字节核对已通过；本次新任务的首次成功发生在修复后，不宣称首轮无故障或已经完成录音连接器、执行中接管和 OAuth 的新版复验。

## 实际部署结构

| 项目 | 配置 |
| --- | --- |
| 系统账号 | `loom`，专用系统账号，无交互登录 |
| 程序 | `/opt/loom/releases/<release>/app`，`/opt/loom/current` 指向当前版本 |
| 运行时 | `/opt/loom/runtime`；Node 24.21.0 / ARM64 |
| 独立工具链 | `/opt/loom/current/toolchain`；DSH 0.2.1-rc.3、lark-cli 1.0.95 |
| Harness | `DSH_HOME=/var/lib/loom/dsh`，profile `loom-company` |
| Agent 数据 | `DSH_AGENTS_HOME=/var/lib/loom/agents` |
| Loom 数据 | `/var/lib/loom/state/orchestrator.sqlite`；新建数据库 |
| 机器人 | `/opt/loom/bin/lark-bot`，只使用 `/var/lib/loom/lark` 的 bot 身份 |
| 服务 | `loom.service`，配置见 [示例单元](../examples/loom-server.service) |
| 管理监听 | `127.0.0.1:3084`，未开放 LAN / 公网管理端口 |

程序和工具链归 root 所有。服务使用 `ProtectHome=yes`、`ProtectSystem=strict`、`NoNewPrivileges=yes`、私有临时目录和 `UMask=0077`，持久写入范围为 `/var/lib/loom`。这些限制保护现有主机目录，不构成网络出口隔离或完整企业安全验收。群模式还要通过应用工具守卫禁止 Shell、任意文件和个人资料。

本次只配置用户指定的新机器人和既有模型服务；没有复制个人数据库、会话历史、用户登录或邮箱凭据。密钥经 SSH 单独传输，凭据文件为 `0600`，不包含在安装包或仓库中。原机器的个人 Loom、旧机器人及一体机已有业务服务保持独立。

## 管理与维护

在一体机桌面双击 `Loom-公司试点.desktop`（显示名「Loom · 公司试点」），或在一体机浏览器打开 `http://127.0.0.1:3084/orchestrator/loom/`。入口同时安装在 `skysi` 的应用菜单：`/home/skysi/.local/share/applications/luxi-loom-server.desktop`。这是现有浏览器打开同一套 Loom 工作空间的快捷方式；本机尚未安装 ARM64 原生桌面客户端。

后台由 `loom.service` 管理，不依赖桌面登录或窗口是否打开。关闭管理页面不会停止服务。2026-11-06 已复核服务为 active、管理 API 返回 200，工作空间显示 2 个已完成任务和 2 份报告；尚未直接观察一体机远程桌面的窗口呈现。`3082` 是开发机原有个人实例，不能与公司试点的 `3084` 混用。

2026-11-06 设置页补充主人权限说明：所有已保存的主人均可发起、补充和控制任务，管理者保留为其中一员；另行标出当前已生效的名单。此次仅更新静态界面，未保存策略、增添主人或重启服务，前后名单仍仅登登、auto、未暂停、2 项任务与 2 份报告。前端类型检查、成员选择的 2 项现有测试、双主人／第二主人无 @ 接单的 2 项后端回归通过（外部接口仍为替身）；浏览器已从实际服务器读回新说明。UI 增量包 SHA-256：`3240501160ce6c12f0fa9058e36d49327821101655785d43cf5611c6aff873d4`；原界面备份在 `/var/lib/loom/backups/20261106-before-master-copy-ui/client`，保留旧哈希资源以支持已打开的页面。

管理员从自己的电脑建立隧道，两端使用相同端口以保留 Host / Origin 校验：

```sh
ssh -N -L 127.0.0.1:3084:127.0.0.1:3084 user@company-host
```

浏览器打开 `http://127.0.0.1:3084/orchestrator/loom/`。隧道断开只影响管理访问，飞书后台服务继续运行。不要把整个 Harness 直接反代为免登录企业网页。

```sh
sudo systemctl status loom.service
sudo systemctl restart loom.service
sudo systemctl stop loom.service
sudo systemctl start loom.service
```

服务已 enable；异常退出后 10 秒重启，5 分钟内最多连续尝试 5 次。主动 `stop` 保持停止。主机本身未重启，本轮验证的是服务启用状态和进程恢复，不冒充已经完成断电重启测试。查看日志时不要转发未经脱敏的原文，Harness 启动日志可能包含本机访问令牌。

升级前暂停接单，确认在途工作状态，停止服务并使用 SQLite 备份接口备份数据库及对应 Harness / Agent 数据。新版本使用新的 release 目录，保留旧目录；切换程序后再启动。回退代码前核对数据库 schema 兼容性，不用旧数据库覆盖新产生的任务。凭据另行保护，不进入普通诊断包。

## 本轮真实验收

- ARM 上安装并运行实际 DSH 与 CLI，管理 HTML、接口和飞书 bot 身份检查成功。
- 独立 `loom-acceptance` Harness 会话通过现有 `dashscope/deepseek-v4.1-flash-1017` 调用了两次真实 Bash：`uname -m` 返回 `aarch64`，打印验收标记成功，模型最终返回 `LOOM_ARM_ACCEPTANCE_OK`。这证明模型、Harness 和本机工具可用，不代替群任务验收。
- 正常服务重启成功；对主进程发送 SIGUSR2 模拟异常退出后，systemd 自动拉起，记录一次自动重启。
- 重启前后管理者、模型、规则、处理模式、暂停状态、任务和产物记录一致；新实例没有迁入个人任务。
- 管理接口缺少校验头、携带外部 Origin 或非本机 Host 均返回 403，合法回环请求返回 200。
- 脱敏证据保存在开发机 `.artifacts/aibox-deploy/`，服务器保存在 `/var/lib/loom/acceptance/`。初始部署包 SHA-256：`c7cb8b3af98885b48e60bb5c7912b2857776f809444a6ffda4cabd55fa50595b`；共享报告修正后当前版本为 `/opt/loom/releases/20261106-arm64-7d31cfa7`，包 SHA-256：`7d31cfa78dd586f8adbb679ead8673a9a5e59d3f31df4970937652388f62b54e`。

## 飞书接入进展与下一步

用户指定 `cli_aa63c5ce3cbbdcb0`（登登的 Superagent 助手），仅监听 Harness研究小小组，首位主人为本人。已验证机器人凭据、入群及真实长连接；管理者使用新应用返回的 Open ID，通过同一群的群主身份与原应用核对，没有沿用旧应用的 Open ID。

最初成员 API 返回 99991672，后台只开通了用户身份权限。用户补齐应用身份 `im:chat.members:read` 后，服务器实际读取 4 位成员，重新核验并保存本人为唯一主人。2026-11-06 15:14（北京时间）共享空间启用，Router 切换为独立持久会话，自主处理 auto、全局暂停解除。旧机器人在同一测试群改为仅 @ 接收，私聊与历史保留；A1 在旧实例被忽略，没有重复任务。

### 群内真实任务与交付

- A1 为本人实际发送的无 @ 新消息，系统按 `inferred`、`office-summary` 自动接单。15:15:54 消息发出，15:16:08 建立任务，15:16:15 定稿，15:16:19 附件发送成功。从消息到附件约 25 秒，Worker 定稿约 7 秒；这是单条虚构总结的观测值，不是通用性能保证。
- 通过飞书 API 读回原线程，只有结果正文和 `result.txt`，没有开工确认。下载文件与服务器正文完全一致，SHA-256 相同，来源登记 R1–R3 所在实际消息。
- 本人原线程追加三行改稿要求，沿用任务 `22383ff8aeef66dc52e395da7721c17b`，未创建第二个任务。v2 已发附件，但正文误称无法生成附件且多出说明，严格格式验收不通过。
- 修正 `src/executor/dsh.ts`、`src/app/sessions.ts` 和 `src/app/tools/executor.ts`：明确完整正文交给宿主生成附件，隐藏共享模式不可用的继承工具；拒绝 `artifact_file` 在共享任务中读取工作区文件，提交回执分别返回版本与排队状态。新增实际 Runtime 回归验证拒绝文件发布不产生版本或投递副作用。相关 5 个测试文件 70 项通过，类型检查和构建通过。
- 修正后本人再次在原线程发出要求，v3 严格三行，无多余声明；实际下载附件与 v3 哈希一致，v1/v2/v3 全部保留。旧版本没有被覆盖或删除。修正后这轮原生进展只有受控读取与报告成功，未再尝试不可用文件或 Shell 工具。
- 在实际服务器通过管理 API 接管已完成的 A1，等到 `human / drained / 无在途操作`；旧 revision 的交还返回 409。服务重启后仍保持接管状态，使用新 revision 交还，不重跑已完成任务、不重复发送已有附件。此项不代替执行中强中断、实际外部写入不明或多人争用的验收。
- 群模式的邮箱、Codex、同步、个人草稿和个人交付设置 API 实测返回 409。界面隐藏私人历史与跨设备入口，交付固定为原群线程。
- 服务重启后，本人在独立新线程发送 A3，仅引用 A1 讨论，没有重贴 R1–R3。新任务 `c1759d247f88f1d6644e497d9d3fd68b` 取回原始三条记录与两次改稿要求，交接说明引用三个已存在的消息 ID；来源清单登记这些消息及哈希。原线程正文与附件已从飞书读回，下载文件与服务器报告一致。
- A3 从 15:25:01 消息到 15:27:32 附件约 151 秒。原生会话累计模型约 136 秒、工具约 205 毫秒，约 2.08 万输出 token（宿主累计值）；包含报告后的收尾步骤，不能当作纯正文 token。瓶颈主要为模型生成与多步上下文处理，不是网络文件读取。本轮不擅自更换模型或推理参数。
- 召回当前按共享群分页，A3 的来源清单包含 7 条已读取记录，报告只引用了 3 条相关历史消息；尚未实现按所指线程预先裁剪检索。因此证明的是重启后的持久群上下文可用，不能宣称已经具备精确的任务级检索或最少上下文输入。

实际证据包括 `shared-workspace-activation.json`、`live-a1.json`、`a1-delivery-verification.json`、`a1-v3-verification.json`、`a1-progress-v3.json`、`report-fix-restart.json`、`group-control-restart-verification.json`、`a3-verification.json` 与 `a3-progress.json`。数据库备份位于服务器 `/var/lib/loom/backups/20261106-before-shared-report-fix/`，仅允许服务器管理员读取。

### 后续真实验收

- 收窄上下文召回到所指线程与关联记录，减少无关材料和重复读取；增加推理／token 与墙钟预算的实测和可见退出条件。
- 测试群中另外一条纯图片与一条非工作短句分别留下“图片未授权”和“评估超时”的 unavailable 记录，未创建 Worker。当前未删除或静默清除这些诊断；普通闲聊与未接入媒介的轻量分流、超时恢复及健康提示仍需优化。这不影响已完成的 A1/A3，但不算全部输入类型已验收。
- 有第二位真实用户参加后，验证非主人仅贡献上下文、增加主人后的接单与协作、移除后的撤权。尚未实际参加的用户不能用模拟事件充当多人验收。

飞书云文档 / Base ACL 连接器和内网资源连接器仍待实现。本次上线不扩大这些资源权限，也不涉及跨设备私人历史同步服务的部署。

## 2026-11-06：录音纪要与百炼 ASR 增量

16:50（北京时间）已升级到 `/opt/loom/releases/20261106-arm64-recordings-70acad09`，包 SHA-256 为 `70acad0965746541be165143e427e3b059cd99a2c6abc9f8d2bd6b7e39a8c281`。停止服务前核对两项任务均已结束；SQLite、Harness 与 Agent 数据备份到 `/var/lib/loom/backups/20261106-before-recordings/`，旧 release 保留。升级后服务 active、管理 API 200，两项历史任务保留，仍为 auto、未全局暂停。

用户此前已将四位成员选为主人，升级保留 Yoyo、登登、Hugo、砚川，不自行改动名单。通过现有版本化 API 创建委托 `loom-delegate-097981aa52d176a2cb73`「群录音会议纪要」，仅当前共享群、先询问后确认、百炼转写、原线程交付；policy revision 为 4。没有重放旧文件或生成测试群消息。

服务使用独立 systemd drop-in `/etc/systemd/system/loom.service.d/asr.conf` 配置 `bailian`、`qwen-audio-3.1-asr-flash-filetrans` 与凭据文件引用。复用既有百炼账号，`/var/lib/loom/asr.key` 归 loom 所有、0600，安装包不含 Key。真实私有上传、异步任务及结果查询成功：5.592 秒官方示例识别出“开放时间早上9点至下午5点。”，带时间戳与匿名说话人；该探针不是用户会议文件，不能代替真实飞书纪要验收。

浏览器已读回新委托和“百炼转写已配置”。后端完整回归 87 文件、1402 项通过、4 项跳过；Loom 前端 14 项通过，类型检查和构建通过；最后的录音、云 ASR、文档约束专项 24 项通过。外部操作的自动化测试使用替身，真实云服务探针另记 `/var/lib/loom/acceptance/asr-upload-transcript.json`。部署与委托证据见 `.artifacts/aibox-deploy/recordings-release.json`、`recording-delegation-live.json` 和 `recording-delegation-live.png`。

16:54 Yoyo 实际无 @ 上传 40 分 41 秒 m4a，登登原线程确认，真实百炼转写和 v1 附件于 16:56 交付，约 141 秒。随后登登请求详版，16:59 同一任务交付 v2；两版均从飞书实际下载、与保存报告哈希一致，询问／确认／附件均属原线程，全文转写已分页读完。双主人链路证据为 `recording-live-verification.json`、`recording-live-v2-verification.json` 和 `recording-delegation-live-done.png`。识别准确度及纪要语义仍需参会人审阅。具体权限、格式、80 MB / 2 小时限制、48 小时供应商临时空间边界见 [MEETING_RECORDINGS.md](MEETING_RECORDINGS.md)。公司受管 OSS、供应商留存治理、执行中实际撤权和长会议质量仍需后续验证。

## 2026-11-06：Word 生成与真实附件交付修复

已升级至 `/opt/loom/releases/20261106-arm64-word-3167da08`，包 SHA-256 为 `3167da08bd23306bf48f839312692ee959a42b79d0574416d89a39f25e45d716`。新增固定的 Word renderer，由 DSH Worker 经 `orchestrator_report.document` 调用；保留共享模式对任意文件、Shell 和个人资料的限制。无需新增飞书权限，未改变模型、四位主人、录音委托、ASR 凭据或管理端口。

升级前备份到 `/var/lib/loom/backups/20261106-before-word/`，恢复排查时另存 `/var/lib/loom/backups/20261106-word-startup-preserve/`。首轮启动暴露既有录音任务的初始化问题：控制校验早于 Setup 的机器人身份解析，导致管理路由尚未挂载。旧版回退也复现，未恢复旧数据库覆盖新记录。最终版本将控制校验移至身份与来源同步之后，并通过 `tests/meetings.spec.ts` 的持久录音任务重启用例验证。

恢复期间未完成的录音任务曾被保守暂停；确认身份、群和来源后，经原有带 revision 的控制 API 交还助手，实际 DSH Worker 随后完成既有 Word 要求。此处不宣称所有恢复场景都能无条件自动继续：来源暂不可用时应保守暂停，重新核验后才能恢复。最终服务 active，管理 API 200、auto、未全局暂停；三项原任务均已完成，无额外重复任务。服务没有开放公网，也未重启整机。

18:34:21（北京时间）录音任务 `4e157ffba56ffff6014905e87753fcf8` 登记真实 Word v6，18:34:26.889 发回原录音线程。文件「会议纪要-新录音50副本.docx」25,200 字节，SHA-256 `482b8dc4256776826a429ab3746e731ee146ba14c82b4a2eb62272398a95b4c4`。从飞书原生接口实际下载并核对群、线程、文件名；保存文件、下载文件与 Loom API 导出字节一致，3 张 OOXML 表格、16 页实际渲染均检查。v1–v5 保留，未重新上传音频或发起转写。

本次交还到附件约 55 秒，Word 工具生成及登记约 1.1 秒；任务累计耗时包含此前失败、用户讨论和修复等待，不能当作单次转换时间。后端 1408 项通过、4 项跳过，前端 14 项通过，类型检查和构建通过。证据为 `.artifacts/aibox-deploy/word-release.json`、`word-live-verification.json`、`word-api-proof.json`、`word-download-live.png`；服务器保留 `/var/lib/loom/acceptance/word-live-verification.json`。完整能力边界见 [DOCUMENT_ARTIFACTS.md](DOCUMENT_ARTIFACTS.md)，其他文件格式及邮件 Word 附件仍未接入。
