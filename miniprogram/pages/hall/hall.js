const api = require('../../services/api');
const { loadConfig } = require('../../utils/config-store');
const { decoratePost } = require('../../utils/post-view');
const { toAppError } = require('../../utils/errors');
const changes = require('../../utils/changes');
const { mergeUnique } = require('../../utils/list');
const { activeOptions } = require('../../utils/validate');
const { shareHome } = require('../../utils/share');

const ALL = { code: '', name: '全部' };
const REMAINING_OPTIONS = [
  { code: '', name: '全部' },
  { code: 1, name: '缺 1 人' },
  { code: 2, name: '缺 2 人' },
];

Page({
  data: {
    configStatus: 'loading', // loading | error | ready
    configError: '',
    modeOptions: [ALL],
    rankOptions: [ALL],
    serverOptions: [ALL],
    remainingOptions: REMAINING_OPTIONS,
    modeIndex: 0,
    rankIndex: 0,
    serverIndex: 0,
    remainingIndex: 0,

    list: [],
    listStatus: 'loading', // loading | error | empty | ready
    listError: '',
    hasMore: false,
    loadingMore: false,
    moreError: false,
  },

  config: null,
  cursor: null,
  seq: 0, // 每次重新查询自增，丢弃过期响应，避免筛选切换后混入旧结果
  seenRevision: 0,

  onLoad() {
    this.seenRevision = changes.current();
    this.init();
  },

  onShow() {
    // 发布、编辑、结束、删除或详情发现失效后，回到大厅重新拉取
    if (this.config && changes.current() !== this.seenRevision) {
      this.seenRevision = changes.current();
      this.reload({ keepList: true });
    }
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    if (!this.config) this.init().then(done, done);
    else this.reload({ keepList: true }).then(done, done);
  },

  onReachBottom() {
    this.loadMore();
  },

  onShareAppMessage() {
    return shareHome();
  },

  async init() {
    this.setData({ configStatus: 'loading' });
    try {
      this.config = await loadConfig();
    } catch (err) {
      this.setData({ configStatus: 'error', configError: toAppError(err).message });
      return;
    }
    this.setData({
      configStatus: 'ready',
      // 筛选中不单独列出“不限”：选择具体段位或服务器时，后端会同时返回“不限”的信息
      modeOptions: [ALL].concat(activeOptions(this.config.modes)),
      rankOptions: [ALL].concat(activeOptions(this.config.ranks).filter((r) => r.code !== 'ANY')),
      serverOptions: [ALL].concat(activeOptions(this.config.servers).filter((s) => s.code !== 'ANY')),
    });
    await this.reload();
  },

  query() {
    const { modeOptions, rankOptions, serverOptions, modeIndex, rankIndex, serverIndex, remainingIndex } = this.data;
    const q = { limit: (this.config.limits && this.config.limits.pageSize) || 20 };
    if (modeOptions[modeIndex].code) q.modeCode = modeOptions[modeIndex].code;
    if (rankOptions[rankIndex].code) q.rankCode = rankOptions[rankIndex].code;
    if (serverOptions[serverIndex].code) q.serverCode = serverOptions[serverIndex].code;
    if (REMAINING_OPTIONS[remainingIndex].code) q.remainingSlots = REMAINING_OPTIONS[remainingIndex].code;
    return q;
  },

  // 清空游标重新获取第一页。keepList 用于下拉刷新时保留旧内容直到新结果返回
  async reload({ keepList = false } = {}) {
    const seq = ++this.seq;
    this.cursor = null;
    if (!keepList || !this.data.list.length) {
      this.setData({ list: [], listStatus: 'loading', hasMore: false, moreError: false });
    }
    try {
      const res = await api.listPosts(this.query());
      if (seq !== this.seq) return;
      this.cursor = res.nextCursor;
      const list = mergeUnique([], res.items.map((p) => decoratePost(p, this.config)));
      this.setData({
        list,
        listStatus: list.length ? 'ready' : 'empty',
        hasMore: !!res.hasMore,
        loadingMore: false,
        moreError: false,
      });
    } catch (err) {
      if (seq !== this.seq) return;
      if (keepList && this.data.list.length) {
        wx.showToast({ title: toAppError(err).message, icon: 'none' });
      } else {
        this.setData({ listStatus: 'error', listError: toAppError(err).message });
      }
    }
  },

  async loadMore() {
    const { hasMore, loadingMore, listStatus } = this.data;
    if (!hasMore || loadingMore || listStatus !== 'ready') return;
    const seq = this.seq;
    this.setData({ loadingMore: true, moreError: false });
    try {
      const res = await api.listPosts(Object.assign(this.query(), { cursor: this.cursor }));
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

  onModeChange(e) {
    this.setData({ modeIndex: Number(e.detail.value) });
    this.reload();
  },
  onRankChange(e) {
    this.setData({ rankIndex: Number(e.detail.value) });
    this.reload();
  },
  onServerChange(e) {
    this.setData({ serverIndex: Number(e.detail.value) });
    this.reload();
  },
  onRemainingTap(e) {
    const i = Number(e.currentTarget.dataset.index);
    if (i === this.data.remainingIndex) return;
    this.setData({ remainingIndex: i });
    this.reload();
  },
  onResetFilters() {
    this.setData({ modeIndex: 0, rankIndex: 0, serverIndex: 0, remainingIndex: 0 });
    this.reload();
  },

  onSelectPost(e) {
    const { id, version } = e.detail;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}&v=${version}` });
  },

  onPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' });
  },
});

