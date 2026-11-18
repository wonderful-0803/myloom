# C3：设备配对、网关连接与请求账本核心

日期：2026-11-17。承接 [C1](GATEWAY_RUNNER_C1.md) 和 [C2](GATEWAY_RUNNER_C2.md)。本批完成公司服务器侧的受信网关核心：一次性配对、设备公钥绑定、签名连接挑战、在线状态、心跳、撤销和按设备转发；设备登记、配对消费和撤销状态已接入 Loom `StateStore`，请求账本也提供 SQLite/PostgreSQL CAS 适配器。新增主动 TLS 长连接：Runner 只向 Gateway 出站连接，完成 Ed25519 挑战后承载 RPC，断开后指数退避重连。

本批已把 TLS Gateway 接入 `CompanyServer` 的可选配置，并增加管理员配对 API。2026-11-17 AI 盒子已完成证书、3443 监听和 Runner 配对；本轮进一步将 `CompanyRemoteExecution` 接入公司 Worker 的 `ExecutionRouter`，远程只读工具只能走 Gateway/Runner，不能回退到服务端本机。

## 实现

| 位置 | 能力 |
| --- | --- |
| `src/execution/gateway.ts` | `DeviceGateway`、`MemoryGatewayDirectory`、`StateGatewayDirectory`、可插拔 `GatewayRequestLedger`、`StateGatewayLedgerBackend`、配对挑战、设备登记、连接挑战、心跳、撤销、连接过期和按设备 `RemoteTransport` |
| `src/execution/tls.ts` | AI 盒子 TLS Gateway、Runner 主动 TLS 客户端、Ed25519 握手、JSONL RPC、心跳确认、断线重连和远程回执错误映射 |
| `src/state/server.ts` / `src/state/http.ts` | CompanyServer 可选 TLS 生命周期、同一 StateStore 组装、管理员配对/注册/列表/撤销 API |
| `src/execution/company.ts` | `CompanyRemoteExecution`：设备选择、任务/控制复核、短期 permit、Gateway transport 和 `ExecutionRouter` 组装 |
| `src/state/native.ts` | Runner 目标 Worker 只注册 `loom_remote_read/glob/grep`，本机文件/Shell 工具关闭；远程结果继续走原生 Worker 报告链 |
| `src/execution/gateway-config.ts` | 稳定 Gateway Ed25519 identity、TLS key/cert 私有文件校验和首次生成 |
| `src/execution/index.ts` | 导出网关核心，供受信服务宿主组装 |
| `tests/gateway.spec.ts` | 配对一次性、签名连接、设备绑定、请求去重、身份冲突、断线/过期和撤销验证 |
| `tests/tls-gateway.spec.ts` | 自签名 TLS 测试证书、主动连接、RPC、心跳和 Gateway 重启后的自动重连 |

### 设备身份

1. Loom 已授权的服务端调用方创建短时一次性 pairing challenge。
2. 设备用本机公钥消费 challenge；网关将 `tenantId / spaceId / userId / environmentId` 与设备公钥绑定，生成内部 `deviceId`。
3. 后续上线先取得随机 nonce，再用设备私钥签名 `deviceId + nonce`；仅凭公开 deviceId、requestId 或群成员身份不能连接。
4. 撤销会使连接立即失效、递增连接 epoch，并拒绝新的挑战；连接超时后网关将设备视为离线。

管理员入口只位于现有产品 API 的 `/orchestrator/api/loom/gateway/{info,pair,register,devices,devices/:id/revoke}`，复用现有会话、管理员身份、同源和 CSRF。`info` 只返回 TLS 地址和 Gateway 公钥；配对能力在 challenge 中固定，注册时不能扩大；设备公钥不会返回给浏览器列表。

`connectionPayload` 和 `signConnectionChallenge` 是供本机 Runner 适配器使用的签名辅助函数；私钥只在 Runner 端存在。配对码、设备令牌和私钥不能写入普通日志或交付附件。

### 请求边界

- `DeviceGateway.transport(deviceId)` 只允许转发到已登记且当前在线的设备。
- dispatch 会重新解析 C1 `RemoteRequest`，并校验请求的 tenant、space、owner 和 environment 与登记设备一致。
- query/cancel 必须找到同一设备上已经登记的 requestId 和 intentHash；不能凭 requestId 查询另一设备的回执。
- `GatewayRequestLedger` 保存首次请求的稳定意图、设备归属和 `ReceiptCursor`。默认内存后端用于隔离模拟；`StateGatewayLedgerBackend` 使用 Loom `execution` family 的 CAS revision，跨 Runtime 重启保留 request/receipt。`StateGatewayDirectory` 使用 `gateway-pairing:*` 与 `gateway-device:*` 两组受管 KV key，在同一事务中消费配对并登记设备；撤销用设备记录 CAS 更新。相同 requestId/intentHash 返回现有回执；同 ID 改参数或改设备绑定直接拒绝。
- 设备离线、连接过期或被撤销都返回 `RunnerOffline`，不会调用服务端本机闭包。
- 回执继续通过 C1 schema、序号、结果类型和摘要校验，状态不能倒退。取消请求本身不是停止证明。

TLS 层使用 TLS 1.3 加密 JSONL 长连接；Runner 采用出站连接，不要求个人电脑开放入站端口。TLS 服务器证书由公司服务配置，设备身份仍由配对后的 Ed25519 公钥挑战确认。心跳没有在限定时间内得到确认时，Runner 主动关闭连接并进入重连循环；RPC 在连接丢失时返回 `RunnerOffline` 或 `ExecutionOutcomeUnknown`，不伪造成功。

编译后，端侧 Runner 可由以下入口保持主动连接（`--ca` 是 AI 盒子 TLS 服务证书或其 CA，不是设备私钥）：

```sh
pnpm build
node scripts/runner-connect.mjs \
  --home /private/loom-runner \
  --ca /private/loom-gateway-ca.pem \
  --host 192.168.0.158 \
  --port 3443 \
  --servername loom-gateway.local
```

该命令只读取 Runner 本机的 `device.json` 和 SQLite 账本，主动向盒子连接；设备配对、目录授权和证书文件仍须由已授权的服务端/管理员流程准备。

网关的 `signPermit` 只能由已完成 A/B 授权和持久建单的服务端调用；它不是浏览器、模型或设备可调用的签发接口。正式集成时，签发前必须在 A 的 `execution` 与 `control` 同一事务内登记 request、当前 Session lease、control revision、resource grant 和 environment，提交后才发送。

## 当前边界

已完成的是 C3 的受信核心和隔离验证：

- TLS listener 已作为 `CompanyServer` 的可选第二监听器接入；当前 AI 盒子尚未配置证书和 `gateway` 配置块。
- 配对/注册/设备列表/撤销 API 只挂在现有已认证产品 API 下，并要求当前管理员与 CSRF。
- 无任意命令、写文件、Shell、后台 job 或产物上传。
- 没有把个人设备授权扩大给同群其他主人。
- 没有解除 `Sessions.ensure` 和远程 `artifact_file` 的现有门禁。
- 没有把设备目录作为服务端本地目录使用，也没有离线时本机回退。

仍待实现：

1. 补证书轮换/连接限流/健康检查，并把当前 acceptance profile 接到正式设备安装向导。
2. 将 grant/connection 的生命周期和撤销通知与真实连接适配器绑定；设备登记、配对消费和撤销记录已经接入 StateStore，活跃连接本身仍是进程内对象，重启后必须重新握手。
3. 将 gateway request ledger 与 `registerExecution` / `finishExecution` / `reconcileExecution` 绑定，保持暂停、接管和 unknown 语义一致。
4. 将 Runner 的目录授权与配对 API 串到设备安装向导，避免手工复制敏感凭据。
5. 将远程 read/glob/grep 的任务等待、离线唤醒、取消和 unknown 状态继续接到产品进度视图；首轮真实 `fs.read` 已通过。
6. 执行 C4 剩余矩阵：设备离线等待、重连唤醒、撤销、重启、重复请求、取消和 unknown 核查。

## 验证

`tests/gateway.spec.ts` 使用独立 Ed25519 设备密钥和 C1 `RunnerSimulator`，验证：

- 配对码只能消费一次，错误签名不能建立连接。
- 请求经过登记设备转发，回执在网关账本中更新。
- 完成后的相同请求不会再次调用 Runner。
- 改参数、改环境或跨设备请求被拒绝。
- 心跳/连接过期和设备撤销都会进入 offline/revoked，后续请求不产生副作用。
- SQLite StateStore 中的配对消费、设备登记、撤销和 request/receipt CAS 在新的 gateway/ledger 实例中可读回。

当前 TLS/Runner 连接、真实 Linux 设备目录和 `ExecutionRouter` 只读请求均已验收；真实 Agent Worker 代理工具由 `tests/dsh-state/company-remote.spec.ts` 覆盖，生产环境仍需完成设备安装向导和剩余 C4 故障矩阵。
