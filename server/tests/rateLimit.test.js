const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, createEntityRateLimiter } = require('../rateLimit');

function createRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('createRateLimiter allows request and sets headers in memory mode', async () => {
  const middleware = createRateLimiter('chat', {}, null);
  const req = { ip: '127.0.0.1', body: {} };
  const res = createRes();
  let nextCalled = false;

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-RateLimit-Limit'], '12');
  assert.match(res.headers['X-RateLimit-Remaining'], /\d+/);
  assert.match(res.headers['X-RateLimit-Reset'], /\d+/);
});

test('createRateLimiter blocks once limit is exceeded', async () => {
  const middleware = createRateLimiter('summary_check', {}, null);
  const req = { ip: '10.0.0.2', body: {} };

  for (let i = 0; i < 30; i++) {
    const res = createRes();
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `request ${i + 1} should pass`);
  }

  const blockedRes = createRes();
  let blockedNextCalled = false;
  await middleware(req, blockedRes, () => { blockedNextCalled = true; });

  assert.equal(blockedNextCalled, false);
  assert.equal(blockedRes.statusCode, 429);
  assert.equal(blockedRes.body.success, false);
  assert.equal(blockedRes.body.error, 'Rate limit exceeded');
});

test('createEntityRateLimiter uses entityId first', async () => {
  const middleware = createEntityRateLimiter('move', null);
  const req = {
    ip: '8.8.8.8',
    entityId: 'session-entity',
    body: { entityId: 'body-entity' }
  };
  const res = createRes();
  let nextCalled = false;

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-RateLimit-Limit'], '120');
});
