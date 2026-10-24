// 运行环境配置。切换真实后端时只需修改这里，页面代码不需要改动。
module.exports = {
  // 'mock'：本机模拟后端（数据存于本地缓存，仅用于演示和开发）
  // 'cloud'：通过云函数调用真实后端
  apiMode: 'mock',

  // cloud 模式：云开发环境 ID（留空则使用默认环境）与业务云函数名
  cloudEnv: 'apex-team-mvp-d9g5f5u5h64c3c701',
  cloudFunctionName: 'apex',

  // mock 模式：模拟网络延迟，便于看到加载状态
  mockLatencyMs: 350,
};
