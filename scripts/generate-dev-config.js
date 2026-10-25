// 生成云端配置文档（JSON Lines，一行一个文档），用于在云开发控制台导入 app_config 集合，
// 或由部署脚本写入。选项来源为 miniprogram/services/mock/fixtures.js 的 APP_CONFIG（依据 Apex_Lists_2026-10-25.md）。
const { APP_CONFIG } = require('../miniprogram/services/mock/fixtures');

const ordered = (items) => items.map((item, index) => ({ ...item, order: index }));
const doc = {
  _id: 'main',
  modes: ordered(APP_CONFIG.modes),
  ranks: ordered(APP_CONFIG.ranks),
  servers: ordered(APP_CONFIG.servers),
  reportReasons: ordered(APP_CONFIG.reportReasons),
  limits: APP_CONFIG.limits,
  notify: APP_CONFIG.notify,
};
process.stdout.write(JSON.stringify(doc) + '\n');
