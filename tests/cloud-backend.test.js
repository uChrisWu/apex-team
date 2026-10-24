const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('../cloudfunctions/apex/rpc-service');
const { TEST_CONFIG } = require('../miniprogram/services/mock/fixtures');

const when = new Date('2026-10-24T12:00:00.000Z');
const postId = `p_${'a'.repeat(64)}`;
const card = {
  id: postId, modeCode: 'RANKED', rankCode: 'ANY', serverCode: 'TEST_TOKYO',
  currentPlayers: 1, maxPlayers: 3, remainingSlots: 2, note: '', status: 'RECRUITING',
  createdAt: '2026-10-24T12:00:00+00:00', expiresAt: '2026-10-24T14:00:00+00:00', version: 1,
};

function backend(respond) {
  const calls = [];
  const rpc = async (action, openid, payload, now) => {
    calls.push({ action, openid, payload, now });
    if (action === 'getConfig') return { code: 'OK', data: TEST_CONFIG };
    return respond(action, payload);
  };
  const log = { info() {}, error() {} };
  return { service: createBackend({ rpc, now: () => when, log }), calls };
}

test('rejects server-owned fields and invalid input before publishing', async () => {
  const { service, calls } = backend(() => { throw new Error('unexpected RPC'); });
  const result = await service.handle({ action: 'createPost', payload: {
    modeCode: 'RANKED', rankCode: 'ANY', serverCode: 'TEST_TOKYO', currentPlayers: 1,
    gameId: 'private', requestId: 'req-1', ownerId: 'forged',
  } }, 'wechat-a');
  assert.equal(result.code, 'VALIDATION_ERROR');
  assert.equal(calls.length, 0);
});

test('pagination cursor is tied to filters and normalized to UTC', async () => {
  const { service, calls } = backend(() => ({ code: 'OK', data: {
    items: [card], hasMore: true, nextPosition: { t: card.createdAt, id: postId },
  } }));
  const first = await service.handle({ action: 'listPosts', payload: { modeCode: 'RANKED', limit: 100 } }, null);
  assert.equal(first.code, 'OK');
  assert.equal(first.data.items[0].createdAt, '2026-10-24T12:00:00.000Z');
  assert.equal(calls[1].payload.limit, 50);
  const next = await service.handle({ action: 'listPosts', payload: {
    modeCode: 'RANKED', cursor: first.data.nextCursor,
  } }, null);
  assert.equal(next.code, 'OK');
  assert.equal(calls[3].payload.cursorId, postId);
  assert.equal(calls[3].payload.cursorTime, '2026-10-24T12:00:00.000Z');
  const wrongFilter = await service.handle({ action: 'listPosts', payload: {
    modeCode: 'TRIOS', cursor: first.data.nextCursor,
  } }, null);
  assert.equal(wrongFilter.code, 'VALIDATION_ERROR');
  assert.equal(calls.length, 5);
});

test('rejects malformed cursors and unknown filter values', async () => {
  const { service, calls } = backend(() => { throw new Error('unexpected list RPC'); });
  for (const payload of [{ cursor: 'garbage' }, { cursor: '' }, { modeCode: 'not-a-mode' }, { remainingSlots: 3 }]) {
    const result = await service.handle({ action: 'listPosts', payload }, null);
    assert.equal(result.code, 'VALIDATION_ERROR');
  }
  assert.equal(calls.length, 4);
});

test('preserves database business errors and hides transport failures', async () => {
  const denied = backend(() => ({ code: 'FORBIDDEN', message: '只有发布者可以操作' }));
  const result = await denied.service.handle({ action: 'closePost', payload: { postId, version: 1 } }, 'wechat-b');
  assert.equal(result.code, 'FORBIDDEN');
  const failed = backend(() => { throw new Error('connection details'); });
  const error = await failed.service.handle({ action: 'getContact', payload: { postId } }, 'wechat-a');
  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.equal(error.message.includes('connection details'), false);
});

test('create retries keep the client request ID', async () => {
  const { service, calls } = backend(() => ({ code: 'OK', data: { id: postId, status: 'RECRUITING', version: 1 } }));
  const payload = { modeCode: 'RANKED', rankCode: 'ANY', serverCode: 'TEST_TOKYO',
    currentPlayers: 1, gameId: 'secret', requestId: 'retry-1' };
  const first = await service.handle({ action: 'createPost', payload }, 'wechat-a');
  const retry = await service.handle({ action: 'createPost', payload }, 'wechat-a');
  assert.equal(first.requestId, 'retry-1');
  assert.deepEqual(first.data, retry.data);
  assert.equal(calls.length, 2);
});
