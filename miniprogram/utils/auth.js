// 登录状态。访客可浏览；发布、联系和管理前调用 requireLogin()。
// 登录在当前页面内完成（弹窗确认 + ensureUser），不跳转页面，因此已填写的内容和操作意图不会丢失。
const api = require('../services/api');
const { showError } = require('./errors');

const LOGGED_IN_KEY = 'auth:loggedIn';

let user = null;
let pending = null;
let revision = 0;

function login() {
  if (!pending) {
    pending = api
      .ensureUser()
      .then((data) => {
        user = data;
        revision += 1;
        wx.setStorageSync(LOGGED_IN_KEY, true);
        return user;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

// 已登录直接返回用户；否则询问是否登录，取消或失败返回 null
async function requireLogin(reason) {
  if (user) return user;
  const { confirm } = await wx.showModal({
    title: '需要登录',
    content: reason || '该操作需要先登录',
    confirmText: '登录',
    cancelText: '暂不',
  });
  if (!confirm) return null;
  wx.showLoading({ title: '登录中', mask: true });
  try {
    const u = await login();
    wx.hideLoading();
    return u;
  } catch (err) {
    // 先关闭 loading 再提示，避免 hideLoading 把错误提示一起关掉
    wx.hideLoading();
    showError(err);
    return null;
  }
}

function restore() {
  if (!wx.getStorageSync(LOGGED_IN_KEY)) return Promise.resolve(null);
  return login().catch(() => null);
}

function logout() {
  user = null;
  revision += 1;
  wx.removeStorageSync(LOGGED_IN_KEY);
}

// 发布、结束、删除后刷新“是否有有效招募”
function refresh() {
  return user ? login().catch(() => user) : Promise.resolve(null);
}

module.exports = {
  requireLogin,
  login,
  restore,
  logout,
  refresh,
  getUser: () => user,
  isLoggedIn: () => !!user,
  // 页面用来判断登录身份是否变化，以便重新拉取带权限的数据
  revision: () => revision,
  // 恢复登录进行中时，页面可等待其结束再决定展示内容
  ready: () => pending || Promise.resolve(user),
};
