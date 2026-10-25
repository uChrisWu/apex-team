// 错误码与中文提示。接口约定见需求文档第 3 节。
const MESSAGES = {
  UNAUTHENTICATED: '请先登录',
  FORBIDDEN: '你没有权限执行此操作',
  VALIDATION_ERROR: '填写内容有误，请检查后重试',
  ACTIVE_POST_EXISTS: '你已有一条招募中的信息，请先结束或删除后再发布',
  NOT_FOUND: '信息不存在或已删除',
  POST_UNAVAILABLE: '该招募已满员、关闭或过期',
  VERSION_CONFLICT: '信息已被更新，请重新加载后再操作',
  CONTENT_RISKY: '内容包含不合规信息，请修改后重试',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  // 前端自有错误码：请求未得到后端响应
  NETWORK_ERROR: '网络异常，请检查网络后重试',
};

class AppError extends Error {
  constructor(code, serverMessage, requestId, details) {
    super(messageFor(code, serverMessage));
    this.code = code;
    this.requestId = requestId || null;
    this.details = details || {};
  }
}

function messageFor(code, serverMessage) {
  // 校验类错误优先使用后端给出的具体说明
  if (code === 'VALIDATION_ERROR' && serverMessage) return serverMessage;
  return MESSAGES[code] || serverMessage || MESSAGES.INTERNAL_ERROR;
}

function toAppError(err) {
  if (err instanceof AppError) return err;
  return new AppError('NETWORK_ERROR');
}

function showError(err) {
  wx.showToast({ title: toAppError(err).message, icon: 'none', duration: 2500 });
}

module.exports = { AppError, MESSAGES, messageFor, toAppError, showError };
