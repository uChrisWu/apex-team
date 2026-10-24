// 测试配置：游戏模式、段位和服务器的正式清单尚待确认（需求文档第 7 节），
// 这里的选项仅用于原型演示，名称中带“测试”标注。
const TEST_CONFIG = {
  modes: [
    { code: 'RANKED', name: '排位赛（测试）' },
    { code: 'TRIOS', name: '三人匹配（测试）' },
    { code: 'MIXTAPE', name: '混合模式（测试）' },
  ],
  ranks: [
    { code: 'ANY', name: '不限' },
    { code: 'ROOKIE', name: '菜鸟（测试）' },
    { code: 'BRONZE', name: '青铜（测试）' },
    { code: 'SILVER', name: '白银（测试）' },
    { code: 'GOLD', name: '黄金（测试）' },
    { code: 'PLATINUM', name: '白金（测试）' },
    { code: 'DIAMOND', name: '钻石（测试）' },
    { code: 'MASTER', name: '大师（测试）' },
    { code: 'PREDATOR', name: '猎杀者（测试）' },
  ],
  servers: [
    { code: 'TEST_TOKYO', name: '东京（测试）' },
    { code: 'TEST_HONGKONG', name: '香港（测试）' },
    { code: 'TEST_SINGAPORE', name: '新加坡（测试）' },
    { code: 'TEST_FRANKFURT', name: '法兰克福（测试）' },
  ],
  limits: {
    maxPlayers: 3,
    gameIdMaxLength: 64,
    noteMaxLength: 100,
    expireMinutes: 120,
    pageSize: 20,
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
  const ranks = TEST_CONFIG.ranks.map((r) => r.code);
  const servers = TEST_CONFIG.servers.map((s) => s.code);
  const modes = TEST_CONFIG.modes.map((m) => m.code);
  const posts = [];
  for (let i = 0; i < 26; i++) {
    const created = now - i * 4 * 60000 - 30000;
    posts.push({
      id: `seed-${String(i + 1).padStart(3, '0')}`,
      ownerOpenid: `mock-openid-seed-${i + 1}`,
      modeCode: modes[i % 4 === 3 ? 2 : i % 2],
      rankCode: ranks[(i * 5) % ranks.length],
      serverCode: servers[i % servers.length],
      gameId: `SeedPlayer_${i + 1}`,
      currentPlayers: i % 3 === 0 ? 2 : 1,
      note: NOTES[i % NOTES.length],
      status: 'RECRUITING',
      deleted: false,
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(created).toISOString(),
      expiresAt: new Date(created + TEST_CONFIG.limits.expireMinutes * 60000).toISOString(),
      version: 1,
    });
  }
  return posts;
}

module.exports = { TEST_CONFIG, seedPosts };
