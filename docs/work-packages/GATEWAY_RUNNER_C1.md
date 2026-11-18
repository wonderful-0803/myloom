# C1：远程执行协议与路由边界

日期：2026-11-12。目标网关仍在既有 AI 盒子。首批完成协议与模拟器，不等同于 Linux 设备已接入；C2 的本机只读工具/SQLite 回执、C3 的设备身份/网关/A-B 账本和 C4 两机验收继续待实现。

## 本批实现

- `src/execution/protocol.ts`：严格的 v1 请求、查询、取消与回执 schema。请求携带 tenant/space/user/task/assignment/session/environment/workspace、资源授权 revision、控制 revision、Session epoch、期限、参数摘要和 permit。未知字段、未来协议、写能力、绝对/越界路径及超预算数据拒绝。
- 能力清单首批只定义 `fs.read`、`fs.glob`、`fs.grep`，参数/结果独立于本机 DSH 工具实现。grep 首轮为有界文本查询，真实扫描和路径句柄检查留在 C2；schema 不冒充文件系统隔离。
- `src/execution/router.ts`：显式 opt-in `ExecutionRouter`。本机仍走 `LocalExecutionPort`；Runner 分支不接触本机闭包，只转发受信宿主签发的请求。异步建单后重新核验当前绑定、来源身份、租约/控制/资源授权；接收结果前再核验。准备命令、生命周期、子 Agent 和后台 job 未开放远程映射。
- `ReceiptCursor` 验证回执身份、参数/结果摘要、工具结果类型、大小、顺序和终态。低序号乱序消息不回退状态，同序号冲突或终态变更拒绝。成功结果重新构造原生 `ToolExecutionResult`，设备不能注入任意原生元数据或上下文。
- 离线在接受前返回 `RunnerOffline`，供 C3 登记等待环境；分发后丢回执、停止未确认或超时进入 `ExecutionOutcomeUnknown`。取消信号不是停止证明，不能用本机操作作为远程失败补救。
- `src/execution/simulator.ts`：内存模拟 accepted/running/terminal、重复请求/冲突及取消。需要显式注入 permit 核验和合成工具执行器；没有网络监听、本机文件工具或持久账本，不能部署成真实 Runner。
- `dsh-superagent/execution` 导出供后续受信宿主组装。当前 Runtime、`Sessions.ensure` 和远端产物读取门禁保持原样；盒子运行服务没有启用真实远程执行。

## 信任边界

`RemoteAuthority.prepare/check` 是受信服务接口，不是浏览器或模型可调用的签发器。C3 必须在 A 的事务里使用当前 B lease 登记原始稳定 requestId、在途操作与授权，并持久化返回回执；C1 本身不提供这样的权威实现，不能仅靠 schema 或内存去重宣称外部执行可靠。

`RemoteTransport` 是已认证连接的抽象。Simulator 测试用独立 HMAC 许可校验篡改；这不是已交付的设备配对、TLS、凭据轮换或生产签名协议。查询和取消的网络身份亦须由 C3 实际绑定，不允许只凭公开 requestId 查询他人结果。

共享群当前仍只读取受控来源。某位主人配对设备，不意味着群内所有主人获准读其私人目录或 Codex。没有专门共享资源授权的群任务不应装配个人文件代理。C1 未新增设备、来源或用户授权。

## 验证

`tests/execution-protocol.spec.ts` 覆盖正常只读返回、本机行为、未知/Shell/写工具拒绝、路径穿越、同请求去重和改参拒绝、篡改/过期许可、设备离线、异步授权撤销/换环境、取消未停止、回执丢失后同 ID 查询、乱序/终态/结果摘要/注入字段。测试只用合成 R1 和模拟传输，没有接触真实个人目录或网络设备。

全量 **108 个文件、1654 项通过、4 项跳过**，含真实专用 PostgreSQL；TypeScript 和构建通过。现有执行端口回归一并通过。新增 SSH 工作台登录的验收与盒子切换独立记录，不作为远程设备能力证据。随后增加私有 profile 依赖回归 3 项，修复后包含真实 PostgreSQL 的产品/协议/配置专项 43 项通过，类型检查通过。真实群 Word 已完成下载核对，仍不是 Runner 能力证据。

本轮发现旧公司服务测试只等待三秒，而 native drain 后交付重试的持久退避可超过三秒；保留状态/交付断言，等待预算改为十秒，实际 PostgreSQL 路径通过。没有修改生产退避来迎合测试。

## 下一步

C2 开发实际 Linux 只读 Runner：显式本机根目录授权、句柄/安全打开防替换、限制类型/字节/输出、受限账号运行、SQLite 回执和重启核对。C3 再落实单次设备配对、主动 TLS 连接、心跳与撤销、A/B 权威签发和持久等待/唤醒，并将代理工具装配到 DSH。最后在盒子和另一台 Linux 使用虚构文件做 C4 验收。远程 Shell、文件写入和 job 均保持后续范围。
