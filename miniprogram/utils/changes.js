// 数据变更计数。发布、编辑、结束、删除或发现记录失效时调用 bump()，
// 列表页在 onShow 时比较计数决定是否重新拉取第一页。
let revision = 0;

module.exports = {
  bump() {
    revision += 1;
  },
  current() {
    return revision;
  },
};
