// store.js 调用形状检查：用记录调用的假 db 代替 wx-server-sdk，确认查询条件、排序与文档映射。
// 真实行为（事务、索引、权限）需部署后在云开发环境中验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../cloudfunctions/apex/store');

function fakeDb(docs = {}) {
  const calls = [];
  const command = {
    gt: (v) => ({ $gt: v }),
    lt: (v) => ({ $lt: v }),
    in: (v) => ({ $in: v }),
    and: (v) => ({ $and: v }),
    or: (v) => ({ $or: v }),
  };
  function collection(name) {
    return {
      doc: (id) => ({
        get: async () => {
          calls.push(['get', name, id]);
          const data = (docs[name] || {})[id];
          if (!data) throw Object.assign(new Error(`document.get:fail document with _id ${id} does not exist`), { errCode: -1 });
          return { data: Object.assign({ _id: id }, data) };
        },
        set: async (arg) => calls.push(['set', name, id, arg]),
        update: async (arg) => calls.push(['update', name, id, arg]),
      }),
      add: async (arg) => calls.push(['add', name, arg]),
      where(cond) {
        const q = { name, cond, order: [] };
        return {
          orderBy(field, dir) { q.order.push([field, dir]); return this; },
          limit(n) { q.limit = n; return this; },
          get: async () => {
            calls.push(['query', q]);
            return { data: [{ _id: 'p_1', ownerId: 'u1', createdAt: new Date(0) }] };
          },
        };
      },
    };
  }
  return {
    calls,
    command,
    collection,
    runTransaction: async (fn) => fn({ collection }),
  };
}

test('读取：文档映射与不存在时返回 null', async () => {
  const db = fakeDb({ users: { 'oid-1': { userId: 'u1' } }, app_config: { main: { modes: [] } } });
  const store = createStore(db);
  assert.deepEqual(await store.getUser('oid-1'), { openid: 'oid-1', userId: 'u1' });
  assert.equal(await store.getUser('missing'), null);
  assert.equal(await store.getPost('p_x'), null);
  assert.deepEqual(await store.getConfig(), { modes: [] });
});

test('大厅查询：筛选条件、ANY 段位、游标与排序', async () => {
  const db = fakeDb();
  const store = createStore(db);
  const at = new Date('2026-10-25T00:00:00Z');
  const after = { createdAt: new Date('2026-10-24T23:00:00Z'), id: 'p_9' };
  const rows = await store.listPosts({ publicAt: at, filters: { modeCode: 'RANKED', rankCode: 'GOLD', currentPlayers: 2 }, after, limit: 21 });
  assert.deepEqual(rows, [{ id: 'p_1', ownerId: 'u1', createdAt: new Date(0) }]);
  const [, q] = db.calls[0];
  assert.equal(q.name, 'team_posts');
  assert.deepEqual(q.cond, {
    $and: [
      { deletedAt: null, status: 'RECRUITING', expiresAt: { $gt: at }, modeCode: 'RANKED', rankCode: { $in: ['GOLD', 'ANY'] }, currentPlayers: 2 },
      { $or: [{ createdAt: { $lt: after.createdAt } }, { createdAt: after.createdAt, _id: { $lt: 'p_9' } }] },
    ],
  });
  assert.deepEqual(q.order, [['createdAt', 'desc'], ['_id', 'desc']]);
  assert.equal(q.limit, 21);
});

test('我的发布查询只按所有者和未删除过滤', async () => {
  const db = fakeDb();
  await createStore(db).listPosts({ ownerId: 'u1', limit: 5 });
  assert.deepEqual(db.calls[0][1].cond, { deletedAt: null, ownerId: 'u1' });
});

test('事务写入：记录以 _id 保存，不重复写入 id 字段', async () => {
  const db = fakeDb();
  await createStore(db).transaction(async (tx) => {
    await tx.createPost({ id: 'p_2', ownerId: 'u1' });
    await tx.updateUser('oid-1', { activePostId: 'p_2' });
  });
  assert.deepEqual(db.calls, [
    ['set', 'team_posts', 'p_2', { data: { ownerId: 'u1' } }],
    ['update', 'users', 'oid-1', { data: { activePostId: 'p_2' } }],
  ]);
});

test('首次登录以 OpenID 作为 _id 创建账号', async () => {
  const db = fakeDb();
  const user = await createStore(db).createUserIfMissing({ openid: 'oid-2', userId: 'u2', activePostId: null });
  assert.equal(user.userId, 'u2');
  assert.deepEqual(db.calls[1], ['add', 'users', { data: { _id: 'oid-2', userId: 'u2', activePostId: null } }]);
});
