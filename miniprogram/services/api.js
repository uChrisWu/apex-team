// 统一接口调用层。页面只通过这里访问后端，不直接读写数据库。
// 成功响应：{ code: 'OK', data, requestId }
// 失败响应：{ code, message, requestId }，转换为 AppError 抛出
const env = require('../config/env');
const { AppError } = require('../utils/errors');

let transport = null;

function getTransport() {
  if (!transport) {
    transport = env.apiMode === 'cloud' ? require('./transport-cloud') : require('./mock/transport-mock');
  }
  return transport;
}

async function call(action, payload = {}) {
  let res;
  try {
    res = await getTransport().send(action, payload);
  } catch (err) {
    console.warn(`[api] ${action} 请求失败`, err);
    throw new AppError('NETWORK_ERROR');
  }
  if (!res || typeof res.code !== 'string') {
    throw new AppError('INTERNAL_ERROR', null, res && res.requestId);
  }
  if (res.code !== 'OK') {
    // ACTIVE_POST_EXISTS 会附带本人 existingPostId，兼容放在顶层或 data 内
    const details = Object.assign({}, res.data || {});
    if (res.existingPostId) details.existingPostId = res.existingPostId;
    throw new AppError(res.code, res.message, res.requestId, details);
  }
  return res.data;
}

module.exports = {
  isMock: env.apiMode !== 'cloud',

  getConfig: () => call('getConfig'),
  ensureUser: () => call('ensureUser'),

  // { modeCode?, rankCode?, serverCode?, remainingSlots?, cursor?, limit? } → { items, nextCursor, hasMore }
  listPosts: (query) => call('listPosts', query),
  getPost: (postId) => call('getPost', { postId }),
  getContact: (postId) => call('getContact', { postId }),

  // form: modeCode, rankCode, serverCode, currentPlayers, gameId, note
  createPost: (form, requestId) => call('createPost', Object.assign({}, form, { requestId })),
  updatePost: (postId, version, form) => call('updatePost', Object.assign({}, form, { postId, version })),
  closePost: (postId, version) => call('closePost', { postId, version }),
  deletePost: (postId, version) => call('deletePost', { postId, version }),

  listMyPosts: (query) => call('listMyPosts', query),

  // 申请加入：申请人提交自己的游戏 ID 与可选留言；房主查看并同意（人数 +1）或拒绝
  applyToPost: (postId, form) => call('applyToPost', Object.assign({ postId }, form)),
  cancelApplication: (postId) => call('cancelApplication', { postId }),
  listPostRequests: (postId) => call('listPostRequests', { postId }),
  decideRequest: (requestId, decision) => call('decideRequest', { requestId, decision }),

  // 组队方式：房主填写私人房间等信息，只有被同意的申请人能看到；空字符串表示清除
  updateTeamInfo: (postId, teamInfo) => call('updateTeamInfo', { postId, teamInfo }),

  // 举报：reason 为配置中的举报原因代码
  reportPost: (postId, reason) => call('reportPost', { postId, reason }),
};
