// 加载中 / 空数据 / 失败 三种状态的统一展示；失败时提供重试
Component({
  properties: {
    status: { type: String, value: 'loading' }, // loading | empty | error
    message: { type: String, value: '' },
    actionText: { type: String, value: '' },
  },
  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});
