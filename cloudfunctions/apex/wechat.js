// 微信开放能力：内容安全检测与订阅消息。需要在 config.json 中声明云调用权限。
function createWechat(cloud) {
  return {
    // 返回 'pass' | 'review' | 'risky'；接口异常时抛错，由业务层拒绝写入
    async checkText(openid, content) {
      try {
        const res = await cloud.openapi.security.msgSecCheck({ openid, scene: 3, version: 2, content });
        return (res.result && res.result.suggest) || 'pass';
      } catch (err) {
        // 87014：内容含有违法违规内容
        if (err && err.errCode === 87014) return 'risky';
        throw err;
      }
    },

    sendSubscribeMessage({ touser, templateId, page, data, miniprogramState }) {
      return cloud.openapi.subscribeMessage.send({ touser, templateId, page, data, miniprogramState });
    },
  };
}

module.exports = { createWechat };
