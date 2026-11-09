# 工作包 C：工具网关与 Linux Runner

状态：待实现。基于 [已实现的执行端口](README.md)，依赖 [A 的控制／账本／租约](LOOM_STATE.md) 和 [B 的 Session 恢复与代次](DSH_STATE.md)。首轮交付一个实际可验收的 Linux 只读设备环境，不默认开放任意远程 Shell。

## 部署位置与责任

| 组件 | 部署位置 | 保存／执行内容 |
| --- | --- | --- |
| ExecutionRouter／ToolGateway | 公司服务器 | 能力分类、选环境、授权和 lease 校验、持久建单、分发、取消、回执与等待条件 |
| DeviceGateway | 公司服务器 | 设备认证、心跳、能力快照、连接重建；不读取个人电脑目录来“代跑” |
| Runner／环境适配器 | 目标个人电脑或受管执行节点 | 本机目录授权、工具运行、进程／job 管理、结果限额及轻量回执账本 |
| Desktop | 可选用户界面 | 登录企业服务、配对设备、选目录、查看进展／撤销；关闭窗口不等于停止 Runner |
| DSH Worker | 公司计算节点 | Agent Loop、能力装配与受控工具代理；不持有端侧凭据或假定项目位于本机 |

服务器可部署自己的受管 Runner，但它仍是一个显式环境，不能作为个人设备离线时的自动回退。飞书文字同步服务 `src/sync/` 不承担远程命令；同步空间身份、项目采集权限和执行权限互不替代。

## 与本轮代码的衔接

`src/execution/port.ts` 定义了 `ExecutionPort`、`ExecutionRequest`、`ExecutionBinding` 和本机端口。Runtime 共享同一实例，`DshExecutor` 与 `Sessions` 已从这个边界调用执行。现在所有 `runner` 目标明确拒绝，以下事项是 C 必须实际补齐的内容：

1. 实现受信 `ExecutionRouter`：本机目标调用原生闭包，Runner 目标调用网络 backend；断线、未知工具或不支持能力直接等待／拒绝，禁止调用本机闭包。
2. 当前请求只有已有 ActorRef、可选空间及控制 revision。扩展企业身份、授权、epoch、能力版本、deadline 和结果模型；这些字段不能从外部消息正文获取。
3. 当前 `prepare` input 仍包含本机 command／variables。设计独立远程 `workspace.ensure`，只传受审阅的模板版本和资源句柄；不能发送公司模型 Key、PATH、机器人／邮件 Secret 或任意准备命令。
4. 当前 `tool` 含所有原生 DSH 工作工具；必须按下表分层，不能一律 RPC，也不能只代理 bash。
5. 当前 `settle` 的本机闭包还组合了子 Agent 与 job 等待。计算侧子 Agent 继续由 DSH drain／join，设备 job 状态由 Runner 回执提供；二者共同确认停止。
6. `Sessions.ensure` 仍拒绝 Runner，`Artifacts.readReportFile` 同样拒绝远端路径。只有代理工具、计算 scratch workspace 和受控文件传输都验收后，才逐项放开，不能删除门禁就交付。

建议新增 `src/execution/router.ts / gateway.ts / protocol.ts / runner/`，以及 Linux Runner 的独立 CLI 入口。插件和原生工具的分发点在 `src/app/sessions.ts`；生命周期在 `src/executor/dsh.ts`；服务器与 Runner 的本地适配器各自独立。以上路径均为拟建，非已实现代码。

## 工具与能力分类

| 能力 | 实际执行处 | 首轮策略 |
| --- | --- | --- |
| Loom 来源读取、报告、控制、飞书／邮件交付 | 公司服务及现有应用服务 | 保留现有鉴权和固定产物；不向设备下放产品服务权限 |
| Scenario／Skill 解析、模型选择、todo、subagent、agent 间消息 | 计算侧 | 仍受父任务、场景和控制版本限制；Skill 内的文件／Shell 必须继续经过环境代理 |
| read／glob／grep／read_image | 目标 Runner | 首轮允许已选目录内受限读取、枚举、文件类型与大小限制 |
| Codex 历史读取 | 目标 Runner 的专门只读工具 | 单独授权项目／日期／读取用途，不导入私人原生会话数据库到群空间 |
| write／edit、bash／pwsh、job_* | 目标 Runner | 首轮默认禁用；后续每类工具独立审阅、预算、撤权及实际副作用验收 |
| web_search／web_fetch | 已明确的受管检索环境 | 不借个人电脑网络扩大可访问范围；无能力时保持不可用 |
| 产物文件快照 | Runner 读取＋服务端 BlobStore | 只取任务声明的文件并校验真实类型／大小／哈希，不把远端路径当成本机路径 |

能力安装表含 toolId、版本、输入／结果 schema、效果类别（read／write／external）、资源要求、超时、预算及取消方式。场景声明、当前任务授权、系统模式、环境能力取交集，未知工具默认拒绝。新增 DSH 插件必须登记；插件绕过代理直接 fs／spawn 的情况不允许进入企业 Worker。

当前个人模式的通用工具和 `danger-full-access` 不能成为企业隔离策略。企业计算环境使用受限预设和受管账号；没有代理的原生文件／Shell 通道全部移除。共享群继续只开放已明确支持的受控来源和报告；不能因为某位主人配了设备，就让整个群读取其私人目录。

## 设备登记与最少配置

预期用户流程：飞书登录 → 在本人设备页选择“接入这台 Linux” → 一次性配对 → 在本机选择允许目录及工具 → 显示在线。无需填写模型 Key、应用 Secret、设备 IP 或开放入站端口。没有本地资源需求的办公任务，用户不用安装 Runner。

设备首次登记生成本机密钥对，由已认证用户创建短有效期、单次使用的配对挑战；服务端绑定企业／用户／环境／设备公钥。不能仅凭公开 deviceId、显示名或群成员身份配对。Runner 凭据放 Linux 受限本地存储，目录和文件权限收紧；客户端日志不打印配对码、令牌或文件正文。

Runner 仅主动建立 TLS 长连接（WebSocket 或长轮询，首版择一固定），服务端按已绑定身份认证。不要把现有管理员回环 HTTP 或 ngrok 临时链接当作设备网关。协议支持版本协商、短期连接凭据轮换、心跳、断线重连、重放游标及有界队列。

撤销设备立即使网关拒绝新请求、失效连接凭据并发送取消。设备断网时无法保证即时收到撤销，所以本机操作还要使用短期许可和过期检查；离线不能开始新写。已经运行的外部副作用不能宣称被撤销回滚，结果进入实际核对流程。

## 请求、回执与持久去重

以下是目标 wire envelope 草案，需先固定 schema 再编码；不能直接 JSON.stringify 当前带回调的端口：

```ts
interface RemoteRequest {
  protocolVersion: 1
  requestId: string           // 首次持久建单生成，重试／重连不改变
  tenantId: string; spaceId: string; userId: string
  ticketId: string; assignmentId: string; sessionId: string
  environmentId: string; workspaceId: string
  toolId: string; toolVersion: string; effect: 'read' | 'write' | 'external'
  resourceGrantId: string; grantRevision: number
  controlRevision: number; sessionEpoch: number
  expiresAt: string; argsHash: string; args: unknown
  permit: string              // 服务端绑定以上字段的短期执行许可
}
```

环境选择由调度器在允许范围内完成，模型只提供业务参数，不能自行改 environmentId／userId／grant。Runner 不相信 args 中的“已获授权”文字，按本机授予的 workspaceId 解析根目录；协议限制总消息大小、文件数量、总字节数、超时和并发数。

服务端账本属于 A，存请求哈希、状态、控制／租约版本、目标和结果引用。Runner 用独立 SQLite 保存 requestId、argsHash、当前状态、jobId、结果哈希及必要的有界结果缓存，做到重启后可查询；它保存执行回执，不保存完整 Loom／DSH 会话。敏感结果设保留期限，确认上传后按策略清理。

状态机：`queued → accepted → running → succeeded / failed / cancelled`，不能确认时进入 `unknown`。服务端可另记录 `waiting_environment`，避免把等待显示为运行。accepted 只说明设备已持久接收，running 才是开始执行。

同 requestId 同 argsHash：返回已知状态／结果，不能重新执行；同 ID 不同参数：拒绝并审计。设备必须先持久登记再开始工具。启动工具后、完成落账前崩溃的写操作标 unknown；只有只读或有真实幂等语义的工具才可按规则重试。持久账本不等于外部写 exactly-once。

结果保留原生 DSH result envelope 所需字段，但对网络 JSON 进行 schema、尺寸、类型及结果引用校验后再转换，不能 `as ToolExecutionResult` 盲信设备。图片／文件字节走受限对象上传，结果引用固定哈希与 ACL；原始 stderr 不直接进入飞书或公司可见日志。

## 分发与执行的顺序

1. 计算持有 B 的有效 Session lease，提出工具意图；网关校验场景、当前主人／空间、环境授权、任务有效性、控制版本及预算。
2. 在 A 的短事务内登记稳定请求与在途操作，和暂停竞争同一控制行。提交后再发送，不在数据库事务内等设备。
3. Runner 核验设备、签名／许可、有效期、参数哈希、本机资源授权和能力版本。新写入在在线状态下领取针对本次 requestId 的短期许可，网关再核验最新 controlRevision／epoch／grant。
4. Runner 持久 accepted，执行前再次检查许可与本机撤销；原子资源操作在授权目录范围内进行，进程运行受本机账号／沙箱限制。
5. Runner 持久结果后回传；网关核对请求、版本和哈希，提交回执，再让 DSH 使用结果。旧任务结果可记入账本用于核对，但不能覆盖当前人工版本或触发旧交付。

本机路径校验必须防止 `..`、符号链接、越界目录和检查后替换；采用平台上可行的句柄／安全打开方式，不只做字符串前缀比较。Runner 默认不是 root，不继承全部用户环境、SSH agent 或公司凭据。实际 Shell 能力上线前应明确操作系统沙箱强度，代码级白名单不能冒称强隔离。

## 取消、接管、离线和后台任务

暂停顺序：A 持久提升控制版本／禁止新分发 → 网关取消排队并向设备发取消 → DSH 停止推进／排空子 Agent → Runner 停止实际 job 及其进程树 → 查询真实回执 → 无在途且确认停止后进入 paused／human。

网络 AbortSignal 只是取消请求，不能证明远端停止。没有收到可核验的停止结果时保留 taking_over／unknown。映射为 `ExecutionOutcomeUnknown` 的结果不能丢失；A 持久 operation 关联 requestId，用户可查看并显式核查。现有 `TaskControls` 只作本机语义参考，跨进程登记由 A 实现。

设备离线时，依赖它的任务持久记录等待条件并释放 Worker 运行槽，显示“等待设备 Linux-2”；不频繁调用模型询问是否上线，也不整轮失败重跑。重连事件只唤醒获授权且未暂停／接管／过期的请求，旧许可全部重新确认，已结束的任务不复活。

后台 job 必须有 environmentId＋sessionId＋requestId 归属，支持列表、输出分页、状态查询、取消和重连恢复。清理当前 Session 及后代拥有的 job；不得按系统进程名批量杀别人的进程。计算侧的子 Agent 和设备侧 job 分开 drain，聚合确认静止。关闭 UI、Runner 退出、暂停任务、撤销设备分别显示明确状态。

初版只读工具可不支持长 job，但要显式声明能力不支持并拒绝背景执行。后续要解除 bash／job 门禁，必须先实现账本、进程组、取消确认与重连验收，不能让模型偷偷绕过到任意 Shell。

## 分步实施

1. **C1：协议与模拟器。**固定能力清单／请求／结果／取消／查询 schema；实现服务端路由端口及协议模拟器，确认远程错误没有本机回退。
2. **C2：Linux 只读 Runner。**本机配对／根目录授权／read／glob／grep／受限产物传输、权限文件、回执 SQLite。单元测试使用临时目录和独立密钥。
3. **C3：网关与 A／B 串联。**登记、lease／control／grant 核验、持久请求、在线心跳、等待／唤醒／撤销；将 compute scratch 和代理工具接入真实 DSH。
4. **C4：两台 Linux 验收。**一台公司计算／网关、一台个人环境，使用虚构资料；人为断网、重启、并发取消，保留两端脱敏 requestId 日志与结果哈希。
5. **C5：逐类扩展。**专门 Codex 只读工具、受审阅的数据处理器、文件写入，最后才考虑受限 Shell／job。每类增加资源、效果、完成校验、撤权和故障用例。

## 验收矩阵与交付物

| 场景 | 必须结果 |
| --- | --- |
| Runner 不在线／工具未安装 | 明确等待／拒绝，服务器本机无替代执行 |
| 请求、回执重复／乱序／丢失 | 原 requestId 核对，同参数不重复做；状态不倒退 |
| 相同 ID 改参数或篡改环境／权限字段 | 拒绝且无副作用 |
| 配对码重用、他人设备、过期／旧 epoch 许可 | 拒绝；无跨用户／跨空间读取 |
| 目录穿越、符号链接、巨大输出和伪造图片 | 拒绝或截断并明确标注；不越出预算 |
| 接管时工具在途、设备断网 | 不新增执行，不伪装已接管；结果未知可核查 |
| 设备撤销、离线又重连、任务已暂停 | 不自动续跑；旧凭据与旧许可无效 |
| Runner 工具已执行但回执前崩溃 | 读可核对／按策略重试，写 unknown 且不盲重放 |
| Server 更换计算进程 | 同 Session、同 requestId 恢复，不启动第二份 job |
| 产物上传＋人工修改竞争 | 固定哈希／版本，旧结果不覆盖人工文件、不发旧附件 |
| 群任务诱导读取某主人私人 Codex／目录 | 模式和来源边界拒绝，不能凭群成员身份共享 |

交付网关／Runner 可运行入口、schema 和兼容策略、Linux 安装／停止／卸载／撤销说明、两端账本查询与 unknown 核查流程、模拟器测试、真实两机验收记录。现有 `tests/execution-port.spec.ts` 是端口回归，**不是远程执行已经验收的证据**。

回滚先停新分发、持久暂停依赖 Runner 的任务，再取消／核对在途并撤销连接。保留回执与状态；不能将 runner 目标批量改为 local 继续执行。真实设备安装、配对、来源授权和生产切换分别取得实际操作授权。
