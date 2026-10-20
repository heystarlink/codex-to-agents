# 工作单系统设计

## 目标

通过本地工作单连接 Codex 与执行 Agent。Codex 负责规划、派工和验收，执行 Agent 负责完成任务并回传进度与结果。系统提供任务提交、状态追踪、追问和结果恢复。

当前执行端接入为 DSH 桌面端，由该接入提供模型调用、工具执行，以及桌面聊天、项目、归档和恢复管理。其他 Agent 尚未接入。

## 本工程的设计决定

1. 以“可保存、可检查的工作单”为交互单位，统一表达执行任务与管理操作。
2. MCP 写入不可修改的请求文件、读取状态文件；DSH 插件主动领取请求，通过文件队列交换任务与结果。
3. 模型执行、追问、项目操作和聊天操作均进入同一队列。即使 DSH 离线，工作单也能先保存，恢复后领取。
4. 每个请求有调用者可预先生成的编号，编号与内容一一绑定。重复提交复用已有单据；内容不同则拒绝。
5. 请求与结果分开保存。任务开始交付前先记录状态；不确定是否已经交付时不重放，读取 DSH 日志恢复结果。
6. MCP 与 DSH 插件分别负责生产和消费；只有 DSH 插件更新执行状态。一个数据目录只允许一个消费者，MCP 客户端可以有多个。
7. DSH 桌面是实际会话、模型、文件工具和权限的拥有者；本工程保存的是控制单和结果摘要，不另存账号凭据。

## 本地存储与运行约束

Codex 通过 stdio 调用 MCP 工具，MCP 与执行端通过本机文件队列协作。数据目录权限为 `0700`，请求与结果文件权限为 `0600`，由同一系统账户下的进程访问。

单个数据目录允许多个 MCP 生产者、一个执行端消费者。消费者通过独占锁领取队列的处理权；文件发布依赖本机文件系统的原子操作，因此数据目录需放在本机磁盘。

## 官方接口依据

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)：stdio 工具发现和调用。
- [DSH 插件入口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)：Cordis 生命周期和依赖注入。
- [DSH 会话控制器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)：创建、追问、取消、重命名、请求关联编号。
- [DSH 项目控制器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/workspace-controller/README.md)：项目注册、重命名、移除、会话归档与恢复。
- [官方 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.zh.md)：不提供桌面项目注册、归档和原生 steer；因此无法单独覆盖此次目标。

## 首版边界

支持单机桌面工作流。文件队列依赖本机文件系统的原子发布能力，不用于网络共享盘。并发只串行化控制请求；运行中的不同 DSH 会话仍可能并行执行。任务中的文件修改范围由主控安排，DSH 负责工具权限。没有自动任务路由、自动合并代码或后台无人值守业务策略。

关闭插件只停止领取新单和刷新状态，不取消 DSH 已经接收的工作。需要停止模型工作时先提交取消单，再关闭插件。
