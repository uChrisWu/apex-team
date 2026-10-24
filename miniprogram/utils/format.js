// 时间统一以 UTC ISO 8601 传输，这里按设备时区展示
function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatPublishTime(iso, now = Date.now()) {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  const diffMin = Math.floor((now - t.getTime()) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;

  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const today = new Date(now);
  if (t.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now - 86400000);
  if (t.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  const md = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${hm}`;
  return t.getFullYear() === today.getFullYear() ? md : `${t.getFullYear()}-${md}`;
}

function formatRemaining(expiresIso, now = Date.now()) {
  const ms = new Date(expiresIso).getTime() - now;
  if (isNaN(ms) || ms <= 0) return '';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} 分钟后过期`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分钟后过期` : `${h} 小时后过期`;
}

module.exports = { formatPublishTime, formatRemaining };
