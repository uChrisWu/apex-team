// 组队卡片。post 为经过 decoratePost 处理的记录
Component({
  options: { addGlobalClass: true },
  properties: {
    post: { type: Object, value: {} },
    showStatus: { type: Boolean, value: false },
  },
  methods: {
    onTap() {
      this.triggerEvent('select', { id: this.data.post.id, version: this.data.post.version });
    },
  },
});
