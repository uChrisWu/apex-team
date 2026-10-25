// 云函数业务层测试：使用与 store.js 接口一致的内存 store。
// store.js 本身依赖云开发数据库，需部署后用验收流程验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../cloudfunctions/apex/service');
const { TEST_CONFIG } = require('../miniprogram/services/mock/fixtures');

function memoryStore(config = TEST_CONFIG) {
  const users = new Map();
  const posts = new Map();
  const stats = { configReads: 0 };
  const copy = (v) => (v ? structuredClone(v) : null);
  let queue = Promise.resolve();

  const reader = {
    getUser: async (openid) => copy(users.get(openid)),
    getPost: async (id) => copy(posts.get(id)),
  };

  const store = Object.assign({}, reader, {
    stats,
    users,
    posts,
    async getConfig() {
      stats.configReads += 1;
      return copy(config);
    },
    async createUserIfMissing(user) {
      if (!users.has(user.openid)) users.set(user.openid, copy(user));
      return copy(users.get(user.openid));
    },
    async listPosts({ ownerId, publicAt, filters = {}, after, limit }) {
      return [...posts.values()]
        .filter((p) => {
          if (p.deletedAt) return false;
          if (ownerId) return p.ownerId === ownerId;
          if (p.status !== 'RECRUITING' || p.expiresAt <= publicAt) return false;
          if (filters.modeCode && p.modeCode !== filters.modeCode) return false;
          if (filters.rankCode && p.rankCode !== filters.rankCode && p.rankCode !== 'ANY') return false;
          if (filters.serverCode && p.serverCode !== filters.serverCode) return false;
          if (filters.currentPlayers && p.currentPlayers !== filters.currentPlayers) return false;
          return true;
        })
        .filter((p) => !after || p.createdAt < after.createdAt || (+p.createdAt === +after.createdAt && p.id < after.id))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(copy);
    },
    // 事务串行执行；回调抛错时丢弃全部写入，模拟回滚
    transaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const tx = Object.assign({}, reader, {
          createPost: async (post) => writes.push(() => posts.set(post.id, copy(post))),
          updatePost: async (id, patch) => writes.push(() => posts.set(id, Object.assign(posts.get(id), copy(patch)))),
          updateUser: async (openid, patch) => writes.push(() => users.set(openid, Object.assign(users.get(openid), copy(patch)))),
        });
        const result = await fn(tx);
        writes.forEach((w) => w());
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
  });
  return store;
}

const FORM = { modeCode: 'RANKED', rankCode: 'GOLD', serverCode: 'TEST_TOKYO', currentPlayers: 1, gameId: '  PlayerA ', note: '开麦' };
const A = 'openid-a';
const B = 'openid-b';

function setup(opts = {}) {
  const clock = { t: Date.parse('2026-10-25T12:00:00Z') };
  const store = memoryStore(opts.config);
  const logs = [];
  const service = createService({
    store,
    now: () => new Date(clock.t),
    clock: () => clock.t,
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  const call = (action, payload, openid) => service.handle({ action, payload }, openid);
  const ok = async (action, payload, openid) => {
    const res = await call(action, payload, openid);
    assert.equal(res.code, 'OK', `${action}: ${res.code} ${res.message}`);
    return res.data;
  };
  return { clock, store, call, ok, logs };
}

async function login(ok, ...openids) {
  for (const o of openids) await ok('ensureUser', {}, o);
}

test('第 6 节最小端到端流程', async () => {
  const { clock, call, ok } = setup();
  await login(ok, A, B);
  const created = await ok('createPost', Object.assign({ requestId: 'r1' }, FORM), A);

  const hall = await ok('listPosts', { modeCode: 'RANKED', rankCode: 'GOLD', serverCode: 'TEST_TOKYO' }, null);
  assert.deepEqual(hall.items.map((p) => p.id), [created.id]);
  assert.equal(hall.items[0].gameId, undefined);

  const guest = await ok('getPost', { postId: created.id }, null);
  assert.equal(guest.gameId, undefined);
  assert.equal(guest.canEdit, false);
  assert.equal((await call('getContact', { postId: created.id }, null)).code, 'UNAUTHENTICATED');
  assert.deepEqual(await ok('getContact', { postId: created.id }, B), { gameId: 'PlayerA' });
  assert.equal((await ok('getPost', { postId: created.id }, B)).currentPlayers, 1);

  const own = (await ok('listMyPosts', {}, A)).items[0];
  assert.equal(own.gameId, 'PlayerA');
  const v2 = await ok('updatePost', Object.assign({}, FORM, { postId: created.id, version: own.version, currentPlayers: 2 }), A);
  assert.equal(v2.remainingSlots, 1);
  const v3 = await ok('updatePost', Object.assign({}, FORM, { postId: created.id, version: v2.version, currentPlayers: 3 }), A);
  assert.equal(v3.status, 'FULL');
  assert.equal((await ok('listPosts', {}, null)).items.length, 0);
  assert.equal((await call('getContact', { postId: created.id }, B)).code, 'POST_UNAVAILABLE');
  assert.equal((await ok('ensureUser', {}, A)).hasActivePost, false, '满员后释放有效招募引用');

  const again = await ok('createPost', Object.assign({ requestId: 'r2' }, FORM), A);
  clock.t += 120 * 60000;
  assert.equal((await ok('getPost', { postId: again.id }, A)).status, 'EXPIRED');
  assert.equal((await ok('listPosts', {}, null)).items.length, 0);
  assert.equal((await call('getContact', { postId: again.id }, B)).code, 'POST_UNAVAILABLE');
  assert.equal((await call('closePost', { postId: again.id, version: 1 }, A)).code, 'POST_UNAVAILABLE');
  await ok('deletePost', { postId: again.id, version: 1 }, A);
  assert.equal((await call('getPost', { postId: again.id }, B)).code, 'NOT_FOUND');
});

test('写操作需先 ensureUser，访客不能发布', async () => {
  const { call } = setup();
  assert.equal((await call('createPost', Object.assign({ requestId: 'x' }, FORM), null)).code, 'UNAUTHENTICATED');
  assert.equal((await call('createPost', Object.assign({ requestId: 'x' }, FORM), A)).code, 'UNAUTHENTICATED');
  assert.equal((await call('ensureUser', {}, null)).code, 'UNAUTHENTICATED');
});

test('单条有效招募、existingPostId 与幂等创建', async () => {
  const { call, ok } = setup();
  await login(ok, A);
  const first = await ok('createPost', Object.assign({ requestId: 'a' }, FORM), A);
  const retry = await ok('createPost', Object.assign({ requestId: 'a' }, FORM), A);
  assert.equal(retry.id, first.id);
  const other = await call('createPost', Object.assign({ requestId: 'b' }, FORM), A);
  assert.equal(other.code, 'ACTIVE_POST_EXISTS');
  assert.equal(other.data.existingPostId, first.id);
  assert.equal((await ok('listMyPosts', {}, A)).items.length, 1);
});

test('并发创建不同请求只产生一条有效招募', async () => {
  const { call, ok } = setup();
  await login(ok, A);
  const results = await Promise.all(['c1', 'c2', 'c3'].map((r) => call('createPost', Object.assign({ requestId: r }, FORM), A)));
  assert.equal(results.filter((r) => r.code === 'OK').length, 1);
  assert.equal(results.filter((r) => r.code === 'ACTIVE_POST_EXISTS').length, 2);
});

test('已删除记录的重试创建返回 NOT_FOUND', async () => {
  const { call, ok } = setup();
  await login(ok, A);
  const post = await ok('createPost', Object.assign({ requestId: 'gone' }, FORM), A);
  await ok('deletePost', { postId: post.id, version: 1 }, A);
  assert.equal((await call('createPost', Object.assign({ requestId: 'gone' }, FORM), A)).code, 'NOT_FOUND');
});

test('旧记录操作不会清除新记录的有效引用', async () => {
  const { ok } = setup();
  await login(ok, A);
  const old = await ok('createPost', Object.assign({ requestId: 'old' }, FORM), A);
  await ok('updatePost', Object.assign({}, FORM, { postId: old.id, version: 1, currentPlayers: 3 }), A);
  const fresh = await ok('createPost', Object.assign({ requestId: 'new' }, FORM), A);
  await ok('deletePost', { postId: old.id, version: 2 }, A);
  assert.equal((await ok('ensureUser', {}, A)).activePostId, fresh.id);
});

test('权限与版本冲突', async () => {
  const { call, ok } = setup();
  await login(ok, A, B);
  const post = await ok('createPost', Object.assign({ requestId: 'p' }, FORM), A);
  assert.equal((await call('closePost', { postId: post.id, version: 1 }, B)).code, 'FORBIDDEN');
  assert.equal((await call('deletePost', { postId: post.id, version: 1 }, B)).code, 'FORBIDDEN');
  assert.equal((await ok('getPost', { postId: post.id }, B)).canDelete, false);
  assert.equal((await ok('getPost', { postId: post.id }, A)).canEdit, true);
  await ok('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1, currentPlayers: 2 }), A);
  assert.equal((await call('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1 }), A)).code, 'VERSION_CONFLICT');
  assert.equal((await call('closePost', { postId: post.id, version: 1 }, A)).code, 'VERSION_CONFLICT');
});

test('校验：字段类型、白名单、长度按码点', async () => {
  const { call, ok } = setup();
  await login(ok, A);
  const create = (patch, id) => call('createPost', Object.assign({ requestId: id || 'v' + Math.random().toString(36).slice(2) }, FORM, patch), A);
  for (const patch of [
    { currentPlayers: 3 }, { currentPlayers: '1' }, { currentPlayers: 1.5 }, { modeCode: 'NOPE' }, { rankCode: '' },
    { serverCode: 'X' }, { gameId: '   ' }, { gameId: 'x'.repeat(65) }, { note: 'x'.repeat(101) }, { note: null },
    { ownerId: 'forged' }, { status: 'CLOSED' }, { platformCode: 'PC' },
  ]) {
    assert.equal((await create(patch)).code, 'VALIDATION_ERROR', JSON.stringify(patch));
  }
  assert.equal((await create({ note: '🎮'.repeat(100) })).code, 'OK');
  assert.equal((await call('createPost', Object.assign({ requestId: 'bad id!' }, FORM), A)).code, 'VALIDATION_ERROR');
  assert.equal((await call('getConfig', { extra: 1 }, A)).code, 'VALIDATION_ERROR');
});

test('编辑不延长有效期，不接受服务端字段', async () => {
  const { clock, call, ok } = setup();
  await login(ok, A);
  const post = await ok('createPost', Object.assign({ requestId: 'e' }, FORM), A);
  const before = await ok('getPost', { postId: post.id }, A);
  clock.t += 30 * 60000;
  assert.equal((await call('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1, expiresAt: 'x' }), A)).code, 'VALIDATION_ERROR');
  const after = await ok('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1 }), A);
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(after.createdAt, before.createdAt);
});

test('筛选与分页：ANY 段位、游标绑定筛选、无重复', async () => {
  const { clock, call, ok } = setup();
  const owners = Array.from({ length: 25 }, (_, i) => `seed-${i}`);
  for (const [i, o] of owners.entries()) {
    await ok('ensureUser', {}, o);
    clock.t += 1000;
    await ok('createPost', Object.assign({}, FORM, {
      requestId: `s${i}`,
      rankCode: i % 5 === 0 ? 'ANY' : i % 2 ? 'GOLD' : 'SILVER',
      modeCode: i % 3 ? 'RANKED' : 'TRIOS',
      currentPlayers: i % 4 ? 1 : 2,
    }), o);
  }
  const ids = [];
  let cursor;
  do {
    const res = await ok('listPosts', Object.assign({ limit: 7 }, cursor ? { cursor } : {}), null);
    ids.push(...res.items.map((p) => p.id));
    cursor = res.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25);

  const gold = await ok('listPosts', { rankCode: 'GOLD', limit: 50 }, null);
  assert.ok(gold.items.every((p) => p.rankCode === 'GOLD' || p.rankCode === 'ANY'));
  assert.ok(gold.items.some((p) => p.rankCode === 'ANY'));
  const combo = await ok('listPosts', { modeCode: 'TRIOS', remainingSlots: 1, limit: 50 }, null);
  assert.ok(combo.items.length > 0 && combo.items.every((p) => p.modeCode === 'TRIOS' && p.remainingSlots === 1));

  const first = await ok('listPosts', { modeCode: 'RANKED', limit: 3 }, null);
  assert.equal((await call('listPosts', { modeCode: 'TRIOS', cursor: first.nextCursor }, null)).code, 'VALIDATION_ERROR');
  assert.equal((await call('listMyPosts', { cursor: first.nextCursor }, 'seed-1')).code, 'VALIDATION_ERROR');
  for (const payload of [{ cursor: 'garbage' }, { cursor: '' }, { remainingSlots: 3 }, { limit: 0 }, { limit: '5' }, { foo: 1 }]) {
    assert.equal((await call('listPosts', payload, null)).code, 'VALIDATION_ERROR', JSON.stringify(payload));
  }
  assert.equal((await ok('listPosts', { limit: 500 }, null)).items.length, 25, '超出上限时按 50 截断');
});

test('配置缓存：多次列表只读一次配置', async () => {
  const { store, ok } = setup();
  for (let i = 0; i < 5; i++) await ok('listPosts', {}, null);
  await ok('getConfig', {}, null);
  assert.equal(store.stats.configReads, 1);
});

test('数据库异常不外泄，日志不含身份与游戏 ID', async () => {
  const { store, call, ok, logs } = setup();
  await login(ok, A);
  await ok('createPost', Object.assign({ requestId: 'log' }, FORM), A);
  store.getPost = async () => {
    throw Object.assign(new Error(`document with _id ${A} does not exist`), { errCode: -502001 });
  };
  const res = await call('getContact', { postId: 'p_' + 'a'.repeat(64) }, A);
  assert.equal(res.code, 'INTERNAL_ERROR');
  assert.ok(!res.message.includes(A));
  const all = logs.join('\n');
  assert.ok(!all.includes(A), '日志不含 OpenID');
  assert.ok(!all.includes('PlayerA'), '日志不含游戏 ID');
});

test('配置缺失时返回 INTERNAL_ERROR', async () => {
  const { call } = setup({ config: null });
  assert.equal((await call('getConfig', {}, null)).code, 'INTERNAL_ERROR');
});
