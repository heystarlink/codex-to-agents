# 工作单系统设计

## 目标

通过本地工作单连接 Codex 与执行 Agent。Codex 负责规划、派工和验收，执行 Agent 负责完成任务并回传进度与结果。系统提供任务提交、状态追踪、追问和结果恢复。

当前接入 DSH 桌面端和 Hermes Agent CN Desktop。两个执行端提供模型调用、工具执行和聊天管理；桌面项目注册只由 DSH 提供。工作单省略 `executor` 时保持原有 DSH 行为，显式 `executor=hermes` 交给 Hermes。

## 本工程的设计决定

1. 以“可保存、可检查的工作单”为交互单位，统一表达执行任务与管理操作。
2. MCP 写入不可修改的请求文件、读取状态文件；DSH 插件和 Hermes 消费者分别领取属于自身执行端的请求。
3. 模型执行、追问、项目操作和聊天操作均进入同一队列。即使执行端离线，工作单也能先保存，恢复后领取。
4. 每个请求有调用者可预先生成的编号，编号与内容一一绑定。重复提交复用已有单据；内容不同则拒绝。
5. 请求与结果分开保存。任务开始交付前先记录状态；不确定是否已经交付时不重放，检查原生记录和持久回执。
6. 一个数据目录中，每个执行端只允许一个消费者，所有 MCP 客户端共用一个后台。DSH 使用原有消费者锁；Hermes 使用独立锁，由共享后台按需加载，已有独立消费者时等待它退出后接管。
7. 各执行端拥有实际会话、模型、文件工具和权限；本工程保存控制单和结果摘要，不另存模型密钥或账号凭据。

## 本地存储与运行约束

Codex 通过 Streamable HTTP 调用 MCP 工具，MCP 与执行端通过本机文件队列协作。数据目录权限为 `0700`，请求与结果文件权限为 `0600`，由同一系统账户下的进程访问。

单个数据目录允许多个 MCP 生产者，每个执行端各有一个消费者。消费者通过各自的独占锁领取队列的处理权；文件发布依赖本机文件系统的原子操作，因此数据目录需放在本机磁盘。DSH 继续使用 `consumer.lock`、`runtime.json`；Hermes 使用 `consumer-hermes.lock`、`runtime-hermes.json` 与 `hermes-receipts/`。

新消费者心跳包含 `protocol: 2`。若共享目录中仍有存活的旧版 DSH 消费者，MCP 不发布 Hermes 工作单，避免旧代码领取新执行端任务。DSH 启用命令生成包含四个模块的独立代码快照，保证重新加载时也刷新嵌套 ESM 导入；桌面未自动重载时需要重启一次。

## 共享后台和按需加载

`backend-control.mjs` 用本机健康检查和后台独占锁确保同一数据目录只有一个 `agents-backend`。并发连接启动时只有锁持有者保留服务，其余启动进程退出。`backend.json` 保存地址、PID 和实例编号，重启复用原端口；实例编号和数据目录用于核实响应属于原后台。`backend-headers` 作为 Codex 的 `http_headers_helper`，按需启动后台并向宿主提供认证头。

后台仅监听 `127.0.0.1`，每个请求校验 Host、Origin 和私有 Bearer 值，拒绝跨站请求与重定向。认证值以 `0600` 保存到 `backend-auth.json`，不写入连接 URL、工作单或端点元数据。`/mcp` 暴露六个派工工具，`/board` 暴露看板资源和三个看板工具。采用无会话的 JSON 响应，每次请求创建和关闭 MCP 协议对象，共用后台、文件队列、看板 HTML 和一秒快照缓存。关闭某个客户端不会停止后台。

命令入口仅静态加载 Node 内置模块和进程命名工具。Hook 不导入 SDK、队列或执行器；后台第一次收到 MCP 请求时才加载 SDK，第一次读取看板时才构建 HTML，发现未完成的 Hermes 工作单或收到 Hermes `runtime_info` 查询时才加载消费者。只读看板不会唤起 Hermes 连接。消费者加载后继续处理队列，模块保留在内存中。每两秒检查共享设置，配置改变或移除时关闭原内置消费者。

旧 `serve` 命令保留为仅依赖 Node 内置模块的 stdio 到 HTTP 转发，不再各自启动消费者。转发不自动重放失败的变更请求；调用方需通过原工作单编号检查结果。停止后台不发送原生取消指令，未完成单据由恢复流程检查持久回执和原生日志。

## Hermes 适配

通过 loopback Dashboard HTML 中的临时会话 token 连接 `/api/ws`，使用 JSON-RPC 创建、恢复会话，投递提示，补充指令或请求取消。模型目录和聊天管理采用原生 REST API；不读取模型密钥、不求值页面脚本、不跟随 HTTP 重定向。token 仅在内存中保留，服务重启后重新获取。

`session.create` 返回的 `stored_session_id` 作为工作单的持久会话编号，短期 `session_id` 仅用于 RPC 地址。具名自定义提供方在运行时可能只报告 `custom`，此时从该原生会话的 `model_config` 读取规范提供方编号来核对允许列表。

普通追问等前序工作单与原生会话均空闲后再发送，避免 Hermes 的默认忙碌投递策略中断当前任务或覆盖待发消息。`interrupt` 调用 `session.steer`，只回报补充指令是否受理；`cancel` 调用 `session.interrupt`，清理原生待发消息，保留尚未投递的本地工作单。

每条提示附带工作单编号，流式事件只投影当前单的可见文本，不记录推理内容。原生 `message.complete` 或 `error` 写入持久回执后，再由消费者更新终态。进程重启读取已确认回执；缺少终态时只能回显本单原生记录并保持 `uncertain`，不能从空闲状态推断成功。

## 左侧插件看板与自动派工

本地插件注册 `agents_board` HTTP MCP，连接共享后台的 `/board`，只提供看板入口、界面读取和设置保存，不重复注册六个派工工具。`open_panel` 声明 MCP Apps 资源和 `global` / `thread` 入口，资源采用 `text/html;profile=mcp-app`，经 `ui/initialize` 协商 2026-01-26 协议后通过宿主 `tools/call` 访问数据。消息仅接受父窗口来源，面板关闭时拒绝等待中的调用。

看板查询采用完成后延迟一秒的定时器，避免慢查询重叠。`visibilitychange`、`pagehide` 和根元素的 `IntersectionObserver` 暂停隐藏页面或缓存面板的查询；恢复可见时立即刷新。宿主关闭面板时清理定时器和观察器。界面暂停与后台消费者相互独立，工作单继续执行。多个可见面板同时查询时合并快照读取，缓存最多一秒；提交工作和保存设置后使缓存失效。

开关与执行端保存在 `delegation.json`，缺省关闭。设置写入工具声明 `visibility: ["app"]`，不向模型提供自动更改偏好的工具；HTTP 监控仍拒绝写请求。切换只保存偏好，不创建工作单、修改既有任务状态或取消原生任务。

插件提供 `UserPromptSubmit` Hook。经用户在 Codex 审核并信任后，每条消息读取当前开关，向 Codex 添加本轮偏好；关闭消息明确取代同一会话先前的开启偏好。读取失败按关闭处理。Hook 不保存用户提示、不直接派工，也不修改全局 `AGENTS.md` 或工具权限。是否委派由 Codex 在当前有效指令下判断，不是服务端强制路由所有用户消息。

macOS 的活动监视器未必采用 `process.title`。安装时以原 Node 可执行文件的硬链接生成常驻 `agents-backend` 和短暂 `agents-hook` 启动入口；跨卷时复制可执行文件，不增加常驻包装进程，不更改原 Node 的内容或权限。`agents-board`、`agents-mcp` 仅用于旧 stdio 配置的兼容转发。看板快照附带共享服务名称、PID 与 RSS，多个面板显示相同 PID。更新配置不会中断或重命名既有运行进程。

## 官方接口依据

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)：Streamable HTTP 工具发现、调用和旧 stdio 转发。
- [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)：HTTP 连接与 `http_headers_helper`。
- [MCP Apps 快速开始](https://developers.openai.com/plugins/build/app-quickstart)：无会话 HTTP 服务和 MCP Apps 资源。
- [OpenAI 插件 Sidebar apps 扩展](https://developers.openai.com/plugins/build/extensions)：左侧入口和会话面板入口。
- [Codex 插件 Hook](https://learn.chatgpt.com/docs/hooks)：`UserPromptSubmit` 上下文输出及用户信任要求。
- [DSH 插件入口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)：Cordis 生命周期和依赖注入。
- [DSH 会话控制器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)：创建、追问、取消、重命名、请求关联编号。
- [DSH 项目控制器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/workspace-controller/README.md)：项目注册、重命名、移除、会话归档与恢复。
- [官方 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.zh.md)：不提供桌面项目注册、归档和原生 steer；因此无法单独覆盖此次目标。
- [Hermes CN Core REST/认证源码](https://github.com/Eynzof/Hermes-CN-Core/blob/8cbf6b37bac168197428793a0b2352388dfe0cd1/hermes_cli/web_server.py)：本地 Dashboard 临时 token、模型目录、聊天 REST 与 WebSocket 入口。
- [Hermes CN Core 会话协议源码](https://github.com/Eynzof/Hermes-CN-Core/blob/8cbf6b37bac168197428793a0b2352388dfe0cd1/tui_gateway/server.py)：`session.create/resume/activate`、`prompt.submit`、`session.steer/interrupt` 与终态事件。

## 首版边界

支持单机桌面工作流。文件队列依赖本机文件系统的原子发布能力，不用于网络共享盘。并发只串行化各执行端的控制请求；不同会话仍可能并行执行。任务中的文件修改范围由主控安排，执行端负责工具权限。按显式 executor 分流，不自动选择模型或合并代码。

Hermes 适配已核对 CN Desktop 0.6.3 / runtime 0.18.2-cn.2；不支持远程 OAuth Dashboard、其他 profile 的切换或 DSH 式桌面项目注册。模型目录表示已配置，不保证凭据仍有效；实际提供方拒绝会保留为失败结果。

停止消费者不会主动发送任务取消指令。需要停止模型工作时先提交取消单，再关闭消费者。原生运行时自身的断线会话回收策略仍然生效。
