const api = require('../../services/api');
const auth = require('../../utils/auth');
const changes = require('../../utils/changes');
const postActions = require('../../utils/post-actions');
const { loadConfig } = require('../../utils/config-store');
const { decoratePost, decorateRequest } = require('../../utils/post-view');
const { validateApplyForm, limitsOf, activeOptions } = require('../../utils/validate');
const { requestApplyNotice } = require('../../utils/notify');
const { toAppError, showError } = require('../../utils/errors');
const { sharePost } = require('../../utils/share');

Page({
  data: {
    status: 'loading', // loading | error | notfound | ready
    errorMessage: '',
    post: null,
    copying: false,
    limits: limitsOf(null),
    canSubscribe: false,
    justPublished: false, // 刚发布成功，突出转发到群的引导

    // 申请人
    myRequest: null,
    applyOpen: false,
    applyForm: { gameId: '', message: '' },
    applyErrors: {},
    applying: false,

    // 房主
    requests: [],
    requestsStatus: 'idle', // idle | loading | error | ready
    decidingId: '',
  },

  postId: '',
  listVersion: null, // 从大厅进入时卡片上的 version，用于判断大厅是否需要刷新
  loaded: false,
  config: null,

  onLoad(options) {
    this.postId = decodeURIComponent(options.id || '');
    this.listVersion = options.v ? Number(options.v) : null;
    this.setData({ justPublished: options.fresh === '1' });
    auth.ready().then(() => this.load());
  },

  onShow() {
    // 从编辑页返回、切换登录身份或从订阅消息进入后，以接口结果为准重新加载
    if (this.loaded) this.load({ silent: true });
  },

  onPullDownRefresh() {
    this.load({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  // 右上角菜单与页面内的转发按钮都转发这条招募；信息不存在时转发首页
  onShareAppMessage() {
    return sharePost(this.data.status === 'ready' ? this.data.post : null);
  },

  async load({ silent = false } = {}) {
    if (!this.postId) {
      this.setData({ status: 'notfound' });
      return;
    }
    if (!silent || this.data.status !== 'ready') this.setData({ status: 'loading' });
    try {
      const [config, post] = await Promise.all([loadConfig(), api.getPost(this.postId)]);
      this.config = config;
      this.loaded = true;
      if (post.status !== 'RECRUITING' || (this.listVersion !== null && post.version !== this.listVersion)) {
        changes.bump();
        this.listVersion = post.version;
      }
      this.setData({
        status: 'ready',
        post: decoratePost(post, config),
        myRequest: post.myRequest ? decorateRequest(post.myRequest) : null,
        limits: limitsOf(config),
        canSubscribe: !!(config.notify && config.notify.templateId),
      });
      if (post.canDelete) this.loadRequests();
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

  // ---------- 申请加入（申请人） ----------

  async onOpenApply() {
    const { post } = this.data;
    if (!post || post.status !== 'RECRUITING') return;
    const user = await auth.requireLogin('登录后才能申请加入队伍');
    if (!user) return;
    // 登录后重新加载，确认身份（可能是发布者本人）和已有申请
    await this.load({ silent: true });
    if (this.data.post.canDelete || (this.data.myRequest && this.data.myRequest.status !== 'CANCELLED')) return;
    this.setData({
      applyOpen: true,
      applyErrors: {},
      'applyForm.gameId': this.data.applyForm.gameId || user.lastGameId || '',
    });
  },

  onCloseApply() {
    this.setData({ applyOpen: false });
  },

  onApplyInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`applyForm.${field}`]: e.detail.value, [`applyErrors.${field}`]: '' });
  },

  async onSubmitApply() {
    if (this.data.applying) return;
    const { values, errors } = validateApplyForm(this.data.applyForm, this.config);
    const keys = Object.keys(errors);
    if (keys.length) {
      this.setData({ applyErrors: errors });
      wx.showToast({ title: errors[keys[0]], icon: 'none' });
      return;
    }
    this.setData({ applying: true });
    try {
      const request = await api.applyToPost(this.postId, values);
      this.setData({ applyOpen: false, myRequest: decorateRequest(request) });
      wx.showToast({ title: '已发送申请', icon: 'success' });
    } catch (err) {
      const e = toAppError(err);
      showError(e);
      if (e.code === 'POST_UNAVAILABLE' || e.code === 'NOT_FOUND') {
        this.setData({ applyOpen: false });
        this.load({ silent: true });
      }
    } finally {
      this.setData({ applying: false });
    }
  },

  async onCancelApply() {
    const { confirm } = await wx.showModal({ title: '撤回申请', content: '撤回后房主将看不到这条申请，之后可以重新申请。' });
    if (!confirm) return;
    try {
      const request = await api.cancelApplication(this.postId);
      this.setData({ myRequest: decorateRequest(request) });
      wx.showToast({ title: '已撤回', icon: 'success' });
    } catch (err) {
      showError(err);
      this.load({ silent: true });
    }
  },

  // ---------- 申请处理（房主） ----------

  async loadRequests() {
    if (this.data.requestsStatus !== 'ready') this.setData({ requestsStatus: 'loading' });
    try {
      const res = await api.listPostRequests(this.postId);
      this.setData({ requests: res.items.map(decorateRequest), requestsStatus: 'ready' });
    } catch (err) {
      this.setData({ requestsStatus: 'error' });
    }
  },

  onCopyApplicant(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.gameid });
  },

  async onDecide(e) {
    const { id, decision } = e.currentTarget.dataset;
    if (this.data.decidingId) return;
    const accepting = decision === 'ACCEPT';
    const { confirm } = await wx.showModal({
      title: accepting ? '同意申请' : '拒绝申请',
      content: accepting ? '同意后当前人数将自动 +1，请记得在游戏内邀请对方。' : '确定拒绝这条申请吗？',
      confirmText: accepting ? '同意' : '拒绝',
    });
    if (!confirm) return;
    this.setData({ decidingId: id });
    try {
      const res = await api.decideRequest(id, decision);
      changes.bump();
      auth.refresh();
      const full = res.post.status === 'FULL';
      wx.showToast({ title: accepting ? (full ? '已同意，队伍已满员' : '已同意，人数 +1') : '已拒绝', icon: 'none' });
      this.listVersion = res.post.version;
      this.setData({ post: decoratePost(res.post, this.config) });
      this.loadRequests();
    } catch (err) {
      showError(err);
      this.load({ silent: true });
    } finally {
      this.setData({ decidingId: '' });
    }
  },

  // 必须直接在点击回调中请求订阅；每次同意可接收一条提醒
  onSubscribe() {
    requestApplyNotice(this.config).then((accepted) => {
      wx.showToast({ title: accepted ? '已开启一次申请提醒' : '未开启提醒', icon: 'none' });
    });
  },

  // ---------- 举报 ----------

  async onReport() {
    const reasons = activeOptions(this.config && this.config.reportReasons).slice(0, 6);
    if (!reasons.length) return;
    let tapIndex;
    try {
      ({ tapIndex } = await wx.showActionSheet({ itemList: reasons.map((r) => r.name) }));
    } catch (_) {
      return; // 取消
    }
    const user = await auth.requireLogin('登录后才能举报');
    if (!user) return;
    try {
      const res = await api.reportPost(this.postId, reasons[tapIndex].code);
      wx.showToast({ title: res.duplicate ? '你已举报过这条信息' : '已收到举报，我们会尽快处理', icon: 'none' });
    } catch (err) {
      showError(err);
    }
  },

  // ---------- 管理 ----------

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
