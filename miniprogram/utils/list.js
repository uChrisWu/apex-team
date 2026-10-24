// 分页合并时按记录 ID 去重，保留先出现的
function mergeUnique(existing, incoming) {
  const seen = {};
  existing.forEach((p) => {
    seen[p.id] = true;
  });
  return existing.concat(incoming.filter((p) => (seen[p.id] ? false : (seen[p.id] = true))));
}

module.exports = { mergeUnique };
