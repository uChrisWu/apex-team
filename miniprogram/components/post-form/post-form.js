// 发布与编辑共用的表单。只负责输入与初步校验，提交时触发 submit 事件，由页面调用接口。
// 表单内容保存在组件内部，提交失败或中途登录都不会清空。
const { validatePostForm, allowedCounts, limitsOf, codePointLength } = require('../../utils/validate');

const EMPTY = { modeCode: '', rankCode: '', serverCode: '', currentPlayers: 1, gameId: '', note: '' };

Component({
  options: { addGlobalClass: true },
  properties: {
    config: { type: Object, value: null },
    formMode: { type: String, value: 'create' }, // create | edit
    value: { type: Object, value: null }, // 编辑时的现有字段
    submitting: { type: Boolean, value: false },
    submitText: { type: String, value: '发布' },
  },
  data: {
    form: Object.assign({}, EMPTY),
    rankIndex: -1,
    serverIndex: -1,
    counts: [],
    limits: limitsOf(null),
    errors: {},
    noteLength: 0,
  },
  observers: {
    'config, value, formMode'(config, value, formMode) {
      if (!config) return;
      const form = Object.assign({}, EMPTY, pick(value || {}));
      this.setData({
        form,
        noteLength: codePointLength(form.note),
        counts: allowedCounts(formMode, config),
        limits: limitsOf(config),
        rankIndex: indexOf(config.ranks, form.rankCode),
        serverIndex: indexOf(config.servers, form.serverCode),
        errors: {},
      });
    },
  },
  methods: {
    onRankChange(e) {
      const i = Number(e.detail.value);
      this.setData({ rankIndex: i, 'form.rankCode': this.data.config.ranks[i].code, 'errors.rankCode': '' });
    },
    onServerChange(e) {
      const i = Number(e.detail.value);
      this.setData({ serverIndex: i, 'form.serverCode': this.data.config.servers[i].code, 'errors.serverCode': '' });
    },
    onCountTap(e) {
      this.setData({ 'form.currentPlayers': Number(e.currentTarget.dataset.value), 'errors.currentPlayers': '' });
    },
    onModeTap(e) {
      this.setData({ 'form.modeCode': e.currentTarget.dataset.value, 'errors.modeCode': '' });
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
