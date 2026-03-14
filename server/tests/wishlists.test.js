const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { app } = require('../index');
const serverCrypto = require('../crypto');
const db = require('../db');

async function withServer(run) {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function postWishlist(baseUrl, entityId, token, body) {
  const response = await fetch(`${baseUrl}/entity/${entityId}/wishlists`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  return { status: response.status, json };
}

test('wishlist endpoint accepts legacy wishText payload', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalGetSession = db.getSession;
  const originalSaveEntityWishlist = db.saveEntityWishlist;

  process.env.DATABASE_URL = 'postgres://unit-test';

  const entityId = 'entity-wishlist-legacy';
  const token = serverCrypto.createSessionToken(entityId).token;
  const savedPayloads = [];

  db.getSession = async () => ({ token, entity_id: entityId });
  db.saveEntityWishlist = async (_entityId, payload) => {
    savedPayloads.push({ _entityId, payload });
    return { id: savedPayloads.length, entityId: _entityId, ...payload };
  };

  try {
    await withServer(async (baseUrl) => {
      const { status, json } = await postWishlist(baseUrl, entityId, token, {
        wishText: '  Learn shell guard combos  ',
        dreamContext: '  Defend reef sectors  '
      });

      assert.equal(status, 200);
      assert.equal(json.success, true);
      assert.equal(json.createdCount, 1);
      assert.equal(json.item.wishText, 'Learn shell guard combos');
      assert.equal(json.items.length, 1);
      assert.equal(savedPayloads.length, 1);
      assert.equal(savedPayloads[0]._entityId, entityId);
      assert.deepEqual(savedPayloads[0].payload, {
        wishText: 'Learn shell guard combos',
        dreamContext: 'Defend reef sectors',
        status: 'current'
      });
    });
  } finally {
    db.getSession = originalGetSession;
    db.saveEntityWishlist = originalSaveEntityWishlist;
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});

test('wishlist endpoint accepts wishes[] batch payload and persists each wish', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalGetSession = db.getSession;
  const originalSaveEntityWishlist = db.saveEntityWishlist;

  process.env.DATABASE_URL = 'postgres://unit-test';

  const entityId = 'entity-wishlist-batch';
  const token = serverCrypto.createSessionToken(entityId).token;
  const savedPayloads = [];

  db.getSession = async () => ({ token, entity_id: entityId });
  db.saveEntityWishlist = async (_entityId, payload) => {
    savedPayloads.push({ _entityId, payload });
    return { id: savedPayloads.length, entityId: _entityId, ...payload };
  };

  const longWish = 'x'.repeat(1300);

  try {
    await withServer(async (baseUrl) => {
      const { status, json } = await postWishlist(baseUrl, entityId, token, {
        wishes: ['  first wish  ', '', '   ', longWish],
        status: '  queued ',
        dreamContext: '  Daily loop  '
      });

      assert.equal(status, 200);
      assert.equal(json.success, true);
      assert.equal(json.createdCount, 2);
      assert.equal(json.items.length, 2);
      assert.equal(savedPayloads.length, 2);

      assert.deepEqual(savedPayloads[0].payload, {
        wishText: 'first wish',
        dreamContext: 'Daily loop',
        status: 'queued'
      });

      assert.equal(savedPayloads[1].payload.wishText.length, 1200);
      assert.equal(savedPayloads[1].payload.wishText, longWish.slice(0, 1200));
      assert.equal(savedPayloads[1].payload.dreamContext, 'Daily loop');
      assert.equal(savedPayloads[1].payload.status, 'queued');
    });
  } finally {
    db.getSession = originalGetSession;
    db.saveEntityWishlist = originalSaveEntityWishlist;
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});

test('wishlist endpoint rejects empty or invalid payloads', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalGetSession = db.getSession;
  const originalSaveEntityWishlist = db.saveEntityWishlist;

  process.env.DATABASE_URL = 'postgres://unit-test';

  const entityId = 'entity-wishlist-invalid';
  const token = serverCrypto.createSessionToken(entityId).token;

  db.getSession = async () => ({ token, entity_id: entityId });
  let saveCallCount = 0;
  db.saveEntityWishlist = async () => {
    saveCallCount += 1;
    return { id: saveCallCount };
  };

  try {
    await withServer(async (baseUrl) => {
      const missingLegacy = await postWishlist(baseUrl, entityId, token, { dreamContext: 'x' });
      assert.equal(missingLegacy.status, 400);
      assert.equal(missingLegacy.json.success, false);
      assert.match(missingLegacy.json.error, /wishText is required/);

      const invalidBatch = await postWishlist(baseUrl, entityId, token, { wishes: 'not-an-array' });
      assert.equal(invalidBatch.status, 400);
      assert.equal(invalidBatch.json.success, false);
      assert.match(invalidBatch.json.error, /wishes must be an array/i);

      const emptyBatch = await postWishlist(baseUrl, entityId, token, { wishes: ['', '   '] });
      assert.equal(emptyBatch.status, 400);
      assert.equal(emptyBatch.json.success, false);
      assert.match(emptyBatch.json.error, /at least one non-empty wish/i);

      assert.equal(saveCallCount, 0);
    });
  } finally {
    db.getSession = originalGetSession;
    db.saveEntityWishlist = originalSaveEntityWishlist;
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});
