// 发布与编辑共用的表单。只负责输入与初步校验，提交时触发 submit 事件，由页面调用接口。
// 表单内容保存在组件内部，提交失败或中途登录都不会清空。
const { validatePostForm, allowedCounts, limitsOf, activeOptions, maxPlayersFor, codePointLength } = require('../../utils/validate');

const EMPTY = { modeCode: '', rankCode: '', serverCode: '', currentPlayers: 1, gameId: '', note: '' };

Component({
  options: { addGlobalClass: true },
  properties: {
    config: { type: Object, value: null },
    formMode: { type: String, value: 'create' }, // create | edit
    value: { type: Object, value: null }, // 编辑时的现有字段
    defaultGameId: { type: String, value: '' }, // 新建时预填上次使用的游戏 ID
    submitting: { type: Boolean, value: false },
    submitText: { type: String, value: '发布' },
  },
  data: {
    form: Object.assign({}, EMPTY),
    // 只展示启用中的选项；编辑时若原选项已停用，需要重新选择
    modes: [],
    ranks: [],
    servers: [],
    rankIndex: -1,
    serverIndex: -1,
    counts: [],
    maxPlayers: 3,
    limits: limitsOf(null),
    errors: {},
    noteLength: 0,
  },
  observers: {
    'config, value, formMode'(config, value, formMode) {
      if (!config) return;
      const form = Object.assign({}, EMPTY, pick(value || {}));
      if (!value && this.data.defaultGameId) form.gameId = this.data.defaultGameId;
      const ranks = activeOptions(config.ranks);
      const servers = activeOptions(config.servers);
      this.setData({
        form,
        modes: activeOptions(config.modes),
        ranks,
        servers,
        noteLength: codePointLength(form.note),
        limits: limitsOf(config),
        rankIndex: indexOf(ranks, form.rankCode),
        serverIndex: indexOf(servers, form.serverCode),
        errors: {},
      });
      this.syncCounts();
    },
    // 登录信息可能晚于配置返回；只在新建且尚未填写时预填
    defaultGameId(gameId) {
      if (gameId && !this.data.value && !this.data.form.gameId) this.setData({ 'form.gameId': gameId });
    },
  },
  methods: {
    // 人数选项随游戏模式变化（双人模式上限为 2）；超出上限时调整为允许的最大值
    syncCounts() {
      const { config, formMode, form } = this.data;
      const counts = allowedCounts(formMode, config, form.modeCode);
      const patch = { counts, maxPlayers: maxPlayersFor(config, form.modeCode) };
      if (counts.indexOf(form.currentPlayers) === -1) patch['form.currentPlayers'] = counts[counts.length - 1];
      this.setData(patch);
    },
    onModeTap(e) {
      this.setData({ 'form.modeCode': e.currentTarget.dataset.value, 'errors.modeCode': '', 'errors.currentPlayers': '' });
      this.syncCounts();
    },
    onRankChange(e) {
      const i = Number(e.detail.value);
      this.setData({ rankIndex: i, 'form.rankCode': this.data.ranks[i].code, 'errors.rankCode': '' });
    },
    onServerChange(e) {
      const i = Number(e.detail.value);
      this.setData({ serverIndex: i, 'form.serverCode': this.data.servers[i].code, 'errors.serverCode': '' });
    },
    onCountTap(e) {
      this.setData({ 'form.currentPlayers': Number(e.currentTarget.dataset.value), 'errors.currentPlayers': '' });
    },
    onGameIdInput(e) {
      this.setData({ 'form.gameId': e.detail.value, 'errors.gameId': '' });
    },
    onNoteInput(e) {
      this.setData({ 'form.note': e.detail.value, noteLength: codePointLength(e.detail.value), 'errors.note': '' });
    },
    onSubmit() {
      if (this.data.submitting) return;
      const { values, errors } = validatePostForm(this.data.form, this.data.formMode, this.data.config);
      const keys = Object.keys(errors);
      if (keys.length) {
        this.setData({ errors });
        wx.showToast({ title: errors[keys[0]], icon: 'none' });
        return;
      }
      this.triggerEvent('submit', { values });
    },
  },
});

function pick(v) {
  const out = {};
  Object.keys(EMPTY).forEach((k) => {
    if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
  });
  return out;
}

function indexOf(options, code) {
  return (options || []).findIndex((o) => o.code === code);
}
