# 进阶手册

[返回产品介绍和入门教程](../README.md)

日常使用可以直接在 Codex 里提需求。本页用于调整接入配置、直接调用 MCP 工具，以及维护本地后台。

## 配置执行端

所有命令在仓库目录中运行。默认数据目录是 `~/.codex-to-agents`；执行端接入、插件安装和管理命令应使用同一个 `--home`。

| 参数 | 适用场景 | 默认值或规则 |
|---|---|---|
| `--home` | 接入、插件安装、后台、监控等命令 | `~/.codex-to-agents`；位于本机磁盘，使用同一系统账户 |
| `--directory` | 启用执行端，设置默认任务目录 | 数据目录下的 `workspace/`；具体任务可以指定其他绝对目录 |
| `--provider` | DSH 必填；Hermes 可选 | 已配置的提供方 ID，多个 ID 用逗号分隔；作为允许列表 |
| `--codex` | `enable`、`disable`、`plugin-install` | 默认从 PATH 查找 `codex`；也可传入 CLI 的绝对路径 |
| `--profile` | DSH 接入 | 默认 `desktop` |
| `--dsh-home` | DSH 接入 | 默认 `~/.dsh` |
| `--hermes-url` | Hermes 接入 | 默认 `http://127.0.0.1:9120`，仅支持本机 loopback Dashboard |
| `--hermes-token-env` | Hermes 接入 | 可选，存放 Dashboard token 的环境变量名 |

下面以 Hermes Dashboard 运行在本机 9121 端口为例：

```bash
node src/command.mjs enable --executor hermes \
  --hermes-url http://127.0.0.1:9121 \
  --directory "$HOME/codex-agents-demo"
```

省略 Hermes `--provider` 时使用模型目录中的已配置提供方，任务可选择模型或使用 Hermes 当前默认模型。Hermes 自身的模型回退由 Hermes 管理。DSH 不会因提供方不可用而由本工程自动切换到其他提供方。

可先调用 `runtime_info` 查看提供方与模型 ID。显式指定模型时，使用目录返回的 ID；目录表示已配置，不保证模型凭据或上游服务此刻可用。

Hermes 的本地 Dashboard 临时 token 仅在内存中使用，不保存到工作单或配置。使用 `--hermes-token-env` 时，环境变量需对运行后台的进程可见；它不是模型 API 密钥。当前不支持远程 OAuth Dashboard 或切换 Hermes profile。

## 自动派工设置

看板将开关和执行端保存到所选数据目录的 `delegation.json`，默认关闭，默认执行端为 Hermes。设置对使用该插件和数据目录的本机 Codex 会话共享生效。

插件的 `UserPromptSubmit` Hook 经用户信任后，在每条用户消息到来时读取当前设置，并给 Codex 添加本轮派工偏好。设置读取失败按关闭处理。Hook 不投递任务、不记录用户提示、不修改全局 `AGENTS.md` 或工具权限；具体是否委派由 Codex 按需求和有效指令判断。

开关只影响后续主动派工。已提交的任务继续跟进，明确指定 Agent 的请求仍按用户要求处理。设置写入工具仅对插件界面开放；浏览器监控保持只读。

## 直接调用 MCP 工具

下面的 JSON 是 MCP 工具的 `arguments` 示例。常规聊天无需手写 JSON，直接用自然语言说明目标即可。

| 工具 | 用途 |
|---|---|
| `runtime_info` | 读取执行端心跳、模型目录和当前派工偏好 |
| `work_submit` | 保存执行任务，立即返回工作单编号 |
| `work_update` | 保存追问、补充或取消单 |
| `work_inspect` | 读取某份工作单，或列出最近工作单 |
| `workspace_control` | 保存 DSH 项目列表、注册、改名或移除操作 |
| `conversation_control` | 保存聊天列表、改名、归档或恢复操作 |

所有变更操作先返回工作单编号。项目列表和聊天列表同样通过工作单取得，再用 `work_inspect` 读取结果。

### 检查执行端

给 `runtime_info` 传入：

```json
{ "executor": "hermes" }
```

Hermes 模型目录位于 `snapshot.catalog.models`。省略参数时返回两个执行端，位于 `executors.dsh` 和 `executors.hermes`。查询 Hermes 时会按需启动其消费者。

模型目录每 15 秒更新一次，心跳每轮更新；超过 6 秒未更新显示为离线。心跳证明最近有响应，不代表任务已成功。

### 提交和读取任务

给 `work_submit` 传入以下示例。此处 UUID 是示例请求编号，实际使用时为每份新任务生成新的 UUID；使用接入时配置的默认目录和 Hermes 默认模型：

```json
{
  "order_id": "7d2615b6-a00f-42cb-8261-39900ec7c177",
  "executor": "hermes",
  "goal": "在默认任务目录创建 hello.js，输出 Hello, World!。只修改这个文件。",
  "title": "Hello World"
}
```

需要选择目录、提供方或模型时，添加 `directory`、`provider`、`model` 和可选 `effort`。`directory` 为执行端可访问的绝对目录，且应已存在。省略 `executor` 的底层工具请求使用 DSH；看板里的默认执行端不会改写这个工具默认值。

读取上面的示例请求，给 `work_inspect` 传入：

```json
{ "order_id": "7d2615b6-a00f-42cb-8261-39900ec7c177" }
```

相同编号和相同参数只发布一次；同一个编号绑定不同内容会被拒绝。响应丢失时，用原编号和原参数检查或重试，避免换编号盲目重放。

### 继续任务或请求取消

给 `work_update` 传入以下参数，继续上面的示例任务：

```json
{
  "target_order": "7d2615b6-a00f-42cb-8261-39900ec7c177",
  "action": "append",
  "message": "把输出改为 Hello, Agents!，仍只修改 hello.js，并运行验证。"
}
```

`target_order` 继承原任务的执行端，不能改成另一执行端。也可用 `conversation_id` 替代 `target_order`，二者只能选一个；直接指向 Hermes 原生聊天时，需显式传入 `executor: "hermes"`。

| `action` | 行为 |
|---|---|
| `append` | 追问；Hermes 等前序工作单和原生会话均空闲后再投递 |
| `interrupt` | 补充指令；Hermes 使用原生 steer，受理成功不代表执行结束 |
| `cancel` | 请求取消当前活动；不需要 `message`，原任务状态需另行检查 |

Hermes 的取消会清理原生待发消息，但本工程尚未投递的追问单仍保留。DSH 会保留原生排队消息。已经开始的工具操作不保证立即中断。

### 管理项目和聊天

`workspace_control` 仅支持 DSH，提供 `list`、`register`、`rename`、`remove`。Hermes 使用任务目录，不支持 DSH 式桌面项目注册。移除 DSH 项目注册保留文件与聊天历史。

`conversation_control` 对两个执行端均提供 `list`、`rename`、`archive`、`restore`。操作已有聊天时，使用 `work_inspect` 返回的 `conversation_id`；它与工作单编号不同。归档运行中的聊天需显式设置 `stop_running: true`。管理操作不是跨系统事务，失败后需核对是否已产生部分变更。

### 理解任务状态

| 状态 | 含义与下一步 |
|---|---|
| `queued` | 已保存，等待所选执行端领取 |
| `dispatching` | 正在创建会话或交付操作 |
| `executing` | 已提交给执行端，继续查看进度 |
| `completed` | 已取得完成结果，仍需核对实际产物 |
| `failed` | 执行失败，查看错误及原生记录 |
| `blocked` | 已阻塞，按错误原因处理 |
| `cancelled` | 已取消，核对原生执行状态 |
| `uncertain` | 交付或终态不明，先检查原生聊天和文件，系统不自动重投 |

任务、状态和结果保存在本机。执行端离线时，工具仍可保存工作单；执行端恢复后继续领取。自动派工流程会先检查在线状态。

Hermes 原生终态先保存到持久回执，重启后恢复已确认结果。若断线期间漏掉终态，只展示本单原生记录并保持 `uncertain`，不会把“会话已空闲”当作任务成功。

## 管理共享后台

```bash
node src/command.mjs backend status
node src/command.mjs backend restart
node src/command.mjs backend stop
```

同一数据目录的 `/mcp` 派工连接和 `/board` 看板连接共用一个 `agents-backend`。后台仅监听 `127.0.0.1`；Codex 的 `http_headers_helper` 在建立连接时确保后台已启动，并提供本机私有认证头。认证值保存在 `backend-auth.json`，权限为 `0600`，不放进 URL 或插件配置。

重启复用原端口，保留工作单与原生会话。停止后台不会取消执行端已接收的任务，也不会卸载插件；之后新建 MCP 连接会按需启动后台。

旧 `serve` 命令保留为 stdio 到共享 HTTP 后台的轻量转发。旧命令显式传入 `--hermes-url` 时，会将该设置保存为数据目录共用的 Hermes 配置。

共享后台会处理尚未完成的 Hermes 工作，关闭某个客户端不会停止它。需要单独在前台调试消费者时，可运行：

```bash
node src/command.mjs worker --executor hermes
```

同一数据目录只允许一个 Hermes 消费者。已有独立消费者时，共享后台等它退出后按需接管。

## 使用终端或浏览器监控

查看一次终端快照：

```bash
node src/command.mjs monitor --once
```

打开本机浏览器监控服务：

```bash
node src/command.mjs monitor --web
```

浏览器打开终端打印的地址，默认端口 `18862`，用 Ctrl+C 停止监控服务。浏览器监控只读，自动派工开关需在 Codex 内嵌看板中设置。

这里的浏览器服务是单独启动的可选监控入口，不是插件后台的 `/board` MCP 地址；不要把两个端口混用。进程信息对应当前提供快照的服务。查看派工共享后台 PID 时，使用 Codex 内嵌看板或 `backend status`。

## 更新与停用

### 更新已有安装

更新代码并安装依赖后，重新生成和安装插件，再重启后台与 Codex：

```bash
npm ci
node src/command.mjs plugin-install
node src/command.mjs backend restart
```

只使用派工工具时，可以重新执行对应执行端的 `enable` 代替安装看板。更新 DSH 插件源码后，需要重新执行 DSH 接入命令并重启 DSH，使其载入新的代码快照。

从旧版 stdio 连接升级时，重启 Codex 以载入新的 HTTP 配置。若 DSH 仍运行不区分执行端的旧消费者，系统会拒绝保存 Hermes 单据；重新启用 DSH 并重启它后再试。

### 停用某个执行端

停用 Hermes：

```bash
node src/command.mjs disable --executor hermes
```

共享后台会在约两秒内读取新设置并关闭内置 Hermes 消费者，保留 MCP 注册、DSH 设置和工作单。独立启动的 `worker` 需另外退出。

停用 DSH：

```bash
node src/command.mjs disable
```

该命令卸载 DSH 执行插件；未启用 Hermes 时也移除派工 MCP 注册。DSH 仍需完成配置重载，未自动生效时重启 DSH。插件看板与共享后台仍可独立存在，单据、文件和备份保留。

停用执行端前，可以先关闭自动派工，避免新的自动任务。需要停止已经接收的工作时，先提交取消请求并核对结果；退出消费者或停止后台不会主动取消原生任务。

## 开发与验证

自动测试：

```bash
npm test
```

覆盖工作单发布、幂等提交、消费者排他、恢复、模型限制、结果关联、HTTP 共享后台、stdio 转发和看板隐藏/恢复。2026-10-22 最近一次代码自检为 40 项通过；这不等于所有模型和客户端组合都完成业务验收。

DSH 实机脚本：

```bash
node scripts/desktop-check.mjs
```

脚本使用 DSH `desktop` profile 和 `deepseek-account` / `deepseek-flash`，临时加载测试执行插件并发送少量真实模型请求；如果已有本工程的消费者插件，则拒绝修改现有配置。报告保存在 `.local/latest-check.json`，结束后恢复测试插件配置。

Hermes 实机脚本：

```bash
node scripts/hermes-check.mjs
```

使用 Hermes 当前默认模型，可通过 `--provider` 和 `--model` 覆盖。在独立目录内验证文件产出、幂等重试、两条排队追问、共享连接、后台重启及聊天管理，会产生少量真实模型请求。测试聊天在结束时归档并关闭其原生运行资源，测试后台随后停止。报告保存在 `.local/latest-hermes-check.json`。

2026-10-22 最近一轮 Hermes 文件产出验收在两个已配置模型上超时，未通过完整流程验收；共享连接、按需启动、原生会话管理和后台重启另行验证通过。未证实的超时根因不作为上游故障结论。

源码职责、持久化和恢复策略见[设计说明](../DESIGN.md)。正式发布前还需确定本工程许可证并审核依赖许可。
