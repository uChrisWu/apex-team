// Print the labelled mock options as a development-only PostgreSQL seed.
const { TEST_CONFIG } = require('../miniprogram/services/mock/fixtures');

const ordered = (items) => items.map((item, index) => ({ ...item, order: index }));
const config = JSON.stringify({
  modes: ordered(TEST_CONFIG.modes),
  ranks: ordered(TEST_CONFIG.ranks),
  servers: ordered(TEST_CONFIG.servers),
  limits: TEST_CONFIG.limits,
}).replace(/'/g, "''");
process.stdout.write(`INSERT INTO apex_private.app_config (id, data)
VALUES ('main', '${config}'::jsonb)
ON CONFLICT (id) DO NOTHING;\n`);
