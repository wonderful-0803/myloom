# Loom Signal 触发链路

这轮优化借鉴 LobeHub 的事件信号思路，把来源接收、短窗口聚合、任务评估和审计记录分开。信号记录只保存有限元数据，原始 Trigger、任务授权和资源 ACL 仍由现有 Loom 状态负责。

## 当前实现

`src/state/signals.ts` 提供两个内部记录器。

- `recordFeishuSignal` 为每个 Feishu Trigger 创建一条 `audit` 记录，关系是 `signal.feishu`。记录包含 `message`、`attachment` 或 `thread-reply` 类型、Trigger ID、时间和正文哈希，不保存正文。来源消息 ID 保证重放幂等。
- `recordRunnerSignal` 在 StateStore 设备目录发生连接状态或 epoch 变化时创建 `signal.runner` 记录，只保存设备、用户、环境、状态、epoch 和数据库时间。设备目录的 CAS 写入与状态记录在同一事务完成。

未 @ 的群消息会由 `DurableFeishuSource` 分配一个短生命周期的批次 Thread。两秒内的同一群消息进入同一批次，`Thread.evaluateAfter` 让 Core 等窗口结束后启动一次 Eval。明确 @、私聊和已有话题回复不等待这个窗口。所有原始消息仍各自保存，短窗口只影响评估批次。

Router 通过 `ProductAccess.referencedSources` 读取当前候选消息明确引用的同群、同方向历史消息。它只接受 Feishu 的 `parentId` 或 `rootId` 链接，逐条复核来源权限和内容哈希，并把引用作为资料传入评估输入。引用资料不能单独产生意图、授权或规则匹配。

工作台事件收件箱显示附件、话题回复、等待评估、正在评估和“同话题合并评估”。这些状态来自持久 Trigger、Thread、Decision 与信号审计，查看页面不会启动模型或 Worker。

## 下一步

- 把定时器、连接器回执和更多 Runner 生命周期事件接入同一审计关系，并为每类来源定义数据留存期限。
- 将短窗口从当前批次 Thread 扩展为可恢复的持久队列 flush，处理进程重启、跨进程顺序和大批量消息预算。
- 为长期委托增加事件预算、模型调用预算、失败退避和可见的等待原因。
- 在工作台增加信号时间线和 Runner 等待状态，但不把信号日志当作新的资源授权。
