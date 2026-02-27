const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const { createEntityRouter } = require('../entityRoutes');

function createDbStub(overrides = {}) {
  return {
    entityExists: async () => false,
    entityNameExists: async () => false,
    getEntityByFingerprint: async () => null,
    createEntity: async () => {
      throw new Error('createEntity should be stubbed in test');
    },
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
  app.use(createEntityRouter(db));
  return app;
}

function generatePublicKeyPem() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'pem' });
}

test('POST /entity/create returns 409 when insert races on entity_id unique constraint', async () => {
  process.env.DATABASE_URL = 'postgres://example.test/db';

  const db = createDbStub({
    createEntity: async () => {
      const err = new Error('duplicate key value violates unique constraint "entities_entity_id_key"');
      err.code = '23505';
      err.constraint = 'entities_entity_id_key';
      throw err;
    }
  });

  const app = createApp(db);

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/entity/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: 'race_entity_1',
        entity_type: 'lobster',
        entity_name: 'race_entity_1',
        public_key: generatePublicKeyPem()
      })
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body, {
      success: false,
      error: 'entity_id already exists. Each entity must have a unique ID.'
    });
  });

  delete process.env.DATABASE_URL;
});

test('POST /entity/create keeps 500 for non-constraint insert failures', async () => {
  process.env.DATABASE_URL = 'postgres://example.test/db';

  const db = createDbStub({
    createEntity: async () => {
      throw new Error('database temporarily unavailable');
    }
  });

  const app = createApp(db);

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/entity/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: 'server_fail_1',
        entity_type: 'lobster',
        entity_name: 'server_fail_1',
        public_key: generatePublicKeyPem()
      })
    });

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, {
      success: false,
      error: 'Internal server error'
    });
  });

  delete process.env.DATABASE_URL;
});
