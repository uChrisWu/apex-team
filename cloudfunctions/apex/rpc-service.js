const crypto = require('node:crypto');

const ACTIONS = new Set(['getConfig', 'ensureUser', 'listPosts', 'getPost', 'getContact', 'createPost', 'updatePost', 'closePost', 'deletePost', 'listMyPosts']);
const FORM_FIELDS = ['modeCode', 'rankCode', 'serverCode', 'currentPlayers', 'gameId', 'note'];

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.code = 'VALIDATION_ERROR';
  }
}

function fail(message) {
  throw new BusinessError(message);
}

function hasOnly(payload, fields) {
  return Object.keys(payload).every((field) => fields.includes(field));
}

function pageSize(value, config) {
  if (value === undefined || value === null) return config.limits.pageSize;
  if (!Number.isInteger(value) || value < 1) fail('分页大小无效');
  return Math.min(value, 50);
}

function cursorIdentity(action, payload, openid) {
  const key = action === 'listMyPosts'
    ? `mine:${openid}`
    : JSON.stringify([payload.modeCode || '', payload.rankCode || '', payload.serverCode || '', payload.remainingSlots || 0]);
  return crypto.createHash('sha256').update(key).digest('hex');
}

function readCursor(value, identity) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('分页游标无效');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw new Error('cursor');
    const position = JSON.parse(decoded);
    if (position.q !== identity || typeof position.id !== 'string' || !/^p_[0-9a-f]{64}$/.test(position.id)
      || typeof position.t !== 'string' || new Date(position.t).toISOString() !== position.t) throw new Error('cursor');
    return position;
  } catch (_) {
    fail('分页游标无效');
  }
}

function toIso(value) {
  return new Date(value).toISOString();
}

function normalizePost(post) {
  return {
    ...post,
    createdAt: toIso(post.createdAt),
    expiresAt: toIso(post.expiresAt),
    ...(post.updatedAt ? { updatedAt: toIso(post.updatedAt) } : {}),
  };
}

function createBackend({ rpc, now = () => new Date(), log = console }) {
  async function call(action, payload, openid, currentTime) {
    const result = await rpc(action, openid, payload, currentTime.toISOString());
    if (!result || typeof result.code !== 'string') throw new Error('Invalid PostgreSQL RPC response');
    return result;
  }

  async function dispatch(action, payload, openid, currentTime) {
    if (action === 'getConfig' || action === 'ensureUser') {
      if (!hasOnly(payload, [])) fail('请求内容无效');
    } else if (action === 'getPost' || action === 'getContact') {
      if (!hasOnly(payload, ['postId']) || typeof payload.postId !== 'string' || !payload.postId) fail('信息 ID 无效');
    } else if (action === 'createPost') {
      if (!hasOnly(payload, [...FORM_FIELDS, 'requestId']) ||
        typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId)) fail('请求标识无效');
    } else if (action === 'updatePost' || action === 'closePost' || action === 'deletePost') {
      const fields = action === 'updatePost' ? [...FORM_FIELDS, 'postId', 'version'] : ['postId', 'version'];
      if (!hasOnly(payload, fields) || typeof payload.postId !== 'string' || !payload.postId ||
        !Number.isInteger(payload.version) || payload.version < 1) fail('提交内容无效');
    }

    if (action === 'createPost' || action === 'updatePost') {
      if (typeof payload.gameId === 'string') payload.gameId = payload.gameId.trim();
      if (typeof payload.note === 'string') payload.note = payload.note.trim();
    }

    let cursorId = null;
    if (action === 'listPosts' || action === 'listMyPosts') {
      const configResult = await call('getConfig', {}, openid, currentTime);
      if (configResult.code !== 'OK') return configResult;
      const config = configResult.data;
      const fields = action === 'listPosts'
        ? ['modeCode', 'rankCode', 'serverCode', 'remainingSlots', 'cursor', 'limit']
        : ['cursor', 'limit'];
      if (!hasOnly(payload, fields)) fail('筛选条件无效');
      if (action === 'listPosts') {
        for (const [field, options] of [['modeCode', config.modes], ['rankCode', config.ranks], ['serverCode', config.servers]]) {
          if (payload[field] !== undefined && !options.some((item) => item.code === payload[field])) fail('筛选条件无效');
        }
        if (payload.remainingSlots !== undefined && ![1, 2].includes(payload.remainingSlots)) fail('缺少人数无效');
      }
      const identity = cursorIdentity(action, payload, openid);
      const position = readCursor(payload.cursor, identity);
      cursorId = identity;
      payload = {
        ...payload,
        limit: pageSize(payload.limit, config),
        ...(position ? { cursorTime: position.t, cursorId: position.id } : {}),
      };
      delete payload.cursor;
    }

    const result = await call(action, payload, openid, currentTime);
    if (result.code !== 'OK') return result;
    if (action === 'getPost' || action === 'updatePost') result.data = normalizePost(result.data);
    if (action === 'listPosts' || action === 'listMyPosts') {
      const page = result.data;
      result.data = {
        items: page.items.map(normalizePost),
        hasMore: page.hasMore,
        nextCursor: page.nextPosition
          ? Buffer.from(JSON.stringify({ t: toIso(page.nextPosition.t), id: page.nextPosition.id, q: cursorId })).toString('base64url')
          : null,
      };
    }
    return result;
  }

  return {
    async handle(event, openid) {
      const traceId = crypto.randomUUID();
      const action = event && event.action;
      const payload = event && event.payload;
      try {
        if (!ACTIONS.has(action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) fail('请求内容无效');
        const result = await dispatch(action, { ...payload }, openid, new Date(now()));
        log.info(JSON.stringify({ requestId: traceId, action, result: result.code, at: new Date().toISOString() }));
        return result.code === 'OK'
          ? { code: 'OK', data: result.data, requestId: action === 'createPost' ? payload.requestId : traceId }
          : { code: result.code, message: result.message, requestId: traceId, ...(result.data ? { data: result.data } : {}) };
      } catch (error) {
        const known = error instanceof BusinessError;
        log.error(JSON.stringify({ requestId: traceId, action, result: known ? error.code : 'INTERNAL_ERROR',
          at: new Date().toISOString(), errorType: error.name, errorCode: error.code || null }));
        return { code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : '服务暂时不可用，请稍后重试', requestId: traceId };
      }
    },
  };
}

module.exports = { createBackend, readCursor, cursorIdentity };
