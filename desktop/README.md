# Loom Desktop

Linux x64、macOS（Apple 芯片／Intel）与 Windows x64 本机客户端。复用本机个人助手的工作空间与任务；提供独立窗口、托盘、连接引导及系统导出对话框。Windows 使用原生 Node 后台进程，不需要 WSL、tmux 或 Python 控制脚本。账户仅在使用者本机配置，不复制其他电脑的凭据。

完整使用、构建和权限说明见 [桌面端文档](../docs/DESKTOP.md)。

从仓库根目录运行：

```sh
pnpm --dir desktop install
pnpm desktop:start
pnpm desktop:test
pnpm desktop:build
pnpm desktop:install
```

Mac 上运行 `pnpm --dir desktop build:macos arm64` 或 `pnpm --dir desktop build:macos x64`。也可在 `myloom` 的 **Build macOS desktop** 工作流使用原生 Mac 构建、验证本地签名并检查首次启动，下载对应 ZIP；解压后将 `Loom.app` 放入“应用程序”。内测包尚无 Apple Developer ID 签名或公证，第一次打开可能需要在系统“隐私与安全性”中核实后允许打开。实际检查结果见完整文档的联调记录。

Windows 上运行 `pnpm desktop:build:windows` 生成 `desktop/dist/windows-0.4.1/Loom-win32-x64/Loom.exe` 和 `desktop/dist/Loom-0.4.1-windows-x64.zip`。解压整个目录后双击 `Loom.exe`。可用 `node desktop/scripts/smoke-windows.cjs <exe路径> <证据目录> <可选引擎目录>` 验证实际原生窗口，`node desktop/scripts/smoke-edit-windows.cjs <exe路径>` 验证失败后的逐页返回与编辑。ZIP 尚无发布者签名。

安装包不包含完整新机器依赖，仍需要本机的 Superagent 引擎及 Harness／CLI；首次向导可选择已构建的引擎目录。Windows 的 Node、Git、Harness 和飞书 CLI 均使用本机版本，完整准备步骤见桌面文档。真实 Harness 与隔离外部接口联调已通过；真实飞书账户、付费模型与完整办公任务仍需使用者配置后验收。独立飞书工作台、手机、云端与多用户接入仍在后续范围。
