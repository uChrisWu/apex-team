// 数据层：云开发文档型数据库（wx-server-sdk）。
// 集合：users（_id = OpenID）、team_posts（_id = 记录 ID）、app_config（_id = 'main'）。
// 三个集合的权限都应设为客户端不可读写，只允许云函数访问。
const USERS = 'users';
const POSTS = 'team_posts';
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

  function toPost(doc) {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return Object.assign({ id: _id }, rest);
  }

  function postData(post) {
    const { id, ...rest } = post;
    return rest;
  }

  function reader(handle) {
    return {
      getUser: async (openid) => toUser(await getDoc(handle.collection(USERS).doc(openid))),
      getPost: async (id) => toPost(await getDoc(handle.collection(POSTS).doc(id))),
    };
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
        // 选择具体段位时同时包含“不限”
        if (filters.rankCode) base.rankCode = _.in([filters.rankCode, 'ANY']);
        if (filters.serverCode) base.serverCode = filters.serverCode;
        if (filters.currentPlayers) base.currentPlayers = filters.currentPlayers;
      }
      const where = after
        ? _.and([base, _.or([{ createdAt: _.lt(after.createdAt) }, { createdAt: after.createdAt, _id: _.lt(after.id) }])])
        : base;
      const res = await db.collection(POSTS).where(where).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(limit).get();
      return res.data.map(toPost);
    },

    // 事务内只使用按 _id 的读写；冲突时由 runTransaction 自动重试
    transaction(fn) {
      return db.runTransaction(async (t) => {
        const tx = Object.assign(reader(t), {
          createPost: (post) => t.collection(POSTS).doc(post.id).set({ data: postData(post) }),
          updatePost: (id, patch) => t.collection(POSTS).doc(id).update({ data: patch }),
          updateUser: (openid, patch) => t.collection(USERS).doc(openid).update({ data: patch }),
        });
        return fn(tx);
      }, 3);
    },
  });
}

module.exports = { createStore };
