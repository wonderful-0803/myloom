# 任务文档与 Word 交付

2026-11-06 修复：DSH Worker 仍负责理解需求、组织内容和提交结果。Loom 为 Worker 的 `orchestrator_report` 增加受控文档生成入口，并把实际二进制文件纳入版本与交付；没有开放公司服务器的任意 Shell 或文件读取。

## 执行方式

要求 Word 时，Worker 在 `summary` 提交完整 Markdown 正文，并传 `document: { format: "docx", filename: "会议纪要.docx" }`。固定生成器把标题、段落、列表、引用和表格转换为真正的 OOXML。DSH 可以读取已保存的历史版本复用正文，不必重新转写录音；仅改变格式时不应改写结论。

明确要求 Word 的任务拒绝没有 `document` 的 ready 报告，避免再用 TXT 代替 Word。普通文本任务保留原交付流程。工具限制与生成故障使用 Loom 能力说明，不再引导用户去飞书后台开“文件连接器权限”。不支持的格式应说明实际能力缺口。

## 范围与控制

- 输入只有已授权任务正文、格式和安全文件名，不接受脚本、路径、模板文件或任意 URL 输入。Markdown 中的图片不下载，HTML 按文本处理，链接仅作为可读文字，不生成主动远程资源或宏。
- 固定 renderer 在独立 Worker 中运行，清空环境变量，20 秒超时，128 MB 老年代内存预算，最多 40,000 字符、10 列／200 行表格、2 MB 输出。取消或接管会终止生成；这是受控工具与资源预算，不宣称已实现通用代码的 OS 沙箱。
- 文件以不可变字节保存到现有私有 SQLite，版本记录文件名、MIME、字节数和 SHA-256。正文哈希和文件哈希分开；来源、任务归属及人工修改版本在提交前后核验。生成期间任务要求变化时拒绝旧结果。
- 飞书投递使用固定版本的字节，校验完整性、当前主人、群、来源和控制状态。沿用现有 bot 附件通道、原线程与发送去重；未知结果不自动重发。Word 生成不要求新的飞书 API scope。
- Loom 下载入口返回对应版本文件，界面显示“下载 Word”；飞书按需导出也使用保存文件。历史 TXT 版本保持原样。人工改正文会产生新版本并解除旧 Word 文件绑定，防止以旧文件冒充新内容，交还后可重新生成。
- 当前只新增 Word 生成。PDF、Excel、PPT、任意工作区二进制文件导入与公司模板仍需各自接入和验收；固定生成器不等于这些能力已经可用。邮箱现有通道仅发正文，Word 附件在邮箱目的地下明确记录受阻，不偷偷以正文代替。

## 验证

实现：`src/documents.ts`、`src/document-worker.ts`、`src/document-render.ts`、`src/document-format.ts`，以及任务报告工具、`artifacts.ts`、`result-delivery.ts`、Loom 下载和飞书按需导出入口。

`tests/documents.spec.ts` 验证实际 OOXML、中文标题、真实表格、时间引用、安全文件名、无远程图片、超限与中断；`tests/group-mode.spec.ts` 验证 TXT 冒充拒绝、真实文件字节、版本下载、原线程去重、损坏拒发、人工改稿及撤权。外部飞书操作使用替身，真实模型与附件验收另记部署文档。

Word 使用固定 `docx` / `marked` 版本并打入 renderer bundle，一体机不需要安装 Office 或在线文档服务。验收时用已有纪要正文生成 Word，经 documents 技能的 LibreOffice 渲染逐页检查；该渲染器用于开发质量检查，不是线上任务依赖。

2026-11-06 已在公司一体机完成真实 DSH Worker 验收：既有录音任务 `4e157ffba56ffff6014905e87753fcf8` 读取已保存的详版正文，生成并在原录音线程交付 v6「会议纪要-新录音50副本.docx」，未重新转写、未新增任务。实际飞书附件为 25,200 字节，SHA-256 `482b8dc4256776826a429ab3746e731ee146ba14c82b4a2eb62272398a95b4c4`；飞书下载、Loom API 导出与保存文件一致。检查实际 OOXML 内有 3 张表格；将最终附件渲染为 16 页并逐页检查中文、换行、表格和页码，未发现裁切或重叠。v1–v5 仍保留。录音识别与纪要事实仍需参会人审阅，版面检查不代替内容验收。

后端 88 个测试文件、1408 项通过及 4 项跳过，前端 14 项通过，类型检查与构建通过。录音持久任务重启回归覆盖初始化顺序：先完成身份和来源同步，再校验控制与恢复执行。真实升级及保守暂停后的授权恢复见 [服务器部署记录](SERVER_DEPLOYMENT.md)。本机证据为 `.artifacts/aibox-deploy/word-live-verification.json`、`word-api-proof.json`、`word-download-live.png` 和 `word-live-render/`，不将会议正文写入公开文档。

官方实现参考：[docx OOXML 打包](https://docx.js.org/api/classes/index.Packer.html)、[Marked Lexer](https://marked.js.org/using_pro)。
