# 微信云开发后端（开发环境）

后端是一个普通事件云函数 `apex`，数据保存在云开发**文档型数据库**。小程序以 `{ action, payload }` 调用云函数，返回 `{ code, data, requestId }` 或 `{ code, message, requestId }`。小程序不直接访问数据库；用户身份取自云函数的微信上下文（OpenID），不接收客户端自报的身份。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `cloudfunctions/apex/index.js` | 入口：初始化 `wx-server-sdk`，取 OpenID，转交业务层 |
| `cloudfunctions/apex/service.js` | 业务层：输入白名单与校验、状态与权限规则、分页游标、响应与日志格式；不依赖数据库，可在 Node 中测试 |
| `cloudfunctions/apex/store.js` | 数据层：文档型数据库的读写、查询与事务 |
| `tests/cloud-backend.test.js` | 用内存 store 测试业务规则 |
| `tests/cloud-store.test.js` | 检查数据层的查询条件与调用形状 |

## 数据集合

| 集合 | `_id` | 主要字段 |
| --- | --- | --- |
| `users` | 微信 OpenID | `userId`（内部 UUID，对外返回）、`activePostId`、`createdAt` |
| `team_posts` | `p_` + SHA-256(`userId:requestId`) | `ownerId`、`modeCode`、`rankCode`、`serverCode`、`currentPlayers`、`maxPlayers`、`gameId`、`note`、`status`、`createdAt`、`updatedAt`、`expiresAt`、`deletedAt`、`version`、`createRequestId` |
| `app_config` | `main` | `modes`、`ranks`、`servers`（`{ code, name, order }`）、`limits` |

- 时间字段保存为 Date，响应转为 UTC ISO 8601。
- 记录 `_id` 由账号和创建 `requestId` 决定，同一创建请求重试命中同一条记录；重试命中已删除记录时返回 `NOT_FOUND`。
- 删除为软删除（`deletedAt`）。到期不依赖定时任务：`status` 保持 `RECRUITING`，读取时按 `expiresAt` 判定为 `EXPIRED`。
- 发布、编辑、结束、删除在事务中执行，事务内只按 `_id` 读写。“每人一条有效招募”通过事务读取 `users.activePostId` 保证；释放引用时只在它仍指向该记录时清除。
- 配置在云函数实例内缓存 60 秒，修改配置后最多 1 分钟生效。

## 开发环境初始化

当前开发环境：`apex-team-mvp-d7gut8z8x9d0cc13d`（已关联小程序 `wx6321ebe2a68cd778`）。正式环境须另建并分开配置。

1. **创建集合**：在云开发控制台 → 数据库中新建 `users`、`team_posts`、`app_config` 三个集合。
2. **设置权限**：三个集合的权限都设为客户端不可读写（简易权限选“所有用户不可读写”，或自定义安全规则 `{ "read": false, "write": false }`）。云函数使用管理员权限，不受此限制；小程序端无法直接读到游戏 ID 或 OpenID。
3. **导入配置**：在仓库根目录运行 `node scripts/generate-dev-config.js > dev-app-config.json`，在 `app_config` 集合中选择“导入”，文件格式选 JSON，导入生成的文件。选项均为带“测试”标记的开发配置；正式环境需换成确认后的清单。
4. **建立索引**（数据量小时可后补）：在 `team_posts` 上建立
   - `status` 升序、`deletedAt` 升序、`createdAt` 降序 —— 大厅查询
   - `ownerId` 升序、`deletedAt` 升序、`createdAt` 降序 —— 我的发布
5. **部署云函数**：在微信开发者工具中，确认 `cloudfunctions` 目录关联的是上述环境，右键 `cloudfunctions/apex` →“上传并部署：云端安装依赖”。运行环境 Node.js 18 或以上，超时 10 秒，不添加 HTTP 触发器，不需要环境变量。
6. **验证**：在开发者工具控制台执行：
   ```js
   for (const action of ['getConfig', 'ensureUser']) wx.cloud.callFunction({ name: 'apex', data: { action, payload: {} } }).then(r => console.log(action, JSON.stringify(r.result)), e => console.error(action, e))
   ```
   两项均返回 `"code":"OK"` 后，在 `miniprogram/config/env.js` 中设置 `apiMode: 'cloud'`，并按 [acceptance.md](acceptance.md) 完成双设备验收。保留 `mock` 模式供本地演示。

## 接口

- 公共接口：`getConfig`、`listPosts`、`getPost`。列表与详情不返回游戏 ID、OpenID 或创建请求 ID；`getPost` 只对已建立账号的所有者返回可操作权限。
- 登录接口：`ensureUser`，返回 `{ userId, hasActivePost, activePostId }`。发布、联系、我的发布等私有接口要求先调用过 `ensureUser`，否则返回 `UNAUTHENTICATED`。
- 登录后接口：`getContact`、`createPost`、`listMyPosts`；所有者写接口：`updatePost`、`closePost`、`deletePost`。错误码与 V0.4 后端需求文档一致。
- 分页按创建时间、记录 ID 倒序；游标是绑定筛选条件或当前账号的不透明字符串，筛选变化时须从第一页重新加载。
- 日志只记录追踪 ID、接口名、结果码和时间，不记录 OpenID、游戏 ID 或数据库错误原文。

## 联调记录

2026-10-25（CLI 部署）：用 CAM 子账号密钥通过 `@cloudbase/manager-node` 与 `@cloudbase/node-sdk` 完成初始化：创建三个集合，权限均为 `ADMINONLY`（已回读确认）；在 `team_posts` 建立 `hall_recent`、`mine_recent` 索引；写入 `app_config/main` 测试配置；以 ZIP 方式部署 `apex`（Nodejs20.19、`index.main`、10 秒、云端安装依赖、无触发器、无环境变量；仅授予 TCB 权限的密钥无法使用默认的 COS 上传方式）。以无微信身份方式调用已部署函数：`getConfig`、两种 `listPosts` 查询返回 `OK`，非法筛选、未知接口返回 `VALIDATION_ERROR`，不存在的记录返回 `NOT_FOUND`，`ensureUser`、`getContact`、`createPost`、`listMyPosts` 返回 `UNAUTHENTICATED`。随后在微信开发者工具控制台调用：`getConfig`、`ensureUser` 均返回 `OK`，`users` 集合生成 1 条账号记录（`userId` 与返回值一致，时间为 Date 类型），确认可信 OpenID 链路可用；前端改为 `apiMode: 'cloud'`。尚未在云端验证：发布/编辑/结束/删除与事务、游标翻页查询、双用户真机验收。

2026-10-25：后端由 PostgreSQL 改为云开发文档型数据库，开发环境迁移到本小程序自有的 `apex-team-mvp-d7gut8z8x9d0cc13d`，不再需要数据库 API Key。业务规则已用内存 store 测试（`npm test`），数据层仅做了调用形状检查。待验证：集合权限、索引、云函数部署、事务与并发创建、双用户真机验收。
