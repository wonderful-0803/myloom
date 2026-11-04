# 飞书事件映射（模拟 ↔ 真实接入）

Loom R7 起支持：**未配置凭证时模拟试用**；**配置 App ID/Secret 后**接收真实开放平台回调，并尝试 IM 出站回执。

> **诚实声明**：本机 `localhost` webhook **不能**被飞书公网推送打到。同事群真要用，必须把事件订阅请求地址指到可公网到达的 URL（云主机 / 反向代理 / ngrok 等）。模拟试用 ≠ 已接入。

## 真实接入步骤（开放平台）

1. 打开 [飞书开放平台](https://open.feishu.cn/) → 创建企业自建应用。
2. 凭证与基础信息：复制 **App ID**、**App Secret**。
3. 权限管理：至少开通  
   - `im:message` / `im:message:send_as_bot`（发消息）  
   - `im:message.group_at_msg:readonly` 或接收群聊消息相关权限  
   - 按需：云文档评论、日历、审批事件权限。
4. 事件订阅：  
   - 请求地址填：`https://<公网可达主机>/api/feishu/webhook`  
   - 也可在 Loom「接入飞书」抽屉复制当前探测到的 URL（本机仅为 `http://localhost:4567/...`，**不能直接给飞书**）。  
   - 配置 Verification Token、Encrypt Key（若启用加密）。  
   - 订阅 `im.message.receive_v1`（必需）；可选文档/日历/审批事件。
5. 在 Loom UI「接入飞书」保存 App ID / Secret / Token / Encrypt Key；生产建议勾选「强制校验签名」。
6. 发布应用版本，将机器人拉进值班群。群里 @ 机器人报障后，Loom 应开单；回执气泡标「已推飞书」或「回执失败·本地」。

## 连接状态（UI / API）

| 状态 | 含义 |
|------|------|
| 未配置 / 模拟模式 | 无 App Secret；试用走本地模拟；回执标「模拟回执」 |
| 已配置 | 已存凭证，尚未收到事件 |
| 已接通（有事件） | 配置后收到过 webhook |

`GET /api/settings/feishu` 返回脱敏信息 + `webhookUrl`；密钥**不会**进入前端 bundle。

## 源种类

| Loom SourceKind | 模拟入口 | 真实飞书事件 | 典型场景 |
|-----------------|----------|--------------|----------|
| `feishu.message` | UI 试用 / `scenario=group_bug_report` | `im.message.receive_v1` | 群 @ 报障（主故事） |
| `feishu.doc_comment` | `scenario=doc_comment` | `drive.file.comment_add_v1` | 文档催简报 |
| `feishu.calendar` | `scenario=calendar_brief` | `calendar.event.reminder` | 站会前简报 |
| `feishu.approval` | `scenario=approval_approved` | `approval.instance` | 审批变更说明 |

## 真实回调（schema 2.0）

Loom 识别：

```json
{
  "schema": "2.0",
  "header": { "event_type": "im.message.receive_v1", "token": "...", "app_id": "..." },
  "event": {
    "sender": { "sender_id": { "open_id": "ou_xxx" } },
    "message": {
      "message_id": "om_xxx",
      "chat_id": "oc_xxx",
      "message_type": "text",
      "content": "{\"text\":\"@_user_1 报障...\"}",
      "mentions": []
    }
  }
}
```

- `message.content` 为 JSON 字符串，解析 `text`。  
- 顶层 `{ "encrypt": "..." }` 用 Encrypt Key 按飞书 AES-256-CBC 解密后再处理。  
- `url_verification`：返回 `{ "challenge": "..." }`。

## 出站回执

配置凭证后，接单/完成 ACK 会尝试：

1. `tenant_access_token/internal`
2. `im/v1/messages/{message_id}/reply`，失败则 `im/v1/messages?receive_id_type=chat_id`

无凭证或网络失败 → **本地气泡保留**，并标明 `模拟回执` / `回执失败·本地`（禁止伪装成已发群）。

## 一键试用（模拟）

```bash
pnpm demo:feishu
# 或 UI 主 CTA「开始试用（模拟）」→ POST /api/demo/feishu
```

## 与 Mandate 的匹配（Gate）

- 群消息含 bug / 崩溃 / 报障 / Infinity / 复现 → 缺陷 Mandate → 规则补丁改 `loom-sandbox`（**非 LLM**）
- 文档评论无缺陷词 + 周报语义 → 简报
- 日历 / 审批 APPROVED → 简报或变更说明
