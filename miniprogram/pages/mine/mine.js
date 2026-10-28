const api = require('../../services/api');
const auth = require('../../utils/auth');
const changes = require('../../utils/changes');
const postActions = require('../../utils/post-actions');
const { loadConfig } = require('../../utils/config-store');
const { decoratePost } = require('../../utils/post-view');
const { mergeUnique } = require('../../utils/list');
const { toAppError, showError } = require('../../utils/errors');
const { shareHome } = require('../../utils/share');

// 模拟调试面板只在 mock 模式下加载
const devtools = api.isMock ? require('../../services/mock/transport-mock').devtools : null;

Page({
  data: {
    loginStatus: 'checking', // checking | guest | user
    loggingIn: false,

    list: [],
    listStatus: 'loading', // loading | error | empty | ready
    listError: '',
    hasMore: false,
    loadingMore: false,
    moreError: false,

    dev: null, // { users, currentOpenid, offline }
  },

  config: null,
  cursor: null,
  seq: 0,
  seenRevision: -1,
  seenAuthRevision: -1,

  onShow() {
    this.refreshDevPanel();
    auth.ready().then(() => this.syncLogin());
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    if (this.data.loginStatus !== 'user') return done();
    this.reload({ keepList: true }).then(done, done);
  },

  onReachBottom() {
    this.loadMore();
  },

  onShareAppMessage() {
    return shareHome();
  },

  syncLogin() {
    if (!auth.isLoggedIn()) {
      this.seenAuthRevision = auth.revision();
      this.setData({ loginStatus: 'guest', list: [] });
      return;
    }
    this.setData({ loginStatus: 'user' });
    auth.refresh();
    // 待处理申请随时可能变化，每次显示都刷新；登录身份变化时清空旧列表
    this.reload({ keepList: auth.revision() === this.seenAuthRevision });
  },

  async onLogin() {
    if (this.data.loggingIn) return;
    this.setData({ loggingIn: true });
    try {
      await auth.login();
      this.syncLogin();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  async reload({ keepList = false } = {}) {
    const seq = ++this.seq;
    this.seenRevision = changes.current();
    this.seenAuthRevision = auth.revision();
    this.cursor = null;
    if (!keepList || !this.data.list.length) {
      this.setData({ list: [], listStatus: 'loading', hasMore: false, moreError: false });
    }
    try {
      const [config, res] = await Promise.all([loadConfig(), api.listMyPosts({ limit: 20 })]);
      if (seq !== this.seq) return;
      this.config = config;
      this.cursor = res.nextCursor;
      const list = mergeUnique([], res.items.map((p) => decoratePost(p, config)));
      this.setData({
        list,
        listStatus: list.length ? 'ready' : 'empty',
        hasMore: !!res.hasMore,
        loadingMore: false,
        moreError: false,
      });
    } catch (err) {
      if (seq !== this.seq) return;
      const e = toAppError(err);
      if (e.code === 'UNAUTHENTICATED') {
        auth.logout();
        this.syncLogin();
        return;
      }
      // 刷新失败时下次进入页面重试
      this.seenRevision = -1;
      if (keepList && this.data.list.length) showError(e);
      else this.setData({ listStatus: 'error', listError: e.message });
    }
  },

  async loadMore() {
    const { hasMore, loadingMore, listStatus } = this.data;
    if (!hasMore || loadingMore || listStatus !== 'ready') return;
    const seq = this.seq;
    this.setData({ loadingMore: true, moreError: false });
    try {
      const res = await api.listMyPosts({ cursor: this.cursor, limit: 20 });
      if (seq !== this.seq) return;
      this.cursor = res.nextCursor;
      this.setData({
        list: mergeUnique(this.data.list, res.items.map((p) => decoratePost(p, this.config))),
        hasMore: !!res.hasMore,
        loadingMore: false,
      });
    } catch (err) {
      if (seq !== this.seq) return;
      this.setData({ loadingMore: false, moreError: true });
    }
  },

  findPost(e) {
    const id = e.currentTarget.dataset.id;
    return this.data.list.find((p) => p.id === id);
  },

  onSelectPost(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.detail.id)}` });
  },

  onViewRequests(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` });
  },

  onEdit(e) {
    wx.navigateTo({ url: `/pages/publish/publish?id=${encodeURIComponent(e.currentTarget.dataset.id)}` });
  },

  async onClose(e) {
    this.handleResult(await postActions.closePost(this.findPost(e)), '已结束招募');
  },

  async onDelete(e) {
    this.handleResult(await postActions.deletePost(this.findPost(e)), '已删除');
  },

  handleResult(res, successText) {
    if (res.ok) {
      wx.showToast({ title: successText, icon: 'success' });
    } else if (res.error) {
      if (res.error.code === 'VERSION_CONFLICT') {
        wx.showModal({ title: '信息已更新', content: '这条信息已被修改，列表已刷新，请确认后再操作。', showCancel: false });
      } else {
        showError(res.error);
      }
    } else {
      return; // 用户取消
    }
    this.reload({ keepList: true });
  },

  onPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' });
  },

  // ---- 模拟调试面板 ----
  refreshDevPanel() {
    if (!devtools) return;
    this.setData({
      dev: {
        users: devtools.users,
        currentOpenid: devtools.currentUser().openid,
        offline: devtools.isOffline(),
      },
    });
  },

  onDevSwitchUser(e) {
    devtools.switchUser(e.currentTarget.dataset.openid);
    auth.logout();
    changes.bump();
    this.refreshDevPanel();
    this.syncLogin();
    wx.showToast({ title: '已切换，需重新登录', icon: 'none' });
  },

  onDevToggleOffline(e) {
    devtools.setOffline(e.detail.value);
    this.refreshDevPanel();
  },

  onDevLogout() {
    devtools.logout();
    auth.logout();
    this.syncLogin();
  },

  async onDevReset() {
    const { confirm } = await wx.showModal({ title: '重置模拟数据', content: '将清空所有模拟发布并重新生成示例数据。' });
    if (!confirm) return;
    devtools.resetData();
    changes.bump();
    auth.refresh();
    this.syncLogin();
    wx.showToast({ title: '已重置', icon: 'success' });
  },
});
