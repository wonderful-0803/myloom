# C2：Linux 只读 Runner 与本地持久回执

日期：2026-11-12。承接 [C1](GATEWAY_RUNNER_C1.md)。本批完成在非 root Linux 账号下运行的端侧核心、显式目录授权、真实文本工具、SQLite 回执及独立进程恢复。**没有网络监听，没有改公司盒子的服务，也没有给现有群接入个人目录。** 在线配对、TLS 连接、公司 A/B 授权与设备网关属于 C3，真实两机属于 C4。

## 实现位置与部署边界

| 模块 | 本批职责 |
| --- | --- |
| `src/execution/runner/config.ts` | 本机独立 Ed25519 身份、明确的 tenant/space/user/environment 绑定、私有配置与固定网关公钥；验证绑定完整意图的许可 |
| `src/execution/runner/files.ts` | 根目录 inode/device 固定、Linux fd 相对打开与复核，真实 `fs.read` / `fs.glob` / `fs.grep` |
| `src/execution/runner/ledger.ts` | 独立 SQLite 授权/版本、请求/回执、控制与 Session fence、去重、结果清理与永久请求墓碑、进程独占 |
| `src/execution/runner/runner.ts` | 有界串行队列、授权/期限复核、取消/撤权、真实完成落账、关闭与失败挂起 |
| `dsh-superagent/runner` | 可嵌入的 `LinuxRunner`、本机初始化和协议许可摘要；不依赖 Harness 实例或公司模型/飞书密钥 |
| `scripts/runner-local.mjs` | 本机 CLI：初始化、授权、撤权、查询与私有 stdio 调试；不是公开网络接口 |
| `scripts/smoke-runner-local.mjs` | 编译后独立 CLI/文件/SQLite/重启/撤权验收，全部使用临时目录和虚构 R1/R2 |

Runner 应装在需要访问文件的 Linux 设备上；公司网关留在既有 AI 盒子。当前生产仍只执行原来获授权的本机办公任务，`Sessions.ensure` 和远程产物读取门禁没有解除。文件工具不是群模式默认能力：某人接入自己的电脑不会给其他主人授权。C3 必须把环境绑定到已经审核的空间和主人，并在服务端继续取场景、任务、资源和设备权限的交集。

## 本地身份与授权

`initializeRunner` 只接受操作者明确给出的单一身份映射和审核过的 Ed25519 网关**公钥**。它生成设备密钥，保存 `device.json`；配置目录必须为当前非 root 账号所有、0700、规范路径，配置/SQLite 文件必须为单链接、0600、当前账号所有。拒绝其他身份、符号链接和已有不同数据库。这个步骤是离线信任引导，**不是**已实现飞书扫码、联网配对、凭据轮换或服务端设备登记。

每份目录授权有 workspaceId、grantId、版本、用途模式（personal/shared-group）、能力、后缀、到期时间和固定根目录身份。创建、更新要求期望版本；撤销增加版本并取消在途读取。任何授权都只能用于初始化时固定的 tenant/space/user/environment；模式标签本身不能改变空间或让个人资源变成群共享。变更空间/设备身份需要明确的新配置，不能原地复用旧回执库。

根目录必须由本机账号拥有，不能是 `/`、Runner 状态目录或其上级/下级，也不能包含符号链接。读取时只允许授权的文本后缀；隐藏文件/目录、世界可写对象、其他账号对象、符号链接、硬链接和非普通文件拒绝。没有 Shell、写入、编辑、插件加载、后台 job、Codex 历史、图片/二进制解码或公司凭据下发。

## 文件边界与预算

- 每层目录用 `O_DIRECTORY|O_NOFOLLOW` 打开，子路径相对于持有的 `/proc/self/fd` 句柄打开；文件也使用 `O_NOFOLLOW|O_NONBLOCK`，先检查类型再读取，FIFO 不会被当作文本等待。
- 校验根 inode/device、每层实际句柄路径、所有者及文件单链接；结果释放前重新检查句柄和根身份。目录被移动/替换、读取期间文件 size/mtime/ctime 变化都拒绝，不仅做路径字符串前缀判断。
- 固定每文件 1 MiB、一次总读取 2 MiB、目录项 2000、目录层级/路径段 16、grep 文件 200；输出最多 200 路径/匹配和约 60 KB JSON 内容预算，再经过 C1 的 80 KB 回执校验。超限拒绝或明确 `truncated`，不输出隐藏的余下内容。
- UTF-8 严格解码，拒绝 NUL 和非文本控制字节。`read.offset` 从 0 开始按行计算，`grep.line` 从 1 开始；grep 为字面包含匹配，不执行正则。glob 支持 `*`、`?` 与整段 `**`，不执行扩展表达式或命令。
- 读取/枚举在异步步骤和结果发布前检查取消、许可、授权与 fence；一次执行有五秒协作预算。阻塞中的内核文件 I/O 不能靠 JS 取消证明已停止，因此不会用超时/AbortSignal 提前伪造终态。

这是应用层文本能力边界，不是任意插件或同 UID 恶意进程的 OS 沙箱。该账号不应运行不受信程序，私有状态和发行包也不应允许项目代码修改。不引入 mount namespace、网络出口隔离或任意 Shell 的强隔离承诺。

## 许可、接收和恢复

许可使用 Ed25519，签名域为 `loom-runner-request-v1` 加 C1 的规范 `intentHash`；签名覆盖完整身份、任务、工具、参数摘要、期限、资源版本、控制版本和 Session epoch。Runner 验证实际参数、固定公钥、当前本机授权和至多 60 秒的剩余期限。远程文字不能授予本机目录，也不能用旧 epoch/control 重新执行；已见的最大 fence 持久保存。

`LinuxRunner.transport(peer)` 的 peer **必须由受信调用方先认证**。它只校验与本机固定绑定相同，不承担网络认证。C2 的 stdio 由本机账号的父进程拥有；公开 requestId、intentHash 或 deviceId 都不是身份凭据。C3 不得把 stdio 直接挂到未认证 HTTP/WebSocket 上，也不能暴露 init/grant/revoke 管理函数。

新请求先在 SQLite FULL 同步事务中写 accepted，才排队/执行；running 是另一个持久边界，最后保存结果及摘要。并发一项，待执行队列最多 32 项。同 ID 同意图返回原回执，不再读取已经变化的文件；同 ID 改身份/参数/期限/版本拒绝。失败回执只带固定错误码，不带文件正文、绝对路径、原始异常或凭据。

进程独占通过另一份 SQLite 的持有事务实现，锁随真正进程退出由内核释放；没有“超时即接替”的规则。SIGSTOP 时第二进程仍不能取得所有权；SIGKILL 后新进程把持久 accepted/running 转为 unknown，不自动重读，哪怕能力是只读。服务端可以在 C3 按明确策略核查/另建请求；不能偷偷复用原 ID 把 unknown 改成新一次成功。

取消正在运行的工具先发 AbortSignal，回执仍为 running；只有工具实际返回、句柄释放后才保存 cancelled。排队且未开始的请求可直接取消。撤权后不再返回旧缓存正文；cancel 也不能被用来绕过此限制取回旧 succeeded 内容。正常关闭排空/取消并落账；磁盘或持久化故障后拒绝新请求，重启再核查。

敏感请求/结果保留一小时，后续访问时惰性清理；永久保留 ID/意图/状态/序号墓碑，过期后不能重新执行。SQLite 启用 secure_delete、DELETE journal，清理不承诺底层设备的取证级擦除。最多 10000 请求墓碑和约 100 MB 活跃内容；耗尽时拒绝新接收。磁盘配额/加密由部署系统落实，不能删库恢复同一个环境身份以绕过去重。

## 本机操作与停止

构建后执行 `node scripts/runner-local.mjs --help`。仅在独立测试目录或明确选择的正式目录使用；本批没有替用户创建真实业务目录授权。

```sh
pnpm build
node scripts/runner-local.mjs init --home /private/loom-runner --binding /private/binding.json --gateway-key /reviewed/gateway.pub
node scripts/runner-local.mjs grant --home /private/loom-runner --grant /private/grant.json
node scripts/runner-local.mjs inspect --home /private/loom-runner
node scripts/runner-local.mjs stdio --home /private/loom-runner
# 关闭 stdio 的输入后等待进程退出，再做独立管理操作：
node scripts/runner-local.mjs revoke --home /private/loom-runner --id project-read --revision 1
```

binding 示例只含 `tenantId/spaceId/userId/environmentId`。grant 示例：

```json
{"id":"project-read","workspaceId":"selected-project","scope":"personal","root":"/selected/project","capabilities":["fs.read","fs.glob","fs.grep"],"extensions":[".txt",".md",".csv"],"expiresAt":"2026-11-13T00:00:00.000Z"}
```

日期/目录必须由实际操作者选择，示例不是默认授权。stdio 只接收 `{op,request}` 的 dispatch/query/cancel；它是开发联调接口，不是产品要求用户手工签名的最终配置流程。同一 home 只运行一个 owner；其他进程失败时先检查原进程，不删 owner 文件强抢。关闭终端、停止 Runner、撤权和关闭桌面窗口不能混为一谈。正常 EOF 等待正在执行的操作结束；直接 SIGTERM/SIGKILL 可能留下 unknown，下次由账本恢复，不宣称已撤销执行。

卸载先停止接收和撤销服务端设备（C3）、核对所有在途回执，再停止本机进程。保留私有账本供核查；不要把钥匙/回执放进普通安装包或诊断附件。C2 没有安装系统服务或改开机启动；C3 才接统一设备页与常驻生命周期。

## 验证与剩余工作

`tests/runner.spec.ts` 使用临时目录、独立 Ed25519 密钥和虚构 R1/R2，覆盖真实三种工具、C1 路由、去重、权限/期限/epoch/control、撤销与取消、目录替换、符号/硬链接/FIFO/二进制/大小、Unicode/转义输出预算、扫描上限、私有文件、身份更换和结果墓碑。

`tests/runner-process.spec.ts` 在真正独立 Node 进程执行本机读，SIGSTOP 后竞争进程被拒绝，SIGKILL 后从同一 SQLite 恢复 unknown，原 ID 不重读。`scripts/smoke-runner-local.mjs` 使用编译产物和本机 CLI 做初始化、授权、实际读取、不同进程重启、结果一致、Shell 拒绝和撤权后缓存拒绝。均无真实个人目录、公司历史、模型或飞书 API 调用。

本批没有完成：在线配对/TLS/设备认证、服务器持久建单与 A/B 事务签发、全局撤权通知、离线等待/重连唤醒、真实 DSH 代理工具装配、二进制产物上传，以及两台电脑验收。这些门禁继续保留，下一步按 C3 落实。不能把可嵌入的本机 Runner 或 stdio 验收当成已接入飞书真实远程任务。

验收结果：本机 Linux x86_64 / Node 24.20.0，**全量 111 个文件、1681 项通过、4 项现有跳过**，含独立 PostgreSQL 16；Runner/端口/协议/文档专项 **6 文件、62 项通过**，类型检查和构建通过。发行包 122 文件检查无设备密钥/数据库；在 `/tmp` 解包、只提供 Zod 而不提供 Harness 的独立目录中实际执行编译后 CLI 验收成功。脱敏证据 `.artifacts/runner-c2-20261112/verification.json`，测试用 PostgreSQL 容器已按专用标签移除。本批未在 ARM Runner 或另一台个人设备安装，不将开发机独立进程测试记为 C4 两机验收。
