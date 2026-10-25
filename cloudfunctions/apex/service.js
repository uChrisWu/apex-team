// 业务层：输入校验、业务规则与响应格式。数据读写通过注入的 store 完成，
// 因此可以在 Node 中用内存 store 测试，部署时使用 store.js（云开发文档型数据库）。
const crypto = require('node:crypto');

const ACTIONS = new Set(['getConfig', 'ensureUser', 'listPosts', 'getPost', 'getContact', 'createPost', 'updatePost', 'closePost', 'deletePost', 'listMyPosts']);
const FORM_FIELDS = ['modeCode', 'rankCode', 'serverCode', 'currentPlayers', 'gameId', 'note'];
const MAX_PAGE_SIZE = 50;
const POST_ID = /^p_[0-9a-f]{64}$/;

class BusinessError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function fail(code, message, data) {
  throw new BusinessError(code, message, data);
}

function invalid(message) {
  fail('VALIDATION_ERROR', message);
}

function hasOnly(payload, fields) {
  return Object.keys(payload).every((field) => fields.includes(field));
}

// 长度按 Unicode 码点计算（BE-03）
function codePoints(str) {
  return Array.from(str).length;
}

function hasCode(options, code) {
  return typeof code === 'string' && (options || []).some((item) => item.code === code);
}

function toIso(value) {
  return new Date(value).toISOString();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------- 分页游标：绑定筛选条件或当前账号，客户端只能原样回传 ----------

function cursorIdentity(scope) {
  return sha256(JSON.stringify(scope));
}

function readCursor(value, identity) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid('分页游标无效');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw new Error('cursor');
    const position = JSON.parse(decoded);
    if (position.q !== identity || typeof position.id !== 'string' || !POST_ID.test(position.id)
      || typeof position.t !== 'string' || new Date(position.t).toISOString() !== position.t) throw new Error('cursor');
    return { createdAt: new Date(position.t), id: position.id };
  } catch (_) {
    return invalid('分页游标无效');
  }
}

function writeCursor(post, identity) {
  return Buffer.from(JSON.stringify({ t: toIso(post.createdAt), id: post.id, q: identity })).toString('base64url');
}

// ---------- 表单校验（BE-07） ----------

function validateForm(payload, isCreate, config) {
  const counts = isCreate ? [1, 2] : [1, 2, 3];
  if (!hasCode(config.modes, payload.modeCode)) invalid('游戏模式无效');
  if (!hasCode(config.ranks, payload.rankCode)) invalid('目标段位无效');
  if (!hasCode(config.servers, payload.serverCode)) invalid('服务器无效');
  if (!Number.isInteger(payload.currentPlayers) || !counts.includes(payload.currentPlayers)) {
    invalid(isCreate ? '发布时当前人数只能是 1 或 2' : '当前人数只能是 1、2 或 3');
  }
  if (typeof payload.gameId !== 'string') invalid('请填写游戏 ID');
  if (payload.note !== undefined && typeof payload.note !== 'string') invalid('备注格式无效');

  const gameId = payload.gameId.trim();
  const note = (payload.note || '').trim();
  if (!gameId) invalid('请填写游戏 ID');
  if (codePoints(gameId) > config.limits.gameIdMaxLength) invalid(`游戏 ID 最多 ${config.limits.gameIdMaxLength} 个字符`);
  if (codePoints(note) > config.limits.noteMaxLength) invalid(`备注最多 ${config.limits.noteMaxLength} 个字符`);

  return {
    modeCode: payload.modeCode,
    rankCode: payload.rankCode,
    serverCode: payload.serverCode,
    currentPlayers: payload.currentPlayers,
    gameId,
    note,
  };
}

// ---------- 状态与返回字段 ----------

// 到期判断以服务端时间为准，不依赖整理任务（BE-05）
function effectiveStatus(post, now) {
  if (post.status === 'RECRUITING' && new Date(post.expiresAt).getTime() <= now.getTime()) return 'EXPIRED';
  return post.status;
}

function isActive(post, now) {
  return !!post && !post.deletedAt && effectiveStatus(post, now) === 'RECRUITING';
}

function cardView(post, now) {
  return {
    id: post.id,
    modeCode: post.modeCode,
    rankCode: post.rankCode,
    serverCode: post.serverCode,
    currentPlayers: post.currentPlayers,
    maxPlayers: post.maxPlayers,
    remainingSlots: post.maxPlayers - post.currentPlayers,
    note: post.note,
    status: effectiveStatus(post, now),
    createdAt: toIso(post.createdAt),
    expiresAt: toIso(post.expiresAt),
    version: post.version,
  };
}

function detailView(post, user, now) {
  const isOwner = !!user && user.userId === post.ownerId;
  const recruiting = effectiveStatus(post, now) === 'RECRUITING';
  return Object.assign(cardView(post, now), {
    updatedAt: toIso(post.updatedAt),
    canEdit: isOwner && recruiting,
    canClose: isOwner && recruiting,
    canDelete: isOwner,
  });
}

function ownView(post, now) {
  return Object.assign(detailView(post, { userId: post.ownerId }, now), { gameId: post.gameId });
}

// ---------- 服务 ----------

function createService({ store, now = () => new Date(), clock = () => Date.now(), log = console, configTtlMs = 60000 }) {
  let configCache = null;
  let configLoadedAt = 0;

  // 配置变化很少，缓存一段时间，避免每次列表请求都多读一次数据库
  async function loadConfig() {
    if (configCache && clock() - configLoadedAt < configTtlMs) return configCache;
    const config = await store.getConfig();
    if (!config) throw new Error('app_config/main is missing');
    configCache = config;
    configLoadedAt = clock();
    return config;
  }

  // 业务错误以返回值带出事务，不依赖 SDK 对抛出异常的处理方式。
  // 所有检查都在写入之前完成，因此带错误返回时事务中没有写操作。
  async function inTransaction(fn) {
    const result = await store.transaction(async (tx) => {
      try {
        return { value: await fn(tx) };
      } catch (err) {
        if (err instanceof BusinessError) return { error: err };
        throw err;
      }
    });
    if (result.error) throw result.error;
    return result.value;
  }

  async function requireUser(openid, reader) {
    if (!openid) fail('UNAUTHENTICATED', '请先登录');
    const user = await reader.getUser(openid);
    if (!user) fail('UNAUTHENTICATED', '请先登录');
    return user;
  }

  function requirePostId(payload) {
    if (typeof payload.postId !== 'string' || !POST_ID.test(payload.postId)) fail('NOT_FOUND', '信息不存在或已删除');
  }

  // 所有者写操作的公共检查；返回可写的记录
  function checkOwnerWrite(post, user, version, needActive, at) {
    if (!post || post.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
    if (post.ownerId !== user.userId) fail('FORBIDDEN', '只有发布者可以操作');
    if (post.version !== version) fail('VERSION_CONFLICT', '信息已被更新');
    if (needActive && effectiveStatus(post, at) !== 'RECRUITING') fail('POST_UNAVAILABLE', '该信息已不在招募中');
  }

  // 记录不再招募时，仅在用户引用仍指向它时释放，避免清除新发布的引用
  async function releaseActive(tx, user, post) {
    if (user.activePostId === post.id) await tx.updateUser(user.openid, { activePostId: null });
  }

  const handlers = {
    async getConfig() {
      const config = await loadConfig();
      return { modes: config.modes, ranks: config.ranks, servers: config.servers, limits: config.limits };
    },

    async ensureUser(payload, openid, at) {
      if (!openid) fail('UNAUTHENTICATED', '无法取得微信身份');
      const user = await store.createUserIfMissing({
        openid,
        userId: crypto.randomUUID(),
        activePostId: null,
        createdAt: at,
      });
      const active = user.activePostId ? await store.getPost(user.activePostId) : null;
      const activeId = isActive(active, at) ? active.id : null;
      return { userId: user.userId, hasActivePost: !!activeId, activePostId: activeId };
    },

    async listPosts(payload, openid, at) {
      if (!hasOnly(payload, ['modeCode', 'rankCode', 'serverCode', 'remainingSlots', 'cursor', 'limit'])) invalid('筛选条件无效');
      const config = await loadConfig();
      for (const [field, options] of [['modeCode', config.modes], ['rankCode', config.ranks], ['serverCode', config.servers]]) {
        if (payload[field] !== undefined && !hasCode(options, payload[field])) invalid('筛选条件无效');
      }
      if (payload.remainingSlots !== undefined && ![1, 2].includes(payload.remainingSlots)) invalid('缺少人数无效');
      const filters = {
        modeCode: payload.modeCode,
        rankCode: payload.rankCode,
        serverCode: payload.serverCode,
        currentPlayers: payload.remainingSlots ? config.limits.maxPlayers - payload.remainingSlots : undefined,
      };
      const identity = cursorIdentity(['hall', filters.modeCode || '', filters.rankCode || '', filters.serverCode || '', payload.remainingSlots || 0]);
      return page({ publicAt: at, filters }, payload, identity, config, (p) => cardView(p, at));
    },

    async listMyPosts(payload, openid, at) {
      if (!hasOnly(payload, ['cursor', 'limit'])) invalid('筛选条件无效');
      const user = await requireUser(openid, store);
      const config = await loadConfig();
      return page({ ownerId: user.userId }, payload, cursorIdentity(['mine', user.userId]), config, (p) => ownView(p, at));
    },

    async getPost(payload, openid, at) {
      if (!hasOnly(payload, ['postId'])) invalid('请求内容无效');
      requirePostId(payload);
      const post = await store.getPost(payload.postId);
      if (!post || post.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
      const user = openid ? await store.getUser(openid) : null;
      return detailView(post, user, at);
    },

    async getContact(payload, openid, at) {
      if (!hasOnly(payload, ['postId'])) invalid('请求内容无效');
      await requireUser(openid, store);
      requirePostId(payload);
      const post = await store.getPost(payload.postId);
      if (!post || post.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
      if (effectiveStatus(post, at) !== 'RECRUITING') fail('POST_UNAVAILABLE', '该信息已不在招募中');
      return { gameId: post.gameId };
    },

    async createPost(payload, openid, at) {
      if (!hasOnly(payload, [...FORM_FIELDS, 'requestId'])) invalid('请求内容无效');
      if (typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId)) invalid('请求标识无效');
      const config = await loadConfig();
      const form = validateForm(payload, true, config);

      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        // 记录 ID 由账号与 requestId 决定：同一创建请求的重试命中同一条记录
        const id = 'p_' + sha256(`${user.userId}:${payload.requestId}`);
        const prior = await tx.getPost(id);
        if (prior) {
          if (prior.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
          return { id, status: effectiveStatus(prior, at), version: prior.version };
        }
        if (user.activePostId) {
          const active = await tx.getPost(user.activePostId);
          if (isActive(active, at)) fail('ACTIVE_POST_EXISTS', '已有招募中的信息', { existingPostId: active.id });
        }
        const post = Object.assign({ id, ownerId: user.userId, maxPlayers: config.limits.maxPlayers }, form, {
          status: 'RECRUITING',
          createdAt: at,
          updatedAt: at,
          expiresAt: new Date(at.getTime() + config.limits.expireMinutes * 60000),
          deletedAt: null,
          version: 1,
          createRequestId: payload.requestId,
        });
        await tx.createPost(post);
        await tx.updateUser(user.openid, { activePostId: id });
        return { id, status: 'RECRUITING', version: 1 };
      });
    },

    async updatePost(payload, openid, at) {
      checkWritePayload(payload, [...FORM_FIELDS, 'postId', 'version']);
      const config = await loadConfig();
      const form = validateForm(payload, false, config);

      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const post = await tx.getPost(payload.postId);
        checkOwnerWrite(post, user, payload.version, true, at);
        // 编辑不改变 createdAt、expiresAt
        const patch = Object.assign({}, form, {
          status: form.currentPlayers === post.maxPlayers ? 'FULL' : 'RECRUITING',
          updatedAt: at,
          version: post.version + 1,
        });
        await tx.updatePost(post.id, patch);
        const updated = Object.assign({}, post, patch);
        if (updated.status !== 'RECRUITING') await releaseActive(tx, user, updated);
        return detailView(updated, user, at);
      });
    },

    async closePost(payload, openid, at) {
      checkWritePayload(payload, ['postId', 'version']);
      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const post = await tx.getPost(payload.postId);
        checkOwnerWrite(post, user, payload.version, true, at);
        const version = post.version + 1;
        await tx.updatePost(post.id, { status: 'CLOSED', updatedAt: at, version });
        await releaseActive(tx, user, post);
        return { id: post.id, status: 'CLOSED', version };
      });
    },

    async deletePost(payload, openid, at) {
      checkWritePayload(payload, ['postId', 'version']);
      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const post = await tx.getPost(payload.postId);
        checkOwnerWrite(post, user, payload.version, false, at);
        await tx.updatePost(post.id, { deletedAt: at, updatedAt: at, version: post.version + 1 });
        await releaseActive(tx, user, post);
        return { id: post.id };
      });
    },
  };

  function checkWritePayload(payload, fields) {
    if (!hasOnly(payload, fields)) invalid('提交内容无效');
    requirePostId(payload);
    if (!Number.isInteger(payload.version) || payload.version < 1) invalid('版本号无效');
  }

  function pageLimit(value, config) {
    if (value === undefined || value === null) return config.limits.pageSize;
    if (!Number.isInteger(value) || value < 1) invalid('分页大小无效');
    return Math.min(value, MAX_PAGE_SIZE);
  }

  async function page(query, payload, identity, config, view) {
    const limit = pageLimit(payload.limit, config);
    const after = readCursor(payload.cursor, identity);
    // 多取一条用于判断是否还有下一页
    const posts = await store.listPosts(Object.assign({}, query, { after, limit: limit + 1 }));
    const hasMore = posts.length > limit;
    const items = posts.slice(0, limit);
    return {
      items: items.map(view),
      hasMore,
      nextCursor: hasMore ? writeCursor(items[items.length - 1], identity) : null,
    };
  }

  return {
    async handle(event, openid) {
      const traceId = crypto.randomUUID();
      const action = event && event.action;
      const payload = event && event.payload;
      try {
        if (!ACTIONS.has(action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('请求内容无效');
        if ((action === 'getConfig' || action === 'ensureUser') && !hasOnly(payload, [])) invalid('请求内容无效');
        const data = await handlers[action](Object.assign({}, payload), openid || null, new Date(now()));
        log.info(JSON.stringify({ requestId: traceId, action, result: 'OK', at: new Date().toISOString() }));
        return { code: 'OK', data, requestId: action === 'createPost' ? payload.requestId : traceId };
      } catch (error) {
        const known = error instanceof BusinessError;
        // 日志不记录微信身份与游戏 ID
        const entry = { requestId: traceId, action, result: known ? error.code : 'INTERNAL_ERROR', at: new Date().toISOString() };
        if (known) log.info(JSON.stringify(entry));
        // 数据库错误信息可能包含文档 _id（即 OpenID），因此只记录类型和错误码
        else log.error(JSON.stringify(Object.assign(entry, { errorType: error && error.name, errorCode: (error && (error.errCode || error.code)) || null })));
        return Object.assign(
          { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '服务暂时不可用，请稍后重试', requestId: traceId },
          known && error.data ? { data: error.data } : {}
        );
      }
    },
  };
}

module.exports = { createService, readCursor, cursorIdentity, effectiveStatus };
