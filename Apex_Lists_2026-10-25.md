# Apex Legends 服务器 游戏模式与段位列表

更新日期：2026 年 10 月 25 日  
用途：为 Apex 组队微信小程序提供服务器、游戏模式和段位选项。

本文区分当前游戏内容与小程序配置建议。服务器实际可选项以游戏登录界面的数据中心菜单为准；限时模式随活动变化。中文名称采用便于玩家理解的表述，可通过英文名称核对。

## 1 服务器列表

EA 已确认 Apex 于 2025 年 4 月迁移至 Amazon GameLift。以下区域参考迁移后的服务器报道，并与 2026 年社区整理交叉核对；它不是 EA 发布的实时服务器可用性清单。[1][2][3]

| 区域 | 中文名称 | 英文名称 | 区域代码 |
| --- | --- | --- | --- |
| 亚洲 | 东京 日服 | Tokyo | `ap-northeast-1` |
| 亚洲 | 中国香港 港服 | Hong Kong | `ap-east-1` |
| 亚洲 | 新加坡 | Singapore | `ap-southeast-1` |
| 欧洲 | 法兰克福 欧服 | Frankfurt | `eu-central-1` |
| 北美 | 北弗吉尼亚 美东 | N. Virginia / Ashburn | `us-east-1` |
| 北美 | 俄亥俄 | Ohio | `us-east-2` |
| 北美 | 俄勒冈 美西 | Oregon | `us-west-2` |
| 南美 | 圣保罗 巴西服 | São Paulo | `sa-east-1` |
| 大洋洲 | 悉尼 澳服 | Sydney | `ap-southeast-2` |
| 中东 | 巴林 | Bahrain | `me-south-1` |

说明：

- 巴林包含在区域清单中，但本文未确认其在更新日期的实时可用状态。
- 网上旧列表中的台湾、伦敦、比利时、阿姆斯特丹及多个 GCE 编号节点，不宜直接照搬为当前可选数据中心。
- 数据中心选择与最终匹配区域不是完全相同的概念。EA 表示匹配会考虑区域、人数、模式与平台等因素。[4]

## 2 游戏模式列表

EA 将主要玩法分为 Core 和 Freestyle。Core 包含排位与非排位大逃杀；Freestyle 包含 Wildcard、混合模式和 Bot Royale Evolved 等休闲玩法。[5]

| 模式 | 英文名称 | 说明 |
| --- | --- | --- |
| 排位赛 | Ranked | 三人排位大逃杀，影响段位 |
| 三人匹配 | Battle Royale — Trios | 常规三人大逃杀 |
| 双人匹配 | Battle Royale — Duos | 常规双人大逃杀，非排位 |
| Wildcard 外卡模式 | Wildcard | 快节奏玩法，含复活及特殊规则 |
| 混合模式 | Mixtape | 多种玩法轮换的播放列表 |
| 人机大逃杀进化版 | Bot Royale Evolved | 以人机对战为主的练习玩法 |
| 射击训练场 | Firing Range | 练枪、测试技能及约战 |
| 训练教程 | Training | 新手教学 |
| 私人比赛 自定义房间 | Private Match | 通过房间组织比赛 |
| 限时活动 | Limited-time Modes | 随活动开放，可能在现有模式中运行 |

主要模式依据 EA 模式说明及当前赛季模式整理。[5][6]

### 2.1 混合模式子玩法

| 中文名称 | 英文名称 |
| --- | --- |
| 团队死斗 | Team Deathmatch |
| 控制 | Control |
| 子弹时间 枪械轮换 | Gun Run |

这些是混合模式中的轮换玩法，不代表所有子玩法同时开放。[5][6]

### 2.2 当前限时活动

**Blood Pact** 活动开放时间为 **2026 年 10 月 13 日至 11 月 3 日**，活动玩法在 Wildcard 内运行。小程序可将其显示为 Wildcard 的活动标签，避免与独立匹配队列混淆。[7]

当前赛季的单人模式、四人模式和竞技场不宜作为常驻可用模式列出；如后续回归，应按活动公告启用。[6]

## 3 段位列表

当前段位从低到高如下。菜鸟至钻石各有 IV、III、II、I 四个小段位，其中 IV 最低，I 最高。大师和顶尖猎杀者不分这四个小段位；猎杀者为各平台大师中的前 750 名。[8]

| 顺序 | 中文段位 | 英文名称 | 小段位 |
| --- | --- | --- | --- |
| 1 | 菜鸟 | Rookie | IV、III、II、I |
| 2 | 青铜 | Bronze | IV、III、II、I |
| 3 | 白银 | Silver | IV、III、II、I |
| 4 | 黄金 | Gold | IV、III、II、I |
| 5 | 白金 铂金 | Platinum | IV、III、II、I |
| 6 | 钻石 | Diamond | IV、III、II、I |
| 7 | 大师 | Master | 无 |
| 8 | 顶尖猎杀者 | Apex Predator | 无 |

### 3.1 已公布但尚未生效的调整

EA 于 2026 年 10 月公布排位路线图，计划在第 32 赛季，即 2027 年初，调整段位结构：[9]

- Iron 替代 Rookie。
- Emerald 位于 Platinum 与 Diamond 之间。
- 新增 Grandmaster，并调整猎杀者资格所对应的段位。

这些调整不属于本文更新日期的现行段位，小程序应在相应版本正式上线后再更新。

## 4 小程序配置建议

本节为产品设计建议，不属于游戏官方规则。

### 4.1 基础选项

| 字段 | 建议配置 |
| --- | --- |
| 服务器 | 使用上述区域，并增加 不限 和 其他 |
| 游戏模式 | 排位、三人匹配、双人匹配、Wildcard、混合模式、训练场、自定义、限时活动 |
| 段位要求 | 不限、菜鸟、青铜、白银、黄金、白金、钻石、大师、顶尖猎杀者 |
| 小段位 | 首版可不要求填写，后续增加 IV 至 I 的可选项 |
| 人数 | 分开记录当前人数与还缺人数，并根据模式限制队伍上限 |

“不限”是组队筛选条件，不是正式服务器或段位。“其他”用于覆盖尚未录入的服务器选项。训练教程通常不需要组队发布，首版可不展示。

### 4.2 维护方式

- 服务器、模式和段位采用独立配置，支持调整排序与启停。
- 保存稳定的内部 ID，中文显示名可单独修改。
- 活动名称与模式分开存储，例如模式为 Wildcard，活动为 Blood Pact。
- 段位要求与发布者自身段位分开存储，避免混淆。
- 停用旧选项时保留历史组队记录的显示名称。

## 5 参考来源

以下来源于 2026 年 10 月 25 日查询。EA 页面为官方说明；服务器区域明细与赛季模式补充包含第三方资料，实际开放情况应以游戏客户端与最新公告为准。

1. [EA 官方 Game Reliability Update](https://www.ea.com/en/games/apex-legends/apex-legends/news/dev-update-0625) — 确认迁移至 Amazon GameLift。
2. [esports.gg Apex Legends servers migrate to AWS](https://esports.gg/news/apex-legends/apex-legends-servers-migrate-to-aws-here-are-all-the-locations/) — 迁移后的区域代码与地点。
3. [Nebula0 Apex Legends Servers Old vs Current](https://nebula0.com/posts/apex-legends-servers-old-vs-current/) — 2026 年社区服务器整理。
4. [EA 官方 Matchmaking](https://help.ea.com/en/articles/apex-legends/matchmaking/) — 匹配区域与数据中心选择说明。
5. [EA 官方 Game Modes](https://help.ea.com/en/articles/apex-legends/game-modes/) — 主要模式与分类。
6. [apexdb.gg Game Modes](https://apexdb.gg/modes/) — 当前赛季队列与轮换玩法补充。
7. [EA 官方 Blood Pact Event](https://www.ea.com/games/apex-legends/apex-legends/news/blood-pact-event) — 当前活动时间与玩法。
8. [EA 官方 Ranked Guide](https://help.ea.com/en/articles/apex-legends/ranked/) — 当前段位与猎杀者规则。
9. [EA 官方 Ranked Roadmap](https://www.ea.com/en/games/apex-legends/apex-legends/news/ranked-roadmap-31-32) — 第 31 与第 32 赛季计划。
