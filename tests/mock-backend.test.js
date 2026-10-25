// 模拟后端按接口约定的行为测试，包含需求文档第 6 节的最小端到端流程
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockBackend } = require('../miniprogram/services/mock/backend');

const A = 'user-a';
const B = 'user-b';

function setup() {
  let stored = null;
  const clock = { t: Date.parse('2026-10-24T12:00:00Z') };
  const backend = createMockBackend({
    load: () => stored,
    save: (db) => {
      stored = JSON.parse(JSON.stringify(db));
    },
    now: () => clock.t,
  });
  const call = (action, payload, openid) => backend.handle(action, payload, openid);
  const okData = (action, payload, openid) => {
    const res = call(action, payload, openid);
    assert.equal(res.code, 'OK', `${action} 应成功，实际 ${res.code}: ${res.message}`);
    return res.data;
  };
  return { backend, clock, call, okData };
}

const FORM = {
  rankCode: 'GOLD',
  serverCode: 'TOKYO',
  currentPlayers: 1,
  modeCode: 'RANKED',
  gameId: '  PlayerA  ',
  note: '开麦',
};

function allIds(okData, query) {
  const ids = [];
  let cursor = null;
  do {
    const page = okData('listPosts', Object.assign({}, query, { cursor, limit: 7 }));
    page.items.forEach((p) => ids.push(p.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

test('第 6 节最小端到端流程', () => {
  const { clock, call, okData } = setup();
  okData('ensureUser', {}, A);
  okData('ensureUser', {}, B);

  // A 发布“目标段位 R、服务器 S、1/3 人”
  const created = okData('createPost', Object.assign({ requestId: 'r1' }, FORM), A);
  assert.equal(created.status, 'RECRUITING');

  // B 筛选可见
  const found = allIds(okData, { rankCode: 'GOLD', serverCode: 'TOKYO' });
  assert.ok(found.includes(created.id));

  // 访客详情不返回游戏 ID，也无管理权限
  const guestView = okData('getPost', { postId: created.id }, null);
  assert.equal(guestView.gameId, undefined);
  assert.equal(guestView.canEdit, false);

  // 访客不能联系；B 登录后复制，人数不变
  assert.equal(call('getContact', { postId: created.id }, null).code, 'UNAUTHENTICATED');
  const contact = okData('getContact', { postId: created.id }, B);
  assert.equal(contact.gameId, 'PlayerA');
  assert.equal(okData('getPost', { postId: created.id }, B).currentPlayers, 1);

  // A 改为 2/3，B 看到缺 1 人
  const own = okData('listMyPosts', {}, A).items[0];
  assert.equal(own.gameId, 'PlayerA');
  const v2 = okData('updatePost', Object.assign({}, FORM, { postId: created.id, version: own.version, currentPlayers: 2 }), A);
  assert.equal(v2.remainingSlots, 1);
  assert.ok(allIds(okData, { remainingSlots: 1 }).includes(created.id));

  // A 改为 3/3：大厅看不到，旧详情再联系被拒绝
  const v3 = okData('updatePost', Object.assign({}, FORM, { postId: created.id, version: v2.version, currentPlayers: 3 }), A);
  assert.equal(v3.status, 'FULL');
  assert.ok(!allIds(okData, {}).includes(created.id));
  assert.equal(call('getContact', { postId: created.id }, B).code, 'POST_UNAVAILABLE');

  // A 可以重新发布
  const again = okData('createPost', Object.assign({ requestId: 'r2' }, FORM), A);
  assert.notEqual(again.id, created.id);

  // 过期路径：2 小时后不可见、不可联系、不可编辑，但可删除
  clock.t += 120 * 60000;
  assert.equal(okData('getPost', { postId: again.id }, A).status, 'EXPIRED');
  assert.ok(!allIds(okData, {}).includes(again.id));
  assert.equal(call('getContact', { postId: again.id }, B).code, 'POST_UNAVAILABLE');
  assert.equal(
    call('updatePost', Object.assign({}, FORM, { postId: again.id, version: 1 }), A).code,
    'POST_UNAVAILABLE'
  );
  okData('deletePost', { postId: again.id, version: 1 }, A);
  assert.equal(call('getPost', { postId: again.id }, B).code, 'NOT_FOUND');
});

test('每人只能有一条招募中信息，并返回 existingPostId', () => {
  const { call, okData } = setup();
  const first = okData('createPost', Object.assign({ requestId: 'a' }, FORM), A);
  const res = call('createPost', Object.assign({ requestId: 'b' }, FORM), A);
  assert.equal(res.code, 'ACTIVE_POST_EXISTS');
  assert.equal(res.data.existingPostId, first.id);

  // 关闭后可再次发布
  okData('closePost', { postId: first.id, version: 1 }, A);
  okData('createPost', Object.assign({ requestId: 'c' }, FORM), A);
});

test('创建请求按 requestId 幂等', () => {
  const { okData } = setup();
  const one = okData('createPost', Object.assign({ requestId: 'same' }, FORM), A);
  const two = okData('createPost', Object.assign({ requestId: 'same' }, FORM), A);
  assert.equal(one.id, two.id);
  assert.equal(okData('listMyPosts', {}, A).items.length, 1);
});

test('校验：人数、必填和长度限制', () => {
  const { call } = setup();
  const bad = (patch) => call('createPost', Object.assign({ requestId: Math.random().toString() }, FORM, patch), A).code;
  assert.equal(bad({ currentPlayers: 3 }), 'VALIDATION_ERROR');
  assert.equal(bad({ currentPlayers: 0 }), 'VALIDATION_ERROR');
  assert.equal(bad({ gameId: '   ' }), 'VALIDATION_ERROR');
  assert.equal(bad({ gameId: 'x'.repeat(65) }), 'VALIDATION_ERROR');
  assert.equal(bad({ note: 'x'.repeat(101) }), 'VALIDATION_ERROR');
  assert.equal(bad({ serverCode: 'NOPE' }), 'VALIDATION_ERROR');
  assert.equal(bad({ rankCode: '' }), 'VALIDATION_ERROR');
  assert.equal(bad({ modeCode: '' }), 'VALIDATION_ERROR');
  assert.equal(bad({ modeCode: 'NOPE' }), 'VALIDATION_ERROR');
});

test('长度按 Unicode 码点计算', () => {
  const { call } = setup();
  // 100 个表情是 100 个码点（200 个 UTF-16 单元），应允许
  const res = call('createPost', Object.assign({ requestId: 'emoji' }, FORM, { note: '🎮'.repeat(100) }), A);
  assert.equal(res.code, 'OK');
});

test('游戏模式：筛选精确匹配，不返回平台', () => {
  const { okData } = setup();
  const ranked = okData('listPosts', { modeCode: 'RANKED', limit: 50 }, null).items;
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((p) => p.modeCode === 'RANKED'));

  const combo = okData('listPosts', { modeCode: 'TRIOS', remainingSlots: 2, limit: 50 }, null).items;
  assert.ok(combo.every((p) => p.modeCode === 'TRIOS' && p.remainingSlots === 2));

  const post = okData('createPost', Object.assign({ requestId: 'm' }, FORM), A);
  const contact = okData('getContact', { postId: post.id }, B);
  assert.deepEqual(Object.keys(contact), ['gameId']);
  assert.equal(okData('getPost', { postId: post.id }, null).platformCode, undefined);
});

test('权限与并发冲突', () => {
  const { call, okData } = setup();
  const post = okData('createPost', Object.assign({ requestId: 'x' }, FORM), A);
  assert.equal(call('closePost', { postId: post.id, version: 1 }, B).code, 'FORBIDDEN');
  assert.equal(okData('getPost', { postId: post.id }, B).canEdit, false);
  assert.equal(okData('getPost', { postId: post.id }, A).canEdit, true);

  okData('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1, currentPlayers: 2 }), A);
  // 旧版本号写入被拒绝，不静默覆盖
  assert.equal(
    call('updatePost', Object.assign({}, FORM, { postId: post.id, version: 1 }), A).code,
    'VERSION_CONFLICT'
  );
  assert.equal(call('deletePost', { postId: post.id, version: 1 }, A).code, 'VERSION_CONFLICT');
});

test('编辑只接受白名单字段且不延长有效期', () => {
  const { clock, okData } = setup();
  const post = okData('createPost', Object.assign({ requestId: 'w' }, FORM), A);
  const before = okData('getPost', { postId: post.id }, A);
  clock.t += 30 * 60000;
  const after = okData(
    'updatePost',
    Object.assign({}, FORM, { postId: post.id, version: 1, status: 'CLOSED', expiresAt: '2099-01-01T00:00:00Z' }),
    A
  );
  assert.equal(after.status, 'RECRUITING');
  assert.equal(after.expiresAt, before.expiresAt);
});

test('分页无重复，选中段位时包含“不限”', () => {
  const { okData } = setup();
  const ids = allIds(okData, {});
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length > 20, '示例数据应超过一页');

  const gold = okData('listPosts', { rankCode: 'GOLD', limit: 50 }, null).items;
  assert.ok(gold.length > 0);
  assert.ok(gold.every((p) => p.rankCode === 'GOLD' || p.rankCode === 'ANY'));
  assert.ok(gold.some((p) => p.rankCode === 'ANY'));

  const first = okData('listPosts', { limit: 20 }, null);
  assert.equal(first.items.length, 20);
  const times = first.items.map((p) => p.createdAt);
  assert.deepEqual(times, times.slice().sort().reverse());
});

test('模拟后端：双人模式上限、服务器“不限”、违规内容', () => {
  const { call, okData } = setup();
  okData('ensureUser', {}, A);
  const duo = Object.assign({ requestId: 'd' }, FORM, { modeCode: 'DUOS', serverCode: 'ANY' });
  assert.equal(call('createPost', Object.assign({}, duo, { currentPlayers: 2 }), A).code, 'VALIDATION_ERROR');
  const post = okData('createPost', duo, A);
  assert.equal(okData('getPost', { postId: post.id }, A).maxPlayers, 2);
  assert.ok(okData('listPosts', { serverCode: 'TOKYO', limit: 50 }, null).items.some((p) => p.id === post.id));
  assert.equal(call('createPost', Object.assign({ requestId: 'r' }, FORM, { note: '违规' }), B).code, 'CONTENT_RISKY');
});

test('模拟后端：申请加入、同意 +1、满员后申请失效', () => {
  const { okData, call } = setup();
  for (const o of [A, B, 'user-c']) okData('ensureUser', {}, o);
  const post = okData('createPost', Object.assign({ requestId: 'p' }, FORM, { currentPlayers: 2 }), A);
  const rb = okData('applyToPost', { postId: post.id, gameId: 'B' }, B);
  okData('applyToPost', { postId: post.id, gameId: 'C' }, 'user-c');
  assert.equal(okData('ensureUser', {}, A).pendingRequestCount, 2);
  assert.equal(okData('listMyPosts', {}, A).items[0].pendingRequestCount, 2);
  assert.equal(call('applyToPost', { postId: post.id, gameId: 'A' }, A).code, 'FORBIDDEN');

  const res = okData('decideRequest', { requestId: rb.id, decision: 'ACCEPT' }, A);
  assert.equal(res.post.status, 'FULL');
  assert.equal(okData('getPost', { postId: post.id }, 'user-c').myRequest.status, 'EXPIRED');
  assert.equal(okData('ensureUser', {}, A).pendingRequestCount, 0);
});
