# Loom 桌面端

提供 **Linux x64 本机版**和 **macOS arm64／x64 内测版**：独立 Electron 应用、托盘、连接状态及首次配置向导。可接入已有 Superagent / DeepSeek Harness，也可在已有本机引擎和依赖上从零配置独立的助手，不启动演示执行器。已有助手的任务库和账户凭据不自动复制。macOS 原生构建、签名和空白首次启动检查的实际结果另记联调记录，不将打包完成等同于完整飞书与模型联调。

## macOS 压缩包（0.3.0）

- Apple M 系列芯片：`Loom-0.3.0-macos-arm64.zip`。
- Intel 处理器：`Loom-0.3.0-macos-x64.zip`。

解压后将 `Loom.app` 拖到“应用程序”，再打开。当前 Electron 45.2.2 产物的最低版本为 macOS 13.0，也可核对包内说明及 `.zip.json`。ZIP 有独立 SHA256 校验文件，包含 `.app`、使用说明和许可证，不包含模型、个人账户、任务库或开发机路径。应用使用本地 ad-hoc 签名供内测，未完成 Apple Developer ID 签名与公证；如果系统拦截，在“系统设置 → 隐私与安全性”核实来源后选择“仍要打开”，不要关闭系统整体安全保护。

Mac 首次使用仍须先准备 Node、DeepSeek Harness、Python 3、tmux、飞书 CLI 及已构建的本仓库办公引擎，依赖安装见 [个人部署](PERSONAL_SETUP.md)。在向导第一步点击“选择办公引擎目录”，选择完成 `pnpm build:loom` 和 `pnpm build` 的源码目录，再检查环境并配置自己的模型及机器人。引擎目录选择经原生窗口和后端验证，保存后可恢复；环境准备后禁止换引擎，避免中途改用其他程序。Mac 助手记录存于 `~/Library/Application Support/luxi-loom/`，向导偏好在 `~/Library/Application Support/luxi-loom-first-run/`；已保存的路径及 XDG 覆盖继续生效。

Mac 入口补齐 Finder 的 Homebrew／用户命令路径、菜单栏模板图标、Dock 重开和 Cmd+Q；只在 Linux 传入 X11 启动参数。关闭客户端不转移本机计算，退出与明确停止助手的语义沿用现有实现。Windows、跨设备任务迁移、完整新机器自动装依赖和签名更新仍未实现。

在 macOS 原生构建：

```sh
pnpm --dir desktop install --frozen-lockfile
pnpm --dir desktop build:macos arm64
# Intel Mac 使用 x64
```

`scripts/package-macos.cjs` 使用固定版本 Electron 和 Packager，从显式文件清单暂存客户端，生成 ICNS／菜单栏图标，再验证二进制架构和本地签名，通过系统 `ditto` 制作保留应用元数据的 ZIP。脚本在非 macOS 环境拒绝运行，避免省略签名及原生验证。仓库工作流在独立 arm64、Intel macOS runner 上构建，权限仅 `contents: read`，只上传 ZIP、校验及空白首次启动证据；不注入个人配置、不启动 Harness／机器人、不调用付费模型。完整业务联调仍须在目标 Mac 配置后验收。

## 从零配置独立助手（0.2.0）

打开新增的 **Loom · 独立助手** 应用／桌面快捷方式，或在原客户端连接页选择“从零配置一个独立助手”。独立入口使用 `--setup-experience`，有单独的桌面偏好、单实例锁和窗口类别；原客户端可以继续打开原任务库。

1. **本机环境**：选择现有办公引擎目录，检查 Node、dsh、Python、tmux 和飞书 CLI，点击“准备运行环境”创建全新的 Harness home/profile，并加载本地 bundle。此时不启动监听器，也不导入任何模型、飞书或邮件凭据。
2. **模型**：填写兼容 API 地址、模型 ID 和 API Key；实际向所填地址发送一条固定的短连接测试，可能产生少量 API 费用，不包含个人资料。不把 HTTP 连通等同于复杂工具调用或任务质量验收。
3. **飞书**：本机填写 App ID／Secret，校验租户凭证、机器人身份以及 bot-only CLI。Secret 通过独立的 CLI file SecretRef 使用，不调用会覆盖共享 app-ID keychain 的 `config init`。飞书应用创建、机器人能力、长连接消息订阅、权限发布及企业审批仍须在平台完成；向导说明这些前置步骤，不伪造已开通状态。
4. **消息范围**：选择本应用下的本人 Open ID，可从机器人已加入群的成员中选择；私聊默认开、群默认不选，最多 3 个群，可区分仅 @／全部消息。仅一个所有者可发起任务，其他群关闭；自主模式默认 observe，可明确选择 auto。所有者是本机用户在配置页确认的身份，不是新增的飞书用户 OAuth 登录。
5. **检查并启动**：展示模型、机器人、唯一用户、群范围、设备执行权限与交付方式；勾选确认后才初始化全新任务库并启动。复核凭据与群成员关系、检查旧监听及跨配置 bot lease；同一机器人已在原助手运行、或原监听状态无法核实时拒绝启动，不替用户停止旧任务。需要复用同一机器人时，先在原客户端明确停止助手，再返回重试。启动后等待实际消息消费者 ready，未就绪不标记完成。

Linux 上每次体验的本机记录在 `~/.config/luxi-loom-first-run/`，助手在 `${XDG_DATA_HOME:-~/.local/share}/luxi-loom/instances/<id>/` 中拥有独立 profile、state 和 CLI 配置，后续打开同一入口会恢复进度或进入已配置的工作空间。模型凭据采用 Harness 的 `.credentials.yaml`，飞书 Secret 使用本机专用文件，目录 0700、凭据文件 0600；不宣称这些文件由操作系统钥匙串加密。界面和任务记录不包含密钥；Loom 工作空间仍没有原生 IPC。邮箱、Codex 历史和自动邮件授权不在新配置中默认继承。

`src/personal-setup.ts` 和固定本机脚本为新目录保存真实的版本化办公设置；拒绝覆盖已有任务库，同一份初始化可重试。`desktop/onboarding.cjs` 负责步骤校验、受限外部校验与独立环境启动。服务脚本同时向已有 tmux 传入独立 Harness home 和 Agent 配置目录，防止沿用服务端原有环境。

此向导已补齐**当前 Linux 上配置一个新助手**的真实流程，Mac 的原生空白首次启动与完整账户联调另行验收。安装包仍未捆绑完整办公引擎及 Harness/CLI 依赖，也没有全新电脑的一键安装或飞书应用免审批流程。缺少依赖时显示缺项，不把配置页当作完整新机器部署已经完成。

## 使用

安装后从系统应用菜单或桌面的 **Loom** 打开。已有配置自动识别并进入工作空间，无需重新输入飞书密钥或模型 Key。右上角“连接与运行状态”可查看当前机器人、模型、任务数量及组件状态；缺依赖、服务停止、配置待完成和组件错误分别显示，不通过重启掩盖问题。

- 关闭窗口：收起到后台，可再次点击应用图标或托盘打开。
- 托盘：打开任务／交付物、查看连接状态、退出客户端或明确停止助手。
- “退出 Loom（助手继续运行）”：只退出桌面程序，后台任务继续。
- “停止助手并退出…”：原生确认后调用现有服务的安全停止，不强杀；停止未确认则保留界面。下次启动仍尊重手动停止，只有本人点击“启动本机助手”才恢复。
- 桌面提醒默认关闭，可在连接页打开；仅对本次运行中观察到的任务完成或需要处理状态提醒，不补发历史通知。
- 导出 TXT / Markdown 使用系统文件保存对话框，仍只读取原来的固定报告版本。

当前未注册开机自启，未实现自动升级、飞书扫码接入或完整新机器依赖安装。电脑休眠／关机后，本机任务无法继续计算；关闭窗口不会使任务转移到云端。

## 开发和打包

```sh
pnpm --dir desktop install
pnpm desktop:start
pnpm desktop:test
pnpm desktop:build
pnpm desktop:install
```

前提为当前项目已完成 `pnpm build:loom` 和 `pnpm build`，本机已有可用的 dsh、Python 3、tmux 及个人 profile。`desktop:build` 生成 `desktop/dist/Loom-linux-x64/loom` 和版本化 tar.gz，包含 Electron 与桌面代码，不包含 Harness、模型、飞书 CLI、个人数据或密钥。包中只保存当前项目的默认路径；迁移新设备须先配置本机助手，再选择项目目录。因此该包是本机内测交付物，不能宣称普通用户在全新设备已可免配置使用。

`desktop:install` 安装到当前用户的 `~/.local/share/luxi-loom-desktop`（遵循 XDG_DATA_HOME），添加系统菜单条目和 XDG 桌面快捷方式。无需 sudo，不修改系统服务或开放网络端口。个人界面偏好写在 Electron 的用户目录 settings.json（0600），只含项目路径、回环地址及通知偏好；不存飞书／模型／邮箱凭据。卸载时移除这个专用目录、`applications/luxi-loom.desktop` 和桌面快捷方式即可；原助手及数据库独立保留。

## 边界与验证

桌面主界面和 Loom 工作空间使用独立的 WebContents：受信本机连接页具有有限 IPC；工作空间无 preload、Node 或系统命令接口。启用 Chromium 沙箱、上下文隔离及 Web 安全，拒绝任意页面跳转、弹窗、权限申请及远程资源请求，保留后端原有防嵌入头和同源校验。桌面侧仅允许本机 `127.0.0.1` 服务及 Loom 路径；不开放通用 shell、任意文件读取或任意 URL 接口。Linux 使用软件渲染兼容本机驱动，未关闭沙箱。

0.1.1 修复当前 Wayland 桌面中只有托盘、没有可见窗口的问题：通过进程启动参数 `--ozone-platform=x11` 使用已有 XWayland；直接打开包内二进制时也会在创建窗口和连接后台之前补参数重启一次。不能用主进程启动后追加同名开关代替，因为显示后端可能已经初始化。安装入口的 `StartupWMClass=loom` 与真实窗口匹配，托盘菜单仅在状态改变时更新，避免每轮检测都替换正在操作的菜单。当前验证范围为有 `DISPLAY` 的 X11／XWayland，纯 Wayland 尚未验收。

生命周期适配复用现有 personal-superagent 脚本：检测单一进程／项目归属、后台在线时只连接，手动停止不自动重启，操作期间串行化。缺构建或运行依赖时不尝试执行。暂停、接管、产物版本及邮件授权仍由原后端检查，不由桌面窗口重置。桌面进程不是新的设备沙箱，当前同一 OS 用户的权限假设不变。

`desktop/test/runtime.test.cjs` 验证现有服务复用、并发启动去重、手动停止、缺依赖、进程归属、错误脱敏、URL／资源／IPC 来源和通知变化。可选 `LOOM_DESKTOP_SMOKE_DIR=受限目录 pnpm desktop:start` 启动实际 Electron 自检，读取真实工作空间、检查无特权工作空间、记录连接页和工作空间截图，验证原生导航、单实例、关闭后台继续及重新打开；不创建业务任务、不发飞书消息或邮件。打包后亦可对包内 loom 执行同样的自检。实际结果记录在 `PERSONAL_ACCEPTANCE.md`，不把测试替身当作真实运行证据。

实际窗口自检另外需要系统已有的 `xwininfo` 和 `xprop`，按本应用的原生窗口 ID 核验 PID 与 `IsViewable`，覆盖托盘菜单回调重开、隐藏后再次启动及最小化后再次启动。仅检查 `isVisible()` 或渲染截图不足以证明用户真的看得到窗口。

后续新机器依赖安装、其他系统、Developer ID／公证、签名更新和跨设备接入需要单独补齐；本轮仍是单人、本机范围。参考 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security) 和 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)。

首次配置另有 `desktop/test/onboarding.test.cjs`、`tests/personal-setup.spec.ts` 与服务脚本测试。可选 `node desktop/test/integration-runtime.cjs` 实际创建、初始化、启动并停止独立 Harness，外部飞书／模型使用替身；`LOOM_DESKTOP_SETUP_SMOKE_DIR=<受限目录>` 配合 `--setup-experience` 验证真实原生窗口、五步表单、密码清理、群名称按文本显示及最终确认。UI 中的云端校验同样使用明确标注的测试替身，不等于新应用真实权限或真实付费模型验收。
