// 发布与编辑共用此页：带 id 参数时为编辑
const api = require('../../services/api');
const auth = require('../../utils/auth');
const changes = require('../../utils/changes');
const { loadConfig } = require('../../utils/config-store');
const { STATUS_TEXT } = require('../../utils/post-view');
const { newRequestId } = require('../../utils/ids');
const { requestApplyNotice } = require('../../utils/notify');
const { toAppError, showError } = require('../../utils/errors');

// 编辑时从“我的发布”的本人记录加载 gameId（getPost 不返回游戏 ID）
async function findOwnPost(postId) {
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const res = await api.listMyPosts({ cursor, limit: 50 });
    const hit = res.items.find((p) => p.id === postId);
    if (hit) return hit;
    if (!res.hasMore) return null;
    cursor = res.nextCursor;
  }
  return null;
}

Page({
  data: {
    formMode: 'create',
    status: 'loading', // loading | error | ready | notfound | locked | login
    errorMessage: '',
    lockedMessage: '',
    config: null,
    value: null,
    submitting: false,
    activePostId: null,
    defaultGameId: '',
    isMock: api.isMock,
  },

  postId: '',
  version: null,
  requestId: '', // 创建请求的幂等标识，跨重试复用

  onLoad(options) {
    if (options.id) {
      this.postId = decodeURIComponent(options.id);
      this.setData({ formMode: 'edit' });
      wx.setNavigationBarTitle({ title: '编辑组队' });
    } else {
      this.requestId = newRequestId();
    }
    auth.ready().then(() => this.load());
  },

  onShow() {
    if (this.data.formMode === 'create' && this.data.status === 'ready') this.syncActivePost();
  },

  load() {
    return this.data.formMode === 'edit' ? this.loadEdit() : this.loadCreate();
  },

  async loadCreate() {
    this.setData({ status: 'loading' });
    try {
      const config = await loadConfig();
      this.setData({ status: 'ready', config });
    } catch (err) {
      this.setData({ status: 'error', errorMessage: toAppError(err).message });
      return;
    }
    this.syncActivePost();
  },

  syncActivePost() {
    const user = auth.getUser();
    this.setData({
      activePostId: user && user.hasActivePost ? user.activePostId : null,
      defaultGameId: (user && user.lastGameId) || '',
    });
  },

  async loadEdit() {
    const user = await auth.requireLogin('编辑信息需要先登录');
    if (!user) {
      this.setData({ status: 'login' });
      return;
    }
    this.setData({ status: 'loading' });
    try {
      const [config, post] = await Promise.all([loadConfig(), findOwnPost(this.postId)]);
      if (!post) {
        this.setData({ status: 'notfound' });
        return;
      }
      this.version = post.version;
      if (post.status !== 'RECRUITING') {
        this.setData({
          status: 'locked',
          lockedMessage: `该信息${STATUS_TEXT[post.status] || '已失效'}，不能再编辑。需要再次招募请重新发布。`,
        });
        return;
      }
      this.setData({ status: 'ready', config, value: post });
    } catch (err) {
      this.setData({ status: 'error', errorMessage: toAppError(err).message });
    }
  },

  async onSubmit(e) {
    if (this.data.submitting) return;
    const values = e.detail.values;
    // 订阅请求必须在点击回调中、任何 await 之前发起；授权结果不影响发布
    if (this.data.formMode === 'create') requestApplyNotice(this.data.config);
    const user = await auth.requireLogin('发布组队信息需要先登录，已填写的内容会保留');
    if (!user) return;

    this.setData({ submitting: true });
    try {
      if (this.data.formMode === 'edit') await this.submitEdit(values);
      else await this.submitCreate(values);
    } finally {
      this.setData({ submitting: false });
    }
  },

  async submitCreate(values) {
    try {
      const res = await api.createPost(values, this.requestId);
      changes.bump();
      auth.refresh();
      wx.showToast({ title: api.isMock ? '已发布（模拟）' : '发布成功', icon: 'success' });
      // fresh=1：详情页提示把刚发布的信息转发到群里
      setTimeout(() => wx.redirectTo({ url: `/pages/detail/detail?id=${encodeURIComponent(res.id)}&fresh=1` }), 600);
    } catch (err) {
      const e = toAppError(err);
      if (e.code === 'ACTIVE_POST_EXISTS') {
        this.promptExistingPost(e.details.existingPostId);
      } else if (e.code === 'UNAUTHENTICATED') {
        auth.logout();
        showError(e);
      } else {
        showError(e);
      }
    }
  },

  async promptExistingPost(existingPostId) {
    const { confirm } = await wx.showModal({
      title: '已有招募中的信息',
      content: '每人同时只能有一条招募中的信息。请先结束或删除原信息，再重新发布。',
      confirmText: '去管理',
      cancelText: '留在此页',
    });
    if (!confirm) return;
    if (existingPostId) wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(existingPostId)}` });
    else wx.switchTab({ url: '/pages/mine/mine' });
  },

  async submitEdit(values) {
    try {
      const post = await api.updatePost(this.postId, this.version, values);
      this.version = post.version;
      changes.bump();
      auth.refresh();
      wx.showToast({ title: post.status === 'FULL' ? '已保存，已满员' : '已保存', icon: 'success' });
      setTimeout(() => this.leaveToDetail(), 600);
    } catch (err) {
      const e = toAppError(err);
      if (e.code === 'VERSION_CONFLICT') {
        const { confirm } = await wx.showModal({
          title: '信息已被修改',
          content: '这条信息在别处已被修改。重新加载会显示最新内容，你当前的修改将被替换。',
          confirmText: '重新加载',
          cancelText: '保留输入',
        });
        if (confirm) this.loadEdit();
      } else if (e.code === 'POST_UNAVAILABLE' || e.code === 'NOT_FOUND') {
        changes.bump();
        showError(e);
        this.loadEdit();
      } else {
        showError(e);
      }
    }
  },

  // 从详情页进入编辑则返回详情页（其 onShow 会刷新），否则跳转到详情
  leaveToDetail() {
    const pages = getCurrentPages();
    const prev = pages[pages.length - 2];
    if (prev && prev.route === 'pages/detail/detail' && prev.postId === this.postId) wx.navigateBack();
    else wx.redirectTo({ url: `/pages/detail/detail?id=${encodeURIComponent(this.postId)}` });
  },

  onViewActivePost() {
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(this.data.activePostId)}` });
  },

  onRetry() {
    this.load();
  },

  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/mine/mine' });
  },
});
