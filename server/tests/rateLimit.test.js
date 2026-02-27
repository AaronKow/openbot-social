const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, createEntityRateLimiter } = require('../rateLimit');
const db = require('../db');

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

test('checkRateLimit enforces maxRequests under parallel calls', async () => {
  const originalQuery = db.pool.query;
  const state = new Map();

  db.pool.query = async (sql, params) => {
    assert.ok(sql.includes('ON CONFLICT (identifier, action_type)'));

    const [identifier, actionType, now, maxRequests, windowSeconds] = params;
    const key = `${identifier}:${actionType}`;
    const windowMs = windowSeconds * 1000;
    const existing = state.get(key);

    if (!existing || (now.getTime() - existing.windowStart.getTime()) > windowMs) {
      const next = { requestCount: 1, windowStart: now };
      state.set(key, next);
      return { rows: [{ request_count: 1, window_start: now, allowed: true }] };
    }

    if (existing.requestCount >= maxRequests) {
      return {
        rows: [{
          request_count: existing.requestCount,
          window_start: existing.windowStart,
          allowed: false
        }]
      };
    }

    existing.requestCount += 1;
    state.set(key, existing);
    return {
      rows: [{
        request_count: existing.requestCount,
        window_start: existing.windowStart,
        allowed: true
      }]
    };
  };

  try {
    const maxRequests = 5;
    const attempts = 25;
    const checks = await Promise.all(
      Array.from({ length: attempts }, () => db.checkRateLimit('parallel-ip', 'chat', maxRequests, 60))
    );

    const allowedCount = checks.filter(r => r.allowed).length;
    const blockedCount = checks.filter(r => !r.allowed).length;

    assert.equal(allowedCount, maxRequests);
    assert.equal(blockedCount, attempts - maxRequests);
    assert.ok(checks.every(r => r.remaining >= 0));
    assert.ok(checks.every(r => r.resetAt instanceof Date));
  } finally {
    db.pool.query = originalQuery;
  }
});
