// 转发内容：首页与组队详情
const test = require('node:test');
const assert = require('node:assert/strict');
const { shareHome, sharePost } = require('../miniprogram/utils/share');

test('首页转发指向组队大厅', () => {
  assert.deepEqual(shareHome(), { title: '一起来组队，找到你的 Apex 队友', path: '/pages/hall/hall' });
});

test('招募中的信息转发带模式、服务器和缺少人数，并打开该详情页', () => {
  const share = sharePost({ id: 'p_abc', status: 'RECRUITING', modeName: '排位赛', serverName: '东京（日服）', remainingText: '缺 2 人' });
  assert.equal(share.title, '排位赛 · 东京（日服） 缺 2 人，来组队！');
  assert.equal(share.path, '/pages/detail/detail?id=p_abc');
});

test('已失效的信息不写“来组队”，无信息时转发首页', () => {
  assert.equal(sharePost({ id: 'p_x', status: 'FULL', modeName: '双人匹配', serverName: '悉尼（澳服）', remainingText: '已满员' }).title, '双人匹配 · 悉尼（澳服） 组队信息');
  assert.deepEqual(sharePost(null), shareHome());
});
