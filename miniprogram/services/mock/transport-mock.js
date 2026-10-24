// 模拟传输层：把请求交给本机模拟后端，并模拟网络延迟、登录身份和网络故障。
// 真实环境中身份由云函数从微信上下文取得；这里用“当前模拟用户”代替。
const env = require('../../config/env');
const { createMockBackend } = require('./backend');

// 数据结构变化时更换键名，旧的本地模拟数据自动作废
const DB_KEY = 'mock:db:v2';
const USER_KEY = 'mock:openid';
const OFFLINE_KEY = 'mock:offline';

const MOCK_USERS = [
  { openid: 'mock-openid-a', name: '测试用户 A' },
  { openid: 'mock-openid-b', name: '测试用户 B' },
];

const backend = createMockBackend({
  load: () => wx.getStorageSync(DB_KEY) || null,
  save: (db) => wx.setStorageSync(DB_KEY, db),
});

// 调用 ensureUser 之后才视为已登录；未登录的请求以访客身份发出
let sessionOpenid = null;

function currentMockUser() {
  const openid = wx.getStorageSync(USER_KEY) || MOCK_USERS[0].openid;
  return MOCK_USERS.find((u) => u.openid === openid) || MOCK_USERS[0];
}

function send(action, payload) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (wx.getStorageSync(OFFLINE_KEY)) {
        reject(new Error('模拟网络故障'));
        return;
      }
      if (action === 'ensureUser') sessionOpenid = currentMockUser().openid;
      // 返回副本，避免页面修改到模拟数据库中的对象
      resolve(JSON.parse(JSON.stringify(backend.handle(action, payload, sessionOpenid))));
    }, env.mockLatencyMs);
  });
}

// 以下仅供“我的发布”页的模拟调试面板使用
const devtools = {
  users: MOCK_USERS,
  currentUser: currentMockUser,
  switchUser(openid) {
    wx.setStorageSync(USER_KEY, openid);
    sessionOpenid = null;
  },
  logout() {
    sessionOpenid = null;
  },
  isOffline: () => !!wx.getStorageSync(OFFLINE_KEY),
  setOffline(value) {
    wx.setStorageSync(OFFLINE_KEY, !!value);
  },
  resetData() {
    backend.reset();
  },
};

module.exports = { send, devtools };
