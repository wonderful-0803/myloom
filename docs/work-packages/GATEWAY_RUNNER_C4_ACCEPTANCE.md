# C4：两台 Linux 真实联调清单

本清单用于在 C3 TLS Gateway 接入 `CompanyServer` 后进行真实验收。默认设备：

- AI 盒子／公司服务器：`192.168.0.158`，运行 CompanyServer、PostgreSQL 和 TLS Gateway。
- 第二台 Linux：运行只读 Runner，只主动访问 AI 盒子的 `3443` 端口。
- Loom 工作台：仍使用 `3084`，不与 Runner TLS 端口混用。

## AI 盒子准备

1. 创建私有目录并限制权限：

```sh
sudo install -d -o loom -g loom -m 700 /var/lib/loom/company/gateway/tls
sudo install -d -o loom -g loom -m 700 /var/lib/loom/company/gateway
```

2. 准备 TLS 服务器证书。证书的 SAN 必须包含 Runner 实际连接使用的 `192.168.0.158` 或 `loom-gateway.local`：

```sh
sudo openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /var/lib/loom/company/gateway/tls/server.key \
  -out /var/lib/loom/company/gateway/tls/server.crt \
  -days 365 \
  -subj '/CN=loom-gateway.local' \
  -addext 'subjectAltName=DNS:loom-gateway.local,IP:192.168.0.158'
sudo chown loom:loom /var/lib/loom/company/gateway/tls/server.key /var/lib/loom/company/gateway/tls/server.crt
sudo chmod 600 /var/lib/loom/company/gateway/tls/server.key
sudo chmod 644 /var/lib/loom/company/gateway/tls/server.crt
```

生产环境应使用公司 CA 签发证书，并把 CA 公钥安装到 Runner；不要把服务器私钥复制到第二台 Linux。

3. 在公司配置中增加 `gateway` 块，确认 `host` 为盒子私网地址、`port` 为 `3443`。`identityKey` 由 Loom 首次启动生成，之后必须保持不变。

4. 仅允许实际 LAN 访问 3443；不要通过公网、ngrok 或工作台 LAN 代理暴露该端口。防火墙规则应只允许公司内网网段。

5. 重启 CompanyServer，检查：

```sh
ss -ltnp | grep 3443
journalctl -u loom.service -n 100 --no-pager
```

## 受保护配对

配对入口复用 Loom 工作台的当前管理员身份、同源校验和 CSRF：

先通过 `GET /orchestrator/api/loom/gateway/info` 取得 TLS 地址和 Gateway 公钥。Gateway 公钥可用于 Runner 初始化，不能替代 TLS CA 证书。

```text
POST /orchestrator/api/loom/gateway/pair
```

请求示例：

```json
{
  "environmentId": "linux-2",
  "capabilities": ["fs.read", "fs.glob", "fs.grep"]
}
```

返回的 `id` 和 `code` 只使用一次，默认五分钟有效。`capabilities` 在配对时固定，注册时不能扩大。

设备注册入口同样只允许当前管理员：

```text
POST /orchestrator/api/loom/gateway/register
```

请求示例：

```json
{
  "challengeId": "配对返回的 id",
  "code": "配对返回的 code",
  "deviceId": "设备 device.json 中的 UUID",
  "devicePublicKey": "设备 device.json 中的 Ed25519 公钥",
  "capabilities": ["fs.read", "fs.glob", "fs.grep"]
}
```

查看设备：

```text
GET /orchestrator/api/loom/gateway/devices
```

撤销设备：

```text
POST /orchestrator/api/loom/gateway/devices/{deviceId}/revoke
```

这些接口位于产品 API 下，不是新的匿名管理端口；写请求必须携带现有 CSRF 和幂等键。

## 第二台 Linux 准备

1. 创建专用非 root 用户和私有 Runner 目录。
2. 使用 AI 盒子的 Gateway 公钥初始化 Runner：

```sh
node scripts/runner-local.mjs init \
  --home /var/lib/loom-runner \
  --binding /etc/loom-runner/binding.json \
  --gateway-key /etc/loom/gateway/device-gateway.pub
```

3. 只授权用于验收的虚构目录：

```json
{
  "id": "acceptance-read",
  "workspaceId": "linux-2-fixture",
  "scope": "personal",
  "root": "/var/lib/loom-runner/fixture",
  "capabilities": ["fs.read", "fs.glob", "fs.grep"],
  "extensions": [".txt", ".md", ".json"],
  "expiresAt": "2030-01-01T00:00:00.000Z"
}
```

4. 通过工作台配对接口登记 `deviceId` 和 `devicePublicKey`，再启动：

```sh
node scripts/runner-connect.mjs \
  --home /var/lib/loom-runner \
  --ca /etc/loom/gateway/ca.pem \
  --host 192.168.0.158 \
  --port 3443 \
  --servername loom-gateway.local
```

正式运行可安装 [Runner systemd 模板](../../examples/loom-runner-connect.service)。

## 必须通过的场景

1. Runner 首次出站连接完成 TLS 和 Ed25519 挑战，工作台显示在线。
2. Runner 心跳持续更新，Gateway 重启后设备仍登记，但连接重新握手。
3. 任务读取第二台 Linux 的虚构文件，结果回到 AI 盒子上的 Agent。
4. 第二台 Linux 断网，任务进入“等待设备”，不在 AI 盒子本机回退执行。
5. 恢复网络后自动重连，原请求按 `requestId` 去重。
6. 撤销设备后，已有连接关闭，新请求拒绝，不能读取旧结果绕过撤销。
7. 暂停/接管任务时，Runner 不再接受新的请求；没有停止证明的请求进入 `unknown`。
8. 目录穿越、未授权后缀、Shell、写文件和超预算读取均被拒绝。

验收记录至少保存：两端脱敏 requestId、deviceId、连接 epoch、状态变化、结果哈希、断线/重连时间及撤销操作。真实个人目录和真实业务文件不用于首轮验收。

## 2026-11-17 AI 盒子实机记录

- AI 盒子 `192.168.0.158` 已运行发布包 `a6bfd1dae3096de4697c856abcaaf239b372b25e7e5532d67ef9653741a8f1b1`，Gateway TLS 监听 `3443`，工作台仍通过 `3084` 提供。
- 当前 Linux Runner `9e3a1f2e-8152-4e52-a918-fe41c9980d3f` 已完成配对、TLS 1.3、Ed25519 挑战和心跳；服务重启后自动重连，`connectionEpoch` 从 `1` 递增到 `2`，状态保持 `online`。
- 旧测试设备已通过受保护撤销入口置为 `revoked`，撤销记录保留在 StateStore。
- 已使用虚构目录 `notes/daily.txt` 完成真实 `ExecutionRouter → CompanyRemoteExecution → Gateway → TLS → Runner → fs.read`，读回 `R1/R2` 原文；服务端本机 fallback 回调未执行。
- Worker 侧 `loom_remote_read/glob/grep` 只读工具已接入并由 `tests/dsh-state/company-remote.spec.ts` 验证；远程 Shell、写文件和后台 job 仍未开放。
