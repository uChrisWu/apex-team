// 数据层：云开发文档型数据库（wx-server-sdk）。
// 集合：users（_id = OpenID）、team_posts（_id = 记录 ID）、join_requests（_id = 申请 ID）、reports（_id = 举报 ID）、app_config（_id = 'main'）。
// 所有集合的权限都应设为仅管理端可读写，只允许云函数访问。
const USERS = 'users';
const POSTS = 'team_posts';
const REQUESTS = 'join_requests';
const REPORTS = 'reports';
const CONFIG = 'app_config';

function createStore(db) {
  const _ = db.command;

  // 文档不存在时 get() 会抛错，这里转换为 null
  async function getDoc(ref) {
    try {
      const res = await ref.get();
      return res.data || null;
    } catch (err) {
      if (/not exist|does not exist|cannot find document/i.test(String(err && (err.errMsg || err.message)))) return null;
      throw err;
    }
  }

  function toUser(doc) {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return Object.assign({ openid: _id }, rest);
  }

  function toRecord(doc) {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return Object.assign({ id: _id }, rest);
  }

  function withoutId(record) {
    const { id, ...rest } = record;
    return rest;
  }

  function reader(handle) {
    return {
      getUser: async (openid) => toUser(await getDoc(handle.collection(USERS).doc(openid))),
      getPost: async (id) => toRecord(await getDoc(handle.collection(POSTS).doc(id))),
      getRequest: async (id) => toRecord(await getDoc(handle.collection(REQUESTS).doc(id))),
      getReport: async (id) => toRecord(await getDoc(handle.collection(REPORTS).doc(id))),
    };
  }

  // 选择具体选项时同时包含“不限”（ANY）
  function withAny(code) {
    return code === 'ANY' ? 'ANY' : _.in([code, 'ANY']);
  }

  return Object.assign(reader(db), {
    async getConfig() {
      const doc = await getDoc(db.collection(CONFIG).doc('main'));
      if (!doc) return null;
      const { _id, ...config } = doc;
      return config;
    },

    // _id 唯一，并发首次登录时只有一个 add 成功，其余读取已存在的账号
    async createUserIfMissing(user) {
      const { openid, ...data } = user;
      const existing = await getDoc(db.collection(USERS).doc(openid));
      if (existing) return toUser(existing);
      try {
        await db.collection(USERS).add({ data: Object.assign({ _id: openid }, data) });
        return user;
      } catch (err) {
        const raced = await getDoc(db.collection(USERS).doc(openid));
        if (raced) return toUser(raced);
        throw err;
      }
    },

    // 按创建时间、记录 ID 倒序的游标分页
    async listPosts({ ownerId, publicAt, filters = {}, after, limit }) {
      const base = { deletedAt: null };
      if (ownerId) {
        base.ownerId = ownerId;
      } else {
        base.status = 'RECRUITING';
        base.expiresAt = _.gt(publicAt);
        if (filters.modeCode) base.modeCode = filters.modeCode;
        if (filters.rankCode) base.rankCode = withAny(filters.rankCode);
        if (filters.serverCode) base.serverCode = withAny(filters.serverCode);
        if (filters.remainingSlots) base.remainingSlots = filters.remainingSlots;
      }
      const where = after
        ? _.and([base, _.or([{ createdAt: _.lt(after.createdAt) }, { createdAt: after.createdAt, _id: _.lt(after.id) }])])
        : base;
      const res = await db.collection(POSTS).where(where).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(limit).get();
      return res.data.map(toRecord);
    },

    // 一条信息的申请（含已处理），最多 100 条
    async listRequests(postId) {
      const res = await db.collection(REQUESTS).where({ postId }).orderBy('createdAt', 'desc').limit(100).get();
      return res.data.map(toRecord);
    },

    async countPendingRequests(postId) {
      const res = await db.collection(REQUESTS).where({ postId, status: 'PENDING' }).count();
      return res.total;
    },

    // 发送订阅消息时由内部用户 ID 找到 OpenID
    async getOpenidByUserId(userId) {
      const res = await db.collection(USERS).where({ userId }).field({ _id: true }).limit(1).get();
      return res.data.length ? res.data[0]._id : null;
    },

    // 事务内只使用按 _id 的读写；冲突时由 runTransaction 自动重试
    transaction(fn) {
      return db.runTransaction(async (t) => {
        const tx = Object.assign(reader(t), {
          createPost: (post) => t.collection(POSTS).doc(post.id).set({ data: withoutId(post) }),
          createRequest: (request) => t.collection(REQUESTS).doc(request.id).set({ data: withoutId(request) }),
          updateRequest: (id, patch) => t.collection(REQUESTS).doc(id).update({ data: withoutId(patch) }),
          createReport: (report) => t.collection(REPORTS).doc(report.id).set({ data: withoutId(report) }),
          updatePost: (id, patch) => t.collection(POSTS).doc(id).update({ data: patch }),
          updateUser: (openid, patch) => t.collection(USERS).doc(openid).update({ data: patch }),
        });
        return fn(tx);
      }, 3);
    },
  });
}

module.exports = { createStore };
