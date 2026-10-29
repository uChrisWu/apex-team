// 云函数业务层测试：使用与 store.js 接口一致的内存 store。
// store.js 本身依赖云开发数据库，需部署后用验收流程验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../cloudfunctions/apex/service');
const { APP_CONFIG } = require('../miniprogram/services/mock/fixtures');

function memoryStore(config = APP_CONFIG) {
  const users = new Map();
  const posts = new Map();
  const requests = new Map();
  const reports = new Map();
  const stats = { configReads: 0 };
  const copy = (v) => (v ? structuredClone(v) : null);
  const anyMatch = (code, value) => value === code || (code !== 'ANY' && value === 'ANY');
  let queue = Promise.resolve();

  const reader = {
    getUser: async (openid) => copy(users.get(openid)),
    getPost: async (id) => copy(posts.get(id)),
    getRequest: async (id) => copy(requests.get(id)),
    getReport: async (id) => copy(reports.get(id)),
  };

  const store = Object.assign({}, reader, {
    stats,
    users,
    posts,
    requests,
    reports,
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
          if (filters.rankCode && !anyMatch(filters.rankCode, p.rankCode)) return false;
          if (filters.serverCode && !anyMatch(filters.serverCode, p.serverCode)) return false;
          if (filters.remainingSlots && p.remainingSlots !== filters.remainingSlots) return false;
          return true;
        })
        .filter((p) => !after || p.createdAt < after.createdAt || (+p.createdAt === +after.createdAt && p.id < after.id))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(copy);
    },
    async listRequests(postId) {
      return [...requests.values()].filter((r) => r.postId === postId).map(copy);
    },
    async countPendingRequests(postId) {
      return [...requests.values()].filter((r) => r.postId === postId && r.status === 'PENDING').length;
    },
    async getOpenidByUserId(userId) {
      const hit = [...users.values()].find((u) => u.userId === userId);
      return hit ? hit.openid : null;
    },
    // 事务串行执行；回调抛错时丢弃全部写入，模拟回滚
    transaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const tx = Object.assign({}, reader, {
          createPost: async (post) => writes.push(() => posts.set(post.id, copy(post))),
          updatePost: async (id, patch) => writes.push(() => posts.set(id, Object.assign(posts.get(id), copy(patch)))),
          updateUser: async (openid, patch) => writes.push(() => users.set(openid, Object.assign(users.get(openid), copy(patch)))),
          createRequest: async (r) => writes.push(() => requests.set(r.id, copy(r))),
          updateRequest: async (id, patch) => writes.push(() => requests.set(id, Object.assign(requests.get(id), copy(patch)))),
          createReport: async (r) => writes.push(() => reports.set(r.id, copy(r))),
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

// 微信开放能力的替身：包含“违规”的文字判为 risky；记录发送的订阅消息
function fakeWechat() {
  const sent = [];
  const checks = [];
  return {
    sent,
    checks,
    failChecks: false,
    async checkText(openid, content) {
      checks.push({ openid, content });
      if (this.failChecks) throw Object.assign(new Error('msgSecCheck unavailable'), { errCode: -604101 });
      return content.includes('违规') ? 'risky' : 'pass';
    },
    async sendSubscribeMessage(message) {
      sent.push(message);
    },
  };
}

const NOTIFY_CONFIG = Object.assign({}, APP_CONFIG, {
  notify: { templateId: 'tmpl-1', fields: { applicant: 'thing1', post: 'thing2', time: 'time3', content: 'thing4' }, miniprogramState: 'trial' },
});

const FORM = { modeCode: 'RANKED', rankCode: 'GOLD', serverCode: 'TOKYO', currentPlayers: 1, gameId: '  PlayerA ', note: '开麦' };
const A = 'openid-a';
const B = 'openid-b';
const C = 'openid-c';

function setup(opts = {}) {
  const clock = { t: Date.parse('2026-10-25T12:00:00Z') };
  const store = memoryStore(opts.config);
  const wechat = fakeWechat();
  const logs = [];
  const service = createService({
    store,
    wechat,
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
  return { clock, store, wechat, call, ok, logs };
}

async function login(ok, ...openids) {
  for (const o of openids) await ok('ensureUser', {}, o);
}

test('第 6 节最小端到端流程', async () => {
  const { clock, call, ok } = setup();
  await login(ok, A, B);
  const created = await ok('createPost', Object.assign({ requestId: 'r1' }, FORM), A);

  const hall = await ok('listPosts', { modeCode: 'RANKED', rankCode: 'GOLD', serverCode: 'TOKYO' }, null);
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

// ---------- 配置清单：按模式的人数上限、服务器“不限”、选项启停 ----------

test('人数上限按模式：双人模式最多 2 人', async () => {
  const { call, ok } = setup();
  await login(ok, A);
  const duo = Object.assign({}, FORM, { modeCode: 'DUOS' });
  assert.equal((await call('createPost', Object.assign({ requestId: 'd0' }, duo, { currentPlayers: 2 }), A)).code, 'VALIDATION_ERROR');
  const post = await ok('createPost', Object.assign({ requestId: 'd1' }, duo), A);
  const view = await ok('getPost', { postId: post.id }, A);
  assert.equal(view.maxPlayers, 2);
  assert.equal(view.remainingSlots, 1);
  assert.equal((await call('updatePost', Object.assign({}, duo, { postId: post.id, version: 1, currentPlayers: 3 }), A)).code, 'VALIDATION_ERROR');
  // 改为三人模式后上限随之变化
  const trio = await ok('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1, currentPlayers: 2 }), A);
  assert.equal(trio.maxPlayers, 3);
  assert.equal(trio.status, 'RECRUITING');
  assert.equal((await ok('listPosts', { remainingSlots: 1 }, null)).items.length, 1);
});

test('服务器“不限”在具体服务器筛选中出现，“其他”只精确匹配', async () => {
  const { clock, ok } = setup();
  for (const [i, serverCode] of ['ANY', 'TOKYO', 'OTHER', 'SINGAPORE'].entries()) {
    const o = `srv-${i}`;
    await ok('ensureUser', {}, o);
    clock.t += 1000;
    await ok('createPost', Object.assign({}, FORM, { requestId: `s${i}`, serverCode }), o);
  }
  const servers = async (serverCode) => (await ok('listPosts', { serverCode }, null)).items.map((p) => p.serverCode).sort();
  assert.deepEqual(await servers('TOKYO'), ['ANY', 'TOKYO']);
  assert.deepEqual(await servers('OTHER'), ['ANY', 'OTHER']);
  assert.deepEqual(await servers('ANY'), ['ANY']);
});

test('停用的选项不能用于发布，历史记录仍可显示', async () => {
  const config = structuredClone(APP_CONFIG);
  const { clock, call, ok } = setup({ config });
  await login(ok, A, B);
  const post = await ok('createPost', Object.assign({ requestId: 'x' }, FORM, { modeCode: 'LTM' }), A);
  config.modes.find((m) => m.code === 'LTM').enabled = false;
  clock.t += 61000; // 超过配置缓存时间
  assert.equal((await call('createPost', Object.assign({ requestId: 'y' }, FORM, { modeCode: 'LTM' }), B)).code, 'VALIDATION_ERROR');
  assert.equal((await ok('getPost', { postId: post.id }, null)).modeCode, 'LTM');
  assert.equal((await call('listPosts', { modeCode: 'LTM' }, null)).code, 'OK', '筛选仍接受已有代码');
});

// ---------- 申请加入 ----------

async function postWithApplicants(t, ...applicants) {
  await login(t.ok, A, ...applicants);
  return t.ok('createPost', Object.assign({ requestId: 'team' }, FORM), A);
}

test('申请、提醒数量、申请人状态与重复申请', async () => {
  const t = setup();
  const post = await postWithApplicants(t, B);
  const req = await t.ok('applyToPost', { postId: post.id, gameId: ' Wraith_B ', message: '常玩恶灵' }, B);
  assert.equal(req.status, 'PENDING');
  assert.equal(req.applicantGameId, 'Wraith_B');
  assert.equal((await t.ok('ensureUser', {}, A)).pendingRequestCount, 1);
  assert.equal((await t.ok('listMyPosts', {}, A)).items[0].pendingRequestCount, 1);
  assert.equal((await t.ok('getPost', { postId: post.id }, B)).myRequest.status, 'PENDING');
  assert.equal((await t.ok('getPost', { postId: post.id }, A)).myRequest, undefined, '房主详情不含 myRequest');
  assert.equal((await t.ok('ensureUser', {}, B)).lastGameId, 'Wraith_B', '记住申请人的游戏 ID 便于下次预填');

  const again = await t.ok('applyToPost', { postId: post.id, gameId: 'Other', message: '' }, B);
  assert.equal(again.id, req.id);
  assert.equal(again.applicantGameId, 'Wraith_B', '重复申请返回原申请');
  assert.equal((await t.ok('listPostRequests', { postId: post.id }, A)).items.length, 1);

  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: 'me' }, A)).code, 'FORBIDDEN');
  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: 'x' }, null)).code, 'UNAUTHENTICATED');
  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: '  ' }, B)).code, 'VALIDATION_ERROR');
  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: 'x', message: 'm'.repeat(51) }, B)).code, 'VALIDATION_ERROR');
  assert.equal((await t.call('listPostRequests', { postId: post.id }, B)).code, 'FORBIDDEN', '只有房主能查看申请');
});

test('同意即人数 +1；凑满后满员，其余待处理申请失效', async () => {
  const t = setup();
  const post = await postWithApplicants(t, B, C);
  await t.ok('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1, currentPlayers: 2 }), A);
  const rb = await t.ok('applyToPost', { postId: post.id, gameId: 'B' }, B);
  const rc = await t.ok('applyToPost', { postId: post.id, gameId: 'C' }, C);

  assert.equal((await t.call('decideRequest', { requestId: rb.id, decision: 'ACCEPT' }, B)).code, 'FORBIDDEN');
  const res = await t.ok('decideRequest', { requestId: rb.id, decision: 'ACCEPT' }, A);
  assert.equal(res.request.status, 'ACCEPTED');
  assert.equal(res.post.currentPlayers, 3);
  assert.equal(res.post.status, 'FULL');
  assert.equal(res.post.version, 3);

  assert.equal((await t.ok('getPost', { postId: post.id }, C)).myRequest.status, 'EXPIRED');
  assert.equal((await t.call('decideRequest', { requestId: rc.id, decision: 'ACCEPT' }, A)).code, 'POST_UNAVAILABLE');
  assert.equal((await t.call('decideRequest', { requestId: rb.id, decision: 'REJECT' }, A)).code, 'POST_UNAVAILABLE');
  const owner = await t.ok('ensureUser', {}, A);
  assert.equal(owner.hasActivePost, false, '满员后释放有效招募引用');
  assert.equal(owner.pendingRequestCount, 0);
  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: 'late' }, 'openid-d')).code, 'UNAUTHENTICATED');
});

test('并发同意不会超过人数上限', async () => {
  const t = setup();
  const post = await postWithApplicants(t, B, C);
  await t.ok('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1, currentPlayers: 2 }), A);
  const rb = await t.ok('applyToPost', { postId: post.id, gameId: 'B' }, B);
  const rc = await t.ok('applyToPost', { postId: post.id, gameId: 'C' }, C);
  const results = await Promise.all([rb, rc].map((r) => t.call('decideRequest', { requestId: r.id, decision: 'ACCEPT' }, A)));
  assert.deepEqual(results.map((r) => r.code).sort(), ['OK', 'POST_UNAVAILABLE']);
  assert.equal((await t.ok('getPost', { postId: post.id }, A)).currentPlayers, 3);
});

test('拒绝、撤回与重新申请', async () => {
  const t = setup();
  const post = await postWithApplicants(t, B, C);
  const rb = await t.ok('applyToPost', { postId: post.id, gameId: 'B' }, B);
  await t.ok('cancelApplication', { postId: post.id }, B);
  assert.equal((await t.ok('listPostRequests', { postId: post.id }, A)).items.length, 0, '撤回的申请不展示给房主');
  assert.equal((await t.call('cancelApplication', { postId: post.id }, B)).code, 'VALIDATION_ERROR');
  const again = await t.ok('applyToPost', { postId: post.id, gameId: 'B2' }, B);
  assert.equal(again.id, rb.id);
  assert.equal(again.status, 'PENDING');
  assert.equal(again.applicantGameId, 'B2');

  const rc = await t.ok('applyToPost', { postId: post.id, gameId: 'C' }, C);
  const rejected = await t.ok('decideRequest', { requestId: rc.id, decision: 'REJECT' }, A);
  assert.equal(rejected.request.status, 'REJECTED');
  assert.equal(rejected.post.currentPlayers, 1, '拒绝不改变人数');
  assert.equal((await t.call('decideRequest', { requestId: rc.id, decision: 'ACCEPT' }, A)).code, 'VALIDATION_ERROR', '已处理的申请不能再处理');
  assert.equal((await t.ok('applyToPost', { postId: post.id, gameId: 'C' }, C)).status, 'REJECTED', '被拒绝后不能重复申请');

  const list = await t.ok('listPostRequests', { postId: post.id }, A);
  assert.deepEqual(list.items.map((r) => r.status), ['PENDING', 'REJECTED'], '待处理的排在前面');
});

test('订阅消息：新申请提醒房主，失败不影响申请', async () => {
  const t = setup({ config: NOTIFY_CONFIG });
  const post = await postWithApplicants(t, B, C);
  await t.ok('applyToPost', { postId: post.id, gameId: 'Wraith_B', message: '你好' }, B);
  assert.equal(t.wechat.sent.length, 1);
  const msg = t.wechat.sent[0];
  assert.equal(msg.touser, A);
  assert.equal(msg.templateId, 'tmpl-1');
  assert.equal(msg.page, `pages/detail/detail?id=${post.id}`);
  assert.equal(msg.miniprogramState, 'trial');
  assert.equal(msg.data.thing1.value, 'Wraith_B');
  assert.equal(msg.data.thing2.value, '排位赛 · 东京（日服） 1/3');
  assert.equal(msg.data.time3.value, '2026-10-25 20:00', '按北京时间显示');
  assert.equal(msg.data.thing4.value, '申请加入排位赛：你好');

  await t.ok('applyToPost', { postId: post.id, gameId: 'Wraith_B' }, B);
  assert.equal(t.wechat.sent.length, 1, '重复申请不重复提醒');

  t.wechat.sendSubscribeMessage = async () => {
    throw Object.assign(new Error('quota'), { errCode: 43101 });
  };
  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: 'C' }, C)).code, 'OK');
});

test('未配置模板时不发送提醒，getConfig 只公开模板 ID', async () => {
  const t = setup({ config: Object.assign({}, APP_CONFIG, { notify: { templateId: '' } }) });
  const post = await postWithApplicants(t, B);
  await t.ok('applyToPost', { postId: post.id, gameId: 'B' }, B);
  assert.equal(t.wechat.sent.length, 0);
  const n = setup({ config: NOTIFY_CONFIG });
  assert.deepEqual((await n.ok('getConfig', {}, null)).notify, { templateId: 'tmpl-1' });
  assert.deepEqual((await setup().ok('getConfig', {}, null)).notify, { templateId: APP_CONFIG.notify.templateId }, '字段对应关系不公开');
});

// ---------- 内容安全 ----------

test('内容安全：违规内容拒绝写入，检测异常时不放行', async () => {
  const t = setup();
  await login(t.ok, A, B);
  assert.equal((await t.call('createPost', Object.assign({ requestId: 'r' }, FORM, { note: '违规内容' }), A)).code, 'CONTENT_RISKY');
  assert.equal((await t.call('createPost', Object.assign({ requestId: 'r' }, FORM, { gameId: '违规ID' }), A)).code, 'CONTENT_RISKY');
  assert.equal((await t.ok('listMyPosts', {}, A)).items.length, 0);
  assert.deepEqual(t.wechat.checks.map((c) => c.openid), [A, A], '按发布者 OpenID 检测');

  const post = await t.ok('createPost', Object.assign({ requestId: 'r2' }, FORM), A);
  assert.equal((await t.call('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1, note: '违规' }), A)).code, 'CONTENT_RISKY');
  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: 'B', message: '违规留言' }, B)).code, 'CONTENT_RISKY');

  t.wechat.failChecks = true;
  assert.equal((await t.call('applyToPost', { postId: post.id, gameId: 'B' }, B)).code, 'INTERNAL_ERROR');
  assert.equal((await t.ok('listPostRequests', { postId: post.id }, A)).items.length, 0);
});

// ---------- 举报 ----------

test('举报：登录后可举报他人信息，重复举报只记录一次，保存内容快照', async () => {
  const t = setup();
  await login(t.ok, A, B);
  const post = await t.ok('createPost', Object.assign({ requestId: 'rep' }, FORM), A);
  assert.equal((await t.call('reportPost', { postId: post.id, reason: 'SPAM' }, null)).code, 'UNAUTHENTICATED');
  assert.equal((await t.call('reportPost', { postId: post.id, reason: 'SPAM' }, A)).code, 'FORBIDDEN');
  assert.equal((await t.call('reportPost', { postId: post.id, reason: 'NOPE' }, B)).code, 'VALIDATION_ERROR');
  assert.equal((await t.call('reportPost', { postId: post.id, reason: 'SPAM', extra: 1 }, B)).code, 'VALIDATION_ERROR');

  const first = await t.ok('reportPost', { postId: post.id, reason: 'ABUSE', detail: ' 骂人 ' }, B);
  assert.equal(first.duplicate, false);
  const again = await t.ok('reportPost', { postId: post.id, reason: 'SPAM' }, B);
  assert.equal(again.duplicate, true);
  assert.equal(t.store.reports.size, 1);
  const saved = [...t.store.reports.values()][0];
  assert.equal(saved.reason, 'ABUSE');
  assert.equal(saved.detail, '骂人');
  assert.equal(saved.snapshot.gameId, 'PlayerA');
  assert.equal(saved.status, 'OPEN');
  assert.ok(!JSON.stringify(saved).includes(B), '举报记录不保存 OpenID');

  // 信息结束后仍可举报，删除后不可
  await t.ok('closePost', { postId: post.id, version: 1 }, A);
  await login(t.ok, C);
  assert.equal((await t.call('reportPost', { postId: post.id, reason: 'FAKE' }, C)).code, 'OK');
  await t.ok('deletePost', { postId: post.id, version: 2 }, A);
  assert.equal((await t.call('reportPost', { postId: post.id, reason: 'FAKE' }, 'openid-d')).code, 'UNAUTHENTICATED');
  assert.ok((await t.ok('getConfig', {}, null)).reportReasons.length >= 1);
});

test('组队方式：只有房主能写，满员后仍可更新，只对已同意的申请人可见', async () => {
  const t = setup();
  const post = await postWithApplicants(t, B, C);
  const rb = await t.ok('applyToPost', { postId: post.id, gameId: 'B' }, B);
  await t.ok('applyToPost', { postId: post.id, gameId: 'C' }, C);
  await t.ok('decideRequest', { requestId: rb.id, decision: 'ACCEPT' }, A);

  const ownerView = await t.ok('getPost', { postId: post.id }, A);
  assert.equal(ownerView.teamInfo, '');
  assert.equal(ownerView.canEditTeamInfo, true);
  assert.equal((await t.call('updateTeamInfo', { postId: post.id, teamInfo: '房间 abc' }, B)).code, 'FORBIDDEN');
  assert.equal((await t.call('updateTeamInfo', { postId: post.id, teamInfo: 'x'.repeat(101) }, A)).code, 'VALIDATION_ERROR');
  assert.equal((await t.call('updateTeamInfo', { postId: post.id, teamInfo: '违规房间' }, A)).code, 'CONTENT_RISKY');

  const saved = await t.ok('updateTeamInfo', { postId: post.id, teamInfo: ' 私人房间 abc 密码 6688 ' }, A);
  assert.equal(saved.teamInfo, '私人房间 abc 密码 6688');
  const after = await t.ok('getPost', { postId: post.id }, A);
  assert.equal(after.version, ownerView.version, '更新组队方式不改变版本号');

  assert.equal((await t.ok('getPost', { postId: post.id }, B)).myRequest.teamInfo, '私人房间 abc 密码 6688');
  const pending = await t.ok('getPost', { postId: post.id }, C);
  assert.equal(pending.teamInfo, undefined);
  assert.equal(pending.myRequest.teamInfo, undefined, '未被同意的申请人看不到');
  assert.equal((await t.ok('getPost', { postId: post.id }, null)).teamInfo, undefined);
  assert.equal((await t.ok('listPosts', {}, null)).items[0].teamInfo, undefined);

  await t.ok('closePost', { postId: post.id, version: after.version }, A);
  assert.equal((await t.call('updateTeamInfo', { postId: post.id, teamInfo: '' }, A)).code, 'POST_UNAVAILABLE');
});
