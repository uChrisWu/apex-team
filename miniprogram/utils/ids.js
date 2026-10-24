// 客户端生成的请求 ID，用作创建请求的幂等标识
function newRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = { newRequestId };
