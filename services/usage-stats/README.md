# 插件使用统计服务

独立 Cloudflare Worker + D1 服务。插件通过 Agents 看板中的「发送匿名使用统计」开关自愿接入，默认关闭。共享后台在用户主动同意后，使用本地持久保存的随机 UUID v4，每个 UTC 日最多尝试上报一次；多会话共用同一个 ID，后台重启也不会重复尝试。关闭后停止后续上报，不回传历史记录，不撤回已发送的数据。

只接收随机安装 ID、插件版本；服务端生成 UTC 日期。应用不保存 IP、账号、设备指纹、路径、代码、提示词或会话 ID，不记录请求或异常正文。Cloudflare 作为网络服务提供方仍会处理连接信息；这不是平台完全不处理 IP 的承诺。

## 部署

1. 在 Cloudflare 免费套餐创建 D1 `codex-to-agents-stats`，从数据库 Console 执行 `schema.sql`。该脚本仅创建表和索引，可重复执行。
2. 创建同名 Worker，将 `worker.mjs` 完整粘贴到控制台编辑器的入口文件并部署。
3. Worker 的 Bindings 中添加 D1，变量名 `DB`，选择刚创建的数据库。关闭 Workers Logs / Observability；本服务没有 console 日志。
4. 打开部署地址的 `/health`，绑定可用应返回 `{"ok":true}`。

也可复制 `wrangler.example.toml` 为本地配置，填入真实 D1 ID，通过已授权的 Wrangler 执行 schema 和部署。不要提交任何登录凭据、API token 或私有配置。部署前检查免费额度及当前账户套餐。

## 上报约定

`POST /v1/usage`，Content-Type 为 `application/json`。正文仅允许两个字段、最多 1024 字节：

```json
{"installation_id":"e22f8408-bec2-4b25-a032-55045b383717","version":"0.1.0"}
```

UUID 大小写统一；同安装同日只有一条活动记录。版本长度最多 64，格式为三段数字和可选预发布/构建后缀。日期以服务器 UTC 日为准。成功返回 200；非法数据 400、超限 413、非 JSON 415、数据库故障 503。其他路径 404，错误方法 405。不提供 CORS 或公开统计查询端点，供本机共享后台直接请求。

这是公开写入端：随机 ID 不是身份认证，外部可伪造活跃数据。因此这些指标是“参与统计的活跃安装数”，不能当作真实人数。需要防刷时可在平台另设速率限制；超额时客户端应放弃本次上报，不能影响派工。

## 查询口径

在已登录的 D1 Console 查询。`0.0.0-smoke` 为部署验证保留版本，以下查询排除它；测试时只用随机合成 ID，不上报真实用户数据。

```sql
-- 累计激活安装数（曾成功上报的安装）。
SELECT COUNT(*) AS activated_installations FROM installations
WHERE latest_version <> '0.0.0-smoke';

-- UTC 日活。
SELECT activity_day, COUNT(*) AS active_installations FROM daily_activity
WHERE version <> '0.0.0-smoke'
GROUP BY activity_day ORDER BY activity_day DESC;

-- 今天及此前六个 UTC 日的活跃安装数。
SELECT COUNT(DISTINCT installation_id) AS weekly_active_installations
FROM daily_activity
WHERE activity_day >= date('now', '-6 days') AND activity_day <= date('now')
  AND version <> '0.0.0-smoke';
```

没有登录账号关联，一人多设备、重装或关闭统计会影响数字。当前无自动保留期清理；数据在 D1 中保留，后续可按实际需求配置保留期限。

## 本地验证

Node 22.19+：`node --test services/usage-stats/worker.test.mjs`。测试以真实 SQLite 执行生产 schema 和 SQL，并适配 D1 的 prepare/bind/first/batch；Cloudflare 平台部署仍需单独验证。
