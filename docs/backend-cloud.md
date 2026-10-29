# 微信云开发后端（开发环境）

后端是一个普通事件云函数 `apex`，数据保存在云开发**文档型数据库**。小程序以 `{ action, payload }` 调用云函数，返回 `{ code, data, requestId }` 或 `{ code, message, requestId }`。小程序不直接访问数据库；用户身份取自云函数的微信上下文（OpenID），不接收客户端自报的身份。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `cloudfunctions/apex/index.js` | 入口：初始化 `wx-server-sdk`，取 OpenID，转交业务层 |
| `cloudfunctions/apex/service.js` | 业务层：输入白名单与校验、状态与权限规则、分页游标、响应与日志格式；不依赖数据库，可在 Node 中测试 |
| `cloudfunctions/apex/store.js` | 数据层：文档型数据库的读写、查询与事务 |
| `cloudfunctions/apex/wechat.js` | 微信开放能力：内容安全检测（msgSecCheck）、订阅消息发送 |
| `cloudfunctions/apex/config.json` | 云调用权限声明：`security.msgSecCheck`、`subscribeMessage.send` |
| `tests/cloud-backend.test.js` | 用内存 store 测试业务规则 |
| `tests/cloud-store.test.js` | 检查数据层的查询条件与调用形状 |

## 数据集合

| 集合 | `_id` | 主要字段 |
| --- | --- | --- |
| `users` | 微信 OpenID | `userId`（内部 UUID，对外返回）、`activePostId`、`lastGameId`、`createdAt` |
| `team_posts` | `p_` + SHA-256(`userId:requestId`) | `ownerId`、`modeCode`、`rankCode`、`serverCode`、`currentPlayers`、`maxPlayers`、`remainingSlots`、`gameId`、`note`、`status`、`createdAt`、`updatedAt`、`expiresAt`、`deletedAt`、`version`、`createRequestId`、`teamInfo`（组队方式，仅发布者与已同意的申请人可见）、`teamInfoUpdatedAt` |
| `join_requests` | `r_` + SHA-256(`postId:applicantUserId`) | `postId`、`postOwnerId`、`applicantId`、`applicantGameId`、`message`、`status`、`createdAt`、`updatedAt`、`decidedAt` |
| `reports` | `rp_` + SHA-256(`postId:reporterUserId`) | `postId`、`postOwnerId`、`reporterId`、`reason`、`detail`、`snapshot`（举报时的游戏 ID、备注等）、`status`（OPEN / RESOLVED）、`createdAt` |
| `app_config` | `main` | `modes`（含 `maxPlayers`）、`ranks`、`servers`、`reportReasons`（`{ code, name, order, enabled }`）、`limits`、`notify` |

- 时间字段保存为 Date，响应转为 UTC ISO 8601。
- 记录 `_id` 由账号和创建 `requestId` 决定，同一创建请求重试命中同一条记录；重试命中已删除记录时返回 `NOT_FOUND`。
- 删除为软删除（`deletedAt`）。到期不依赖定时任务：`status` 保持 `RECRUITING`，读取时按 `expiresAt` 判定为 `EXPIRED`。
- 发布、编辑、结束、删除在事务中执行，事务内只按 `_id` 读写。“每人一条有效招募”通过事务读取 `users.activePostId` 保证；释放引用时只在它仍指向该记录时清除。
- 配置在云函数实例内缓存 60 秒，修改配置后最多 1 分钟生效。
- 申请 `_id` 由信息和申请人决定，每人对每条信息只有一条申请。同意申请在事务中完成人数 +1 与满员判断。
- 发布、编辑、申请前调用内容安全检测；检测异常时拒绝写入。订阅消息发送失败只记录日志。

## 开发环境初始化

当前开发环境：`apex-team-mvp-d7gut8z8x9d0cc13d`（已关联小程序 `wx6321ebe2a68cd778`）。正式环境须另建并分开配置。

1. **创建集合**：在云开发控制台 → 数据库中新建 `users`、`team_posts`、`join_requests`、`reports`、`app_config` 五个集合。
2. **设置权限**：所有集合的权限都设为客户端不可读写（简易权限选“所有用户不可读写”，或自定义安全规则 `{ "read": false, "write": false }`）。云函数使用管理员权限，不受此限制；小程序端无法直接读到游戏 ID 或 OpenID。
3. **导入配置**：在仓库根目录运行 `node scripts/generate-dev-config.js > dev-app-config.json`，在 `app_config` 集合中选择“导入”，文件格式选 JSON，导入生成的文件。选项均为带“测试”标记的开发配置；正式环境需换成确认后的清单。
4. **建立索引**（数据量小时可后补）：在 `team_posts` 上建立
   - `status` 升序、`deletedAt` 升序、`createdAt` 降序 —— 大厅查询
   - `ownerId` 升序、`deletedAt` 升序、`createdAt` 降序 —— 我的发布
   - `join_requests` 上：`postId` 升序、`status` 升序 —— 申请列表与待处理数量
5. **部署云函数**：在微信开发者工具中，确认 `cloudfunctions` 目录关联的是上述环境，右键 `cloudfunctions/apex` →“上传并部署：云端安装依赖”。运行环境 Node.js 18 或以上，超时 10 秒，不添加 HTTP 触发器，不需要环境变量。`config.json` 中声明的云调用权限随部署生效。
6. **订阅消息（可选）**：在小程序后台 → 订阅消息中选用一个“入队申请/新申请提醒”类的一次性订阅模板，然后把以下内容写入 `app_config/main.notify`：
   ```json
   {
     "templateId": "模板 ID",
     "fields": { "applicant": "thing1", "post": "thing2", "time": "time3" },
     "miniprogramState": "formal"
   }
   ```
   `fields` 把云函数提供的值（`applicant` 申请人游戏 ID、`post` 队伍概要、`message` 留言、`content` 申请内容即“申请加入＋模式＋留言或服务器”、`time` 北京时间）对应到模板的关键词键名，键名以模板详情为准；`miniprogramState` 为点击通知打开的版本：`developer`、`trial` 或 `formal`。`templateId` 为空时不请求订阅、不发送通知。
7. **验证**：在开发者工具控制台执行：
   ```js
   for (const action of ['getConfig', 'ensureUser']) wx.cloud.callFunction({ name: 'apex', data: { action, payload: {} } }).then(r => console.log(action, JSON.stringify(r.result)), e => console.error(action, e))
   ```
   两项均返回 `"code":"OK"` 后，在 `miniprogram/config/env.js` 中设置 `apiMode: 'cloud'`，并按 [acceptance.md](acceptance.md) 完成双设备验收。保留 `mock` 模式供本地演示。

## 举报处理

在云开发控制台 → 数据库 → `reports` 中按 `status = OPEN` 查看举报。核实违规后，在 `team_posts` 中把对应记录的 `deletedAt` 设为当前时间（软删除，大厅、详情和联系接口立即不可见），并把举报的 `status` 改为 `RESOLVED`。`snapshot` 保存了举报当时的内容，即使信息已被修改也能核查。

## 接口

- 公共接口：`getConfig`、`listPosts`、`getPost`。列表与详情不返回游戏 ID、OpenID 或创建请求 ID；`getPost` 只对已建立账号的所有者返回可操作权限。
- 登录接口：`ensureUser`，返回 `{ userId, hasActivePost, activePostId }`。发布、联系、我的发布等私有接口要求先调用过 `ensureUser`，否则返回 `UNAUTHENTICATED`。
- 登录后接口：`getContact`、`createPost`、`listMyPosts`；所有者写接口：`updatePost`、`closePost`、`deletePost`、`updateTeamInfo`。错误码与 V0.4 后端需求文档一致。
- 分页按创建时间、记录 ID 倒序；游标是绑定筛选条件或当前账号的不透明字符串，筛选变化时须从第一页重新加载。
- 日志只记录追踪 ID、接口名、结果码和时间，不记录 OpenID、游戏 ID 或数据库错误原文。

## 联调记录

2026-10-29（组队方式）：以 ZIP 方式重新部署 `apex`，新增 `updateTeamInfo`。无微信身份调用：`getConfig`、`listPosts` 返回 `OK`（列表不含 `teamInfo`），`updateTeamInfo` 返回 `UNAUTHENTICATED`。`app_config/main.limits` 未写入 `teamInfoMaxLength`，前后端均按默认 100 处理。待在小程序中验证：房主保存、已同意申请人可见。

2026-10-25（V0.5 部署）：新建 `join_requests` 集合（`ADMINONLY`，索引 `post_status`）；`app_config/main` 由测试配置替换为正式清单（8 个模式含人数上限、9 个段位、12 个服务器含“不限”“其他”，`notify.templateId` 为空）；迁移 1 条仍有效的旧记录（`TEST_FRANKFURT` → `FRANKFURT`，补 `remainingSlots`）；以 ZIP 方式重新部署 `apex`（含 `config.json` 云调用权限声明）。无微信身份调用：`getConfig`、`listPosts`（含新服务器代码筛选）返回 `OK`，旧服务器代码筛选返回 `VALIDATION_ERROR`，新增的申请接口均返回 `UNAUTHENTICATED`。待在小程序中验证：内容安全检测（需 OpenID）、申请与同意流程、订阅消息（模板 ID 尚未配置）。

2026-10-25（CLI 部署）：用 CAM 子账号密钥通过 `@cloudbase/manager-node` 与 `@cloudbase/node-sdk` 完成初始化：创建三个集合，权限均为 `ADMINONLY`（已回读确认）；在 `team_posts` 建立 `hall_recent`、`mine_recent` 索引；写入 `app_config/main` 测试配置；以 ZIP 方式部署 `apex`（Nodejs20.19、`index.main`、10 秒、云端安装依赖、无触发器、无环境变量；仅授予 TCB 权限的密钥无法使用默认的 COS 上传方式）。以无微信身份方式调用已部署函数：`getConfig`、两种 `listPosts` 查询返回 `OK`，非法筛选、未知接口返回 `VALIDATION_ERROR`，不存在的记录返回 `NOT_FOUND`，`ensureUser`、`getContact`、`createPost`、`listMyPosts` 返回 `UNAUTHENTICATED`。随后在微信开发者工具控制台调用：`getConfig`、`ensureUser` 均返回 `OK`，`users` 集合生成 1 条账号记录（`userId` 与返回值一致，时间为 Date 类型），确认可信 OpenID 链路可用；前端改为 `apiMode: 'cloud'`。尚未在云端验证：发布/编辑/结束/删除与事务、游标翻页查询、双用户真机验收。

2026-10-25：后端由 PostgreSQL 改为云开发文档型数据库，开发环境迁移到本小程序自有的 `apex-team-mvp-d7gut8z8x9d0cc13d`，不再需要数据库 API Key。业务规则已用内存 store 测试（`npm test`），数据层仅做了调用形状检查。待验证：集合权限、索引、云函数部署、事务与并发创建、双用户真机验收。
