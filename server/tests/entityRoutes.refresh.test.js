const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createEntityRouter } = require('../entityRoutes');
const serverCrypto = require('../crypto');

function createDbStub(overrides = {}) {
  return {
    getSession: async () => null,
    revokeSession: async () => {},
    createSession: async () => {},
    ...overrides
  };
}

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function createApp(db) {
  const app = express();
  app.use(express.json());
  const router = createEntityRouter(db);
  app.use(router);
  return { app, router };
}

test('POST /auth/refresh succeeds for valid active in-memory session token', async () => {
  delete process.env.DATABASE_URL;

  const { app, router } = createApp(createDbStub());

  const oldSession = serverCrypto.createSessionToken('entity-refresh-valid');
  router._memorySessions = new Map([
    [oldSession.token, {
      session_token: oldSession.token,
      entity_id: 'entity-refresh-valid',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked: false
    }]
  ]);

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldSession.token}` }
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.ok(body.session_token);
    assert.notEqual(body.session_token, oldSession.token);

    const oldStored = router._memorySessions.get(oldSession.token);
    const newStored = router._memorySessions.get(body.session_token);
    assert.equal(oldStored.revoked, true);
    assert.ok(newStored);
    assert.equal(newStored.revoked, false);
  });
});

test('POST /auth/refresh fails for revoked in-memory session token', async () => {
  delete process.env.DATABASE_URL;

  const { app, router } = createApp(createDbStub());

  const oldSession = serverCrypto.createSessionToken('entity-refresh-revoked');
  router._memorySessions = new Map([
    [oldSession.token, {
      session_token: oldSession.token,
      entity_id: 'entity-refresh-revoked',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked: true
    }]
  ]);

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldSession.token}` }
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Session not found or revoked');
  });
});

test('POST /auth/refresh fails for expired in-memory session token', async () => {
  delete process.env.DATABASE_URL;

  const { app, router } = createApp(createDbStub());

  const oldSession = serverCrypto.createSessionToken('entity-refresh-expired');
  router._memorySessions = new Map([
    [oldSession.token, {
      session_token: oldSession.token,
      entity_id: 'entity-refresh-expired',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      revoked: false
    }]
  ]);

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldSession.token}` }
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Session not found or revoked');
  });
});

test('POST /auth/refresh fails for unknown in-memory session token', async () => {
  delete process.env.DATABASE_URL;

  const { app, router } = createApp(createDbStub());

  const unknownToken = serverCrypto.createSessionToken('entity-refresh-unknown').token;
  router._memorySessions = new Map();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unknownToken}` }
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Session not found or revoked');
  });
});

test('POST /auth/refresh in DB mode requires getSession(oldToken) to exist', async () => {
  process.env.DATABASE_URL = 'postgres://example.test/db';

  let getSessionCalls = 0;
  let revokeSessionCalls = 0;
  let createSessionCalls = 0;
  const db = createDbStub({
    getSession: async () => {
      getSessionCalls += 1;
      return null;
    },
    revokeSession: async () => {
      revokeSessionCalls += 1;
    },
    createSession: async () => {
      createSessionCalls += 1;
    }
  });

  const { app } = createApp(db);
  const unknownToken = serverCrypto.createSessionToken('entity-refresh-db').token;

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unknownToken}` }
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Session not found or revoked');
  });

  assert.equal(getSessionCalls, 1);
  assert.equal(revokeSessionCalls, 0);
  assert.equal(createSessionCalls, 0);

  delete process.env.DATABASE_URL;
});
