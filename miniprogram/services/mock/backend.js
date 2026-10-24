// 模拟后端：在本机按 V0.3 接口约定实现业务规则，供原型演示和自动化测试使用。
// 不依赖 wx，存储通过 load/save 注入，因此也能在 Node 中运行。
const { TEST_CONFIG, seedPosts } = require('./fixtures');
const { validatePostForm, FORM_FIELDS } = require('../../utils/validate');

const MAX_PAGE_SIZE = 50;

function createMockBackend({ load, save, now = () => Date.now() }) {
  let db = load() || freshDb(now());

  function persist() {
    save(db);
  }

  function ok(data, requestId) {
    return { code: 'OK', data, requestId: requestId || traceId() };
  }

  function fail(code, message, extra) {
    return Object.assign({ code, message, requestId: traceId() }, extra || {});
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

  function findPost(postId) {
    return db.posts.find((p) => p.id === postId && !p.deleted) || null;
  }

  function activePostOf(openid) {
    return db.posts.find((p) => p.ownerOpenid === openid && !p.deleted && effectiveStatus(p) === 'RECRUITING') || null;
  }

  function cardView(post) {
    const total = TEST_CONFIG.limits.maxPlayers;
    return {
      id: post.id,
      rankCode: post.rankCode,
      serverCode: post.serverCode,
      modeCode: post.modeCode,
      currentPlayers: post.currentPlayers,
      maxPlayers: total,
      remainingSlots: total - post.currentPlayers,
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
      isOwner,
      canEdit: isOwner && recruiting,
      canClose: isOwner && recruiting,
      canDelete: isOwner,
    });
  }

  function ownView(post) {
    return Object.assign(detailView(post, post.ownerOpenid), { gameId: post.gameId });
  }

  // 按发布时间倒序、ID 倒序排序；游标为最后一条的“时间|ID”
  function paginate(posts, cursor, limit, view) {
    const size = Math.min(Math.max(Number(limit) || TEST_CONFIG.limits.pageSize, 1), MAX_PAGE_SIZE);
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
    if (Number(version) !== post.version) return fail('VERSION_CONFLICT', '信息已被更新');
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

  const handlers = {
    getConfig() {
      return ok(TEST_CONFIG);
    },

    ensureUser(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      if (!db.users[openid]) {
        db.users[openid] = { userId: `u-${Object.keys(db.users).length + 1}`, createdAt: new Date(now()).toISOString() };
        persist();
      }
      const active = activePostOf(openid);
      return ok({
        userId: db.users[openid].userId,
        hasActivePost: !!active,
        activePostId: active ? active.id : null,
      });
    },

    listPosts(payload) {
      const { modeCode, rankCode, serverCode, remainingSlots, cursor, limit } = payload;
      const total = TEST_CONFIG.limits.maxPlayers;
      const posts = db.posts.filter((p) => {
        if (p.deleted || effectiveStatus(p) !== 'RECRUITING') return false;
        if (modeCode && p.modeCode !== modeCode) return false;
        // 选中某段位时，同时包含招募段位为“不限”的信息
        if (rankCode && p.rankCode !== rankCode && p.rankCode !== 'ANY') return false;
        if (serverCode && p.serverCode !== serverCode) return false;
        if (remainingSlots && total - p.currentPlayers !== Number(remainingSlots)) return false;
        return true;
      });
      return ok(paginate(posts, cursor, limit, cardView));
    },

    getPost(payload, openid) {
      const post = findPost(payload.postId);
      if (!post) return fail('NOT_FOUND', '信息不存在或已删除');
      return ok(detailView(post, openid));
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
      const prior = db.requests[key] && findPost(db.requests[key]);
      if (prior) return ok({ id: prior.id, status: effectiveStatus(prior), version: prior.version }, requestId);

      const { values, errors } = validatePostForm(pickForm(payload), 'create', TEST_CONFIG);
      if (Object.keys(errors).length) return fail('VALIDATION_ERROR', firstError(errors));

      const active = activePostOf(openid);
      if (active) return fail('ACTIVE_POST_EXISTS', '已有招募中的信息', { data: { existingPostId: active.id } });

      const t = now();
      db.seq += 1;
      const post = Object.assign({}, values, {
        id: `post-${t.toString(36)}-${db.seq}`,
        ownerOpenid: openid,
        status: 'RECRUITING',
        deleted: false,
        createdAt: new Date(t).toISOString(),
        updatedAt: new Date(t).toISOString(),
        expiresAt: new Date(t + TEST_CONFIG.limits.expireMinutes * 60000).toISOString(),
        version: 1,
      });
      db.posts.push(post);
      db.requests[key] = post.id;
      persist();
      return ok({ id: post.id, status: post.status, version: post.version }, requestId);
    },

    updatePost(payload, openid) {
      if (!openid) return fail('UNAUTHENTICATED', '请先登录');
      const post = findPost(payload.postId);
      const denied = checkOwnerWrite(post, openid, payload.version, true);
      if (denied) return denied;

      const { values, errors } = validatePostForm(pickForm(payload), 'edit', TEST_CONFIG);
      if (Object.keys(errors).length) return fail('VALIDATION_ERROR', firstError(errors));

      // 编辑不延长有效期
      Object.assign(post, values, {
        status: values.currentPlayers === TEST_CONFIG.limits.maxPlayers ? 'FULL' : 'RECRUITING',
        updatedAt: new Date(now()).toISOString(),
        version: post.version + 1,
      });
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
  };

  return {
    // openid 为 null 表示访客（未登录）
    handle(action, payload, openid) {
      const handler = handlers[action];
      if (!handler) return fail('INTERNAL_ERROR', `未知接口 ${action}`);
      return handler(payload || {}, openid || null);
    },
    reset() {
      db = freshDb(now());
      persist();
    },
  };
}

function freshDb(t) {
  return { seq: 0, users: {}, posts: seedPosts(t), requests: {} };
}

function compareDesc(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

module.exports = { createMockBackend };
