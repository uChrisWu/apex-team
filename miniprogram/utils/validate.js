// 发布/编辑表单的初步校验。后端会做最终校验，这里只为及时提示用户。
const DEFAULT_LIMITS = {
  maxPlayers: 3,
  gameIdMaxLength: 64,
  noteMaxLength: 100,
};

const FORM_FIELDS = ['modeCode', 'rankCode', 'serverCode', 'currentPlayers', 'gameId', 'note'];

function limitsOf(config) {
  return Object.assign({}, DEFAULT_LIMITS, (config && config.limits) || {});
}

function allowedCounts(mode, config) {
  const total = limitsOf(config).maxPlayers;
  const counts = [];
  // 新建时队伍不能已满；编辑时允许改为满员
  const max = mode === 'edit' ? total : total - 1;
  for (let i = 1; i <= max; i++) counts.push(i);
  return counts;
}

// 长度按 Unicode 码点计算，与后端口径一致（BE-03）
function codePointLength(str) {
  return Array.from(str).length;
}

function hasCode(options, code) {
  return (options || []).some((o) => o.code === code);
}

// 返回清洗后的值与按字段的错误信息；errors 为空对象表示通过
function validatePostForm(input, mode, config) {
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
  else if (config && !hasCode(config.modes, values.modeCode)) errors.modeCode = '游戏模式无效，请重新选择';

  if (!values.rankCode) errors.rankCode = '请选择目标段位';
  else if (config && !hasCode(config.ranks, values.rankCode)) errors.rankCode = '目标段位无效，请重新选择';

  if (!values.serverCode) errors.serverCode = '请选择服务器';
  else if (config && !hasCode(config.servers, values.serverCode)) errors.serverCode = '服务器无效，请重新选择';

  if (allowedCounts(mode, config).indexOf(values.currentPlayers) === -1) {
    errors.currentPlayers = mode === 'edit' ? '当前人数只能是 1、2 或 3' : '发布时当前人数只能是 1 或 2';
  }

  if (!values.gameId) errors.gameId = '请填写游戏 ID';
  else if (codePointLength(values.gameId) > limits.gameIdMaxLength) errors.gameId = `游戏 ID 最多 ${limits.gameIdMaxLength} 个字符`;

  if (codePointLength(values.note) > limits.noteMaxLength) errors.note = `备注最多 ${limits.noteMaxLength} 个字符`;

  return { values, errors };
}

module.exports = { DEFAULT_LIMITS, FORM_FIELDS, limitsOf, allowedCounts, codePointLength, validatePostForm };
