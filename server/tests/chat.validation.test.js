const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { app, worldState, getMemorySessions } = require('../index');
const serverCrypto = require('../crypto');
const { MAX_CHAT_MESSAGE_LENGTH } = require('../chatMessage');
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

function seedSession(entityId) {
  const { token } = serverCrypto.createSessionToken(entityId);
  const sessions = getMemorySessions();
  sessions.clear();
  sessions.set(token, {
    revoked: false,
    expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  return token;
}

function seedAgent(agentId, entityId) {
  worldState.agents.clear();
  worldState.chatMessages = [];
  worldState.agents.set(agentId, {
    id: agentId,
    name: 'TestAgent',
    entityId,
    position: { x: 0, y: 0, z: 0 },
    state: 'idle',
    lastAction: null,
    lastUpdate: Date.now(),
    updatedAtTick: 0
  });
}



async function getChat(baseUrl, query = '') {
  const response = await fetch(`${baseUrl}/chat${query}`);
  const json = await response.json();
  return { status: response.status, json };
}

async function postChat(baseUrl, token, body) {
  const response = await fetch(`${baseUrl}/chat`, {
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

test('chat rejects empty message', async () => {
  const entityId = 'entity-empty';
  const agentId = 'agent-empty';
  const token = seedSession(entityId);
  seedAgent(agentId, entityId);

  await withServer(async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, token, { agentId, message: '   ' });
    assert.equal(status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /must not be empty/);
  });
});

test('chat rejects low-signal mention spam', async () => {
  const entityId = 'entity-lowsignal';
  const agentId = 'agent-lowsignal';
  const token = seedSession(entityId);
  seedAgent(agentId, entityId);

  await withServer(async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, token, { agentId, message: '@king-lobster yes??' });
    assert.equal(status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /low-signal/i);
  });
});

test('chat rejects oversized message', async () => {
  const entityId = 'entity-big';
  const agentId = 'agent-big';
  const token = seedSession(entityId);
  seedAgent(agentId, entityId);

  const tooLarge = 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1);

  await withServer(async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, token, { agentId, message: tooLarge });
    assert.equal(status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /exceeds max length/);
  });
});

test('chat rejects duplicate message burst from same agent', async () => {
  const entityId = 'entity-dup';
  const agentId = 'agent-dup';
  const token = seedSession(entityId);
  seedAgent(agentId, entityId);

  await withServer(async (baseUrl) => {
    const first = await postChat(baseUrl, token, {
      agentId,
      message: '@king-lobster I found an algae pallet near x:42 z:18'
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.success, true);

    const second = await postChat(baseUrl, token, {
      agentId,
      message: '@king-lobster I found an algae pallet near x:42 z:18'
    });
    assert.equal(second.status, 429);
    assert.equal(second.json.success, false);
    assert.match(second.json.error, /duplicate chat/i);
    assert.equal(typeof second.json.retryAfter, 'number');
    assert.ok(second.json.retryAfter > 0);
  });
});

test('chat accepts and persists normalized valid message', async () => {
  const entityId = 'entity-valid';
  const agentId = 'agent-valid';
  const token = seedSession(entityId);
  seedAgent(agentId, entityId);

  await withServer(async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, token, { agentId, message: '  hello reef  ' });
    assert.equal(status, 200);
    assert.equal(json.success, true);

    assert.equal(worldState.chatMessages.length, 1);
    assert.equal(worldState.chatMessages[0].message, 'hello reef');
    assert.equal(worldState.chatMessages[0].agentId, agentId);
  });
});


test('chat rejects invalid before query values', async () => {
  worldState.chatMessages = [];

  await withServer(async (baseUrl) => {
    for (const badBefore of ['abc', '-1', '0', '12.5']) {
      const { status, json } = await getChat(baseUrl, `?before=${encodeURIComponent(badBefore)}`);
      assert.equal(status, 400);
      assert.equal(json.success, false);
      assert.match(json.error, /Invalid `before`/);
    }
  });
});

test('chat rejects non-numeric limit for before pagination', async () => {
  worldState.chatMessages = [];

  await withServer(async (baseUrl) => {
    const { status, json } = await getChat(baseUrl, '?before=123&limit=ten');
    assert.equal(status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /Invalid `limit`/);
  });
});

test('chat clamps before pagination limit to safe range', async () => {
  worldState.chatMessages = [
    { id: 'msg-1', timestamp: 1, message: 'oldest' },
    { id: 'msg-2', timestamp: 2, message: 'older' },
    { id: 'msg-3', timestamp: 3, message: 'newer' }
  ];

  await withServer(async (baseUrl) => {
    const unlimitedLike = await getChat(baseUrl, '?before=10&limit=0');
    assert.equal(unlimitedLike.status, 200);
    assert.equal(unlimitedLike.json.messages.length, 1);
    assert.equal(unlimitedLike.json.hasMore, true);

    const capped = await getChat(baseUrl, '?before=10&limit=999');
    assert.equal(capped.status, 200);
    assert.equal(capped.json.messages.length, 3);
    assert.equal(capped.json.hasMore, false);
  });
});


test('chat rejects invalid since query values', async () => {
  worldState.chatMessages = [];

  await withServer(async (baseUrl) => {
    for (const badSince of ['abc', '-1', '12.5']) {
      const { status, json } = await getChat(baseUrl, `?since=${encodeURIComponent(badSince)}`);
      assert.equal(status, 400);
      assert.equal(json.success, false);
      assert.match(json.error, /Invalid `since`/);
    }
  });
});

test('chat since falls back to bounded in-memory results when DB mode is disabled', async () => {
  worldState.chatMessages = Array.from({ length: 150 }, (_, index) => ({
    id: `msg-${index + 1}`,
    timestamp: index + 1,
    message: `m-${index + 1}`
  }));

  await withServer(async (baseUrl) => {
    const { status, json } = await getChat(baseUrl, '?since=0');
    assert.equal(status, 200);
    assert.equal(json.messages.length, 100);
    assert.equal(json.messages[0].timestamp, 51);
    assert.equal(json.messages.at(-1).timestamp, 150);
  });
});


test('chat since uses DB canonical results when DATABASE_URL is set', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalGetChatMessagesAfter = db.getChatMessagesAfter;

  worldState.chatMessages = [
    { id: 'msg-90', timestamp: 90, message: 'ninety' },
    { id: 'msg-100', timestamp: 100, message: 'one-hundred' }
  ];

  process.env.DATABASE_URL = 'postgres://unit-test';
  let capturedSince = null;
  let capturedLimit = null;
  db.getChatMessagesAfter = async (sinceTimestamp, limit) => {
    capturedSince = sinceTimestamp;
    capturedLimit = limit;
    return [
      { timestamp: 95, message: 'db-95' },
      { timestamp: 101, message: 'db-101' }
    ];
  };

  try {
    await withServer(async (baseUrl) => {
      const { status, json } = await getChat(baseUrl, '?since=90&limit=9999');
      assert.equal(status, 200);
      assert.equal(capturedSince, 90);
      assert.equal(capturedLimit, 1000);
      assert.deepEqual(
        json.messages.map(m => m.timestamp),
        [95, 101]
      );
    });
  } finally {
    db.getChatMessagesAfter = originalGetChatMessagesAfter;
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});

test('chat before backfills non-system rows across bounded DB batches', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalGetChatMessagesBefore = db.getChatMessagesBefore;

  process.env.DATABASE_URL = 'postgres://unit-test';
  const capturedCalls = [];
  db.getChatMessagesBefore = async (beforeTimestamp, limit) => {
    capturedCalls.push({ beforeTimestamp, limit });

    if (beforeTimestamp === 101) {
      return Array.from({ length: 20 }, (_, idx) => {
        const timestamp = 81 + idx;
        return {
          timestamp,
          agentName: timestamp >= 99 ? 'reef-lobster' : 'system',
          message: `m-${timestamp}`
        };
      });
    }

    if (beforeTimestamp === 81) {
      return Array.from({ length: 20 }, (_, idx) => {
        const timestamp = 61 + idx;
        return {
          timestamp,
          agentName: 'reef-lobster',
          message: `m-${timestamp}`
        };
      });
    }

    return [];
  };

  try {
    await withServer(async (baseUrl) => {
      const { status, json } = await getChat(baseUrl, '?before=101&limit=20');
      assert.equal(status, 200);
      assert.equal(json.messages.length, 20);
      assert.deepEqual(
        capturedCalls,
        [
          { beforeTimestamp: 101, limit: 20 },
          { beforeTimestamp: 81, limit: 20 }
        ]
      );
      assert.deepEqual(
        json.messages.map(m => m.timestamp),
        [
          63, 64, 65, 66, 67, 68, 69, 70, 71, 72,
          73, 74, 75, 76, 77, 78, 79, 80, 99, 100
        ]
      );
      assert.equal(json.hasMore, true);
    });
  } finally {
    db.getChatMessagesBefore = originalGetChatMessagesBefore;
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});
