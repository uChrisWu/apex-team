// 订阅消息：请求房主授权“新的入队申请”提醒。
// 必须在用户点击的回调中直接调用（不能在 await 之后），每次授权可接收一条提醒。
function requestApplyNotice(config) {
  const templateId = config && config.notify && config.notify.templateId;
  if (!templateId || !wx.requestSubscribeMessage) return Promise.resolve(false);
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (res) => resolve(res[templateId] === 'accept'),
      // 用户拒绝或接口不可用时不影响主流程
      fail: () => resolve(false),
    });
  });
}

module.exports = { requestApplyNotice };
