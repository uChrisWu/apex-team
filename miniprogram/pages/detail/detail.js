const api = require('../../services/api');
const auth = require('../../utils/auth');
const changes = require('../../utils/changes');
const postActions = require('../../utils/post-actions');
const { loadConfig } = require('../../utils/config-store');
const { decoratePost } = require('../../utils/post-view');
const { toAppError, showError } = require('../../utils/errors');

Page({
  data: {
    status: 'loading', // loading | error | notfound | ready
    errorMessage: '',
    post: null,
    copying: false,
  },

  postId: '',
  listVersion: null, // 从大厅进入时卡片上的 version，用于判断大厅是否需要刷新
  loaded: false,

  onLoad(options) {
    this.postId = decodeURIComponent(options.id || '');
    this.listVersion = options.v ? Number(options.v) : null;
    auth.ready().then(() => this.load());
  },

  onShow() {
    // 从编辑页返回或切换登录身份后，以接口结果为准重新加载
    if (this.loaded) this.load({ silent: true });
  },

  onPullDownRefresh() {
    this.load({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  async load({ silent = false } = {}) {
    if (!this.postId) {
      this.setData({ status: 'notfound' });
      return;
    }
    if (!silent || this.data.status !== 'ready') this.setData({ status: 'loading' });
    try {
      const [config, post] = await Promise.all([loadConfig(), api.getPost(this.postId)]);
      this.loaded = true;
      if (post.status !== 'RECRUITING' || (this.listVersion !== null && post.version !== this.listVersion)) {
        changes.bump();
        this.listVersion = post.version;
      }
      this.setData({ status: 'ready', post: decoratePost(post, config) });
    } catch (err) {
      const e = toAppError(err);
      if (e.code === 'NOT_FOUND') {
        this.loaded = true;
        changes.bump();
        this.setData({ status: 'notfound', post: null });
      } else if (silent && this.data.status === 'ready') {
        showError(e);
      } else {
        this.setData({ status: 'error', errorMessage: e.message });
      }
    }
  },

  onRetry() {
    this.load();
  },

  async onCopyContact() {
    const { post, copying } = this.data;
    if (copying || !post || post.status !== 'RECRUITING') return;
    const user = await auth.requireLogin('登录后才能查看并复制发布者的游戏 ID');
    if (!user) return;

    this.setData({ copying: true });
    try {
      // 每次复制前都向后端确认当前仍可联系
      const contact = await api.getContact(post.id);
      await wx.setClipboardData({ data: contact.gameId });
      wx.showToast({ title: '已复制游戏 ID', icon: 'success' });
    } catch (err) {
      const e = toAppError(err);
      if (e.code === 'POST_UNAVAILABLE' || e.code === 'NOT_FOUND') {
        wx.showToast({ title: e.message, icon: 'none' });
      } else if (e.code === 'UNAUTHENTICATED') {
        auth.logout();
        showError(e);
      } else if (err && err.errMsg) {
        // 剪贴板写入失败
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      } else {
        showError(e);
      }
    } finally {
      this.setData({ copying: false });
    }
    // 以接口结果为准刷新状态；登录后也可能变为发布者本人，需要获取管理权限
    this.load({ silent: true });
  },

  onEdit() {
    wx.navigateTo({ url: `/pages/publish/publish?id=${encodeURIComponent(this.postId)}` });
  },

  async onClose() {
    const res = await postActions.closePost(this.data.post);
    this.afterAction(res, '已结束招募');
  },

  async onDelete() {
    const res = await postActions.deletePost(this.data.post);
    if (res.ok) {
      wx.showToast({ title: '已删除', icon: 'success' });
      this.setData({ status: 'notfound', post: null });
      setTimeout(() => {
        if (getCurrentPages().length > 1) wx.navigateBack();
      }, 800);
      return;
    }
    this.afterAction(res);
  },

  afterAction(res, successText) {
    if (res.ok) {
      wx.showToast({ title: successText, icon: 'success' });
      this.load({ silent: true });
      return;
    }
    if (!res.error) return; // 用户取消
    if (res.error.code === 'VERSION_CONFLICT') {
      wx.showModal({
        title: '信息已更新',
        content: '这条信息已被修改，已为你重新加载，请确认后再操作。',
        showCancel: false,
      });
    } else {
      showError(res.error);
    }
    this.load({ silent: true });
  },

  onBackToHall() {
    wx.switchTab({ url: '/pages/hall/hall' });
  },
});
