# 个人助手联调记录

日期：2026-11-03。此记录区分实际调用、模拟测试和待验收能力，不作为产品能力已全部完成的声明。

## 本机环境

- DeepSeek Harness：`0.2.1-rc.3`；飞书 CLI：`1.0.95`。
- 独立 Harness home 与专用 `superagent` Web profile，模型设置及 Session 与原日常环境分开；没有复制原有 Session 或用户登录。
- 管理服务只监听 `127.0.0.1:3082`。GitHub 来源关闭，策略仅配置单个所有者，模式为 `observe`。初始私聊联调后，按操作者指定，仅增加“测试群”，其他群关闭，启用 `ownerOnly` 阻止非名单用户发起或追加任务。
- Eval 和 Executor 均明确指定 `dashscope / qwen3.8-flash`。百炼接口地址保持既有配置。
- 飞书使用独立的 bot-only 配置引用。原配置仍保留用户登录；系统凭据库中的 App Secret 按同一应用共享。

## 已验证

| 检查 | 实际结果 | 证据性质 |
| --- | --- | --- |
| 百炼模型接口与工具协议 | `qwen3.8-flash` 请求计算工具，读取返回值后回答 12 + 8 = 20 | 两次真实 API 调用；合计 883 tokens |
| Harness 模型与工具执行 | 模型调用 `bash` 执行 `python3 -c "print(12+8)"`，工具真实输出 20，模型随后交付中文结果 | 真实 Harness Headless 执行；合计 9496 tokens |
| 管理服务 | 管理 API 可访问，保存个人策略、角色模型及关闭 GitHub；零运行、零排队任务 | 真实本机服务 |
| 服务进程识别 | 修复 Linux 上 Node 的 `MainThread` 名称导致状态误报；现可识别实际 PID | 实机状态检查及服务脚本回归测试 |
| 凭据配置入口 | 不回显终端输入，密钥经 stdin 传入，拒绝掩码和带用户登录的目标配置，CLI 回显不会进入输出 | 模拟 CLI 的自动化测试 |
| 飞书 bot 身份 | 操作者在本机恢复 Secret 后，通过服务端验证，独立配置不含 user 身份；启动检查要求 `--verify` 成功 | 真实身份检查、保存来源及服务重启 |
| 飞书连接 | 来源健康状态为 `Listening for bot events`，随后实际收到操作者私聊和线程追加消息 | 真实消息事件、任务记录及飞书结果读回 |
| 回归验证 | 本轮最新 `pnpm check`：类型检查、66 个测试文件的 1248 项测试和构建全部通过；新增飞书文字助手与邮箱桥接测试 | 本机自动化检查；邮箱与异常场景使用模拟接口 |
| 163 单次邮件交付 | 飞书私聊预览 → 本人确认 → SMTP 接收记录成功；用户随后确认实际收到邮件，任务保持 2 个且内容未变化 | 真实飞书消息读回、SMTP 持久记录和用户收件确认；不冒充邮箱平台送达回执 |
| 受管任务控制 | 本机面板在已完成的虚构任务上实测接管、服务重启后保持控制状态、显式交还；其他任务未被全局暂停 | 真实本机服务；在途发送、原生工具及异常恢复另有模拟宿主测试，不冒充真实外部写入中断验收 |

真实调用的机器日志位于被 Git 忽略的 `.artifacts/`；运行日志可能包含本机面板的访问令牌，不应直接发布。记录不包含密钥、访问令牌、账号 ID 或私人资料。

## 真实私聊闭环

操作者私聊机器人，提供 R1–R3 三条虚构工作记录，要求按“已完成 / 阻碍 / 下一步”总结并保留编号。系统于 10:49 创建一个任务，约 35 秒后 Worker 报告完成，随后回复原消息线程。通过飞书读回确认：结果正确归类 R1–R3，三个编号均保留，没有生成 PR。

操作者随后要求改为三行，并在原线程补充同一要求。系统仍只有一个任务，任务 ID、Worker Session 和执行目录均未变化；新输入被记录并送入第二次 Assignment。第二次执行约 21 秒后完成，修改结果回到原线程，未遗留排队任务或未交付结果。

首次修改结果在三行正文后额外附加了常规审计说明，严格行数要求未完全满足。此次原消息已由开发操作者更正，飞书读回确认恰好三行；不能把这次人工修正当作模型自动遵守格式的证据。已更新交付规则：保留用户要求的行数/列数/JSON 格式，常规校验说明留在内部报告，必要引用和重要局限内联表达。单独真实模型格式探针通过；后续仍需持续观察真实任务的格式遵循，提示词不构成系统级格式保证。

## 真实群聊：数据与指定资料查阅

操作者在指定测试群 @ 机器人，提供 5 行虚构 CSV，并要求仅查阅指定的上游公开 README。系统于 11:48 建单，Worker 使用办公技能、原生文件工具、shell 和 `web_fetch`，约 2 分 31 秒后完成。管理页真实轨迹显示指定 URL 的 `web_fetch` 返回 HTTP 200；没有把外层开发助手的浏览当作 Worker 检索证据。

CSV 汇总为 online 0.30 元、offline 12.50 元、合计 12.80 元；输入 5 行计入 3 行，完全重复排除 1 行、金额缺失排除 1 行。开发复核读取真实产物并独立核对结果、计数和计算器生成的 SHA-256 清单，均通过。原输入、口径、结果和清单在独立任务目录保留，没有覆盖源业务记录。

Worker 保存了指定来源的 URL、获取时间和正文转录，并交付两句依赖与原型限制说明，结论与 README 一致；明确未读取 SETUP.md 和其他链接文件。因此本次只验收“给定公开 URL 的查阅与引用”，不代表通用网络搜索或飞书文档检索已经验收。

原来源快照声称另有两个辅助文件，但完成时实际未落盘。开发复核从已有正文转录补齐 `README-raw.md` 与 `sha256.txt`，标注它们是本地文本提取而非原始 HTTP 字节，并更新交付说明中的快照哈希；不将这次修正计作模型自动完成证据。办公技能已增加逐项核对文件存在性与哈希的要求，仍需后续真实任务检验。

Outbox 中确认消息及最终结果均为 `sent`。权限生效后已通过真实话题历史 API 读回：最终消息位于原消息的同一线程，包含正确的 12.80 元合计、排除说明及可点击的 README 引用。

## 群聊权限恢复与 observe

初次联调时，机器人可接收 @ 消息并回复，但群历史与话题轮询返回 `230027`（权限不足），不 @ 的观察消息也未进入系统。请求管理员核查应用身份权限后，群历史与话题接口实际恢复成功，history 健康状态恢复 ready；没有切换为用户身份或借用个人登录绕过。平台上具体的权限发布操作由管理员处理，本机记录以接口复测为准。

[飞书官方历史消息文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list) 要求应用获取群消息时额外开启 `im:message.group_msg`。恢复后，真实的无 @ 总结测试消息被补收并形成 `wouldAccept` 决策，匹配 office-summary 规则；没有 ticket ID，没有新增 Worker 或该消息的 Outbox 交付记录。普通测试闲聊被记录为 ignore。不能把权限不足时的“没回复”误判为 observe 通过，本次通过以补收后的真实决策和持久记录为依据。

## 已恢复的配置问题

建立隔离配置时曾将 CLI 返回的掩码错误传入初始化命令，覆盖本机共享的应用密钥记录，导致新连接认证失败。已向操作者说明；操作者通过不回显的本地配置命令恢复真实 Secret，随后 bot 服务端验证及服务重启均通过。没有向仓库或聊天输出真实 Secret。新增配置脚本拒绝掩码输入，启动检查也要求通过服务端验证。

## 待完成

- 2026-11-04 按用户明确要求将基础办公规则切为 auto；持续委托仍可独立选择自动执行。新的无 @ 自主任务质量与异常恢复仍待真实消息验收。
- 继续验证更大数据、飞书表格/文档权限、开放网络搜索和产物完整性。
- 用更多真实请求验证改进后的严格格式遵循，以及任务失败、设备重启和长时间离线后的恢复。
- 飞书文字控制已部署，原群线程暂停／状态／继续已实测，接管／交还实测仍待补充；企业邮箱预览已验收；163 单次预览／确认／提交／用户收件确认已验收；企业邮箱发信暂缓。
- 完整原生文件产物索引、卡片操作、协同编辑与邮箱自动规则尚未实现。

当前只接入指定测试群。任务级控制覆盖受管工具、作业和交付队列，不是设备或 OS 沙箱；真实在途外部副作用、协同编辑、飞书控制卡片与独立产物工作台尚未验收或实现。全局处理暂停仍不等同于任务级暂停。

## 真实飞书文字助手：查询与报告导出

16:04 左右在无运行任务时备份持久状态，构建并重启本机服务，新增 assistant 健康项 ready。现有机器人、所有者、测试群、observe、模型与原始持久设置保持一致；没有切换待审批应用。

操作者实际私聊“我的任务”，然后查询已完成的 R1–R3 工作总结报告并导出。16:08 操作者确认已收到；三个请求持久回执均为 `sent`。开发侧通过飞书批量消息 API 读回两条文本和一个文件消息，文件名确为 `result.txt`。任务总数前后都是 2；查询与导出未新建任务或唤醒已完成 Worker。

本机证据保存在 Git 忽略且权限受限的 `.artifacts/feishu-assistant-acceptance.json`、`.artifacts/feishu-assistant-readback.json`；不在本文发布账号 ID、消息正文或凭据。当前取回范围是持久报告，不代表任务目录所有文件已能取回。原线程暂停／继续的真实验收见下文；飞书接管／交还仍待实测。

## 真实原群线程：暂停、状态和继续

操作者在之前 CSV 汇总任务的原线程 @ 现有机器人，依次发送暂停、状态查询和回复中带版本的继续指令。16:15 后台记录显示同一任务控制由 agent → paused（r1）→ agent（r2）；三个入口回执均 sent。飞书消息 API 读回确认状态查询显示“已暂停”，继续回执显示“助手可继续”。任务仍已结束、没有新增任务；另一个任务的控制状态未变化。此测试验证已完成虚构任务的控制入口，不代表真实在途外部写入中断已经验收。

持久请求、实际来源线程、控制历史和消息读回保存于受限的 `.artifacts/feishu-control-acceptance.json`。

## 飞书企业邮箱接入边界

用户已选择飞书企业邮箱。邮件桥接已实现预览、固定任务版本和收件人、显式确认、远端草稿、发送及回执。自动化测试覆盖本人身份、暂停、撤权、草稿创建期间取消和发送响应丢失不重发；这些为模拟邮箱接口证据。

用户完成扫码后，由开发助手回收 Device Flow。CLI 返回授权已完成但部分权限缺失；服务端验证显示 user 身份 ready、token valid，应用及 open_id 与既有任务所有者一致。真实 profile 成功返回本人企业邮箱。当前只授予 `mail:user_mailbox:readonly` 和 `mail:user_mailbox.message:modify`，未授予发送及投递状态查询，不能把扫码成功当作四项权限全部到位。

已在本机来源配置独立用户 `mailCli`，其他飞书设置、policy、observe、模型与执行设置保持一致。补充部分授权检查：连接和报告预览明确显示缺失能力，不提供发送许可；此前的预览在确认时发现授权不足会作废，在创建草稿之前停止。新增模拟测试验证没有远端写入，`pnpm check` 的 1240 项测试、类型检查与构建通过。操作者随后实际发送邮箱查询和邮件预览，两条回复均 sent，并通过飞书消息 API 读回：显示缺失权限、不提供发送指令。没有创建远端草稿或发送真实邮件。机器人仍为独立 bot-only 身份，未为邮箱扩大群权限。首轮只给所有者自己发送固定报告，预设自动规则及附件尚未实现。

## 163 邮箱接入

用户选择“更换我的163邮箱，先不在企业邮箱上验证”。已关闭助手中的企业邮箱 CLI 接入，不继续申请其发送／回执权限。

本机实际连接 `smtp.163.com:465`，证书校验通过，协商 TLS 1.3。用户在自己的终端输入地址和 SMTP 授权码；配置命令仅验证登录后原子保存，没有发送测试邮件。开发助手通过桥接 `identity` 再次验证 SMTP 登录，确认邮箱、绑定的飞书所有者与当前应用一致；没有直接读取或回显授权码。真实身份元数据保存在受限的 `.artifacts/163-mail-identity.json`。

新增 Python 桥接和服务选择；预览固定任务报告和邮箱账号版本，确认前复查；仅给本人地址发信，SMTP 请求与接收结果持久记录，相同 Message-ID 不重复提交，结果不明先查记录及实际邮箱。SMTP 接收与最终送达分别记录。66 个测试文件的 1248 项测试、类型检查和构建通过；异常恢复测试以模拟服务器为证据，真实正常发送验收见下文。

机器人内 163 预览、显式确认、SMTP 实际接收及用户收件确认已通过。自动邮件规则、附件及其他收件人仍未实现。

## 真实 163 单次邮件交付

操作者按逐条消息流程于 16:49 查询邮箱、预览已完成的 R1–R3 虚构工作总结，并于 16:50 发送带本次预览令牌的完整确认指令。实际事件均为所有者私聊，邮箱查询、预览和确认结果三条回执均 sent，已通过飞书批量消息 API 读回。预览显示固定的本人 163 收件人、主题和报告摘要；确认结果显示 SMTP 服务器已接收。

桥接的只读状态查询返回 submitted，Message-ID 与该预览的持久记录一致；本轮只有一份 163 发送许可及对应成功提交记录。操作者在本开发对话中明确确认“已收到邮件”。SMTP 状态仍按服务器接收记录为 submitted，不把用户收件确认伪装成邮箱平台的 delivered 回执，也没有为验收读取收件箱。

任务数仍为 2，全部 ticket 记录与接入前备份完全一致；邮件交付没有新建任务、唤醒 Worker 或改写原报告。服务健康 ready，原机器人、指定测试群、observe 和模型保持既有设置。

本机证据保存于受限的 `.artifacts/163-mail-delivery-acceptance.json`，不在仓库文档披露地址、账号 ID 或令牌。此次只验收固定报告正文经本人确认后发给本人；自动规则、附件、其他收件人和真实异常恢复仍按原清单推进。

## 三组工作的首轮部署：引用交互、正文版本、受控起草

2026-11-03 17:38，在确认现有 2 个任务全部已结束后，以 SQLite backup 保存状态，再部署并重启本机服务。仍使用原机器人和 qwen3.8-flash，全局维持 observe；没有切换待审批应用或继续扩展邮箱权限。后台新增 draft 健康项。开启的静默起草仅限既有测试群及本人明确私聊起草请求，每日上限 3 次；卡片开关保持关闭。设置读回证据为受限的 `.artifacts/interaction-deployment-settings.json`。

代码已接入自然引用的任务控制、邮件预览／确认、草稿操作；正文版本包含作者、来源消息哈希与要求指纹。本人改稿需完成控制权交接，旧 Worker 发布版本与旧邮件许可被拒绝。草稿器是独立、无工具的模型调用，受单并发、30 秒、6000 输入字符和 900 输出 token 限制；不创建 Worker 或自动交付。

`pnpm check` 的 69 个测试文件、1266 项测试、类型检查和构建通过，日志在 `.artifacts/interaction-check.log`。新测试验证原生卡片回调入口的操作者／消息／版本校验与表单改稿、正文不可变与旧稿保护、邮件版本变化、自然引用确认不从正文提取授权、observe 不回复但可入草稿箱、预算、撤权与中断不重放；另覆盖私聊选择持久化、不点回复即可改稿／导出、多候选清除选择、旧引用不升级、派生来源撤权后排队交付作废及进行中草稿取消。模型、飞书与 SMTP 异常仍以模拟接口测试为证据，不把它们当作真实平台通过。

原应用开发者后台实际显示发布审核中，回调列表为空，“添加回调”禁用；没有修改或撤销待审批版本。卡片后端已经实现，真实飞书按钮回调仍待平台解锁与实际点击验收。旧有文字查询与 163 邮件验收不替代这轮验证。

17:40 操作者在指定群发出本人、无 @、独立的虚构 R1–R3 总结需求。实际 decision 仍是 ignore + would_accept，没有 ticketId；无工具起草调用于 7.48 秒后生成 v1。17:41 操作者私聊“草稿箱”，直接收到包含三组和 R1–R3 引用的正文，持久回执 sent，消息 API 读回一致。来源文本与正文 SHA256 均重新计算匹配；ticket 与 outbox 的每条记录和部署前备份完全一致，任务仍为 2，邮件许可仍为原来的 1 份。实际群消息窗口完整返回 1 条用户消息、0 条机器人消息。证据在受限的 `.artifacts/interaction-draft-acceptance.json`、`interaction-draft-readback.json` 和 `interaction-group-window.json`。

首次真实文字改稿未通过：实时 CLI 使用 `reply_to`，旧适配器只读取 `parent_id`；话题回复又可能指向原查询，导致丢失产物关联。已兼容真实字段，同时保存原查询与机器人回执的绑定、绑定实际显示的产物版本，并将私聊助手回复改为主会话普通回复。17:51 部署后，操作者于 17:56 通过实际引用完成改稿与导出，并确认收到 TXT。开发侧从飞书实际下载该 504 字节文件，验证与当次提交正文一致；v1 与首次记录完全一致，v2 为 human，保留原记录及真实改稿消息的来源哈希。ticket/outbox 仍与部署前备份一致，邮件许可仍为 1。证据为受限的 `.artifacts/interaction-edit-acceptance.json`、`interaction-v2-file-readback.json` 和 `interaction-v2-downloaded.txt`。这次提交正文按用户实际输入原样保留，不把其格式描述成另外一份预设三行结果。

操作者反馈每次点击回复太繁琐，进一步新增私聊当前选择：仅依据本人明确查看的对象激活，30 分钟过期，按 owner+chat 持久保存；多候选和新工作清除选择，发送结果未确认时不激活，旧引用仍使用旧版本。已由自动化测试验证无引用的查看／改稿／导出。

18:06 部署后，操作者在私聊主会话独立发送“草稿箱”，再独立发送“导出”，并确认收到 TXT。两次真实入站均无 parent/root 引用，助手请求均 sent，实际飞书文件消息读回为 result.txt；选中与导出的均为 v2，未产生新版本。两次查询没有进入评估或分发 Worker，ticket/outbox 与部署前备份仍一致，邮件许可仍为 1。免点击回复的查看与导出已通过真实验收；无引用改稿仍以自动化测试为证据。证据为受限的 `.artifacts/interaction-focus-acceptance.json`。同步将草稿箱与编辑结果中的提示改为直接发送，无需点击回复。

提示文案调整后，重新通过助手、静默草稿与卡片相关测试及构建，日志为 `.artifacts/interaction-copy-check.log`。另外观察到群内一条带图片的普通讨论评估不可用：当前文字模型无法查看附图；图片需求识别仍待实现，这不属于以上文字流程的验收结果。

## Loom 真实工作空间接入（2026-11-04）

用户提供的源包已解压至 `loom/`、`loom-sandbox/`，原有演示服务和示例项目保留。公开参考链接跳转至登录页，未将该页面当作可读演示；接入依据附件源代码，并在本机实际运行核对。

新增 Loom API 适配现有运行时及只读浏览器类型，界面由同一回环服务在 `/orchestrator/loom/` 提供，不启动 Loom 演示数据库、Router、Worker 或 webhook。任务、草稿、编辑、版本、控制、导出和邮件均调用既有服务；没有复制凭据、切换模型或扩大监听范围。Loom 本人改稿标注渠道，不伪造 Feishu Trigger。

后端 `pnpm check` 的 70 个测试文件、1272 项测试、类型检查与构建通过，日志在 `.artifacts/loom-check.log`。新增 6 项适配测试验证当前所有者、来源撤权后的读取／控制／导出撤销、人工接管与版本 CAS、草稿确认失效及取消、固定邮件许可与重复确认只提交一次。Loom 的类型检查、原有 4 项测试及构建通过；这些模拟外部接口的测试不等同于在本轮再次实发邮件或点击真实飞书卡片。

确认现有 2 个任务均结束后，保存受限 SQLite backup 并重启现有服务。真实 API 读回 2 个历史任务、1 份草稿及 3 份正文产物；静态页面与构建资源均为 HTTP 200。首次查看为仍保存的 2 份历史报告各建立 v1 快照，其版本记录保存时间为本次导入时间，不补造此前历史；原有草稿 v1/v2 保留。浏览器实际打开概览、草稿 v2、来源与版本列表、v1 原稿，旧版确认和编辑按钮禁用。

真实核对结束后，ticket、outbox、原草稿记录、草稿 head 与设置 revision 均和备份一致，邮件许可数量保持 1，没有新建任务、改写本人草稿或发送邮件。无管理请求头、外部 Origin 的 API 请求均返回 403。证据为受限的 `.artifacts/loom-live-acceptance.json`、`.artifacts/before-loom-20261104.sqlite` 与 `.artifacts/loom-workspace.png`。本轮浏览器验收为只读；网页真实改稿、暂停和邮件发送的正常及异常分支以自动化适配测试加既有服务验收为证据，未声称再次进行真实副作用联调。

已知边界继续保留：飞书卡片开关仍关闭，附图识别仍受当前文字模型限制；本机界面不能直接公开为多用户服务。使用及维护步骤见 [LOOM_SETUP.md](LOOM_SETUP.md)。

## Loom 持续委托（2026-11-04）

将用户所述“钉意图”落实为“持续委托”，在真实 Loom 左侧导航及工作概览提供入口。可创建、编辑、启停常驻目标，限定已授权飞书群、本人身份和可选关键词；每条独立选择仅观察／自动执行。它直接复用原生版本化策略，不新建另一套 Mandate、Router 或 Worker 数据库。保存只记录配置回执，具体消息经过范围及模型评估后才生成真实任务。任务依据包含委托规则 ID，可从卡片查看关联任务和交付物。

新增 11 项 `tests/delegations.spec.ts` 集成测试：HTTP 创建及 SQLite 重读、幂等保存、配置与回执一致性、编辑 revision 冲突、实际任务／Worker／报告版本链路、两条委托的独立会话、默认 observe 不扩大其他规则、观察委托、新旧消息边界、本人／群／来源／关键词核验、伪造模型与直接引擎匹配阻断、待决请求停用、暂停后拒绝继续及来源撤销持有任务。设置工具不能变更所有者的常驻授权。测试中的模型判断和飞书等外部接口使用替身；通过它们不等于真实新委托的自主接单质量已验收。

本机保存受限 SQLite backup 后构建、重启，服务 PID 2563428；runtime、feishu、history、assistant、evals 等健康项 ready，卡片仍关闭。`pnpm check` 的 71 个文件、1283 项测试、类型检查及构建通过；`pnpm check:loom` 的类型检查、原有 4 项测试及构建也通过。日志见受限 `.artifacts/delegations-check.log`、`.artifacts/delegations-loom-check.log` 与最终界面构建日志。

浏览器实开持续委托页和表单，验证当前真实授权群可选、目标和关键词可输入、保存按钮随必填条件启用；示例输入随后取消，没有替用户创建或启用长期目标。真实 API 返回新增的 policy revision 和委托列表。核对 2 个历史任务、1 份草稿、3 份产物及全部版本／正文哈希与部署前一致；基础 observe、监听群和核心 outbox 数量不变。未发送测试消息或邮件，未开展新的真实模型自动任务。证据为受限 `.artifacts/before-delegations-20261104.sqlite`、`.artifacts/loom-delegations-acceptance.json`、`.artifacts/loom-delegations-form.png`。

本轮仅支持已授权飞书群的新消息。文档评论、CI、时钟、逐委托执行预算以及完整设备沙箱未实现；常驻委托不增加资料权限，也不免除邮件预览确认。暂停会持有相关未完成的自动任务，历史产物保留；来源撤销后的内容继续由原有读取权限过滤。在途结果不明时遵循原有控制记录，不宣称操作已被撤回。

## 基础规则自动执行与 Loom 模式入口（2026-11-04）

用户明确要求测试自主识别并执行，而不只观察，并指出 Loom 缺少模式入口。先保存受限 SQLite backup，再通过现有版本化 settings API 将 eval.mode 从 observe 切到 auto（eval revision 2）。读回及与备份比对，所有设置只有该字段发生变化：总结、数据汇总、资料查阅三条规则原已启用；所有者名单、指定测试群、模型、超时、并发、工具配置、卡片及邮箱权限均保持原样。切换本身不重放此前已观察的消息。

新增 Loom `PUT /automation` 的窄输入接口，只接受 mode 与 eval revision，内部合并原有评估设置；`PATCH /rules/:id` 只切换已存在基础规则的 enabled，使用 policy revision，不能修改指令、创建新规则或操作持续委托。两者均经过已有本机同源检查与单一所有者部署检查。概览、持续委托和连接设置页提供自主处理入口；完整面板显示规则开关、适用范围和现有 Worker 并发上限。事件页显示当前模式，旧候选标记“当时仅观察 · 未执行”，保持历史决策原样。

`tests/loom.spec.ts` 新增两项集成测试，覆盖模式切换与配置保留、历史观察不重放、新的无 @ 请求经过真实引擎创建 Worker、关闭规则、旧 revision、越权参数和持续委托边界；模型与外部接口使用替身。非单人部署测试同时核验两种写入均被拒绝。`pnpm check` 的 71 个文件、1285 项测试、类型检查及构建通过；`pnpm check:loom` 类型检查、4 项原有测试及构建通过。证据为受限 `.artifacts/automation-check.log`、`.artifacts/automation-tests.log`、`.artifacts/automation-loom-check.log`。

用户此前在原线程 @ 的 benchmark 总结已建立真实任务，属于明确请求，不计为新 auto 模式下的无 @ 自主执行证据。部署模式入口前，通过原有受管任务控制将该任务暂停（r3），确认 paused、在途归零，备份后重启服务 PID 2592603，再恢复同一任务（r4、agent）。没有创建替代任务；部署后任务总数仍为 3，benchmark 任务仍在处理，尚无最终报告。

浏览器实际读回“自主处理：自动执行”及三个启用开关，当前模型和测试群与原配置一致；新的窄接口在真实服务完成同模式幂等读写，保持 eval revision 2。历史产物保留，未由开发助手发送新的群测试消息或邮件。证据为受限 `.artifacts/automation-mode-change.json`、`.artifacts/before-automation-ui-deploy-20261104.sqlite`、`.artifacts/loom-automation-acceptance.json`、`.artifacts/loom-automation-mode.png`。新的无 @ 实际消息执行质量仍待用户发出后验收；开启 auto 不等于所有语句都会开工，仍受规则、目标／来源判断、权限、全局暂停和并发上限约束。切回 observe／off 只影响之后接单，已有任务须在任务页单独暂停。

## 任务进展、慢任务排查与接管说明（2026-11-04）

benchmark 总结的真实接单时间为 10:49:04.706，完成报告为 11:05:04.849，任务墙钟耗时 960143 ms（约 16 分钟）。原生会话累计 57 个模型步骤、59 个工具动作；模型耗时 883907 ms、工具调用耗时 22096 ms、输出 53315 tokens（包含推理与工具指令，会话累计指标还包含 ready 后的收尾）。原生流没有 llm/retry 事件，未发现额度／限流重试。主要耗时在大量串行模型分析与生成；总结文件改写 8 次、计算脚本修改 5 次、原文及产物多次读取。工具调用多数在毫秒至数秒级。期间发生本人接管／交还和开发部署的暂停／服务重启，保留原任务及文件继续，增加了恢复开销，不能将本轮总耗时解释为纯模型推理时间。

新增 `task-progress.ts` 只读投影，通过原生 sessionController.inspect 读取本任务会话并排除继承历史，不激活 Agent。Loom 任务详情每 3 秒显示阶段、动作及任务内文件名、实际耗时、明确报告摘要、重试与控制节点；不输出内部推理、原始命令、工具原文或失败响应正文。查询前后核验当前所有者与来源，日志缺失时给出降级提示。最初仅 24 条最近记录，可展开其余及模型步骤；该任务共投影 128 条记录，默认过滤模型后为 71 条。

接管复用原有持久控制：同步阻止新受管操作和排队交付，异步取消生成并停止作业／子任务，在途与停止确认均完成后才进入 human。新增 UI 展示正在移交、结果待核查及已接管状态，并解释已保存报告的编辑入口与本机目录编辑的边界。修正显式交还／继续原来一律写作 hostRestarted 的记录问题，新轮次正确使用 controlReturned，并使用读取当前文件、要求和人工成果的恢复说明；旧历史保持原样，仅对相邻已有控制记录作明确标注。完成任务交还不会再开工。

办公 Skill 增加有边界的摘要、合并读取、一次提取、必要校验及阶段进展上报指导，避免默认扩展逐题全面复核和反复装饰性改写；没有改变模型和平台权限。此处是执行指导改进，不是时间硬预算或已验证的加速结果，后续真实对照仍待测量。

`pnpm check` 的 72 个文件、1293 项测试、类型检查和构建通过；新增 8 项进展集成测试覆盖真实引擎上的只读查询、原始推理／命令过滤、失败与重试、阶段报告、在途移交、正确交还原因、父会话排除、缓存撤权和异步撤权。`pnpm check:loom` 的类型检查、4 项原测试及构建通过；最后的详情布局与毫秒显示调整也重新类型检查和构建。证据为受限 `.artifacts/progress-check.log`、`.artifacts/progress-tests.log`、`.artifacts/progress-loom-check.log`、`.artifacts/progress-loom-final-build.log`。

确认 3 个任务均已完成后备份 SQLite 并重启服务 PID 2613201。真实进展 API 与原生会话计数逐项一致，无不可读降级；浏览器实际打开 benchmark 详情，核对总用时、模型／工具耗时、动作记录和模型步骤开关。部署和读取前后 ticket、outbox 每条记录及原报告版本／哈希均一致，基础模式仍为 auto；没有重跑任务、改写报告或发送新消息／邮件。证据为受限 `.artifacts/before-progress-ui-20261104.sqlite`、`.artifacts/benchmark-event-index.json`、`.artifacts/benchmark-latency-analysis.json`、`.artifacts/loom-progress-acceptance.json`、`.artifacts/loom-task-progress.png`。真实进行中／未知外部结果的界面分支以自动化状态测试为证据，本轮没有人为制造外部写入故障。

最后一次状态查询中 runtime、模型、飞书及进展接口正常；独立 evals 健康项记录两条未解决的图片评估不可用（当前图片读取能力限制，已有问题）。未将该项改写为成功或通过重放／删除记录隐藏；不影响本轮文字进展的只读验收。控制时间线的请求状态显示“操作已记录”，控制权是否真正移交仍以当前 taking_over／human 及在途状态为准。


## 报告文件交付与可选邮箱常驻授权（2026-11-04）

按用户要求，将完成摘要与报告投递分开：新增 ResultDelivery、类型化 KV 设置／回执与 result effect，默认向飞书交付固定报告，可选仅本地，或核对当前绑定本人邮箱后明确保存常驻发信授权。设置为所有者全局默认，任务可覆盖；CAS 防并发覆盖，不向模型开放修改入口。保存设置不补发历史任务；已完成定稿可在详情显式投递。对同一报告版本／目的地保留去重回执，未知结果不自动重发。草稿箱不参与自动发布。

Worker 的 ready 工具可用 artifact_file 明确登记自身目录的 .md／.txt 完整报告。后端拒绝越界、绝对路径、符号／硬链接、隐藏路径、非法 UTF-8 与过大正文，将内容及文件名写入不可变版本，之后从快照投递而不再读磁盘。未登记时保存 summary；旧已完成且未经人工修改的报告可显式登记已有文件为新版本，保留旧摘要，不重跑、不自动发出。163 MIME 增加同一固定正文的文本附件，严格校验文件名／哈希，不读取任意附件路径。任意 XLSX、PDF、DOCX 与完整文件索引仍待实现。

飞书默认原会话；登记来源跨会话或包含私聊补充时改发本人私聊。该保护依据已登记的源消息链，不能替代完整正文级信息流检查或 OS 沙箱。后台暂停不派发，任务暂停／接管使旧排队动作作废；来源、需求、版本和交付授权在外部写入前重查。邮箱保存绑定服务、本人地址与账号版本指纹，各异步边界复核，换绑／撤销后旧授权失效。已开始的请求不宣称撤回，SMTP 已接收与最终送达分开。

`pnpm check`：73 个文件、1308 项测试、类型检查与构建通过；`pnpm check:loom`：类型检查、4 项原有测试与构建通过。新增 `tests/result-delivery.spec.ts` 14 项集成验收覆盖真实任务 ready 到文件、字节固定、默认／覆盖与 revision、只本地、撤权／接管／改稿、跨会话保护、丢失响应及恢复、邮箱授权／撤销、SMTP 已提交后状态查询失败和旧报告登记；外部飞书／SMTP 使用替身。SMTP Python 测试新增固定附件的 MIME、路径及哈希验证。日志：`.artifacts/result-delivery-check.log`、`.artifacts/result-delivery-loom-check.log`。

部署时发现 benchmark 任务正处理新的飞书追问，未把旧版当作最新定稿补发。使用现有控制从 r6 暂停到 r7，确认 paused、在途归零，保存受限 SQLite backup，再重启服务 PID 2637683，按相同控制 revision 恢复原任务至 r8／agent；不创建替代任务。部署后 3 个任务 ID、原 artifact heads／哈希和原 outbox 记录保留，模型仍为 dashscope/qwen3.8-flash，基础模式 auto，默认交付为 feishu，未启用邮箱常驻授权。

浏览器实际打开交付物页核对三个单选项、默认飞书及邮件授权门槛：选择邮箱后，“授权并保存”在未核对绑定地址前禁用；随后取消选择，保持原设置。截图 `.artifacts/loom-result-delivery.png`；受限验收记录 `.artifacts/loom-result-delivery-acceptance.json`。本轮开发操作者未发送历史报告或邮件；新增自动附件／自动邮件的真实收取仍待新定稿联调，不以替身测试冒充实收。既有手动飞书 TXT 和单次 163 邮件此前实收证据保持有效，但不替代本链路验收。runtime、feishu、history、assistant、result ready；evals 仍有此前图片评估不可用，卡片关闭，不影响本轮文字及文件交付设置的核对。


## Loom 读取 11 月 4 日 Codex 对话历史（2026-11-04）

按用户明确要求，在 Loom 增加 Codex 历史只读页，验证本机当天的用户／助手对话，而非让模型用 codex exec 总结历史。先查 OpenAI App Server 官方文档，再按本机 codex-cli 0.157.0 生成 schema 核对参数；以短暂 stdio App Server 调用 initialize、thread/list、thread/read（includeTurns=false）、thread/items/list，未调用 start／resume／turn 或加载任务执行。共享 daemon 控制 socket 当时不存在，因此不重启／启用桌面 daemon，独立的只读进程读完即退出。

通过真实本机协议读取，48 个未归档本地交互会话中，6 个在上海 11 月 4 日更新。按所有者和日期授权后的读取，在 5 个会话里得到当天正文，1 个更新会话没有当天用户／助手正文；列表因此标为“相关会话”，不将更新时间等同于消息数。长会话可继续原生分页；无时间的消息不猜测日期。只返回文本对话和原生时间，内部推理、工具日志、非文本附件在本机过滤，自动环境／页面上下文不作为用户正文显示。对话不写入 Superagent 任务、草稿、Artifact、搜索索引或发送队列，不自动注入执行上下文。

新增 tests/codex-history.spec.ts 的 7 项 HTTP／真实 Runtime 集成测试：本人／日期 opt-in、持久授权与 CAS、无效日期和越权参数、当天边界、旧会话／归档／子 Agent、工具／推理／附件过滤、分页、原生时间缺失、异步撤权、读取中所有者变化、长消息和重复游标上限。tests/codex-rpc.spec.ts 的 3 项 transport 测试覆盖 stdio 初始化、执行方法拒绝、工具／审批请求拒绝、诊断及错误原文抑制、超时、取消与缓冲上限。测试的协议响应使用替身，真实协议另行验证。

`pnpm check` 的 75 个文件、1318 项测试、类型检查与构建通过；`pnpm check:loom` 类型检查、4 项原有测试及构建通过。最终列表说明与过滤措辞调整后重新执行前端类型检查和构建。日志：.artifacts/codex-history-check.log、.artifacts/codex-history-loom-check.log、.artifacts/codex-history-loom-final-build.log。

确认 3 个 Superagent 任务均已完成、控制为 agent 且在途归零后，备份 SQLite 并重启本机服务。按本次用户授权，通过本机接口将本人 Codex 历史读取绑定为 2026-11-04、Asia/Shanghai、revision 1；没有修改模型、基础 auto、飞书监听范围或邮件授权。真实 HTTP 读取选中原生标题“loom”的当前会话，第一页面包含用户本次“打通和 codex”的原话，全部返回正文时间均在上海日界线内，且可继续翻页。

核对部署前每条 ticket／trigger／outbox／decision 的哈希保留，任务与交付队列没有新增，Artifact heads 未变。验收期间飞书监听仍运行，独立收到 10 条飞书人类消息并产生 3 条 Decision，因此不宣称整个运行数据库零变化；新增 Trigger 的来源均为 feishu，没有 Codex 任务／事件输入。证据：受限 .artifacts/before-codex-history-20261104.sqlite、.artifacts/codex-history-live-probe.json 和 .artifacts/loom-codex-history-acceptance.json；这些 JSON 只存计数、状态、时间／内容哈希，不保存完整对话。

浏览器实际打开 Codex 历史页，核对 2026-11-04、读取授权、6 个相关会话及原生标题“loom”的用户／助手正文和时间。真实接口连续两页各返回 15 条消息，消息 ID 无重叠。页面截图为 .artifacts/loom-codex-history.png；该截图包含本机对话显示，仅作为本次本地验收材料。

本轮范围是当前 OS 用户本机已保存的历史。读取授权可从页面撤销；Codex 双向发消息、执行委派、跨设备读取、多用户共享与 A2A 尚未实现，不能由只读页推导出这些能力。本机 HTTP 管理权限也不等于 OS 级隔离。


## Linux 桌面端首版（2026-11-04）

用户确认优先支持当前 Linux，新增独立 Electron 45.2.2 桌面程序，使用现有个人服务，不另建数据库、Bot 监听器或 Worker。首次自动检测当前项目与依赖并连接已有配置；缺依赖、手动停止、配置未完成和运行异常分别提示。具有原生窗口、托盘、连接状态页、受限系统导出、单实例和可选桌面提醒。关闭窗口只隐藏，退出客户端不停止后台；明确停止助手需原生确认，调用现有安全停止且不强杀，后续启动尊重手动停止标记。

主界面本机连接页的 IPC 与无特权工作空间分离，采用 WebContentsView，工作空间没有 preload、Node 或主界面桥接。实际启用 Chromium 沙箱、上下文隔离与 Web 安全，保留原有防嵌入头与回环同源校验；拒绝任意导航、弹窗、远程资源和权限申请。安装包无个人任务库、飞书／邮箱／模型密钥；仅含 Electron、桌面代码与本机项目默认路径。软件渲染用于当前 Linux 驱动兼容，不通过关闭沙箱解决显示问题。

8 项桌面 Node 测试通过，覆盖已有服务复用、并发启动合并、尊重手动停止、明确停止、缺依赖、重复进程／项目归属、错误脱敏、回环 URL／资源／IPC 来源和新状态通知。全量 `pnpm check` 的 75 个文件、1318 项测试、类型检查和构建通过；桌面代码单独采用 Node 测试和真实 Electron 验收。日志：`.artifacts/desktop-tests.log`、`.artifacts/desktop-root-check.log`。

分别对开发程序、tar.gz 对应程序及安装后的实际二进制启动验收：真实工作空间加载、当前 qwen3.8-flash、3 个既有任务与 4 份产物、受限工作空间（process／require／loomDesktop 均 undefined）、原生连接页、任务导航、第二次启动复用窗口、关闭隐藏后后台仍连接、重开保留当前页面均通过。沙箱 true、contextIsolation true、nodeIntegration false，提醒默认关闭。证据：`.artifacts/desktop-smoke/acceptance.json`、`.artifacts/desktop-packaged/acceptance.json`、`.artifacts/desktop-installed/acceptance.json` 及对应截图。自检不创建业务任务或发送飞书／邮件，不停止或重启当前后台。连接页如实呈现既有需求评估组件告警，不将它误记为桌面启动失败或隐藏为正常。

已生成 `desktop/dist/Loom-0.1.0-linux-x64.tar.gz`（约 118.3 MiB）并安装到当前用户 `~/.local/share/luxi-loom-desktop`；系统应用菜单添加 Loom，XDG 桌面为 `~/桌面/Loom.desktop`，Desktop Entry 校验通过。安装与启动不需要 sudo，不注册开机自启或开放远程端口。构建／安装日志为 `.artifacts/desktop-build.log`、`.artifacts/desktop-local-install.log`，运行输出为 `.artifacts/desktop-installed-run.log`。

### 0.1.1 窗口无法显示修复（2026-11-04）

用户报告仅有托盘、点击“打开 Loom”无反应。实际复现：旧程序的 `isVisible()` 为 true、工作空间已加载，但原生窗口 handle 为 `0x1`，X11 中不存在该窗口。主进程中追加 `ozone-platform=x11` 太晚；在可用 XWayland 的当前 Wayland 桌面中，进程启动时传入该参数后才产生真实可见的 X11 窗口。上节 0.1.0 的截图与内部可见状态不足以证明系统窗口已显示，显示与恢复验收以本节为准。

`desktop/main.cjs` 为直接打开二进制的情况增加创建窗口前的带参重启；开发和安装启动器在进程启动时传参，安装条目的 WMClass 对齐真实 `loom` 窗口。托盘菜单仅在状态变化时重建，主动打开时恢复最小化并提升窗口。没有关闭沙箱、改变业务授权或重启后台助手。

8 项桌面测试通过；增强 `desktop/smoke.cjs`，使用本应用原生 ID，通过 `xwininfo` 和 `xprop` 核验进程归属及 `Map State: IsViewable`。开发入口、无显示参数的包内二进制（验证自动补参）、安装后启动器三条实际运行链路均通过：工作空间加载、托盘菜单回调重开、隐藏后第二次启动、最小化后第二次启动及原页面保持。证据：`.artifacts/desktop-native-dev/acceptance.json`、`desktop-native-package/acceptance.json`、`desktop-native-installed/acceptance.json` 及对应截图／日志；当前工作空间为 4 个既有任务、4 份产物，沙箱 true、contextIsolation true、Node false。没有新建任务或发送消息／邮件；检查期间后台 PID 保持 `2769436`。

已重新打包并安装 `desktop/dist/Loom-0.1.1-linux-x64.tar.gz`，SHA256 为 `a8e2c24dc87b055c77c37597dff89a1f7b4eb4c9985472cc09a253d3d2bb193b`。最终通过系统 Desktop Entry 正常打开客户端，不保留调试端口。当前仅验证本机 X11／XWayland，纯 Wayland 仍待适配。

### 0.2.0 独立首次配置向导（2026-11-04）

按用户明确选择补齐“环境、模型、飞书、消息范围、检查并启动”的真实配置流程。`desktop/onboarding.cjs` 使用新的 UUID、专用 Harness home/profile、独立 state 和 CLI file SecretRef；本机输入凭据、实际请求连接校验，最后由用户确认才启动。新配置仅一名所有者、未选群关闭、observe 默认；auto 须由用户选择。原机器人已有监听或监听归属不明时阻止启动，不自动停止原任务。模型凭据采用 Harness 的私有文件格式，文件 0600、目录 0700；不写入元数据、命令参数或正文，不声称钥匙串加密。工作空间继续无原生桥接。

`src/personal-setup.ts` 保存真实版本化办公配置，拒绝覆盖旧库且相同初始化可重试；服务脚本向 tmux 显式传入独立 `DSH_HOME`／`DSH_AGENTS_HOME`。13 项桌面测试及 19 项相关后端测试通过，类型检查通过。覆盖零配置不导入／不连接旧环境、凭据校验契约、密钥不进入 argv／视图、文件权限、范围扩张拒绝、未确认不启动、已有／未知监听冲突拒绝、独立配置启动和设置幂等。日志：`.artifacts/desktop-onboarding-desktop-tests.log`、`desktop-onboarding-state-tests.log`、`desktop-onboarding-typecheck.log`。

独立真实 Harness 验收两次创建新 profile、初始化真实 SQLite 设置、启动并从原生 Loom API 读回 `loom/fixture-model`、0 任务／0 产物，随后仅停止这些唯一测试 profile。第二轮亦检查消息消费者 ready。记录：`.artifacts/desktop-real-setup-B5KUzB/acceptance.json` 和 `desktop-onboarding-real-runtime.log`；首次环境单独准备证据：`desktop-setup-engine-check/acceptance.json`。模型 HTTP 与飞书外部身份／事件使用明确的本机替身；这些证明引擎与配置闭环，不当作新应用真实权限或实际付费模型验收。

原生桌面五步验收检查真实 X11 可见窗口、最初全部凭据与本人字段为空、旧工作空间未加载、真实独立环境准备、UI 校验和页面推进、密码输入清理、群名称作为文本、最终授权确认以及工作空间无 preload。开发程序和最终 tar.gz 对应程序均通过；云端验证用替身，测试不启动飞书监听或业务任务。证据：`.artifacts/desktop-first-run-ui-v2/acceptance.json`、`desktop-first-run-package/acceptance.json` 及各步截图。首次配置无需等待工作空间网络加载，主进程在本机页面加载后明确显示窗口。

安装后对原运行时重新做完整桌面回归：实际加载、沙箱、无特权工作空间、托盘恢复、隐藏／最小化后再次启动均通过。原模型仍为 `dashscope/deepseek-v4.1-flash-1017`，原 4 个任务与 5 份产物仍可见；证据为 `.artifacts/desktop-onboarding-existing-runtime/acceptance.json`。本次仅更新和重开桌面程序，没有重启原后台；验收期间原后台 PID 为 `2802394`。

生成并安装 `desktop/dist/Loom-0.2.0-linux-x64.tar.gz`；新增“Loom · 独立助手”入口，使用独立桌面偏好，并以 Electron `setDesktopName` 匹配 `luxi-loom-setup` 窗口类别，避免与原客户端混淆。包哈希及最终实际窗口记录见 `.artifacts/desktop-first-run-final.json`。最终打开原客户端和空白首次配置窗口，未代填真实凭据，等待本人在本机体验。新机器依赖一键安装、飞书扫码建应用与真实新应用授权闭环仍未验收。

用户随后已在实际首次配置窗口自行完成环境、真实模型连接和机器人身份校验，当前停在消息范围步骤，尚未保存范围或启动新监听。没有读取或打印输入的凭据。最终修订确认 Electron 二进制相同后，仅以原子替换更新桌面代码资源，保留正在操作的窗口、输入及进度；新的窗口类别在下次启动生效，未为此重启用户配置窗口。最终包与已安装代码一致，哈希为 `68bd555d5d3024a28b8cc8a25d63d67e93e68da4f725b4920902468b93e76855`。最终包五步表单验收见 `.artifacts/desktop-first-run-final-package/acceptance.json`，原后台仍为 `2802394`、runtime／feishu 均 ready；原应用的权限范围、新配置真实长连接及新消息任务闭环仍须由后续操作分别验收。

这是已有 Linux x64 个人助手的本机接入版，不是全新设备免配置安装器。Harness、CLI 和个人 profile 尚未随包部署；自动依赖安装、飞书扫码接入、模型配置向导、开机自启、签名更新、其他系统和手机均待后续。使用与边界见 [DESKTOP.md](DESKTOP.md)。

## 持续委托中的 Codex 会话日报（2026-11-04）

按用户要求扩展同一持续委托表单，增加 Codex 会话日报类型、今天的元数据选择器、项目／固定会话范围、北京时间每日时刻、持续读取用于汇总的用途确认、交付选择与立即运行。未替用户创建、启用或运行任何真实委托；浏览器只填写预览、读取元数据、选择本项目，未勾选用途授权／未保存，随后取消，委托数和日报运行数均为 0。

复用 CodexHistory 的只读协议和原生日期过滤。日报使用独立于单日查看的常驻授权，读取时逐 RPC 复核；固定来源快照交给普通 Harness Ticket／Worker，按现有控制及产物版本／交付处理。Worker 仅保留受控来源读取、产物读取和报告工具；不提供命令、项目文件、联网检索、通信或子 Agent，也跳过全局 executor.prepare。后端校验项目／会话、当前所有者、规则及持久运行回执；手动与时钟使用同一每日幂等键，定时仅为当天建立请求，读取失败只允许显式有限重试。

新增 tests/codex-daily.spec.ts 的 10 项真实 Runtime／HTTP／Engine／Harness 适配测试，覆盖创建与 SQLite 重读、明确用途授权、无效／越界范围、真实任务和不可变 Markdown 报告、受限工具、默认本地交付、手动／时钟去重、上海时刻与新授权错过时刻、观察／空数据、有限重试与错误脱敏、异步撤销、任务暂停和恢复门槛、改范围后的派生物及主会话读取撤权、伪造事件和普通规则绕过阻断、全局飞书模式独立、本人变更及私聊投递撤销。外部历史、模型与飞书使用替身；测试通过不等同于真实模型生成日报或实际收件。扩展 tests/codex-history.spec.ts 的 2 项测试验证独立日报读取、精确项目而非子目录、全文分页和来源编号、边界与数据过滤、读取前项目变化及 RPC 中授权撤销。

`pnpm check` 的 76 个测试文件、1330 项测试、类型检查与构建通过；`pnpm check:loom` 的类型检查、4 项原有测试和构建通过。日志为 .artifacts/codex-daily-check.log 与 .artifacts/codex-daily-loom-check.log。

真实 Codex 只读探针在独立的内存授权检查下，以当前 superagent 项目、11 月 4 日为范围，读得 2 个会话、159 条当天文字，全部原生时间符合上海自然日且带引用编号；记录附件未读取的限制。探针未创建委托／任务、未调用汇总模型，完整源文本只驻留进程内存；证据 .artifacts/codex-daily-native-probe.json 仅保留计数、限制、布尔核对项及哈希。真实 Loom 元数据接口返回 7 个相关会话、4 个项目，未返回消息正文或 preview。

部署前确认既有 3 个任务均已完成、控制 agent、在途为 0，保存受限 .artifacts/before-codex-daily-20261104.sqlite 后重启。实际浏览器核对 Codex 类型、真实项目列表、每天 18:00 表单默认、仅本地交付默认、未确认用途时保存禁用。截图 .artifacts/loom-codex-daily-form.png。部署和元数据／页面核对前后，原 ticket／trigger／outbox／decision 各行哈希、Artifact heads 全部保留，无新任务、发送队列、委托或日报运行；模型仍 dashscope/qwen3.8-flash，基础模式 auto。证据 .artifacts/loom-codex-daily-acceptance.json。

真实自动／立即生成的模型质量、日报引用准确性及飞书／邮箱实际投递，待用户自行创建委托后验收。本机需要保持运行；没有设备唤醒、跨设备／云端调度、通用 Cron、Codex 执行委派或 A2A。原生回调卡片仍关闭，本轮不涉及飞书权限及邮箱凭据变更。

## 事件接单、概览刷新与任务入口（2026-11-04）

用户反馈“已接受”后没有动静、概览的进行中迟迟未更新。只读追踪原消息 f2f9f42cbe439bf7c549d0edaab838b4 和任务 32aed838a944d70553eac7f13c39a528：消息 15:22:12.897，Decision 15:23:11.870，Worker 15:23:12.469（Asia/Shanghai），消息到接受 58.973 秒，接受到启动 0.599 秒。首次检查任务已有实际模型步骤和网页读取；因此不将这轮任务误报为没启动，也不将接单前约一分钟归因于前端网络。随后实际概览读到进行中 1，未复现当时的旧画面；代码确有隐藏标签停轮询、切页无强制刷新，以及慢请求被之后的 refreshId 持续作废的风险，由自动化覆盖和修复，不声称已在真实浏览器复现每种原因。

新增 startLiveSync：同一时刻一个有 10 秒超时的请求，每 3 秒轮询，焦点／路由／可见性变化即时尝试同步；嵌入标签报告 hidden 不再无限停更，停止时取消请求并拒绝旧响应。概览与进展复用该机制；页面显示最后同步时间，连接故障保留旧数据并明确标记，恢复后仅清除同步故障提示。事件 snapshot 的 taskIds 仅从当下获授权的任务推导，原 Decision 保留；显示排队／评估及关联任务当前控制／执行状态，按钮直接打开既有实时进展和交付物，不唤醒模型或另建任务。

另查原生工具记录，web_search 返回 WEB_PROVIDER_CREDENTIAL_MISSING；模型凭据可用不代表搜索服务已有独立凭据。Worker 已转用公开网页和 API 继续收集资料。进展仅对该已知错误码显示固定中文原因，继续屏蔽错误原文和凭据字段；本轮没有读取、配置或更换搜索凭据，也没有宣称已优化模型评估或这轮研究的总耗时。

新增 tests/loom-live-sync.spec.ts 的 3 项测试验证慢请求跨多个轮询周期仍生效、单请求不重叠、隐藏嵌入页及切页／可见性更新、超时取消、重试和卸载后回调抑制；tests/loom.spec.ts 增加 2 项真实 Runtime 适配验证事件与任务同一快照、完成后历史决定不变，以及来源撤销后关联 ID 不泄漏；tests/task-progress.spec.ts 增加错误原因固定措辞与原文脱敏验证。pnpm check 的 77 个文件、1336 项测试、类型检查和构建通过；pnpm check:loom 的类型检查、4 项原测试与构建通过。日志 .artifacts/event-progress-check.log、.artifacts/event-progress-loom-check.log；最后同步提示恢复调整后再次前端类型检查及构建，见 .artifacts/event-progress-loom-final-build.log。

前端构建后实际概览读到进行中 1 及本任务，保存截图。后端关联入口部署时任务仍在执行，通过现有控制在无在途租约时从 r0 暂停至 r1，确认 paused／在途归零并保存受限 SQLite backup，然后重启服务，按同一控制 revision 恢复原任务至 r2／agent。未创建替代任务或新委托；任务的原 Decision、原始消息和其他历史记录保留。部署会增加这轮任务的暂停／恢复开销，不能将本次墙钟耗时当作未受干预的性能测量。

浏览器实开事件页，核对原消息下显示同一标题、执行中和“查看实时进展”；点击后正确打开原任务、真实步骤与控制历史。返回概览读到进行中 1、任务列表 4、最后同步时间持续变化。证据 .artifacts/before-event-progress-20261104.sqlite、.artifacts/event-progress-deploy.json、.artifacts/loom-event-progress-acceptance.json、.artifacts/loom-live-overview.png。模型仍 dashscope/qwen3.8-flash、基础模式 auto、既有日报委托与监听／邮箱授权保持原样。本轮验证的是状态可见性；研究任务当时仍进行中，最终报告与自动交付质量另行验收。

## 切换 deepseek-v4.1-flash-1017（2026-11-04）

按用户明确要求更换模型。现有兼容接口的原生 `/models` 列表包含精确 ID `deepseek-v4.1-flash-1017`，因此沿用 `dashscope` 路由、端点和本机 `DASHSCOPE_API_KEY` 凭据引用，未复制密钥或增加提供商。独立临时目录的 Harness headless 会话先完成一次 `bash`／`printf` 工具调用、成功读取结果并回复 `MODEL_SWITCH_OK`；原生持久记录的 `request/header.header.config` 核实使用目标模型。测试只使用固定合成文本，没有读取业务材料或向飞书／邮箱交付。

确认现有四个任务均已结束后备份 SQLite 及 profile，停止服务、补入模型目录并更换默认模型后启动。通过版本化管理接口将 `eval.model` 从 revision 2 更新至 3、`executor.model` 从 revision 1 更新至 2；静默草稿与 Codex 日报沿用执行模型。已有会话不会自动跟随新默认，另外通过原生 `session/selectModel` 更新一个编排会话及四个 Worker 的后续选择，再读取各自持久 `model/selection` 核实，未恢复执行或重跑任务。

部署后 Models 与 Loom 均返回 `dashscope/deepseek-v4.1-flash-1017`；runtime、models 和飞书监听 ready。核对原有 4 条 Ticket、129 条 Trigger、74 条 Decision、12 条 Outbox 与备份逐行一致；规则、来源、交付设置、自动处理模式和既有日报委托保持原值。模型切换不补配单独的搜索服务凭据，也不以这次合成探针宣称真实办公任务质量或延迟已改善。

证据：受限 `.artifacts/before-deepseek-model-20261104.sqlite`、`.artifacts/before-deepseek-model-profile.yml`、`.artifacts/deepseek-model-probe.patch.yml`、`.artifacts/deepseek-model-probe.ndjson`、`.artifacts/deepseek-model-switch-result.json`、`.artifacts/deepseek-model-acceptance.json`。配置示例及当前状态说明同步更新；`tests/personal.spec.ts`、`tests/model-surface.spec.ts` 共 16 项通过，日志 `.artifacts/deepseek-model-docs-check.log`。本轮没有修改运行时代码。

## ngrok 临时访问 Loom（2026-11-04）

用户明确要求将正在运行的 Web 端通过 ngrok 穿透。使用本机已配置的 ngrok 3.39.11 及现有账号，新建专用 `loom-private` HTTPS 隧道；未变更应用代码、服务监听地址、模型或来源授权。入口以随机密码强制 Basic Auth，只转发 Loom 页面／资源及其专用 API；拒绝非隧道同源的 Origin，并在通过校验后移除 Origin／Authorization、重写本机 Host，保留应用自己的专用请求头校验。请求检查器关闭，策略／密码存于忽略目录的私有文件；独立 tmux 会话持续运行，可单独停止撤销。

通过公网 HTTPS 实测：未认证的页面及 API 均返回 401；认证页面和静态资源返回 200；携带正确隧道 Origin 和应用请求头的只读 API 返回真实四个任务及 `dashscope/deepseek-v4.1-flash-1017`；外站 Origin 返回 403，原生 Harness API 与其他管理设置 API 返回 404。后台迁入 tmux 后再次核对公网页面、资源和真实数据成功。本轮未通过公网执行写操作，不将临时口令入口视为正式多用户身份系统或远程执行方案。受限证据 `.artifacts/ngrok-loom/acceptance.json` 不保存密码或任务正文，停用命令见 `LOOM_SETUP.md`。

用户随后明确要求取消账号密码，以便领导查看效果。将同一 HTTPS 地址改为 `loom-view` 免登录只读隧道，删除活动策略的 Basic Auth，增加非 GET／HEAD 方法及 Codex 原始历史／项目会话选项的拒绝规则，保留路径和 Origin 限制。原密码策略仅为不再加载的历史本机文件；本机入口及执行服务不变。

真实公网请求未携带 Authorization 或认证 Cookie：页面、两份 JS／CSS 资源、四任务快照、任务进展和报告正文均返回 200，无 WWW-Authenticate；POST／PUT／PATCH／DELETE 返回 403，Codex 历史及选项返回 403，其他管理 API 与 Harness API 返回 404，外站 Origin 返回 403。写方法探针使用不存在的只读测试路径和空 JSON，不提交实际操作。证据 `.artifacts/ngrok-loom/public-view-acceptance.json` 仅保存 URL、计数和状态码。这个链接展示当前工作空间的真实可读内容，不具有访问者身份隔离；只是用户授权的临时展示，关闭 tmux 会话即可撤销。

## macOS 桌面压缩包 0.3.0（2026-11-04）

按用户要求制作 Mac ZIP。桌面启动扩展至 darwin；Finder 环境补齐固定 Homebrew／用户命令位置，不运行用户 shell 启动文件；Mac 使用 Application Support 保存新助手。加入菜单栏模板图标，独立配置只在 Linux 传入 X11 参数。首次向导新增原生办公引擎选择：要求已构建、持久保存规范路径，准备后冻结选择，保留原来源／账户隔离和明确启动确认。

打包使用 Electron 45.2.2、Packager 20.3.0 和显式客户端输入清单，不复制源码目录的凭据、node_modules、历史或机器默认路径。macOS 原生打包脚本为每个架构生成 `.app`、ICNS、说明、许可证、ZIP 及 SHA256／JSON，执行系统 codesign 本地签名和深度严格校验，读取实际二进制架构与最低系统版本。这里的 ad-hoc 签名不是 Developer ID，也没有 Apple 公证。

实际 [macOS 构建运行 41813346537](https://github.com/wonderful-0803/myloom/actions/runs/41813346537) 在 `macos-15` arm64 和 `macos-15-intel` x64 上均成功。两端各通过 17 项桌面测试、架构核对、严格签名验证和打包后的真实 Electron 进程启动。空白首次配置验证本机原生窗口句柄、表单无凭据、引擎选择入口、工作空间空白及无 Node／preload 的隔离设置，并保存窗口截图。检查未启动 Harness、飞书消费者或办公任务，也没有模型请求。两份产物原生 Info.plist 最低系统均为 13.0。

初轮 Mac CI 发现 setup-node 的自动 pnpm 缓存先于 pnpm 安装，以及测试夹具把 `/var` 与 `/private/var` 当作不同目录；修正安装顺序及真实路径断言后，以上最终运行全部通过。Linux 本地 17 项桌面测试、23 项架构文档／服务脚本测试与 Linux 打包通过；对打包后的 0.3.0 运行独立偏好目录的实际窗口自检，验证任务导航、工作空间无原生权限、单实例、最小化／隐藏重开、托盘回调及后台继续在线，未重启既有服务。日志及本机证据为 `.artifacts/macos-desktop-tests-final.log`、`.artifacts/macos-docs-service-tests.log`、`.artifacts/macos-linux-regression-smoke/acceptance.json`；Mac 原生截图和报告随对应 CI artifact 保存。

Mac 完整账户配置、真实模型工具调用、飞书收发及长期后台运行尚未在用户的目标 Mac 联调，不能由空白原生启动推定完成。完整办公引擎及 Harness／CLI 依赖不包含在客户端 ZIP 中，仍须先准备；不自动导入开发者或其他设备的账号与任务，也未实现设备迁移、云端执行、自动升级和 Developer ID／公证发行。

## 首次配置返回修改修复 0.4.1（2026-11-05）

用户在最后一步失败后发现“返回修改”被禁用。原实现把数据库初始化后的 `frozen` 同时当作永久导航锁，导致启动失败也无法回到前面的表单。0.4.1 增加明确的编辑状态：返回时先确认当前本机实例停止，再解锁模型、机器人与消息范围；保存编辑状态后重开仍可继续。同一个未产生任务的首次配置数据库可追加设置版本，已有任务或非本向导数据库不会被覆盖。界面更换机器人时清除原机器人所选群与本人，避免旧范围混入新配置。

同时修复模型凭据兼容性：Harness 会把 `.credentials.yaml` 写成带 records 的 YAML，原 JSON-only 读取会得到空 Key 并导致 401。客户端使用固定 `yaml@2.9.1` 解析，缺失／格式错误在本地失败，更新模型 Key 保留其他引用与 Harness 记录。打包只添加该已固定的纯代码依赖，不复制开发机的其他 node_modules 或凭据。

本机通过 27 项桌面测试、4 项首次配置持久化测试、类型检查和构建。已对打包后的 0.4.1 运行真实 Electron 回归：最后一步依次返回到消息范围、飞书和模型页，所有模型字段可编辑，编辑状态保存且实例 ID 不变，记录为 `.artifacts/windows-edit-acceptance.json`。隔离真实 Harness 回归通过首次启动失败、停止当前实例、修改消息范围、再次启动、连接工作空间和最终停止；记录为 `.artifacts/windows-edit-runtime.json`，其中 `failedStartEditRetried` 与 `actualHarnessStopped` 为 true。外部模型／飞书接口仍用替身，未发送业务消息。

用户确认已有另一个飞书实例，要求暂不处理占用；本次保留该实例，仅更新本机客户端。新的 Windows 包为 `desktop/dist/Loom-0.4.1-windows-x64.zip`，可执行程序位于 `desktop/dist/windows-0.4.1/Loom-win32-x64/Loom.exe`。

## Windows 原生客户端 0.4.0（2026-11-05）

用户要求拉取仓库并运行 Windows 客户端，明确不复用 WSL。工作目录同步到 `d7c7fcc` 后，在原 Electron 45.2.2 客户端上实现原生 win32/x64 适配。新增 Windows 图标、可移植 exe／ZIP、原生命令解析、LocalAppData 独立实例、当前用户目录 ACL，以及脱离窗口存活的 Node 后台控制器。命名管道以随机能力令牌验证项目、profile、回环地址和 PID，拒绝重复或不明归属，安全停止等待实际进程退出；桌面退出不顺带结束后台，手动停止阻止自动重启。Windows 无需 tmux、Python 控制脚本或 Linux 环境。

本机验证：

- `pnpm typecheck`、`pnpm build:loom` 和 `pnpm build` 通过；使用原生 Node 24.19.0、Harness 0.2.1-rc.3、飞书 CLI 1.0.90。
- 22 项桌面测试通过，包括 Unicode／空格／引号参数、独立配置、单一进程、错误令牌拒绝、后台进程复用、安全停止、手动停止、未知端口及 PID 归属拒绝。没有依赖 WSL 或管理员目录符号链接权限。
- `tests/windows-process.spec.ts` 和 `tests/personal-setup.spec.ts` 共 8 项通过，真实执行原生 CLI、机器人校验替身与 PowerShell；回归 `tests/runtime.spec.ts` 的路由器等待限制和工具许可 2 项通过。
- 打包后实际运行 `Loom.exe`，从 Windows `Get-Process` 核实 HWND 和窗口标题，同时检查 Electron 原生句柄。首次配置的密钥／身份字段为空，引擎选择可用，窗口可隐藏恢复；工作空间仍无 preload／Node，启用 sandbox、contextIsolation 和 webSecurity。带本仓库引擎路径的检查中，Node、Git、Harness 和飞书 CLI 均识别成功。证据在 `.artifacts/windows-native-packaged-engine/windows-launch.json` 与 `windows-first-run.png`。
- `desktop/test/integration-runtime.cjs` 在 Windows 实际创建独立 Harness profile、加载本地 bundle、初始化真实办公设置，启动真实 Harness 并从 Loom API 读回空任务库及机器人信息，等待模拟消费者 ready，再安全停止并确认没有存活 PID。验收 JSON 汇总为 `.artifacts/windows-native-integration.json`；模型与飞书 HTTP／CLI 为隔离替身，不代表真实账户、付费模型或业务任务验收。

真实原生启动发现并修复了路由器写死 `bash` 的许可列表；Windows 只注册 `pwsh` 时不再启动失败，办公模式禁止 shell 与等待限制同时覆盖两者。扩展回归还发现 CRLF 命令文件所有权标记读取失败，已修复并以重复生成、拒绝外来文件的原生用例覆盖。部分原有测试夹具仍直接依赖 Unix `env`／`sh`、无扩展名脚本、POSIX PATH 及符号链接权限，本机扩展回归未全部通过，不将这些测试记为 Windows 已验收。

`desktop/dist/Loom-0.4.0-windows-x64.zip` 及对应 SHA-256／JSON 是原生 x64 包，显式客户端文件清单排除凭据、开发机默认路径、任务历史和引擎依赖。ZIP 尚无发布者代码签名；尚未验证 Windows ARM64、真实飞书收发、实际模型工具调用、长期任务恢复、跨设备迁移或新机器一键安装。首次运行需要本机引擎和依赖，并由用户在向导输入自己的账户。

## 跨设备同步：Linux 本机复核与双机准备（2026-11-06）

在 `8746af6` 基线上阅读 `src/sync/`、Runtime 路由、跨设备页面及现有用例。用户附的 `DEVICE_SYNC.md` 与仓库文档的初始 SHA-256 一致，用户明确第二台也是 Linux，并选择先准备本地服务及双机验收步骤。

发现并修复空扫描误报：此前未找到任何项目会话时，也写入 `lastSuccess`。现在只有取得实际批次回执才更新服务端确认时间；页面单独显示最近检查及本轮会话／文字数量，0会话明确提示未上传，已有历史确认仍保留。实现 `src/sync/client.ts`、`loom/src/client/live/DeviceSync.tsx`，回归覆盖首次空扫描和成功后再次空扫描。

新增 `pnpm sync:local`：Linux 固定回环服务，首次生成私有凭据和数据目录，重启保留身份及历史；拒绝符号链接凭据。`pnpm sync:smoke:local` 实际启动子进程，核对 `/proc/net/tcp` 的127.0.0.1监听、0700／0600权限、无认证401、授权创建、重启后旧凭据及项目保留、拒绝外来符号链接。使用独立临时数据，不读取真实历史。

实际检查：Node24.20.0、Codex CLI0.157.0；`pnpm check` 通过（81个测试文件，1355项通过、4项跳过，含类型检查与后端构建），`pnpm check:loom` 通过（7项测试及类型检查、前端构建）。相关后端4文件22项通过；新增全局暂停、部分提交后断线重试、设备撤销关闭采集与AI授权用例。三条编译后命令 `sync:smoke`、`sync:smoke:local`、`sync:smoke:codex` 均通过。最后一项使用空的隔离 `CODEX_HOME`，未读用户会话；两连接器/MCP接续中的讨论数据为合成内容。

按用户选择在本机独立 tmux 会话 `loom-sync-acceptance` 启动同步服务，监听 `127.0.0.1:7421`，状态位于 `~/.local/share/loom-sync-acceptance`；凭据不打印、不提交。无认证请求实际返回401，目录和文件权限核对通过。恢复原配置的 Loom 后，真实管理路由 `GET /orchestrator/api/loom/sync` 返回200且仍为 `connected:false`、空映射，浏览器显示实际跨设备配对表单。没有创建用户同步空间、启用项目采集或上传用户历史。

双机逐项步骤见 [Linux 验收清单](DEVICE_SYNC_LINUX_ACCEPTANCE.md)。本机证据目录 `.artifacts/device-sync-acceptance-20261106/` 保存全仓检查日志及不含凭据的本机服务摘要。第二台真实 Linux、实际非空 Codex 项目、SSH／公司HTTPS链路、真实AI召回仍待用户按清单操作；不能将隔离替身或本机空目录读取计为这些场景已通过。服务与来源设备同时关机后无法读取；需要来源整机关机时，服务必须独立保持在线。

## 默认方案调整：飞书同步与高级自建入口（2026-11-06）

用户确认将飞书同步作为默认方案，自建同步放入高级设置并备注“待验证”。`loom/src/client/live/DeviceSync.tsx` 默认显示飞书方案及“待接入”状态，连接按钮禁用；只有显式展开高级设置才挂载现有自建组件。自建入口及展开后的内容均标注待验证，已有后端连接／授权不会因展开、收起或默认入口调整而变更。默认页不调用自建同步 API，不将现有机器人登录视为用户授权。

`pnpm check:loom` 通过：类型检查、8项前端／Loom测试及构建；`tests/docs.spec.ts` 的6项文档检查通过。相关界面用例验证默认飞书状态与禁用按钮、默认无自建请求、展开后配对、独立采集／AI许可、收起不发写操作及空扫描提示。真实浏览器打开当前服务，核对默认飞书卡片、自建高级入口待验证、展开出现原有配对表单、收起后恢复默认布局。截图 `.artifacts/sync-default-feishu-20261106/default.png`，方案和待接入清单同步更新至 `DEVICE_SYNC.md`、`PROJECT.md`、`ROADMAP.md` 及 README。

本轮完成产品默认方案、界面分层和文档调整。飞书账号授权、专用云空间存储适配及真实跨设备飞书同步均未实现或验收，不把入口展示计为这些能力完成。

## 飞书同步实际接入：代码与隔离验收（2026-11-06）

用户要求开始实现上述默认方案。新增 `src/sync/feishu-drive.ts`、`feishu-cloud.ts` 和 `feishu.ts`，复用已有采集、项目／AI 分别授权、版本及只读 MCP；默认页面接入实际用户设备码授权、专用云空间连接、项目与设备管理。云端采用不可变增量文件，上传后下载核对内容和哈希才推进检查点；未确认写入可在重启后核对重试。专用目录按应用与本人定位，拒绝账号／应用不一致和不完整来源链，不引入团队共享或远程执行。

新增 `tests/feishu-sync.spec.ts`、`tests/feishu-drive.spec.ts`，扩展 API 与前端测试。覆盖两个独立连接器往返、来源离线、方案及修改理由、重启、去重、读回不匹配／重试、项目边界、独立 AI 授权、设备撤销、删除及损坏文件拒绝；这些使用合成 Drive 与会话内容，不当作真实飞书传输证据。`pnpm sync:smoke:feishu` 使用编译后连接器及真实 MCP 子进程，验证四个只读工具、双向接续和撤权；原有 `pnpm sync:smoke` 同样通过。

最终 `pnpm check` 通过：83 个测试文件、1367 项通过及 4 项跳过，含类型检查和后端构建；`pnpm check:loom` 的 9 项测试、类型检查和前端构建通过。日志 `.artifacts/feishu-sync-check-20261106.log`。真实部署发现 Harness 的 Worker 命令路径包含机器人专用 CLI；同步改用隔离的宿主用户命令环境，并新增实际子进程回归证明不会误用机器人身份。修复后重跑上述全仓检查并部署。

部署前确认五个既有任务均已结束；重启原本机服务后，真实 `/orchestrator/api/loom/sync/feishu` 返回 200、`connected:false`、空项目映射，正确识别本人账号，报告缺少 `space:document:retrieve`。MCP 配置返回 200 且地址指向独立的 `/sync/feishu`。真实云盘目录探针此前因该缺失权限而拒绝，没有读到其他目录内容。现有公开展示代理携带转发头时，所有同步 API 返回 403，避免将新授权及讨论暴露在原免登录展示入口中。

真实浏览器核对默认页显示“需要补充云空间同步权限”、可用的授权按钮、设备名称与目录用途同意；未同意时连接按钮禁用，自建同步继续折叠并标注“待验证”。截图和不含凭据的状态摘要位于 `.artifacts/feishu-sync-acceptance-20261106/`。未创建用户同步连接、未授权项目、未读取或上传真实用户会话。接下来需本人扫码补授权，再分别验证真实飞书的合成数据读写和两台物理 Linux 的非空测试项目；来源整机离线、真实 AI 接续及删除仍不记为验收通过。

## 新 Linux 无法生成飞书同步二维码：配置初始化修复（2026-11-06）

用户报告同事在 Linux 点击登录后得到通用的“飞书操作未完成”提示。没有访问同事机器，不能仅由该文字认定实际网络或凭据状态；在空的隔离 CLI 目录实际复现 `auth status --json` 返回退出码3、`config/not_configured`，原适配器会把它误报为通用连接故障。桌面向导只准备严格机器人配置，而原同步默认依赖另一份用户配置，也是代码中可确认的初始化缺口。

新增 `src/sync/feishu-config.ts`：只有显式登录才核对当前桌面实例标记、已初始化所有者和机器人路径；使用匹配应用现有的文件凭据引用建立私有同步用户配置，不读取／复制 Secret 正文、不导入原用户列表、不修改机器人限制或默认 CLI。已有同步用户登录保留，应用／所有者变化、未知目录、符号链接及明文 Secret 来源均拒绝。手动部署没有桌面实例标记时不猜测配置目录，继续要求匹配的独立用户 CLI。

CLI 适配器分别返回配置缺失、命令不存在、身份限制、用户授权、缺权限及连接失败的固定诊断，不输出原始 stderr／stdout。状态页保留具体失败原因，二维码生成有进行中提示；重新生成失败会清除旧二维码并允许重试。只登录飞书客户端不当作完成 Loom 授权。

最终 `pnpm check` 通过84个文件、1374项通过及4项跳过，包含类型检查和后端构建；`pnpm check:loom` 的10项测试、类型检查及前端构建通过。新增配置用例含真实 Linux CLI 子进程的模拟二维码生成／设备码完成，核对机器人配置未变且没有云端连接／项目采集；该 CLI 是明确的本机替身，不代表真实飞书授权。另用已安装的真实飞书 CLI 和合成应用文件引用确认独立 user 配置可读取、状态为用户尚未登录；未请求 verify、未使用真实凭据或读取云端。

证据目录 `.artifacts/feishu-sync-login-fix-20261106/` 保存最终全仓／前端检查、合成配置探针和页面截图。更新部署前确认五个既有任务均已完成，部署后飞书监听 ready。真实同事机器需拉取更新、重新构建并重启实际办公引擎后复验；未由本次隔离用例推定真实双机或飞书云空间传输已经完成。
