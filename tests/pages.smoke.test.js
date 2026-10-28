// 页面冒烟测试：用最小的 wx / Page / Component 桩运行页面逻辑，验证主要流程在 mock 模式下可走通。
// 不覆盖 WXML 渲染，界面需在微信开发者工具中预览确认。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'miniprogram');

// ---------- 运行时桩 ----------
const storage = new Map();
const calls = { nav: [], toast: [], modal: [], clipboard: [] };
let modalAnswer = true;
let pageStack = [];

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
  removeStorageSync: (k) => storage.delete(k),
  showModal: (opts) => {
    calls.modal.push(opts);
    return Promise.resolve({ confirm: modalAnswer, cancel: !modalAnswer });
  },
  showToast: (opts) => calls.toast.push(opts.title),
  showLoading: () => {},
  hideLoading: () => {},
  stopPullDownRefresh: () => {},
  setTabBarBadge: (opts) => {
    calls.badge = opts.text;
  },
  removeTabBarBadge: () => {
    calls.badge = null;
  },
  setNavigationBarTitle: () => {},
  setClipboardData: ({ data }) => {
    calls.clipboard.push(data);
    return Promise.resolve();
  },
  showActionSheet: () => Promise.resolve({ tapIndex: 0 }),
  navigateTo: ({ url }) => calls.nav.push(['navigateTo', url]),
  redirectTo: ({ url }) => calls.nav.push(['redirectTo', url]),
  switchTab: ({ url }) => calls.nav.push(['switchTab', url]),
  navigateBack: () => calls.nav.push(['navigateBack']),
};
global.getCurrentPages = () => pageStack;
global.App = () => {};
global.Component = () => {};

let lastPageDef = null;
global.Page = (def) => {
  lastPageDef = def;
};

function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function loadPage(name) {
  const file = path.join(ROOT, 'pages', name, `${name}.js`);
  delete require.cache[file];
  require(file);
  const page = Object.assign({}, lastPageDef);
  page.data = JSON.parse(JSON.stringify(lastPageDef.data));
  page.route = `pages/${name}/${name}`;
  page.setData = function (patch) {
    Object.keys(patch).forEach((k) => setPath(this.data, k, patch[k]));
  };
  return page;
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------- 场景 ----------
// 先切到 mock 模式并把模拟延迟设为 0，再加载其他模块（不依赖 env.js 的当前设置）
Object.assign(require(path.join(ROOT, 'config', 'env')), { apiMode: 'mock', mockLatencyMs: 0 });
const auth = require(path.join(ROOT, 'utils', 'auth'));
const api = require(path.join(ROOT, 'services', 'api'));
const { devtools } = require(path.join(ROOT, 'services', 'mock', 'transport-mock'));

test('mock 模式下主要页面流程', async (t) => {
  require(path.join(ROOT, 'app.js'));

  await t.test('大厅：首屏、分页去重、筛选', async () => {
    const hall = loadPage('hall');
    hall.onLoad();
    await settle();
    assert.equal(hall.data.configStatus, 'ready');
    assert.equal(hall.data.listStatus, 'ready');
    assert.equal(hall.data.list.length, 20);
    assert.equal(hall.data.hasMore, true);

    hall.onReachBottom();
    await settle();
    const ids = hall.data.list.map((p) => p.id);
    assert.ok(ids.length > 20);
    assert.equal(new Set(ids).size, ids.length);

    const goldIndex = hall.data.rankOptions.findIndex((r) => r.code === 'GOLD');
    hall.onRankChange({ detail: { value: goldIndex } });
    assert.equal(hall.data.list.length, 0, '切换筛选时立即清空旧结果');
    await settle();
    assert.ok(hall.data.list.every((p) => p.rankCode === 'GOLD' || p.rankCode === 'ANY'));
    assert.ok(hall.data.list[0].rankName, '卡片带有展示用名称');
  });

  await t.test('大厅：网络失败显示可重试的错误', async () => {
    devtools.setOffline(true);
    const hall = loadPage('hall');
    hall.config = null;
    hall.onLoad();
    await settle();
    // 配置已缓存，因此失败发生在列表请求
    assert.equal(hall.data.listStatus, 'error');
    devtools.setOffline(false);
    hall.reload();
    await settle();
    assert.equal(hall.data.listStatus, 'ready');
  });

  await t.test('详情：访客无游戏 ID，复制前引导登录', async () => {
    assert.equal(auth.isLoggedIn(), false);
    const detail = loadPage('detail');
    detail.onLoad({ id: 'seed-001', v: '1' });
    await settle();
    assert.equal(detail.data.status, 'ready');
    assert.equal(detail.data.post.gameId, undefined);
    assert.equal(detail.data.post.canEdit, false);

    calls.modal.length = 0;
    await detail.onCopyContact();
    assert.equal(calls.modal[0].title, '需要登录');
    assert.equal(auth.isLoggedIn(), true);
    assert.equal(calls.clipboard.pop(), 'SeedPlayer_1');
  });

  let createdId;
  await t.test('发布：成功后跳转详情；重复发布提示已有招募', async () => {
    const publish = loadPage('publish');
    publish.onLoad({});
    await settle();
    assert.equal(publish.data.status, 'ready');
    const values = {
      rankCode: 'GOLD',
      serverCode: 'TOKYO',
      currentPlayers: 1,
      modeCode: 'RANKED',
      gameId: 'MyApexId',
      note: '',
    };
    calls.nav.length = 0;
    await publish.onSubmit({ detail: { values } });
    await settle(700);
    const [kind, url] = calls.nav.pop();
    assert.equal(kind, 'redirectTo');
    const query = url.split('?')[1].split('&').map((kv) => kv.split('='));
    createdId = decodeURIComponent(query.find(([k]) => k === 'id')[1]);
    assert.ok(createdId.startsWith('post-'));
    assert.ok(query.some(([k, v]) => k === 'fresh' && v === '1'), '发布后详情页提示转发到群');

    const fresh = loadPage('detail');
    fresh.onLoad({ id: createdId, fresh: '1' });
    await settle();
    assert.equal(fresh.data.justPublished, true);
    assert.equal(fresh.data.post.canDelete, true);
    assert.equal(fresh.onShareAppMessage().path, `/pages/detail/detail?id=${encodeURIComponent(createdId)}`);

    const again = loadPage('publish');
    again.onLoad({});
    await settle();
    assert.equal(again.data.activePostId, createdId, '已有招募时展示管理入口');
    calls.modal.length = 0;
    await again.onSubmit({ detail: { values } });
    await settle();
    assert.equal(calls.modal[0].title, '已有招募中的信息');
    assert.deepEqual(calls.nav.pop(), ['navigateTo', `/pages/detail/detail?id=${encodeURIComponent(createdId)}`]);
  });

  await t.test('编辑：加载本人 gameId，改为 3/3 后满员', async () => {
    const edit = loadPage('publish');
    edit.onLoad({ id: createdId });
    await settle();
    assert.equal(edit.data.status, 'ready');
    assert.equal(edit.data.value.gameId, 'MyApexId');

    const values = Object.assign({}, edit.data.value, { currentPlayers: 3 });
    pageStack = [];
    await edit.onSubmit({ detail: { values } });
    await settle(700);
    const post = await api.getPost(createdId);
    assert.equal(post.status, 'FULL');

    // 满员后不能再编辑
    const locked = loadPage('publish');
    locked.onLoad({ id: createdId });
    await settle();
    assert.equal(locked.data.status, 'locked');
  });

  await t.test('编辑：版本冲突时提示，不静默覆盖', async () => {
    devtools.resetData();
    await auth.refresh();
    const created = await api.createPost(
      { rankCode: 'ANY', serverCode: 'HONG_KONG', currentPlayers: 1, modeCode: 'RANKED', gameId: 'X', note: '' },
      'conflict-req'
    );
    const edit = loadPage('publish');
    edit.onLoad({ id: created.id });
    await settle();

    // 在别处先修改一次
    await api.updatePost(created.id, 1, Object.assign({}, edit.data.value, { currentPlayers: 2 }));

    calls.modal.length = 0;
    modalAnswer = false; // 选择“保留输入”
    await edit.onSubmit({ detail: { values: Object.assign({}, edit.data.value, { note: '我的修改' }) } });
    modalAnswer = true;
    assert.equal(calls.modal[0].title, '信息已被修改');
    const post = await api.getPost(created.id);
    assert.equal(post.currentPlayers, 2);
    assert.equal(post.note, '');
  });

  await t.test('我的发布：结束后只能删除，删除后从列表移除', async () => {
    const mine = loadPage('mine');
    mine.onShow();
    await settle();
    assert.equal(mine.data.loginStatus, 'user');
    assert.equal(mine.data.list.length, 1);
    const id = mine.data.list[0].id;

    await mine.onClose({ currentTarget: { dataset: { id } } });
    await settle();
    assert.equal(mine.data.list[0].status, 'CLOSED');

    await mine.onDelete({ currentTarget: { dataset: { id } } });
    await settle();
    assert.equal(mine.data.listStatus, 'empty');
  });

  await t.test('申请加入：申请人提交，房主看到提醒并同意后人数 +1', async () => {
    // 当前登录为用户 A；A 先发布一条 1/3 的招募
    devtools.resetData();
    await auth.refresh();
    const created = await api.createPost(
      { modeCode: 'RANKED', rankCode: 'GOLD', serverCode: 'TOKYO', currentPlayers: 1, gameId: 'Owner', note: '' },
      'apply-flow'
    );

    // 切换到用户 B 申请
    devtools.switchUser('mock-openid-b');
    auth.logout();
    await auth.login();
    const detail = loadPage('detail');
    detail.onLoad({ id: created.id });
    await settle();
    assert.equal(detail.data.post.canDelete, false);
    await detail.onOpenApply();
    await settle();
    assert.equal(detail.data.applyOpen, true);
    detail.onApplyInput({ currentTarget: { dataset: { field: 'gameId' } }, detail: { value: 'Wraith_B' } });
    detail.onApplyInput({ currentTarget: { dataset: { field: 'message' } }, detail: { value: '开麦' } });
    await detail.onSubmitApply();
    assert.equal(detail.data.applyOpen, false);
    assert.equal(detail.data.myRequest.status, 'PENDING');

    // 举报：选择第一个原因后提示已收到；再次举报提示已举报过
    calls.toast.length = 0;
    await detail.onReport();
    await detail.onReport();
    assert.deepEqual(calls.toast.slice(-2), ['已收到举报，我们会尽快处理', '你已举报过这条信息']);

    // 切回用户 A：标签显示待处理数量，我的发布与详情可处理申请
    devtools.switchUser('mock-openid-a');
    auth.logout();
    await auth.login();
    assert.equal(calls.badge, '1');
    const mine = loadPage('mine');
    mine.onShow();
    await settle();
    assert.equal(mine.data.list[0].pendingRequestCount, 1);

    const ownerDetail = loadPage('detail');
    ownerDetail.onLoad({ id: created.id });
    await settle();
    assert.equal(ownerDetail.data.requests.length, 1);
    assert.equal(ownerDetail.data.requests[0].applicantGameId, 'Wraith_B');
    await ownerDetail.onDecide({ currentTarget: { dataset: { id: ownerDetail.data.requests[0].id, decision: 'ACCEPT' } } });
    await settle();
    assert.equal(ownerDetail.data.post.currentPlayers, 2);
    assert.equal(ownerDetail.data.requests[0].status, 'ACCEPTED');
    assert.equal(calls.badge, null, '处理后清除标签提醒');
    devtools.resetData();
    await auth.refresh();
  });

  await t.test('详情：他人记录无管理入口，切换用户后本人记录有', async () => {
    const created = await api.createPost(
      { rankCode: 'ANY', serverCode: 'HONG_KONG', currentPlayers: 2, modeCode: 'TRIOS', gameId: 'Owner', note: '' },
      'owner-req'
    );
    devtools.switchUser('mock-openid-b');
    auth.logout();
    await auth.login();

    const detail = loadPage('detail');
    detail.onLoad({ id: created.id });
    await settle();
    assert.equal(detail.data.post.canEdit, false);
    assert.equal(detail.data.post.canDelete, false);

    devtools.switchUser('mock-openid-a');
    auth.logout();
    await auth.login();
    detail.onShow();
    await settle();
    assert.equal(detail.data.post.canEdit, true);
  });
});
