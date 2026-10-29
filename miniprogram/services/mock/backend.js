// 模拟后端：在本机按接口约定实现业务规则，供离线演示和自动化测试使用；规则与云函数 service.js 保持一致。
// 不依赖 wx，存储通过 load/save 注入，因此也能在 Node 中运行。
// 内容安全检测在模拟模式下用关键词“违规”代替微信接口。
const { APP_CONFIG, seedPosts } = require('./fixtures');
const { validatePostForm, validateApplyForm, validateTeamInfo, FORM_FIELDS } = require('../../utils/validate');

const MAX_PAGE_SIZE = 50;
const MOCK_RISKY_WORD = '违规';

function createMockBackend({ load, save, now = () => Date.now() }) {
  let db = normalize(load()) || freshDb(now());

  function persist() {
    save(db);
  }

  function ok(data, requestId) {
    return { code: 'OK', data, requestId: requestId || traceId() };
  }

  function fail(code, message, data) {
    return Object.assign({ code, message, requestId: traceId() }, data ? { data } : {});
  }

  function traceId() {
    db.seq += 1;
    return `mock-trace-${db.seq}`;
  }

  // 招募中但已到期的记录按“已过期”对外展示
  function effectiveStatus(post) {
    if (post.status === 'RECRUITING' && now() >= new Date(post.expiresAt).getTime()) return 'EXPIRED';
    return post.status;
  }

  function isActive(post) {
    return !!post && !post.deleted && effectiveStatus(post) === 'RECRUITING';
  }

  function findPost(postId) {
    return db.posts.find((p) => p.id === postId && !p.deleted) || null;
  }

  function activePostOf(openid) {
    return db.posts.find((p) => p.ownerOpenid === openid && isActive(p)) || null;
  }

  function requestOf(postId, openid) {
    return db.requests.find((r) => r.postId === postId && r.applicantOpenid === openid) || null;
  }

  function pendingCount(post) {
    return isActive(post) ? db.requests.filter((r) => r.postId === post.id && r.status === 'PENDING').length : 0;
  }

  function isRisky(...texts) {
    return texts.some((t) => String(t || '').indexOf(MOCK_RISKY_WORD) !== -1);
  }

  function cardView(post) {
    return {
      id: post.id,
      modeCode: post.modeCode,
      rankCode: post.rankCode,
      serverCode: post.serverCode,
      currentPlayers: post.currentPlayers,
      maxPlayers: post.maxPlayers,
      remainingSlots: post.maxPlayers - post.currentPlayers,
      note: post.note,
      status: effectiveStatus(post),
      createdAt: post.createdAt,
      expiresAt: post.expiresAt,
      version: post.version,
    };
  }

  function detailView(post, openid) {
    const isOwner = !!openid && post.ownerOpenid === openid;
    const recruiting = effectiveStatus(post) === 'RECRUITING';
    return Object.assign(cardView(post), {
      updatedAt: post.updatedAt,
      canEdit: isOwner && recruiting,
      canClose: isOwner && recruiting,
      canDelete: isOwner,
    });
  }

  function ownView(post) {
    return Object.assign(detailView(post, post.ownerOpenid), { gameId: post.gameId, pendingRequestCount: pendingCount(post) });
  }

  function requestView(request) {
    const post = db.posts.find((p) => p.id === request.postId);
    return {
      id: request.id,
      postId: request.postId,
      status: request.status === 'PENDING' && !isActive(post) ? 'EXPIRED' : request.status,
      applicantGameId: request.applicantGameId,
      message: request.message,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
    };
  }

  // 组队方式只给发布者和已被同意的申请人看；招募中或已满员时可以更新
  function withTeamInfo(view, post) {
    return Object.assign(view, { teamInfo: post.teamInfo || '', teamInfoUpdatedAt: post.teamInfoUpdatedAt || null });
  }

  function canShareTeamInfo(post) {
    return ['RECRUITING', 'FULL'].includes(effectiveStatus(post));
  }

  // 按发布时间倒序、ID 倒序排序；游标为最后一条的“时间|ID”
  function paginate(posts, cursor, limit, view) {
    const size = Math.min(Math.max(Number(limit) || APP_CONFIG.limits.pageSize, 1), MAX_PAGE_SIZE);
    const sorted = posts.slice().sort(compareDesc);
    let start = 0;
    if (cursor) {
      const [t, id] = String(cursor).split('|');
      start = sorted.findIndex((p) => compareDesc(p, { createdAt: t, id }) > 0);
      if (start === -1) start = sorted.length;
    }
    const page = sorted.slice(start, start + size);
    const hasMore = start + size < sorted.length;
    const last = page[page.length - 1];
    return {
      items: page.map(view),
      nextCursor: hasMore && last ? `${last.createdAt}|${last.id}` : null,
      hasMore,
    };
  }

  // 校验所有权、版本与状态；返回错误响应或 null
  function checkOwnerWrite(post, openid, version, needRecruiting) {
    if (!post) return fail('NOT_FOUND', '信息不存在或已删除');
    if (post.ownerOpenid !== openid) return fail('FORBIDDEN', '只有发布者可以操作');
    if (version !== undefined && Number(version) !== post.version) return fail('VERSION_CONFLICT', '信息已被更新');
    if (needRecruiting && effectiveStatus(post) !== 'RECRUITING') return fail('POST_UNAVAILABLE', '该信息已不在招募中');
    return null;
  }

  function pickForm(payload) {
    const form = {};
    FORM_FIELDS.forEach((k) => {
      form[k] = payload[k];
    });
    return form;
  }

  function firstError(errors) {
    return errors[Object.keys(errors)[0]];
  }

  function maxPlayersOf(modeCode) {
    const mode = APP_CONFIG.modes.find((m) => m.code === modeCode);
    return (mode && mode.maxPlayers) || APP_CONFIG.limits.maxPlayers;
  }

  function setCount(post, count) {
    post.currentPlayers = count;
    post.status = count >= post.maxPlayers ? 'FULL' : 'RECRUITING';
    post.updatedAt = new Date(now()).toISOString();
    post.version += 1;
  }

  function withAny(code, value) {
    return value === code || (code !== 'ANY' && value === 'ANY');
  }

  const handlers = {
    getConfig() {
      return ok(APP_CONFIG);
    },

    ensureUser(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      if (!db.users[openid]) {
        db.users[openid] = { userId: `u-${Object.keys(db.users).length + 1}`, lastGameId: '', createdAt: new Date(now()).toISOString() };
        persist();
      }
      const active = activePostOf(openid);
      return ok({
        userId: db.users[openid].userId,
        hasActivePost: !!active,
        activePostId: active ? active.id : null,
        pendingRequestCount: active ? pendingCount(active) : 0,
        lastGameId: db.users[openid].lastGameId || '',
      });
    },

    listPosts(payload) {
      const { modeCode, rankCode, serverCode, remainingSlots, cursor, limit } = payload;
      const posts = db.posts.filter((p) => {
        if (!isActive(p)) return false;
        if (modeCode && p.modeCode !== modeCode) return false;
        // 选中具体段位或服务器时，同时包含“不限”
        if (rankCode && !withAny(rankCode, p.rankCode)) return false;
        if (serverCode && !withAny(serverCode, p.serverCode)) return false;
        if (remainingSlots && p.maxPlayers - p.currentPlayers !== Number(remainingSlots)) return false;
        return true;
      });
      return ok(paginate(posts, cursor, limit, cardView));
    },

    getPost(payload, openid) {
      const post = findPost(payload.postId);
      if (!post) return fail('NOT_FOUND', '信息不存在或已删除');
      const view = detailView(post, openid);
      if (openid && post.ownerOpenid === openid) {
        withTeamInfo(view, post);
        view.canEditTeamInfo = canShareTeamInfo(post);
      } else if (openid) {
        const request = requestOf(post.id, openid);
        view.myRequest = request ? requestView(request) : null;
        if (request && request.status === 'ACCEPTED') withTeamInfo(view.myRequest, post);
      }
      return ok(view);
    },

    getContact(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      if (!post) return fail('NOT_FOUND', '信息不存在或已删除');
      if (effectiveStatus(post) !== 'RECRUITING') return fail('POST_UNAVAILABLE', '该信息已不在招募中');
      return ok({ gameId: post.gameId });
    },

    createPost(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const requestId = payload.requestId;
      if (!requestId) return fail('VALIDATION_ERROR', '缺少请求标识');

      // 幂等：同一用户重复提交同一 requestId 返回首次结果
      const key = `${openid}:${requestId}`;
      if (db.idempotency[key]) {
        const prior = db.posts.find((p) => p.id === db.idempotency[key]);
        if (prior.deleted) return fail('NOT_FOUND', '信息不存在或已删除');
        return ok({ id: prior.id, status: effectiveStatus(prior), version: prior.version }, requestId);
      }

      const { values, errors } = validatePostForm(pickForm(payload), 'create', APP_CONFIG);
      if (Object.keys(errors).length) return fail('VALIDATION_ERROR', firstError(errors));
      if (isRisky(values.gameId, values.note)) return fail('CONTENT_RISKY', '内容包含不合规信息，请修改后重试');

      const active = activePostOf(openid);
      if (active) return fail('ACTIVE_POST_EXISTS', '已有招募中的信息', { existingPostId: active.id });

      const t = now();
      db.seq += 1;
      const post = Object.assign({}, values, {
        id: `post-${t.toString(36)}-${db.seq}`,
        ownerOpenid: openid,
        maxPlayers: maxPlayersOf(values.modeCode),
        status: 'RECRUITING',
        deleted: false,
        createdAt: new Date(t).toISOString(),
        updatedAt: new Date(t).toISOString(),
        expiresAt: new Date(t + APP_CONFIG.limits.expireMinutes * 60000).toISOString(),
        version: 1,
      });
      db.posts.push(post);
      db.idempotency[key] = post.id;
      if (db.users[openid]) db.users[openid].lastGameId = values.gameId;
      persist();
      return ok({ id: post.id, status: post.status, version: post.version }, requestId);
    },

    updatePost(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      const denied = checkOwnerWrite(post, openid, payload.version, true);
      if (denied) return denied;

      const { values, errors } = validatePostForm(pickForm(payload), 'edit', APP_CONFIG);
      if (Object.keys(errors).length) return fail('VALIDATION_ERROR', firstError(errors));
      if (isRisky(values.gameId, values.note)) return fail('CONTENT_RISKY', '内容包含不合规信息，请修改后重试');

      // 编辑不延长有效期
      Object.assign(post, values, { maxPlayers: maxPlayersOf(values.modeCode) });
      setCount(post, values.currentPlayers);
      persist();
      return ok(detailView(post, openid));
    },

    closePost(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      const denied = checkOwnerWrite(post, openid, payload.version, true);
      if (denied) return denied;
      post.status = 'CLOSED';
      post.updatedAt = new Date(now()).toISOString();
      post.version += 1;
      persist();
      return ok({ id: post.id, status: post.status, version: post.version });
    },

    deletePost(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      const denied = checkOwnerWrite(post, openid, payload.version, false);
      if (denied) return denied;
      post.deleted = true;
      post.updatedAt = new Date(now()).toISOString();
      post.version += 1;
      persist();
      return ok({ id: post.id });
    },

    listMyPosts(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const posts = db.posts.filter((p) => p.ownerOpenid === openid && !p.deleted);
      return ok(paginate(posts, payload.cursor, payload.limit, ownView));
    },

    applyToPost(payload, openid) {
      if (!openid || !db.users[openid]) return fail('UNAUTHENTICATED', '请先登录');
      const { values, errors } = validateApplyForm(payload, APP_CONFIG);
      if (Object.keys(errors).length) return fail('VALIDATION_ERROR', firstError(errors));
      const post = findPost(payload.postId);
      if (!post) return fail('NOT_FOUND', '信息不存在或已删除');
      if (post.ownerOpenid === openid) return fail('FORBIDDEN', '不能申请加入自己发布的队伍');
      if (!isActive(post)) return fail('POST_UNAVAILABLE', '该信息已不在招募中');
      const prior = requestOf(post.id, openid);
      if (prior && prior.status !== 'CANCELLED') return ok(requestView(prior));
      if (isRisky(values.gameId, values.message)) return fail('CONTENT_RISKY', '内容包含不合规信息，请修改后重试');

      const t = new Date(now()).toISOString();
      const request = prior || { id: `req-${post.id}-${db.users[openid].userId}`, postId: post.id, applicantOpenid: openid };
      Object.assign(request, { applicantGameId: values.gameId, message: values.message, status: 'PENDING', createdAt: t, decidedAt: null });
      if (!prior) db.requests.push(request);
      db.users[openid].lastGameId = values.gameId;
      persist();
      return ok(requestView(request));
    },

    cancelApplication(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const request = requestOf(payload.postId, openid);
      if (!request) return fail('NOT_FOUND', '申请不存在');
      if (request.status !== 'PENDING') return fail('VALIDATION_ERROR', '申请已处理，无法撤回');
      request.status = 'CANCELLED';
      persist();
      return ok(requestView(request));
    },

    listPostRequests(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      const denied = checkOwnerWrite(post, openid, undefined, false);
      if (denied) return denied;
      const items = db.requests
        .filter((r) => r.postId === post.id && r.status !== 'CANCELLED')
        .map(requestView)
        .sort((a, b) => (b.status === 'PENDING') - (a.status === 'PENDING') || (a.createdAt < b.createdAt ? 1 : -1));
      return ok({ items });
    },

    reportPost(payload, openid) {
      if (!openid || !db.users[openid]) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      if (!post) return fail('NOT_FOUND', '信息不存在或已删除');
      if (post.ownerOpenid === openid) return fail('FORBIDDEN', '不能举报自己发布的信息');
      if (!APP_CONFIG.reportReasons.some((r) => r.code === payload.reason)) return fail('VALIDATION_ERROR', '请选择举报原因');
      db.reports = db.reports || [];
      const prior = db.reports.find((r) => r.postId === post.id && r.reporterOpenid === openid);
      if (prior) return ok({ id: prior.id, status: prior.status, duplicate: true });
      const report = { id: `rp-${post.id}-${db.users[openid].userId}`, postId: post.id, reporterOpenid: openid, reason: payload.reason, status: 'OPEN', createdAt: new Date(now()).toISOString() };
      db.reports.push(report);
      persist();
      return ok({ id: report.id, status: 'OPEN', duplicate: false });
    },

    decideRequest(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const request = db.requests.find((r) => r.id === payload.requestId);
      if (!request) return fail('NOT_FOUND', '申请不存在');
      const post = findPost(request.postId);
      const denied = checkOwnerWrite(post, openid, undefined, true);
      if (denied) return denied;
      if (request.status !== 'PENDING') return fail('VALIDATION_ERROR', '该申请已处理');
      if (payload.decision === 'ACCEPT') {
        if (post.currentPlayers >= post.maxPlayers) return fail('POST_UNAVAILABLE', '队伍已满员');
        setCount(post, post.currentPlayers + 1);
      } else if (payload.decision !== 'REJECT') {
        return fail('VALIDATION_ERROR', '处理方式无效');
      }
      request.status = payload.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      request.decidedAt = new Date(now()).toISOString();
      persist();
      const postView = withTeamInfo(detailView(post, openid), post);
      postView.canEditTeamInfo = canShareTeamInfo(post);
      return ok({ request: requestView(request), post: postView });
    },

    updateTeamInfo(payload, openid) {
      if (!openid || !db.users[openid]) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      const denied = checkOwnerWrite(post, openid, undefined, false);
      if (denied) return denied;
      const { value, error } = validateTeamInfo(payload.teamInfo, APP_CONFIG);
      if (error) return fail('VALIDATION_ERROR', error);
      if (isRisky(value)) return fail('CONTENT_RISKY', '内容包含不合规信息，请修改后重试');
      if (!canShareTeamInfo(post)) return fail('POST_UNAVAILABLE', '该信息已结束，无法更新组队方式');
      post.teamInfo = value;
      post.teamInfoUpdatedAt = new Date(now()).toISOString();
      persist();
      return ok(withTeamInfo({ id: post.id }, post));
    },
  };

  return {
    // openid 为 null 表示访客（未登录）
    handle(action, payload, openid) {
      const handler = handlers[action];
      if (!handler) return fail('VALIDATION_ERROR', `未知接口 ${action}`);
      return handler(payload || {}, openid || null);
    },
    reset() {
      db = freshDb(now());
      persist();
    },
  };
}

function freshDb(t) {
  return { seq: 0, users: {}, posts: seedPosts(t), requests: [], idempotency: {} };
}

// 旧版本地数据缺少新字段时视为无效，重新生成
function normalize(db) {
  return db && Array.isArray(db.requests) && db.idempotency ? db : null;
}

function compareDesc(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

module.exports = { createMockBackend, MOCK_RISKY_WORD };
