# Loom Desktop

Linux x64 与 macOS（Apple 芯片／Intel）本机客户端。复用本机个人助手的工作空间与任务；提供独立窗口、托盘、连接引导及系统导出对话框。账户仅在使用者本机配置，不复制其他电脑的凭据。

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

安装包不包含完整新机器依赖，仍需要本机的 Superagent 引擎及 Harness／CLI；首次向导可选择已构建的引擎目录。Mac 完整飞书／模型联调与 Linux 既有验收分开记录。独立飞书工作台、Windows、手机、云端与多用户接入仍在后续范围。
