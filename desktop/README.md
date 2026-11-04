# Loom Desktop

Linux x64 本机接入版。复用当前个人助手的工作空间、任务、飞书、模型和凭据；提供独立窗口、托盘、连接引导及系统导出对话框。

完整使用、构建和权限说明见 [桌面端文档](../docs/DESKTOP.md)。

从仓库根目录运行：

```sh
pnpm --dir desktop install
pnpm desktop:start
pnpm desktop:test
pnpm desktop:build
pnpm desktop:install
```

本包不含完整新机器配置，仍需要已有的 Linux Superagent 运行环境。独立飞书工作台、Windows、macOS、手机、云端与多用户接入不在此版范围。
