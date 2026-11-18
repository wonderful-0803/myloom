# B4：原生元数据与文本会话离线迁移

日期：2026-11-12。继续 [B3](DSH_STATE_B3.md)，部署目标仍为既有 AI 盒子。本批只开发、隔离验证与编写操作入口，不切换盒子，不读取实际个人/公司历史，不启动新的飞书或模型调用。

## 本批范围

- `dsh-superagent/dsh-metadata` 实现 DSH 原生 `StorageBackend.kv`，支持 `open/loadAll/putRecord/deleteRecord/setGlobal/close`。workspace v2 的身份、会话归属、排序、归档和置顶可进入同一 SQL 权威。
- 每个缓存 domain 一个数据库时间租约；禁止两个进程同时持有可写 domain。接手时重开并重新 load，不能把旧 `dsh-storage-domain` 的内存缓存带到新 owner。
- 提供私有归档的导出、dry-run 和可续传导入。使用实际 rc.3 JSONL/JSON reader 读取**显式指定的冻结副本的临时拷贝**，不自己猜 JSONL 文件布局；原始冻结目录在前后检查摘要且不挂载为可写 provider。
- 保留完整 Session ID、不可变 header、事件及 seq、fork inheritedEventCount 与父前缀，导入不发起任务、不恢复执行权。
- 首期导入仅支持格式 4 的**文本会话＋workspace v2**。图片/文件结构化附件、目录内容、运行中进程、原生 schedule、旧格式自动升级和模型凭据不迁移；遇到附件会拒绝，不能生成缺字节的假成功。派生 projection cache 可重建，默认仍走原有缓存路由。

整个 B 包仍未完成：无物理停止证明的崩溃恢复、附件资源迁移、真实模型长任务接续与实际盒子迁移仍待后续验收。迁入日志中的旧路径不会自动变成可用执行环境。

## 实现与数据

| 位置 | 职责 |
| --- | --- |
| `src/dsh-state/metadata.ts` | KV 后端与单元、描述符/布局/版本校验、独立记录及 singleton、单 owner 租约、写入屏障及关闭排空 |
| `src/dsh-state/catalog.ts` | 原生导入/回滚 staging 门禁、非秘密的恢复环境契约 |
| `src/dsh-metadata.ts` | 显式后端注册 `loom-sql`、复用 Session provider 同一仓储/scope、连接受管计算门禁 |
| `src/dsh-state/archive.ts` | 归档摘要、谱系/前缀/workspace 校验、分页写入与读回、可恢复的 staging 标记 |
| `scripts/dsh-state-admin.mjs` | 编译后离线 CLI：export、dry-run、import，无真实 profile 自动发现和渠道调用 |
| `src/state/{ports,sql,backup}.ts` | schema 5、native families 纳入通用备份/回滚，并拒绝仍活跃的元数据 owner |
| `scripts/fixtures/dsh-metadata.mjs` | 实际 rc.3 JSONL/JSON 与 WorkspaceRegistry 跨进程验证，无模型推理 |

外置 schema 升为 **5**，增加 `native-unit`/`native-record` 逻辑 family；不新增第二套数据库连接或锁表。1–4 升级保留 revision/墓碑/作业认领；4→5 仅更新版本标记，不能再次执行旧版 `sort_at` 的 ALTER。旧 schema 4 程序拒绝打开 schema 5，不支持旧新程序混跑。

`native-unit` 按 unit 名保存规范化 descriptor；`native-record` 按 unit＋table/key 的 SHA256 保存单条 JSON 文本、版本与摘要，关系索引按 unit 分页。JSON 文本保留 NUL/孤立 UTF-16；single 布局 key 不被当作路径。`per-record` 支持兼容旧 stamp，不接受的 stamp 作为该条缺失，原数据保留；SQL envelope 损坏和摘要不符拒绝并使本 owner 失效，不静默重置。

KV 先快照参数再入异步链。单条成功返回即已提交；失租约或存储故障后此后端不自行重抢，须销毁旧 domain 并重新加载。close 排空已接受操作、释放自己的 owner/epoch；旧 close 不能释放替代者。通用 domain 的同步内存 getter 不会每次查询数据库，因此不能把原生 registry 直接当跨节点共享读模型；产品仍走 A 的授权投影。

## 计算与元数据所有权连接

元数据插件从 SQL SessionPersistence 取得确切的 store/scope，不另建池。`native-domain/<unit>` 仍使用 A 的租约基础设施，表示该 domain 的缓存写权；它与某个 Worker Session 的租约承担不同对象的所有权。

插件将元数据检查接到 `NativeWriterBinding.assertCurrent`；受管推理与工具门禁核对当前 domain owner。后端续租失败通知 provider 取消受管生命周期；卸载插件也撤销守卫，不能变成无守卫的本地降级。进程间靠租约排他和重载，不使用不存在的分布式缓存同步。

恢复环境契约包含：固定 Harness 版本、经审核的非秘密部署清单摘要、preset ID→composition 摘要、允许的 provider/model 标识。保存到 `grant/native-environment`。不匹配则要求显式迁移；不会默认采用新配置。公司创建/恢复 Agent，以及其推理请求守卫，会读取当前 `agentPresets.readDocument(id).content` 核对 composition 摘要并检查选定模型。动态改 preset 或未登记模型不能静默继续。

`profileRevision` 是运维声明的非秘密清单版本，不是系统对整台主机/二进制的可信证明；插件不读取含密钥的原始 profile。依赖包、可执行文件及真实连接器的兼容仍须部署验收。契约摘要算法为项目 `hash(value)`：对 JSON 值规范化后 SHA256；preset 使用 `hash(content字符串)`，**不是**直接对 YAML 文件字节求 SHA256。保留导出时原始 YAML content，换行也参与版本。

## 配置方式

模板：[隔离 profile 补丁](../../examples/loom-dsh-metadata.cordis.patch.yml)、[环境契约](../../examples/loom-dsh-environment.json)。全零摘要及 replace 字段只是占位，不能直接使用；按实际 profile row ID 合并配置，保留 Worker/Router preset 和无关路由。契约实际文件须为 `0600`、绝对路径、无符号链接。

显式关闭旧 SessionPersistence，挂载 `dsh-state`、`dsh-metadata`，将 **workspace** domain 路由到 `loom-sql`；公司配置仍需显式 `nativeState: external`。不能把整个 domain 默认路由切到新后端，从而意外迁移 schedule 或无关 domain。注册顺序通过 backend lifecycle service 与 domain facility 依赖连接；SQL provider 关闭时额外协调已注册的元数据 domain/后端排空，才允许底层数据库关闭，不关闭无关 domain。root 并发销毁本身不提供业务有序停机保证，操作时仍先停止公司来源和消费者、Agent，再关闭存储。

新节点仍需同版本受管 profile、可用模型凭据引用和 preset 定义，复原相同 scratch 路径模板；持久 workspace/header 保存的是原绝对路径。本批不改写 cwd，也不复制未提交项目文件。不存在/不可验证的旧目录须保留兼容执行池，或后续通过明确的环境迁移解决。

## 导出与 dry-run

先停止旧来源、消费者、Agent 和 domain；完成 flush/close，保留旧库、日志、元数据和对象的私有备份。创建私有冻结副本及说明文件，**不要把正在运行的真实 root 当冻结副本**。前后摘要一致只能证明采样期间文件没变化，不替代操作者确认停止。

私有 `frozen-source.json` 示例：

```json
{
  "harnessRoot": "/absolute/path/to/@deepseek-ai/dsh",
  "sessionRoot": "/private/frozen/sessions",
  "metadataRoot": "/private/frozen/metadata",
  "compression": "zstd",
  "contract": {
    "harnessVersion": "0.2.1-rc.3",
    "profileRevision": "实际64位摘要",
    "presets": { "实际preset": "实际64位composition摘要" },
    "models": [{ "provider": "实际provider", "model": "实际model" }]
  }
}
```

源必须是专属部署的明确冻结根，不自动扫描个人目录。metadata 只复制/读取选定的 `workspace.json`；不复制模型或凭据配置。源文件/目录拒绝符号链接、硬链接、特殊文件、活跃锁目录及超预算数据。POSIX 正常遗留的 `session.lock` 文件不是活跃锁证明，不能仅按文件名判断进程已停止。解析始终在临时副本运行，上游 reader 即便触发内部整理也不会写回源。

```sh
pnpm build
pnpm dsh-state:admin export --config /private/company.json \
  --source /private/frozen-source.json --archive /private/export/native.json \
  --evidence /private/freeze-evidence.txt
pnpm dsh-state:admin dry-run --config /private/company.json \
  --archive /private/export/native.json
```

company.json 使用 A 的显式 tenantId/spaceId/databaseUrlEnv；export/dry-run 不打开数据库。输出只包含计数、scope 和摘要，不输出正文、header 路径或源文件列表。归档文件本身包含完整业务历史，须按敏感业务数据保护；历史可能已有凭据或私人文本，不能将“不迁移凭据配置”理解为历史自动脱敏。checksum 防损坏，不是签名或授权；收件范围由操作者独立确认。

读取预算：归档≤100MB、会话≤5000、冻结树≤200MB/20000 项。超限拒绝，不截断成成功；更大数据需后续分区迁移。workspace pendingMutation、缺失/循环父关系、重复 ID、fork 前缀不符、缺失模型/preset、workspace 归属/排序不一致均拒绝；先在原环境核对，不自动“修复”历史。

## 导入、中断恢复与回滚

在安全终端配置公司专用 `LOOM_*` 数据库环境变量。目标公司 Runtime 必须全局暂停、消费者停止、无活跃原生 writer 或 domain owner；初次导入要求 native namespace 为空，允许 A 业务状态已按独立方案迁入。

```sh
pnpm dsh-state:admin import --config /private/company.json \
  --archive /private/export/native.json --apply \
  --expected-sha256 从dry-run核对的摘要 --actor 明确操作者 \
  --evidence /private/freeze-evidence.txt
```

使用 `migration/native-import` 标记 staging，并认领同一 A 租约基础设施中的导入权；分短事务每批最多100条，原生 provider 与 metadata backend 在 staging 时拒绝读取/启动。最终逐一读回完整日志和所有记录后才改为 ready。崩溃后只能用同摘要归档接着核对/补写，同一键不同内容拒绝覆盖；换归档/换 scope/已有健康目标不会被合并。ready 不取消暂停、不创建 Job、不生成原生停止回执、不恢复模型或渠道写权。

完整回滚使用 A 的 `state:admin export/restore`，包含新 native families、索引、原始 revision 和墓碑。导出要求 native writer/domain owner 均关闭；恢复后作业 held、登录失效、执行关闭，仍需核对原生/外部回执后明确激活。中断的 native import 保持不可访问，优先修复后用同归档恢复；没有“自动删除 staging 并重来”的在线按钮。旧文件副本不能直接回升为切换后最新状态，后续新增原生日志也须一起备份。

## 验证边界

`tests/dsh-state/metadata.spec.ts` 覆盖真实 storage 注册、当前 preset/model 门禁、双数据库 KV、所有权接替/失权、布局/版本、兼容旧记录、损坏、排空与 scope；`archive.spec.ts` 覆盖谱系、workspace、摘要/范围拒绝、staging 中断及重试。schema 1–4 升级与 metadata 关闭/回滚进入状态契约回归。

```sh
pnpm typecheck
pnpm test:dsh-state
pnpm exec vitest run tests/state-contract/store.spec.ts tests/state-contract/backup.spec.ts
pnpm build
pnpm dsh-state:smoke:metadata --harness-root /absolute/path/to/@deepseek-ai/dsh
```

双数据库测试用 `LOOM_STATE_TEST_DATABASE_URL`，实际 rc.3 冒烟用 `LOOM_DSH_B1_DATABASE_URL`，均只接受名称以 `_test` 结尾的专用测试库。实际冒烟在两个独立空 cwd 进程中，使用上游 JSONL/JSON 写入合成源，经编译 CLI 导出/dry-run/导入，再以真实 WorkspaceRegistry 读回同一身份、原顺序、归档/置顶和精确 fork；不调用模型、不连接真实飞书。日志和最终统计在本机 `.artifacts/dsh-state-b4-20261112/verification.json`。

最终结果：**106 个测试文件、1611 项通过、4 项现有跳过**；类型检查与构建通过。最新编译产物的原生 SessionStore、B3 idle Agent 生命周期及 B4 实际迁移冒烟均通过，文本 JSONL（none）和 Zstandard（zstd）两种源编码分别验证；后者通过设置 `LOOM_DSH_METADATA_COMPRESSION=zstd` 再运行同一冒烟命令。metadata 四份公开 KV 类型在开发 alpha.2 与实际 rc.3 间逐字节一致，摘要随实际冒烟输出保存。本批临时 PostgreSQL 验证后删除，不用于部署或保存业务历史。

下一步 B5 聚焦完整 Harness/公司入口的实际模型任务接续、暂停/接管/撤权与交付，以及明确的缺停止证据恢复协议；附件/目录迁移与 Runner 仍不能由本批文本归档替代。
