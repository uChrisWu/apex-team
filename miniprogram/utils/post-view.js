// 把接口返回的记录转换为页面展示用的字段
const { formatPublishTime, formatRemaining } = require('./format');

const STATUS_TEXT = {
  RECRUITING: '招募中',
  FULL: '已满员',
  CLOSED: '已关闭',
  EXPIRED: '已过期',
};

const STATUS_NOTE = {
  FULL: '队伍已满员，无法再联系发布者。',
  CLOSED: '发布者已结束本次招募，无法再联系。',
  EXPIRED: '招募已超过有效期，无法再联系。',
};

function decoratePost(post, config) {
  const total = post.maxPlayers || (config.limits && config.limits.maxPlayers) || 3;
  const remaining = total - post.currentPlayers;
  return Object.assign({}, post, {
    rankName: config.rankNames[post.rankCode] || post.rankCode,
    serverName: config.serverNames[post.serverCode] || post.serverCode,
    modeName: config.modeNames[post.modeCode] || post.modeCode || '',
    maxPlayers: total,
    remainingText: remaining > 0 ? `缺 ${remaining} 人` : '已满员',
    statusText: STATUS_TEXT[post.status] || post.status,
    statusNote: STATUS_NOTE[post.status] || '',
    publishTimeText: formatPublishTime(post.createdAt),
    expireText: post.status === 'RECRUITING' ? formatRemaining(post.expiresAt) : '',
  });
}

module.exports = { decoratePost, STATUS_TEXT };
