# apex-team

Apex 组队微信小程序（微信原生小程序前端）。需求见 [apex-team-frontend-requirements.md](apex-team-frontend-requirements.md) 与 [apex-team-backend-requirements.md](apex-team-backend-requirements.md)（V0.5）。游戏模式、段位、服务器清单见 [Apex_Lists_2026-10-25.md](Apex_Lists_2026-10-25.md)，配置来源为 `miniprogram/services/mock/fixtures.js`。

当前进度：需求文档第 5 节步骤 1–4 已完成（四个页面、复用组件、统一接口层、模拟后端、登录引导、复制联系、编辑/结束/删除、状态与错误提示）。前端已接入开发环境的云函数后端；步骤 5 的真机联调与验收待进行。

## 预览

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
2. 选择“导入项目”，目录选本仓库根目录。AppID 可先用测试号（`project.config.json` 中为 `touristappid`）；接入云开发时需改为正式 AppID。
3. 默认连接开发环境的云函数后端（`miniprogram/config/env.js` 中 `apiMode: 'cloud'`）。如需离线演示，改为 `apiMode: 'mock'`：页面顶部会显示“模拟模式”提示，数据只保存在本机缓存，不会真实发布。
4. 修改代码后若开发者工具仍显示旧内容（项目位于 WSL 时常见），点击“清缓存 → 清除全部缓存”后重新编译。

### 模拟调试面板

“我的发布”页底部（仅模拟模式）提供：

- **切换模拟用户 A / B**：用于验证非本人看不到管理入口、第 6 节双用户流程。
- **模拟网络故障**：所有请求失败，用于检查加载失败与重试。
- **退出登录**、**重置模拟数据**：示例数据发布 2 小时后会全部过期，重置后重新生成。

## 目录结构

```
miniprogram/
  config/env.js            运行模式：mock | cloud，云函数名
  services/
    api.js                 统一接口调用层（页面只通过这里访问后端）
    transport-cloud.js     真实后端：wx.cloud.callFunction
    mock/                  模拟后端（按接口约定实现业务规则）与测试配置
  utils/                   登录、配置缓存、校验、错误提示、时间格式等
  components/
    post-card/             组队卡片
    post-form/             发布/编辑共用表单
    state-view/            加载中 / 空数据 / 失败重试
    mock-banner/           模拟模式提示
  pages/
    hall/                  组队大厅（筛选、下拉刷新、分页）
    publish/               发布组队；带 ?id= 时为编辑
    detail/                组队详情与复制联系
    mine/                  我的发布
cloudfunctions/apex/       云函数后端（业务层 service.js + 文档型数据库 store.js）
tests/                     Node 测试（模拟后端、页面冒烟、云函数业务层）
docs/acceptance.md         验收清单与真机验证记录
```

## 测试

```
npm test
```

无需安装依赖（需要 Node 18 及以上）。测试覆盖模拟后端的业务规则（含第 6 节最小端到端流程）以及页面逻辑的主要流程。WXML 渲染不在测试范围内，需在开发者工具和真机中确认。

## 接入真实后端

后端为云函数 `cloudfunctions/apex` + 云开发文档型数据库。集合、权限、索引、配置导入及部署步骤见 [docs/backend-cloud.md](docs/backend-cloud.md)。

1. 在 `miniprogram/config/env.js` 中设置 `apiMode: 'cloud'`，并填写 `cloudEnv` 和 `cloudFunctionName`。
2. 前端以 `{ action, payload }` 调用一个业务云函数，`action` 为接口名（如 `listPosts`）。返回值需为约定的 `{ code, data | message, requestId }`。

### 联调时需与后端确认的前端假设

字段名、状态值（`RECRUITING` / `FULL` / `CLOSED` / `EXPIRED`）和“不限”段位代码 `ANY` 已按后端需求文档实现。以下细节两份文档都没有规定，前端暂按下表实现，联调时需与后端核对：

| 项目 | 前端当前假设 |
| --- | --- |
| 云函数入参 | `{ action, payload }` |
| getConfig 结构 | `{ modes, ranks, servers: [{ code, name }], limits: { maxPlayers, gameIdMaxLength, noteMaxLength, pageSize } }` |
| existingPostId 位置 | 失败响应的 `data.existingPostId` 或顶层 `existingPostId` 均可 |
| ensureUser 返回 | `{ userId, hasActivePost, activePostId }` |
| 分页游标 | 不透明字符串，前端原样回传 |

模拟模式下，包含“违规”二字的文字会被当作未通过内容安全检测，便于离线验证提示。
