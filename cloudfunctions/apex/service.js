// 业务层：输入校验、业务规则与响应格式。数据读写通过注入的 store 完成，微信开放能力（内容安全、
// 订阅消息）通过注入的 wechat 完成，因此可以在 Node 中测试；部署时分别使用 store.js 与 wechat.js。
const crypto = require('node:crypto');

const ACTIONS = new Set([
  'getConfig', 'ensureUser', 'listPosts', 'getPost', 'getContact', 'createPost', 'updatePost', 'closePost', 'deletePost', 'listMyPosts',
  'applyToPost', 'cancelApplication', 'listPostRequests', 'decideRequest', 'reportPost', 'updateTeamInfo',
]);
const FORM_FIELDS = ['modeCode', 'rankCode', 'serverCode', 'currentPlayers', 'gameId', 'note'];
const MAX_PAGE_SIZE = 50;
const POST_ID = /^p_[0-9a-f]{64}$/;
const REQUEST_ID = /^r_[0-9a-f]{64}$/;

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

function findOption(options, code) {
  return typeof code === 'string' ? (options || []).find((item) => item.code === code) || null : null;
}

// 发布与编辑只接受启用中的选项；停用的选项仍可用于显示历史记录
function enabledOption(options, code) {
  const option = findOption(options, code);
  return option && option.enabled !== false ? option : null;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
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

function validateText(value, { required, max, label }) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') invalid(required ? `请填写${label}` : `${label}格式无效`);
  const text = value.trim();
  if (required && !text) invalid(`请填写${label}`);
  if (codePoints(text) > max) invalid(`${label}最多 ${max} 个字符`);
  return text;
}

function validateForm(payload, isCreate, config) {
  const mode = enabledOption(config.modes, payload.modeCode);
  if (!mode) invalid('游戏模式无效');
  if (!enabledOption(config.ranks, payload.rankCode)) invalid('目标段位无效');
  if (!enabledOption(config.servers, payload.serverCode)) invalid('服务器无效');
  // 队伍上限按模式确定：新建时不能已满，编辑时允许满员
  const maxPlayers = mode.maxPlayers || config.limits.maxPlayers;
  const top = isCreate ? maxPlayers - 1 : maxPlayers;
  if (!Number.isInteger(payload.currentPlayers) || payload.currentPlayers < 1 || payload.currentPlayers > top) {
    invalid(`当前人数只能是 1 至 ${top}`);
  }
  return {
    modeCode: payload.modeCode,
    rankCode: payload.rankCode,
    serverCode: payload.serverCode,
    currentPlayers: payload.currentPlayers,
    maxPlayers,
    gameId: validateText(payload.gameId, { required: true, max: config.limits.gameIdMaxLength, label: '游戏 ID' }),
    note: validateText(payload.note, { required: false, max: config.limits.noteMaxLength, label: '备注' }),
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

// 待处理申请在队伍不再招募后视为已失效
function requestStatus(request, post, now) {
  if (request.status === 'PENDING' && !isActive(post, now)) return 'EXPIRED';
  return request.status;
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

function ownView(post, now, pendingRequestCount) {
  return Object.assign(detailView(post, { userId: post.ownerId }, now), { gameId: post.gameId, pendingRequestCount });
}

function requestView(request, post, now) {
  return {
    id: request.id,
    postId: request.postId,
    status: requestStatus(request, post, now),
    applicantGameId: request.applicantGameId,
    message: request.message,
    createdAt: toIso(request.createdAt),
    decidedAt: toIso(request.decidedAt),
  };
}

// 组队方式（私人房间等）只给发布者和已被同意的申请人看
function withTeamInfo(view, post) {
  return Object.assign(view, { teamInfo: post.teamInfo || '', teamInfoUpdatedAt: toIso(post.teamInfoUpdatedAt) });
}

// 招募中或已满员时可以更新组队方式；已结束、已过期后不再需要
function canShareTeamInfo(post, now) {
  return ['RECRUITING', 'FULL'].includes(effectiveStatus(post, now));
}

function postPatchForCount(post, currentPlayers, at) {
  return {
    currentPlayers,
    remainingSlots: post.maxPlayers - currentPlayers,
    status: currentPlayers >= post.maxPlayers ? 'FULL' : 'RECRUITING',
    updatedAt: at,
    version: post.version + 1,
  };
}

// 订阅消息字段值：thing 类最多 20 个字符，时间按北京时间显示
function noticeValue(kind, text) {
  if (kind.startsWith('time') || kind.startsWith('date')) return text;
  const chars = Array.from(String(text || '-'));
  return chars.length > 20 ? chars.slice(0, 19).join('') + '…' : chars.join('');
}

function beijingTime(date) {
  const d = new Date(date.getTime() + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ---------- 服务 ----------

function createService({ store, wechat, now = () => new Date(), clock = () => Date.now(), log = console, configTtlMs = 60000 }) {
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

  // 用户填写的文字先经过微信内容安全检测；检测服务异常时拒绝写入（BE-09）
  async function checkContent(openid, texts) {
    const content = texts.filter(Boolean).join('\n');
    if (!content) return;
    const suggest = await wechat.checkText(openid, content);
    if (suggest === 'risky') fail('CONTENT_RISKY', '内容包含不合规信息，请修改后重试');
  }

  // 所有者写操作的公共检查
  function checkOwnerWrite(post, user, version, needActive, at) {
    if (!post || post.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
    if (post.ownerId !== user.userId) fail('FORBIDDEN', '只有发布者可以操作');
    if (version !== undefined && post.version !== version) fail('VERSION_CONFLICT', '信息已被更新');
    if (needActive && effectiveStatus(post, at) !== 'RECRUITING') fail('POST_UNAVAILABLE', '该信息已不在招募中');
  }

  // 记录不再招募时，仅在用户引用仍指向它时释放，避免清除新发布的引用
  async function releaseActive(tx, user, post) {
    if (user.activePostId === post.id) await tx.updateUser(user.openid, { activePostId: null });
  }

  async function pendingCountFor(post, at) {
    return isActive(post, at) ? store.countPendingRequests(post.id) : 0;
  }

  // 给房主发送订阅消息；失败（未订阅、额度用完等）只记录，不影响申请结果
  async function notifyOwner(post, request, at) {
    try {
      const config = await loadConfig();
      const notify = config.notify || {};
      if (!notify.templateId || !notify.fields) return;
      const ownerOpenid = await store.getOpenidByUserId(post.ownerId);
      if (!ownerOpenid) return;
      const modeName = (findOption(config.modes, post.modeCode) || {}).name || post.modeCode;
      const serverName = (findOption(config.servers, post.serverCode) || {}).name || post.serverCode;
      const values = {
        applicant: request.applicantGameId,
        post: `${modeName} · ${serverName} ${post.currentPlayers}/${post.maxPlayers}`,
        message: request.message || '无留言',
        // 适合只有“申请内容”一个文字字段的模板：队伍概要加留言
        content: request.message ? `申请加入${modeName}：${request.message}` : `申请加入${modeName} · ${serverName}`,
        time: beijingTime(at),
      };
      const data = {};
      Object.keys(notify.fields).forEach((name) => {
        const key = notify.fields[name];
        if (key && values[name] !== undefined) data[key] = { value: noticeValue(key, values[name]) };
      });
      await wechat.sendSubscribeMessage({
        touser: ownerOpenid,
        templateId: notify.templateId,
        page: `pages/detail/detail?id=${post.id}`,
        data,
        miniprogramState: notify.miniprogramState || 'formal',
      });
    } catch (error) {
      log.info(JSON.stringify({ event: 'notifyOwner', result: 'FAILED', errorCode: (error && (error.errCode || error.code)) || null }));
    }
  }

  const handlers = {
    async getConfig() {
      const config = await loadConfig();
      return {
        modes: config.modes,
        ranks: config.ranks,
        servers: config.servers,
        reportReasons: config.reportReasons || [],
        limits: config.limits,
        notify: { templateId: (config.notify && config.notify.templateId) || '' },
      };
    },

    async ensureUser(payload, openid, at) {
      if (!openid) fail('UNAUTHENTICATED', '无法取得微信身份');
      const user = await store.createUserIfMissing({
        openid,
        userId: crypto.randomUUID(),
        activePostId: null,
        lastGameId: '',
        createdAt: at,
      });
      const active = user.activePostId ? await store.getPost(user.activePostId) : null;
      const activeId = isActive(active, at) ? active.id : null;
      return {
        userId: user.userId,
        hasActivePost: !!activeId,
        activePostId: activeId,
        pendingRequestCount: activeId ? await store.countPendingRequests(activeId) : 0,
        lastGameId: user.lastGameId || '',
      };
    },

    async listPosts(payload, openid, at) {
      if (!hasOnly(payload, ['modeCode', 'rankCode', 'serverCode', 'remainingSlots', 'cursor', 'limit'])) invalid('筛选条件无效');
      const config = await loadConfig();
      for (const [field, options] of [['modeCode', config.modes], ['rankCode', config.ranks], ['serverCode', config.servers]]) {
        if (payload[field] !== undefined && !findOption(options, payload[field])) invalid('筛选条件无效');
      }
      if (payload.remainingSlots !== undefined && ![1, 2].includes(payload.remainingSlots)) invalid('缺少人数无效');
      const filters = {
        modeCode: payload.modeCode,
        rankCode: payload.rankCode,
        serverCode: payload.serverCode,
        remainingSlots: payload.remainingSlots,
      };
      const identity = cursorIdentity(['hall', filters.modeCode || '', filters.rankCode || '', filters.serverCode || '', filters.remainingSlots || 0]);
      return page({ publicAt: at, filters }, payload, identity, config, (p) => cardView(p, at));
    },

    async listMyPosts(payload, openid, at) {
      if (!hasOnly(payload, ['cursor', 'limit'])) invalid('筛选条件无效');
      const user = await requireUser(openid, store);
      const config = await loadConfig();
      const result = await page({ ownerId: user.userId }, payload, cursorIdentity(['mine', user.userId]), config, (p) => p);
      // 每人最多一条有效招募，只有它可能有待处理申请
      const items = [];
      for (const post of result.items) items.push(ownView(post, at, await pendingCountFor(post, at)));
      return Object.assign(result, { items });
    },

    async getPost(payload, openid, at) {
      if (!hasOnly(payload, ['postId'])) invalid('请求内容无效');
      requirePostId(payload);
      const post = await store.getPost(payload.postId);
      if (!post || post.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
      const user = openid ? await store.getUser(openid) : null;
      const view = detailView(post, user, at);
      if (user && user.userId === post.ownerId) {
        withTeamInfo(view, post);
        view.canEditTeamInfo = canShareTeamInfo(post, at);
      } else if (user) {
        // 非发布者可看到自己对这条信息的申请状态；被同意后可看到组队方式
        const request = await store.getRequest(requestIdFor(post.id, user.userId));
        view.myRequest = request ? requestView(request, post, at) : null;
        if (request && request.status === 'ACCEPTED') withTeamInfo(view.myRequest, post);
      }
      return view;
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
      await requireUser(openid, store);
      await checkContent(openid, [form.gameId, form.note]);

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
        const post = Object.assign({ id, ownerId: user.userId }, form, {
          remainingSlots: form.maxPlayers - form.currentPlayers,
          status: 'RECRUITING',
          createdAt: at,
          updatedAt: at,
          expiresAt: new Date(at.getTime() + config.limits.expireMinutes * 60000),
          deletedAt: null,
          version: 1,
          createRequestId: payload.requestId,
        });
        await tx.createPost(post);
        await tx.updateUser(user.openid, { activePostId: id, lastGameId: form.gameId });
        return { id, status: 'RECRUITING', version: 1 };
      });
    },

    async updatePost(payload, openid, at) {
      checkWritePayload(payload, [...FORM_FIELDS, 'postId', 'version']);
      const config = await loadConfig();
      const form = validateForm(payload, false, config);
      await requireUser(openid, store);
      await checkContent(openid, [form.gameId, form.note]);

      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const post = await tx.getPost(payload.postId);
        checkOwnerWrite(post, user, payload.version, true, at);
        // 编辑不改变 createdAt、expiresAt
        const patch = Object.assign({}, form, postPatchForCount(Object.assign({}, post, form), form.currentPlayers, at));
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

    // ---------- 申请加入（BE-08） ----------

    async applyToPost(payload, openid, at) {
      if (!hasOnly(payload, ['postId', 'gameId', 'message'])) invalid('请求内容无效');
      requirePostId(payload);
      const config = await loadConfig();
      const gameId = validateText(payload.gameId, { required: true, max: config.limits.gameIdMaxLength, label: '游戏 ID' });
      const message = validateText(payload.message, { required: false, max: config.limits.applyMessageMaxLength, label: '留言' });
      const applicant = await requireUser(openid, store);
      const existing = await store.getRequest(requestIdFor(payload.postId, applicant.userId));
      if (!existing || existing.status === 'CANCELLED') await checkContent(openid, [gameId, message]);

      const result = await inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const post = await tx.getPost(payload.postId);
        if (!post || post.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
        if (post.ownerId === user.userId) fail('FORBIDDEN', '不能申请加入自己发布的队伍');
        if (!isActive(post, at)) fail('POST_UNAVAILABLE', '该信息已不在招募中');
        const id = requestIdFor(post.id, user.userId);
        const prior = await tx.getRequest(id);
        // 每人对每条信息只有一条申请；撤回后可以重新申请，已处理的申请不能重复提交
        if (prior && prior.status !== 'CANCELLED') return { request: prior, post, created: false };
        const request = {
          id,
          postId: post.id,
          postOwnerId: post.ownerId,
          applicantId: user.userId,
          applicantGameId: gameId,
          message,
          status: 'PENDING',
          createdAt: at,
          updatedAt: at,
          decidedAt: null,
        };
        if (prior) await tx.updateRequest(id, request);
        else await tx.createRequest(request);
        await tx.updateUser(user.openid, { lastGameId: gameId });
        return { request, post, created: true };
      });

      if (result.created) await notifyOwner(result.post, result.request, at);
      return requestView(result.request, result.post, at);
    },

    async cancelApplication(payload, openid, at) {
      if (!hasOnly(payload, ['postId'])) invalid('请求内容无效');
      requirePostId(payload);
      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const id = requestIdFor(payload.postId, user.userId);
        const request = await tx.getRequest(id);
        if (!request) fail('NOT_FOUND', '申请不存在');
        if (request.status !== 'PENDING') invalid('申请已处理，无法撤回');
        const patch = { status: 'CANCELLED', updatedAt: at };
        await tx.updateRequest(id, patch);
        return requestView(Object.assign({}, request, patch), await tx.getPost(payload.postId), at);
      });
    },

    async listPostRequests(payload, openid, at) {
      if (!hasOnly(payload, ['postId'])) invalid('请求内容无效');
      requirePostId(payload);
      const user = await requireUser(openid, store);
      const post = await store.getPost(payload.postId);
      checkOwnerWrite(post, user, undefined, false, at);
      const requests = await store.listRequests(post.id);
      // 待处理的排在前面，其余按申请时间倒序
      const items = requests
        .map((r) => requestView(r, post, at))
        .filter((r) => r.status !== 'CANCELLED')
        .sort((a, b) => (b.status === 'PENDING') - (a.status === 'PENDING') || (a.createdAt < b.createdAt ? 1 : -1));
      return { items };
    },

    async decideRequest(payload, openid, at) {
      if (!hasOnly(payload, ['requestId', 'decision'])) invalid('请求内容无效');
      if (typeof payload.requestId !== 'string' || !REQUEST_ID.test(payload.requestId)) fail('NOT_FOUND', '申请不存在');
      if (!['ACCEPT', 'REJECT'].includes(payload.decision)) invalid('处理方式无效');
      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const request = await tx.getRequest(payload.requestId);
        if (!request) fail('NOT_FOUND', '申请不存在');
        const post = await tx.getPost(request.postId);
        checkOwnerWrite(post, user, undefined, true, at);
        if (request.status !== 'PENDING') invalid('该申请已处理');

        let updatedPost = post;
        if (payload.decision === 'ACCEPT') {
          // 同意即人数 +1；凑满后自动满员并释放有效招募引用，其余待处理申请随之失效
          if (post.currentPlayers >= post.maxPlayers) fail('POST_UNAVAILABLE', '队伍已满员');
          const patch = postPatchForCount(post, post.currentPlayers + 1, at);
          await tx.updatePost(post.id, patch);
          updatedPost = Object.assign({}, post, patch);
          if (updatedPost.status !== 'RECRUITING') await releaseActive(tx, user, updatedPost);
        }
        const requestPatch = { status: payload.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED', decidedAt: at, updatedAt: at };
        await tx.updateRequest(request.id, requestPatch);
        const postView = withTeamInfo(detailView(updatedPost, user, at), updatedPost);
        postView.canEditTeamInfo = canShareTeamInfo(updatedPost, at);
        return {
          request: requestView(Object.assign({}, request, requestPatch), updatedPost, at),
          post: postView,
        };
      });
    },

    // 房主填写私人房间、语音频道等组队方式，只对已同意的申请人展示；不改变 version，不影响编辑
    async updateTeamInfo(payload, openid, at) {
      if (!hasOnly(payload, ['postId', 'teamInfo'])) invalid('请求内容无效');
      requirePostId(payload);
      const config = await loadConfig();
      const teamInfo = validateText(payload.teamInfo, { required: false, max: config.limits.teamInfoMaxLength || 100, label: '组队方式' });
      await requireUser(openid, store);
      await checkContent(openid, [teamInfo]);
      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const post = await tx.getPost(payload.postId);
        checkOwnerWrite(post, user, undefined, false, at);
        if (!canShareTeamInfo(post, at)) fail('POST_UNAVAILABLE', '该信息已结束，无法更新组队方式');
        const patch = { teamInfo, teamInfoUpdatedAt: at };
        await tx.updatePost(post.id, patch);
        return withTeamInfo({ id: post.id }, Object.assign({}, post, patch));
      });
    },

    // ---------- 举报（BE-10） ----------

    // 举报只保存给管理员处理，不对外展示；同一用户对同一信息只记录一次
    async reportPost(payload, openid, at) {
      if (!hasOnly(payload, ['postId', 'reason', 'detail'])) invalid('请求内容无效');
      requirePostId(payload);
      const config = await loadConfig();
      if (!enabledOption(config.reportReasons, payload.reason)) invalid('请选择举报原因');
      const detail = validateText(payload.detail, { required: false, max: config.limits.reportDetailMaxLength || 100, label: '举报说明' });
      return inTransaction(async (tx) => {
        const user = await requireUser(openid, tx);
        const post = await tx.getPost(payload.postId);
        if (!post || post.deletedAt) fail('NOT_FOUND', '信息不存在或已删除');
        if (post.ownerId === user.userId) fail('FORBIDDEN', '不能举报自己发布的信息');
        const id = 'rp_' + sha256(`${post.id}:${user.userId}`);
        const prior = await tx.getReport(id);
        if (prior) return { id, status: prior.status, duplicate: true };
        await tx.createReport({
          id,
          postId: post.id,
          postOwnerId: post.ownerId,
          reporterId: user.userId,
          reason: payload.reason,
          detail,
          // 保存举报时的内容快照，便于信息被修改或删除后核查
          snapshot: { gameId: post.gameId, note: post.note, modeCode: post.modeCode, serverCode: post.serverCode },
          status: 'OPEN',
          createdAt: at,
        });
        return { id, status: 'OPEN', duplicate: false };
      });
    },
  };

  function requestIdFor(postId, userId) {
    return 'r_' + sha256(`${postId}:${userId}`);
  }

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
