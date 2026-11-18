# 飞书工作台入口与首次机器人绑定

2026-11-18 首版实现了飞书工作台入口的身份层和机器人接入向导。这里的“免登录”指 Loom 不再维护独立用户名、密码或扫码账号。浏览器首次访问 `/orchestrator/loom/` 时，若没有 Loom 会话，服务端把浏览器送到飞书 OAuth，回调后只保存服务端会话和飞书 `open_id`。浏览器不能通过查询参数或表单伪造 UID。

## 入口行为

- `CompanyServerOptions.loginMode` 增加 `feishu-workbench`。该模式复用现有 HTTPS Feishu OAuth，但前端收到未登录响应后自动跳转，不显示 Loom 登录表单。
- `ProductSessions` 返回 `actor` 和租户标识。工作台 API 使用会话中的 UID，忽略 `x-user-id` 等浏览器声明。
- 首次拿到 UID 的人可以访问 `/orchestrator/api/loom/workbench/status` 和绑定向导。任务、群、产物和控制接口仍通过 `ProductAccess` 与当前群主人名单核验。
- 多群入口使用允许身份会话的共享 OAuth。未成为任何群主人时可以看到绑定／授权状态，但不能读取或操作业务任务。

## 首次机器人绑定

设置页和未获业务授权的首次页面都显示同一个向导。

1. 选择绑定已有机器人，输入 App ID 和 App Secret，或打开飞书开放平台创建入口。
2. Loom 服务端向飞书租户令牌接口和机器人信息接口发起短时探针。若租户令牌响应包含生效的 `scope` 列表，向导会逐项计算缺失的必需权限；平台没有返回清单时明确显示“需到开放平台确认”，不会猜测。凭据只在请求和私有 secret 文件中出现，不写入 StateStore、审计文本、浏览器响应或模型上下文。
3. 向导展示默认必需能力和可选能力。首版默认清单包含私聊／群消息、原线程回复、附件、群成员核验和 `im.message.receive_v1`。资料查阅、电子表格和多维表格是可选清单。
4. “登记并绑定”只有当前安装管理者可以执行。StateStore 记录机器人身份、权限清单、验证时间和 `requiresRestart`，App Secret 写入 `0700` 私有目录下的 `0600` 文件。
5. 平台权限和敏感权限的申请、审批、事件长连接、机器人能力和应用发布由飞书开放平台决定。首版不会把“令牌探针成功”误报为权限已开通，因此登记后状态通常是“等待平台权限确认”。机器人 App ID 与当前运行安装不同时，必须重启公司服务后才允许切换来源。

## HTTP 接口

这些路由必须先通过 Feishu 会话和同源 CSRF。它们不绕过业务 ACL。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/orchestrator/api/loom/workbench/status` | 返回当前 UID、租户、业务授权状态和脱敏机器人状态 |
| GET | `/orchestrator/api/loom/workbench/capabilities` | 返回默认能力清单和可导入的 manifest |
| GET | `/orchestrator/api/loom/workbench/quick-create` | 返回飞书开放平台入口和默认 manifest |
| POST | `/orchestrator/api/loom/workbench/verify` | 短时验证 App ID／Secret 和机器人身份，不保存绑定 |
| POST | `/orchestrator/api/loom/workbench/bind` | 管理者保存验证结果、权限请求和私有 secret 引用 |

## 当前边界

首版完成了入口、可信 UID 会话、身份探针、权限清单、绑定登记和审计。它还没有把任意新 App 动态热切换成 Feishu 消费者，也没有代替飞书平台创建应用、申请敏感权限或发布版本。绑定新 App 后要完成平台权限和发布，再按部署流程重启服务。多用户任务数据、群主人名单和跨群边界继续由现有工作空间 ACL 管理，不能因为完成 OAuth 就自动扩大。
