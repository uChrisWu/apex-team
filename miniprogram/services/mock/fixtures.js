// 应用配置：游戏模式、段位、服务器选项与公开限制。
// 来源：Apex_Lists_2026-10-25.md（2026-10-25 整理）。云端配置由 scripts/generate-dev-config.js 从这里生成，
// 模拟模式也直接使用它；前端页面只从 getConfig 读取，不硬编码。
// 每个选项：code 为稳定的内部 ID；name 为显示名，可单独修改；order 控制排序；
// enabled 为 false 时不能再用于发布和筛选，但历史记录仍按 name 显示。
const option = (code, name, order, extra) => Object.assign({ code, name, order, enabled: true }, extra || {});

const APP_CONFIG = {
  // maxPlayers：该模式的队伍人数上限
  modes: [
    option('RANKED', '排位赛', 0, { maxPlayers: 3 }),
    option('TRIOS', '三人匹配', 1, { maxPlayers: 3 }),
    option('DUOS', '双人匹配', 2, { maxPlayers: 2 }),
    option('WILDCARD', 'Wildcard 外卡模式', 3, { maxPlayers: 3 }),
    option('MIXTAPE', '混合模式', 4, { maxPlayers: 3 }),
    option('FIRING_RANGE', '射击训练场', 5, { maxPlayers: 3 }),
    option('PRIVATE_MATCH', '自定义房间', 6, { maxPlayers: 3 }),
    option('LTM', '限时活动', 7, { maxPlayers: 3 }),
  ],
  // ANY 为“不限”：筛选具体段位时也包含 ANY
  ranks: [
    option('ANY', '不限', 0),
    option('ROOKIE', '菜鸟', 1),
    option('BRONZE', '青铜', 2),
    option('SILVER', '白银', 3),
    option('GOLD', '黄金', 4),
    option('PLATINUM', '白金', 5),
    option('DIAMOND', '钻石', 6),
    option('MASTER', '大师', 7),
    option('PREDATOR', '顶尖猎杀者', 8),
  ],
  // ANY 为“不限”：筛选具体服务器时也包含 ANY；OTHER 覆盖尚未录入的服务器，按普通选项精确匹配
  servers: [
    option('ANY', '不限', 0),
    option('TOKYO', '东京（日服）', 1),
    option('HONG_KONG', '中国香港（港服）', 2),
    option('SINGAPORE', '新加坡', 3),
    option('FRANKFURT', '法兰克福（欧服）', 4),
    option('US_EAST_VIRGINIA', '北弗吉尼亚（美东）', 5),
    option('US_EAST_OHIO', '俄亥俄', 6),
    option('US_WEST_OREGON', '俄勒冈（美西）', 7),
    option('SAO_PAULO', '圣保罗（巴西服）', 8),
    option('SYDNEY', '悉尼（澳服）', 9),
    option('BAHRAIN', '巴林', 10),
    option('OTHER', '其他', 11),
  ],
  // 举报原因：code 稳定，name 可修改
  reportReasons: [
    option('SPAM', '广告或引流', 0),
    option('ABUSE', '辱骂或不友善', 1),
    option('ILLEGAL', '违法违规', 2),
    option('FAKE', '虚假信息', 3),
    option('OTHER', '其他', 4),
  ],
  limits: {
    maxPlayers: 3, // 所有模式中的最大队伍人数
    gameIdMaxLength: 64,
    noteMaxLength: 100,
    applyMessageMaxLength: 50,
    reportDetailMaxLength: 100,
    expireMinutes: 120,
    pageSize: 20,
  },
  // 订阅消息：templateId 留空时不请求订阅、不发送提醒，仅保留小程序内提醒。
  // fields 把云函数提供的值对应到模板关键词：申请人 = thing1，申请内容 = thing2。
  // miniprogramState 为点击通知打开的版本：developer 开发版 / trial 体验版 / formal 正式版。
  // 已于 2026-10-28 正式发布，使用 formal；开发版只有开发者能打开，普通用户无法进入。
  notify: {
    templateId: 'HXVFr7_2q6iHrjzJ_Gxw3ng6lnehgx5EO4nvggAxYpQ',
    fields: { applicant: 'thing1', content: 'thing2' },
    miniprogramState: 'formal',
  },
};

const NOTES = [
  '来个会玩恶灵的，开麦沟通',
  '休闲排位，不压力',
  '冲分车，希望稳一点',
  '',
  '晚上一直在线，可以长期组',
  '新手友好，慢慢玩',
  '会架枪的来',
  '',
];

// 生成若干条其他玩家的招募，发布时间分布在最近 100 分钟内
function seedPosts(now) {
  const modes = APP_CONFIG.modes;
  const ranks = APP_CONFIG.ranks.map((r) => r.code);
  const servers = APP_CONFIG.servers.filter((s) => s.code !== 'OTHER').map((s) => s.code);
  const posts = [];
  for (let i = 0; i < 26; i++) {
    const created = now - i * 4 * 60000 - 30000;
    const mode = modes[i % 4 === 3 ? 4 : i % 3];
    const currentPlayers = Math.min(i % 3 === 0 ? 2 : 1, mode.maxPlayers - 1);
    posts.push({
      id: `seed-${String(i + 1).padStart(3, '0')}`,
      ownerOpenid: `mock-openid-seed-${i + 1}`,
      modeCode: mode.code,
      rankCode: ranks[(i * 5) % ranks.length],
      serverCode: servers[i % servers.length],
      gameId: `SeedPlayer_${i + 1}`,
      currentPlayers,
      maxPlayers: mode.maxPlayers,
      note: NOTES[i % NOTES.length],
      status: 'RECRUITING',
      deleted: false,
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(created).toISOString(),
      expiresAt: new Date(created + APP_CONFIG.limits.expireMinutes * 60000).toISOString(),
      version: 1,
    });
  }
  return posts;
}

module.exports = { APP_CONFIG, seedPosts };
