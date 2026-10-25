// 云函数入口：小程序以 { action, payload } 调用，身份取自可信的微信上下文
const cloud = require('wx-server-sdk');
const { createService } = require('./service');
const { createStore } = require('./store');
const { createWechat } = require('./wechat');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const service = createService({ store: createStore(cloud.database()), wechat: createWechat(cloud) });

exports.main = (event) => service.handle(event, cloud.getWXContext().OPENID);
