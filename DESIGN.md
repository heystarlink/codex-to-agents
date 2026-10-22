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

后台仅监听 `127.0.0.1`，每个请求校验 Host、Origin 和私有 Bearer 值，拒绝跨站请求与重定向。认证值以 `0600` 保存到 `backend-auth.json`，不写入连接 URL、工作单或端点元数据。`/mcp` 暴露六个派工工具，`/board` 暴露看板资源和五个看板工具。采用无会话的 JSON 响应，每次请求创建和关闭 MCP 协议对象，共用后台、文件队列、看板 HTML 和一秒快照缓存。关闭某个客户端不会停止后台。

命令入口仅静态加载 Node 内置模块和进程命名工具。Hook 不导入 SDK、队列或执行器；后台第一次收到 MCP 请求时才加载 SDK，第一次读取看板时才构建 HTML，发现未完成的 Hermes 工作单、收到 Hermes `runtime_info` 查询或看板请求刷新 Hermes 模型目录时才加载消费者。模型刷新异步进行，不阻塞开关；DSH 模型查询不加载 Hermes。消费者加载后继续处理队列，模块保留在内存中。每两秒检查共享设置，配置改变或移除时关闭原内置消费者。

旧 `serve` 命令保留为仅依赖 Node 内置模块的 stdio 到 HTTP 转发，不再各自启动消费者。转发不自动重放失败的变更请求；调用方需通过原工作单编号检查结果。停止后台不发送原生取消指令，未完成单据由恢复流程检查持久回执和原生日志。

## Hermes 适配

通过 loopback Dashboard HTML 中的临时会话 token 连接 `/api/ws`，使用 JSON-RPC 创建、恢复会话，投递提示，补充指令或请求取消。模型目录和聊天管理采用原生 REST API；不读取模型密钥、不求值页面脚本、不跟随 HTTP 重定向。token 仅在内存中保留，服务重启后重新获取。

`session.create` 返回的 `stored_session_id` 作为工作单的持久会话编号，短期 `session_id` 仅用于 RPC 地址。具名自定义提供方在运行时可能只报告 `custom`，此时从该原生会话的 `model_config` 读取规范提供方编号来核对允许列表。

普通追问等前序工作单与原生会话均空闲后再发送，避免 Hermes 的默认忙碌投递策略中断当前任务或覆盖待发消息。`interrupt` 调用 `session.steer`，只回报补充指令是否受理；`cancel` 调用 `session.interrupt`，清理原生待发消息，保留尚未投递的本地工作单。

每条提示附带工作单编号，流式事件只投影当前单的可见文本，不记录推理内容。原生 `message.complete` 或 `error` 写入持久回执后，再由消费者更新终态。进程重启读取已确认回执；缺少终态时只能回显本单原生记录并保持 `uncertain`，不能从空闲状态推断成功。

## 左侧插件看板与自动派工

本地插件注册 `agents_board` HTTP MCP，连接共享后台的 `/board`，只提供看板入口、界面读取、设置保存、共享文档和更新操作，不重复注册六个派工工具。`open_panel` 声明 MCP Apps 资源和 `global` / `thread` 入口，资源采用 `text/html;profile=mcp-app`，经 `ui/initialize` 协商 2026-01-26 协议后通过宿主 `tools/call` 访问数据。消息仅接受父窗口来源，面板关闭时拒绝等待中的调用。

看板查询采用完成后延迟一秒的定时器，避免慢查询重叠。`visibilitychange`、`pagehide` 和根元素的 `IntersectionObserver` 暂停隐藏页面或缓存面板的查询；恢复可见时立即刷新。宿主关闭面板时清理定时器和观察器。界面暂停与后台消费者相互独立，工作单继续执行。多个可见面板同时查询时合并快照读取，缓存最多一秒；提交工作和保存设置后使缓存失效。

开关偏好与全局 Hook 就绪状态分别展示。共享后台按需用安装时记录的 Codex CLI 发起 `initialize`、`hooks/list`，不发送配置写请求或创建线程；查询完成关闭临时 app-server。原生 `trustStatus` 和 `enabled` 投影到看板，未信任/已修改/停用/缺失/未知均不宣称已生效。检查并发合并、缓存一分钟，用户配置或安装记录变化时提前复查；不阻塞开关和模型目录。配置就绪提示明确要求旧会话重新加载，不把全局状态当作当前会话的运行回执。

看板的派工设置保留自动派工开关、执行端、可用模型和思考强度，不展示工作单列表或进程信息。开关、执行端、可选的 `route: { provider, model }` 与可选顶层 `effort` 保存在 `delegation.json`，兼容旧配置，缺省关闭。省略模型跟随执行端默认；省略 `effort` 时新任务跟随模型默认且不显式传强度。思考强度只取该模型目录返回的 `efforts`，未提供时不虚构选项；显式强度必须与固定 route 一起保存，切换模型或执行端会清除不兼容值。固定模型依据该执行端的新鲜模型目录校验，失效时提示且不静默替换；离线仍允许关闭已有固定模型偏好。设置写入工具声明 `visibility: ["app"]`，不向模型提供自动更改偏好的工具；HTTP 监控仍拒绝写请求。切换只保存偏好，不创建工作单、修改既有任务状态或取消原生任务。

看板通过仅应用可见的 `panel_update` 检查并安装插件更新；工具只接受 `status`、`check`、`apply`，不接收客户端路径、URL 或命令。`status` 读取本地缓存，`check` 才访问已验证的项目远端，`apply` 只对服务端自己的安装目录执行默认分支快进。更新模块延迟导入；安装前核对干净工作区、快进关系和忙碌状态，阻止本地改动、分叉、离线或正在运行的任务，不 stash、reset、强推或删除未跟踪文档。完成后提示重新加载 Codex 或重启 DSH，不宣称自动重启原生应用；模型工具目录不注册该工具。更新区默认折叠，仅在用户打开或操作时查询，安装后的状态查询有限并在页面隐藏时暂停；查询预算用尽而任务仍在进行时提供只读的状态刷新，连接中断按可重试错误提示，不宣告安装失败；`pending_install` 的未完成安装即使状态为 blocked 也保留重试入口，重试只补安装而不重复合并。

插件提供 `UserPromptSubmit` Hook。经用户在 Codex 审核并信任后，每条消息读取当前开关，向 Codex 添加本轮执行端与模型偏好；新建工作单显式传递选定的 provider、model 与 effort（跟随默认时省略 effort），追问沿用原会话配置。关闭消息明确取代同一会话先前的开启偏好，默认模型选择也覆盖先前的固定模型偏好和固定强度。读取失败按关闭处理。Hook 不保存用户提示、不直接派工，也不修改全局 `AGENTS.md` 或工具权限。是否委派由 Codex 在当前有效指令下判断，不是服务端强制路由所有用户消息。

macOS 的活动监视器未必采用 `process.title`。安装时以原 Node 可执行文件的硬链接生成常驻 `agents-backend` 和短暂 `agents-hook` 启动入口；跨卷时复制可执行文件，不增加常驻包装进程，不更改原 Node 的内容或权限。`agents-board`、`agents-mcp` 仅用于旧 stdio 配置的兼容转发。看板快照附带共享服务名称、PID 与 RSS，多个面板显示相同 PID。更新配置不会中断或重命名既有运行进程。

## 共享任务文档

看板按项目名称分类轻量 SDD 任务约定。共享工作区设置指向文档实际存放目录，缺省为数据目录下的 `sdd`；项目元数据仅记录名称，各任务保存为 `<文档工作区>/<项目ID>/<任务UUID>/task.md`，模板包含目标、范围、计划和验收条件。项目分类不关联代码路径，不改变派工 `directory`。

旧版项目元数据中的代码路径只作为兼容字段读取，不再访问或展示；现有项目ID、任务ID、文件位置与内容保持。用户切换文档工作区时仅变更目录设置，旧文件保留，不自动移动或合并文档。

SDD 任务文档有独立于自动派工的持久化开关，保存在同一 `sdd-workspace.json` 的 `enabled` 字段；旧配置缺少该字段时按开启处理，读状态不创建默认目录。`set_workspace` 与 `set_enabled` 共用同一配置锁做读-改-写，互不覆盖；注册项目、创建任务和保存文档在配置锁内重新核对开关，关闭时拒绝写入，避免与并发切换竞态。配置损坏按关闭处理并拒绝写入，修复目录时不会默认开启；读取失败时看板显示可读错误并回滚开关。

文档区默认折叠，展开后才请求项目、任务与选中正文。共享快照不读取或返回任务文档，不新增轮询。普通 Markdown 的绝对路径可供 Codex 和执行 Agent 显式引用；保存文档不会自动派工或加入 Hook 上下文。开关位于折叠区之外的设置卡片，关闭后禁用文档操作、先保护未保存草稿，但仍保留已有文件、目录设置和自动派工开关。

普通模型 MCP 提供受限的 `sdd_task`，复用同一存储的工作区读取、项目分类与文档动作；`get_workspace` 返回开关状态，但不提供工作区目录或开关修改。创建任务可直接写入完整规划，看板省略正文时保留旧模板；文件大小、工作区或开关校验失败时不创建任务目录。模型调用同样使用工作区标识和文档版本，避免跨根访问或覆盖其他编辑者的修改。

开启派工的 Hook 要求 SOL 在形成明确的开发任务规划后先保存任务约定，再在派工目标中引用成功回执返回的路径；只要求规划则保存后交付，不派工。后续同任务读取并更新原文档。普通问答和讨论不创建文档，用户明确要求跳过时遵从。Hook 每条消息读取当前 SDD 开关：关闭或配置损坏时覆盖先前的文档要求，跳过保存与路径交接但仍正常派工；派工关闭而 SDD 开启时允许保存规划但不派工。Hook 不提取或持久化用户提示，实际保存由模型显式调用工具完成；保存失败或工具不可用时不能宣称已保存。

应用通过 `panel_sdd` 完成文档工作区设置、SDD 开关、项目分类、任务创建及文档读取/保存，工具仅对应用可见，存储模块延迟导入。模型可见的 `sdd_task` 不能设置开关或目录。文档限定大小与可操作文件名，拒绝非法标识和符号链接；保存核对内容版本，在多个编辑者间检测过期草稿。编辑器使用纯文本，未保存时切换、重新读取、新建或关闭开关先处理草稿，保存失败保留编辑内容与开关状态。代码和其他文档继续使用各项目原有位置。

看板资源使用 `board/v3` 地址更新宿主缓存。旧页面缺少 `workspace_id` 的文档请求在工具边界返回重新打开提示，不补齐标识或执行操作，避免写入其他看板刚切换的工作区。界面将项目/任务选择与正文编辑置于文档区主体，目录设置和新建操作放入次级折叠区；所有操作仍按需执行，样式适配浅色、深色与窄屏。

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
