const env = require('./config/env');
const auth = require('./utils/auth');

App({
  onLaunch() {
    if (env.apiMode === 'cloud') {
      if (!wx.cloud) {
        console.error('当前基础库不支持云开发，请升级微信或基础库版本');
        return;
      }
      wx.cloud.init(env.cloudEnv ? { env: env.cloudEnv, traceUser: true } : { traceUser: true });
    }
    // 之前登录过的用户静默恢复登录态；失败时保持访客身份，不打扰用户
    auth.restore();
  },

  // 回到前台时刷新待处理申请数量
  onShow() {
    auth.refresh();
  },
});
