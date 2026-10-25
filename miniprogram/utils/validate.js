// 发布/编辑/申请表单的初步校验。后端会做最终校验，这里只为及时提示用户。
const DEFAULT_LIMITS = {
  maxPlayers: 3,
  gameIdMaxLength: 64,
  noteMaxLength: 100,
  applyMessageMaxLength: 50,
};

const FORM_FIELDS = ['modeCode', 'rankCode', 'serverCode', 'currentPlayers', 'gameId', 'note'];

function limitsOf(config) {
  return Object.assign({}, DEFAULT_LIMITS, (config && config.limits) || {});
}

// 可用于发布和筛选的选项：启用的、按 order 排序
function activeOptions(options) {
  return (options || []).filter((o) => o.enabled !== false).sort((a, b) => (a.order || 0) - (b.order || 0));
}

// 队伍人数上限按游戏模式决定；未选择模式时使用全局上限
function maxPlayersFor(config, modeCode) {
  const mode = ((config && config.modes) || []).find((m) => m.code === modeCode);
  return (mode && mode.maxPlayers) || limitsOf(config).maxPlayers;
}

function allowedCounts(formMode, config, modeCode) {
  const total = maxPlayersFor(config, modeCode);
  const counts = [];
  // 新建时队伍不能已满；编辑时允许改为满员
  const max = formMode === 'edit' ? total : total - 1;
  for (let i = 1; i <= max; i++) counts.push(i);
  return counts;
}

// 长度按 Unicode 码点计算，与后端口径一致（BE-03）
function codePointLength(str) {
  return Array.from(str).length;
}

function isActiveCode(options, code) {
  return activeOptions(options).some((o) => o.code === code);
}

// 返回清洗后的值与按字段的错误信息；errors 为空对象表示通过
function validatePostForm(input, formMode, config) {
  const limits = limitsOf(config);
  const values = {
    modeCode: input.modeCode || '',
    rankCode: input.rankCode || '',
    serverCode: input.serverCode || '',
    currentPlayers: Number(input.currentPlayers) || 0,
    gameId: String(input.gameId || '').trim(),
    note: String(input.note || '').trim(),
  };
  const errors = {};

  if (!values.modeCode) errors.modeCode = '请选择游戏模式';
  else if (config && !isActiveCode(config.modes, values.modeCode)) errors.modeCode = '游戏模式无效，请重新选择';

  if (!values.rankCode) errors.rankCode = '请选择目标段位';
  else if (config && !isActiveCode(config.ranks, values.rankCode)) errors.rankCode = '目标段位无效，请重新选择';

  if (!values.serverCode) errors.serverCode = '请选择服务器';
  else if (config && !isActiveCode(config.servers, values.serverCode)) errors.serverCode = '服务器无效，请重新选择';

  const counts = allowedCounts(formMode, config, values.modeCode);
  if (counts.indexOf(values.currentPlayers) === -1) {
    errors.currentPlayers = `当前人数只能是 ${counts.join('、')}`;
  }

  if (!values.gameId) errors.gameId = '请填写游戏 ID';
  else if (codePointLength(values.gameId) > limits.gameIdMaxLength) errors.gameId = `游戏 ID 最多 ${limits.gameIdMaxLength} 个字符`;

  if (codePointLength(values.note) > limits.noteMaxLength) errors.note = `备注最多 ${limits.noteMaxLength} 个字符`;

  return { values, errors };
}

function validateApplyForm(input, config) {
  const limits = limitsOf(config);
  const values = {
    gameId: String(input.gameId || '').trim(),
    message: String(input.message || '').trim(),
  };
  const errors = {};
  if (!values.gameId) errors.gameId = '请填写你的游戏 ID，方便房主邀请你';
  else if (codePointLength(values.gameId) > limits.gameIdMaxLength) errors.gameId = `游戏 ID 最多 ${limits.gameIdMaxLength} 个字符`;
  if (codePointLength(values.message) > limits.applyMessageMaxLength) errors.message = `留言最多 ${limits.applyMessageMaxLength} 个字符`;
  return { values, errors };
}

module.exports = {
  DEFAULT_LIMITS,
  FORM_FIELDS,
  limitsOf,
  activeOptions,
  maxPlayersFor,
  allowedCounts,
  codePointLength,
  validatePostForm,
  validateApplyForm,
};
