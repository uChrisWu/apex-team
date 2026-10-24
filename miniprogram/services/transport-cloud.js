// 真实后端：调用单个业务云函数，逻辑接口名作为 action 传入。
// 云函数的入参结构 { action, payload } 需与后端实现保持一致，联调时核实。
const env = require('../config/env');

function send(action, payload) {
  return wx.cloud
    .callFunction({
      name: env.cloudFunctionName,
      data: { action, payload },
    })
    .then((res) => res.result);
}

module.exports = { send };
