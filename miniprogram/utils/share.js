// 转发给朋友：首页与组队详情的分享内容
const HOME_PATH = '/pages/hall/hall';

function shareHome() {
  return { title: '一起来组队，找到你的 Apex 队友', path: HOME_PATH };
}

// 招募中的信息带上模式、服务器和缺少人数；已失效的仍可转发，打开后显示状态说明
function sharePost(post) {
  if (!post || !post.id) return shareHome();
  const summary = [post.modeName, post.serverName].filter(Boolean).join(' · ');
  const title = post.status === 'RECRUITING' ? `${summary} ${post.remainingText}，来组队！` : `${summary} 组队信息`;
  return { title, path: `/pages/detail/detail?id=${encodeURIComponent(post.id)}` };
}

module.exports = { shareHome, sharePost };
