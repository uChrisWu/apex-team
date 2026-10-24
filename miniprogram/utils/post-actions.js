// 结束、删除操作：先确认，再调用接口。详情页和我的发布共用。
// 返回 { ok: true, data } 或 { ok: false, error }；用户取消时返回 { ok: false }
const api = require('../services/api');
const auth = require('./auth');
const changes = require('./changes');
const { toAppError } = require('./errors');

async function confirmThenRun({ title, content, confirmText, loadingText, run }) {
  const { confirm } = await wx.showModal({ title, content, confirmText, confirmColor: '#d33a2c' });
  if (!confirm) return { ok: false };
  wx.showLoading({ title: loadingText, mask: true });
  try {
    const data = await run();
    wx.hideLoading();
    changes.bump();
    auth.refresh();
    return { ok: true, data };
  } catch (err) {
    wx.hideLoading();
    return { ok: false, error: toAppError(err) };
  }
}

function closePost(post) {
  return confirmThenRun({
    title: '结束招募',
    content: '结束后不能重新开启，需要时请重新发布。确定结束吗？',
    confirmText: '结束',
    loadingText: '正在结束',
    run: () => api.closePost(post.id, post.version),
  });
}

function deletePost(post) {
  return confirmThenRun({
    title: '删除信息',
    content: '删除后无法恢复。确定删除吗？',
    confirmText: '删除',
    loadingText: '正在删除',
    run: () => api.deletePost(post.id, post.version),
  });
}

module.exports = { closePost, deletePost };
