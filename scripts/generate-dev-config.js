// 生成开发环境的配置文档（JSON Lines，一行一个文档），用于在云开发控制台导入 app_config 集合。
// 选项来自带“测试”标记的 mock 配置，只用于开发环境。
const { TEST_CONFIG } = require('../miniprogram/services/mock/fixtures');

const ordered = (items) => items.map((item, index) => ({ ...item, order: index }));
const doc = {
  _id: 'main',
  modes: ordered(TEST_CONFIG.modes),
  ranks: ordered(TEST_CONFIG.ranks),
  servers: ordered(TEST_CONFIG.servers),
  limits: TEST_CONFIG.limits,
};
process.stdout.write(JSON.stringify(doc) + '\n');
