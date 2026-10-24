// 配置（游戏模式、段位、服务器选项及公开限制）只从 getConfig 获取，不在前端硬编码正式清单。
// 成功后缓存；失败不缓存，页面可重试。
const api = require('../services/api');

let cached = null;
let pending = null;

function loadConfig() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = api
      .getConfig()
      .then((config) => {
        cached = withLookups(config);
        return cached;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

// 附加 code → name 映射，方便页面展示
function withLookups(config) {
  const toMap = (list) =>
    (list || []).reduce((m, o) => {
      m[o.code] = o.name;
      return m;
    }, {});
  return Object.assign({}, config, {
    rankNames: toMap(config.ranks),
    serverNames: toMap(config.servers),
    modeNames: toMap(config.modes),
  });
}

module.exports = { loadConfig };
