# 微信云开发后端（开发环境）

云函数入口为 `cloudfunctions/apex/index.js`，调用格式为 `{ action, payload }`；返回 `{ code, data, requestId }` 或 `{ code, message, requestId }`。小程序只调用云函数，不直接访问数据库。身份取自云函数的微信上下文；`ensureUser` 在 PostgreSQL 的 `apex_private.users` 中建立账号，此后私有操作按账号和记录所有者授权。访客调用公共接口不会自动创建账号。

## 开发环境初始化

1. 在微信开发者工具中确认本小程序 AppID `wx6321ebe2a68cd778` 已关联**开发专用**云开发环境 `apex-team-mvp-d9g5f5u5h64c3c701`。腾讯云控制台创建的环境可能需要先完成[小程序关联](https://docs.cloudbase.net/quick-start/create-env)。正式环境须分开。
2. 在该环境的 PostgreSQL SQL 编辑器执行 [postgres-schema.sql](postgres-schema.sql)，再执行 [postgres-functions.sql](postgres-functions.sql)。它们创建私有 `apex_private` schema、三张表、索引，以及 `public.apex_backend_call` 数据库函数。`anon` 与 `authenticated` 没有私有 schema 或表权限。RPC 函数以调用者权限运行，并在开始时确认数据库角色是 `service_role`；这是必须保留的检查，因为 CloudBase 网关目前不强制执行 RPC 的 `GRANT EXECUTE`。
3. 从仓库根目录运行 `node scripts/generate-dev-config.js > dev-app-config.sql`，在 SQL 编辑器执行生成的语句。它只插入缺失的 `main` 配置，不覆盖现有配置。选项均来自带“测试”标记的 mock 配置，只用于开发环境。
4. 在控制台创建仅供该后端使用的 CloudBase API Key，在普通事件云函数 `apex` 的环境变量中配置 `APEX_ENV_ID=apex-team-mvp-d9g5f5u5h64c3c701` 和 `APEX_API_KEY`。该密钥具有 `service_role` 权限，只能保存在云函数环境变量，不能写入仓库或小程序。共享 PostgreSQL 实例没有可用的直连地址，因此云函数通过 CloudBase 的 RPC HTTP API 访问数据库；事务在数据库函数的一次调用内完成。
5. 在 `cloudfunctions/apex` 安装 `package.json` 依赖，部署 Node.js 18 或更高版本的普通事件云函数 `apex`（入口 `index.main`）。不要添加 HTTP 触发器。确认函数列表中存在 `apex`，并用已关联的小程序调用 `getConfig` 和 `ensureUser` 验证可信 OpenID 与数据库访问。
6. 验证 `anon` 和 `authenticated` 无法直接读写 `apex_private` 或调用 RPC 获得数据，并完成接口验收后，在 `miniprogram/config/env.js` 中设置 `apiMode: 'cloud'`。保留 `mock` 模式供本地演示。

CloudBase [RPC](https://docs.cloudbase.net/database/postgresql/rpc) 支持在数据库函数中执行原生事务。函数只接收小程序事件调用，以取得可信微信身份；数据库 RPC 只接受后端保存的 `service_role` 密钥。

## 接口与存储

- 公共接口：`getConfig`、`listPosts`、`getPost`。后两者返回公开字段，不含游戏 ID、微信身份、创建请求 ID。`getPost` 仅对已建立账号的所有者返回可操作权限。
- 登录接口：`ensureUser`，返回 `{ userId, hasActivePost, activePostId }`。
- 登录后接口：`getContact`、`createPost`、`listMyPosts`；所有者写接口：`updatePost`、`closePost`、`deletePost`。失败码与 V0.4 后端需求文档一致。
- `users.openid` 为可信 OpenID，仅云端可见，`id` 是独立的内部 UUID。`team_posts.id` 是内部用户 ID 与创建 `requestId` 的 SHA-256 摘要；相同创建请求返回首次创建结果。删除为软删除。
- 数据库时间保存为 Date，响应转为 UTC ISO 8601。到期判断不依赖定时任务；到期后列表、联系与写操作即时按失效处理。
- 大厅与我的发布按创建时间、记录 ID 倒序分页。游标是绑定筛选或当前账号的不透明字符串，筛选变化时必须从第一页重新加载。

## 联调记录

数据库回归脚本还检查了 `ANY` 段位会被具体段位筛选包含，并且删除旧记录不会清空新发布的有效引用。

2026-10-24：已在开发环境执行 schema、RPC 函数与测试配置初始化。只读检查确认三张私有表存在，`anon` 无私有 schema 使用权限，RPC 函数存在且 `service_role` 有执行权限。SQL 编辑器以 Anonymous 角色调用 `getConfig` RPC 返回 `permission denied for function apex_backend_call`。以 `service_role` 执行 [dev-rpc-smoke.sql](../tests/dev-rpc-smoke.sql) 成功，覆盖创建、重复请求、所有权、字段隐私、筛选、分页、人数变化、版本冲突、关闭、删除、到期边界及有效发布引用；整个测试事务回滚，检查无测试用户残留。`apex` 云函数代码包已上传，控制台状态为“正常”，配置页显示 Node.js 20.19、`index.main`、10 秒超时和 `APEX_ENV_ID`。API Key 配置、云函数到 RPC 的实际调用、并发创建及双用户真机验收仍待验证。部署后按 [acceptance.md](acceptance.md) 记录 A/B 双设备流程，并额外确认：客户端直接数据库读取；用户 B 不能写 A 的记录；并发创建仅有一条有效招募；旧版本写入返回 `VERSION_CONFLICT`；同一 `requestId` 重试不新建记录；到期后无需整理任务即可隐藏与拒绝联系。
