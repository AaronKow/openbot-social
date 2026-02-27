const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const { requireSession, optionalSession, encryptIfAuthenticated } = require('../entityRoutes');
const serverCrypto = require('../crypto');

function createReq(overrides = {}) {
  return {
    headers: {},
    query: {},
    body: {},
    ...overrides
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    }
  };
}

test('requireSession rejects missing bearer token', async () => {
  const middleware = requireSession({}, () => new Map());
  const req = createReq();
  const res = createRes();
  let nextCalled = false;

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Bearer token required/);
});

test('requireSession accepts valid in-memory session and sets entity context', async () => {
  const tokenResult = serverCrypto.createSessionToken('entity-abc');
  const sessions = new Map([
    [tokenResult.token, { revoked: false, expires_at: new Date(Date.now() + 60_000).toISOString() }]
  ]);
  const middleware = requireSession({}, () => sessions);

  const req = createReq({ headers: { authorization: `Bearer ${tokenResult.token}` } });
  const res = createRes();
  let nextCalled = false;

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.entityId, 'entity-abc');
  assert.equal(req.sessionPayload.sub, 'entity-abc');
});

test('optionalSession does not reject invalid tokens', async () => {
  const middleware = optionalSession({}, () => new Map());
  const req = createReq({ headers: { authorization: 'Bearer invalid-token' } });
  const res = createRes();
  let nextCalled = false;

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.entityId, undefined);
});

test('encryptIfAuthenticated encrypts response payload when requested', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const entities = new Map([
    ['entity-1', { public_key: pubPem }]
  ]);

  const middleware = encryptIfAuthenticated({}, () => entities);
  const req = createReq({
    entityId: 'entity-1',
    headers: { 'x-encrypt-response': 'true' }
  });
  const res = createRes();

  await middleware(req, res, () => {});
  const out = await res.json({ ok: true, nested: { count: 2 } });

  assert.equal(out.encrypted, true);
  assert.ok(out.encryptedData);

  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(out.encryptedKey, 'base64')
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(out.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(out.authTag, 'base64'));
  let plaintext = decipher.update(out.encryptedData, 'base64', 'utf8');
  plaintext += decipher.final('utf8');

  assert.deepEqual(JSON.parse(plaintext), { ok: true, nested: { count: 2 } });
});

test('encryptIfAuthenticated falls back to plain json when encryption is disabled', async () => {
  const middleware = encryptIfAuthenticated({}, () => new Map());
  const req = createReq({ entityId: 'entity-1', query: { encrypt: 'false' } });
  const res = createRes();

  await middleware(req, res, () => {});
  const out = await res.json({ success: true });

  assert.deepEqual(out, { success: true });
});


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

test('authenticated route returns encrypted envelope when X-Encrypt-Response is true', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const entityId = 'entity-route-enc';
  const token = serverCrypto.createSessionToken(entityId).token;

  const sessions = new Map([
    [token, { revoked: false, expires_at: new Date(Date.now() + 60_000).toISOString() }]
  ]);
  const entities = new Map([
    [entityId, { public_key: pubPem }]
  ]);

  const app = express();
  app.use(requireSession({}, () => sessions));
  app.use(encryptIfAuthenticated({}, () => entities));
  app.get('/secure', (req, res) => res.json({ success: true, entityId: req.entityId }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/secure`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Encrypt-Response': 'true'
      }
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.encrypted, true);
    assert.ok(body.encryptedData);
    assert.ok(body.encryptedKey);
    assert.ok(body.iv);
    assert.ok(body.authTag);

    const aesKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      Buffer.from(body.encryptedKey, 'base64')
    );

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(body.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(body.authTag, 'base64'));
    let plaintext = decipher.update(body.encryptedData, 'base64', 'utf8');
    plaintext += decipher.final('utf8');

    assert.deepEqual(JSON.parse(plaintext), { success: true, entityId });
  });
});

test('same authenticated route returns plain JSON when X-Encrypt-Response header is absent', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const entityId = 'entity-route-plain';
  const token = serverCrypto.createSessionToken(entityId).token;

  const sessions = new Map([
    [token, { revoked: false, expires_at: new Date(Date.now() + 60_000).toISOString() }]
  ]);
  const entities = new Map([
    [entityId, { public_key: pubPem }]
  ]);

  const app = express();
  app.use(requireSession({}, () => sessions));
  app.use(encryptIfAuthenticated({}, () => entities));
  app.get('/secure', (req, res) => res.json({ success: true, entityId: req.entityId }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/secure`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { success: true, entityId });
  });
});

test('encryptIfAuthenticated does not double-wrap responses that are already encrypted envelopes', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const entityId = 'entity-double-wrap';
  const token = serverCrypto.createSessionToken(entityId).token;

  const sessions = new Map([
    [token, { revoked: false, expires_at: new Date(Date.now() + 60_000).toISOString() }]
  ]);
  const entities = new Map([
    [entityId, { public_key: pubPem }]
  ]);

  const envelope = {
    encrypted: true,
    encryptedData: 'ciphertext',
    encryptedKey: 'key',
    iv: 'iv',
    authTag: 'tag'
  };

  const app = express();
  app.use(requireSession({}, () => sessions));
  app.use(encryptIfAuthenticated({}, () => entities));
  app.get('/secure', (req, res) => res.json(envelope));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/secure`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Encrypt-Response': 'true'
      }
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, envelope);
  });
});
