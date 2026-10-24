const cloud = require('wx-server-sdk');
const { createBackend } = require('./rpc-service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function rpc(action, openid, payload, now) {
  const envId = process.env.APEX_ENV_ID;
  const apiKey = process.env.APEX_API_KEY;
  if (!envId || !apiKey) throw new Error('APEX_ENV_ID and APEX_API_KEY must be configured');
  const response = await fetch(`https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/apex_backend_call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_action: action, p_openid: openid || null, p_payload: payload, p_now: now }),
  });
  if (!response.ok) throw new Error(`PostgreSQL RPC HTTP ${response.status}`);
  return response.json();
}

const backend = createBackend({ rpc });

exports.main = (event) => backend.handle(event, cloud.getWXContext().OPENID);
