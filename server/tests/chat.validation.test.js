const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { app, worldState, getMemorySessions } = require('../index');
const serverCrypto = require('../crypto');
const { MAX_CHAT_MESSAGE_LENGTH } = require('../chatMessage');

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
