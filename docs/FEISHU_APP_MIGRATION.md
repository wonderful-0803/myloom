# 独立飞书机器人与首次权限配置

日期：2026-11-03。状态：新应用已创建，14 项应用身份权限已申请，消息长连接验证成功，首次版本已提交且处于企业管理员审核中；尚未切换运行中的来源。

操作者要求新建独立应用，在首次发布前一次配置已确定的个人办公能力，随后替换现有 CLI 机器人。

## 当前迁移证据

- 新应用“新个人助手机器人”，App ID：`cli_EXAMPLE_ID`。操作者已确认创建和按本清单配置；已启用机器人。
- 平台批量导入识别到 14 项应用身份权限；逐项核对后，13 项显示“已开通”（包含关键权限 `im:message.group_msg`），`drive:drive:readonly` 随首次版本显示“审核中”。应用仍待上线，尚未把申请成功当作全部能力可用。
- 操作者通过不回显的本机终端配置 Secret。独立目录 `/home/your-user/.lark-cli-superagent-next`、包装命令 `/home/your-user/.local/bin/lark-superagent-next`；验证返回正确的新 App ID、bot verified 且无 user 身份。
- 真实 CLI 消费器出现 ready 标记并连接 WebSocket；开发者后台验证显示“连接成功”。已保存长连接模式和应用身份消息事件 `im.message.receive_v1`。
- 首次版本 `1.0.0`（`7703822609137405227`）已提交，平台显示“审核中”，可用范围只含所有者一人，对外共享保持关闭。[版本详情](https://open.feishu.cn/app/cli_EXAMPLE_ID/version/7703822609137405227)。这次首次发布没有自动免审通过。
- 审核前未切换旧机器人、所有者或群配置。旧运行仍为 ownerOnly、observe、指定测试群；模型和历史任务不变。

待企业管理员通过发布后，将新机器人加入“测试群”，再按下文步骤核对新应用范围内的群和所有者身份并完成真实消息验收。操作卡片回调在对应功能实现时配置，未在本轮开放一个无人处理的回调入口。

2026-11-03，操作者确认仍在等待企业审批，选择先沿用“个人助手机器人”的现有权限继续探索原线程、私聊查询及邮箱交付形态，见 [交互方案](FEISHU_INTERACTION.md)。不因本轮交互探索提前切换新应用或追加邮件权限。

## 创建入口的实际区别

已查看飞书开放平台的 CLI 一键创建页和智能体一键创建页，并展开其自动配置说明。两者预置 @ 机器人和私聊等消息权限，展示的清单均没有“获取群组中所有消息（敏感权限）”。因此不能把新建同一模板当作 `im:message.group_msg` 已经授予。

采用企业自建应用的草稿流程，先启用机器人、导入以下权限、配置事件，再创建首次版本。是否免审批以及权限是否正式生效，以企业管理员规则和平台实际状态为准；不能通过重建应用承诺绕过审批。

此前联调中历史 API 的一次成功或空结果，不等同于后台敏感权限审批通过；原接口读回证据仍保留，但不能据此认定长期授权已解决。`lark-cli auth scopes` 返回的 `userScopes` 也不能用于判定机器人应用身份的权限。

## 本版权限清单

可审阅的批量配置草稿见 [权限 JSON](../examples/feishu.personal-app.scopes.json)。平台导入前仍需检查其当前权限名称、支持的身份及重复/失效提示。

| 用途 | 应用身份权限 |
| --- | --- |
| 群信息与明确监听范围 | `im:chat:read` |
| 私聊、@ 消息、群讨论和历史资料 | `im:message:readonly`、`im:message.group_msg`、`im:message.group_at_msg:readonly`、`im:message.p2p_msg:readonly` |
| 原线程结果、操作卡片和消息附件 | `im:message:send_as_bot`、`im:message:update`、`im:resource` |
| 云文档与知识库查阅 | `docx:document:readonly`、`wiki:wiki:readonly` |
| 获授权的文件查阅、元数据及下载 | `drive:drive:readonly`、`drive:drive.metadata:readonly` |
| 电子表格与多维表格读取、汇总 | `sheets:spreadsheet:readonly`、`bitable:app:readonly` |

权限配置仅申请应用身份，不复制个人用户登录。产物先通过机器人消息或附件交付；本清单不授予云文档、表格或业务记录编辑权限，也不申请通讯录遍历、邮件、日历、审批或团队管理权限。将来新增这些工作时，需重新明确权限与动作范围。

应用权限不自动赋予资源访问权：文档、文件、知识库和表格仍需按任务由所有者共享给机器人。运行层继续只监听操作者指定的测试群和私聊，只有所有者可发起及追加要求，保持 observe。平台消息权限可覆盖机器人加入的其他群，因此仍需限制实际入群与资源共享范围。

## 接入前核对

1. 应用名预填“新个人助手机器人”，用途为个人办公。创建前审阅平台显示的身份、组织和权限；新应用须使用独立凭据。
2. 首次发布前导入清单，核对 `im:message.group_msg` 的申请与生效状态，明确可用范围。管理员审批仍以平台结果为准。
3. 启用机器人，配置接收消息事件 `im.message.receive_v1`；操作卡片启用时核对 `card.action.trigger`。验证现有 CLI 事件消费方式是否可用，不能只凭页面勾选认定连接成功。
4. App Secret 只通过本机凭据流程存储，不发到聊天，不从 `config show` 的掩码复制。使用独立的 bot-only CLI 配置验证身份、权限和新机器人。
5. 将新机器人加入指定测试群后，用新应用的 API 重新核对该群和所有者。`open_id` 按应用区分，不能复制旧所有者 ID；群标识也需用新应用实际返回值核实。旧任务的来源与授权记录不批量替换成新身份。
6. 切换前检查在途操作，保留旧配置与历史任务。受控更新新来源、所有者及群监听配置；避免同时运行两个机器人处理同一需求。不改模型或重置任务历史。
7. 验收真实私聊、@ 请求、原线程追加、无 @ 的 observe、群历史与结果读回。通过后再把新机器人标记为当前接入，记录实际平台权限和证据。

## 参考

- [官方 CLI 创建流程](https://github.com/larksuite/cli#quick-start-ai-agent)
- [群消息读取所需权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)
- [应用审核说明](https://open.feishu.cn/document/home/intro-to-custom-app-review)
