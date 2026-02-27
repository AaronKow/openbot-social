const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.NODE_ENV = 'test';

const { app, worldState, getMemorySessions, __testHooks } = require('../index');
const serverCrypto = require('../crypto');

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
  sessions.set(token, {
    revoked: false,
    expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  return token;
}

function seedAgent(agentId, entityId, lastUpdate) {
  worldState.agents.set(agentId, {
    id: agentId,
    name: `Agent-${agentId}`,
    entityId,
    position: { x: 0, y: 0, z: 0 },
    state: 'idle',
    lastAction: null,
    lastUpdate,
    updatedAtTick: 0,
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        position: this.position,
        state: this.state,
        lastAction: this.lastAction,
        lastUpdate: this.lastUpdate,
        entityId: this.entityId,
        updatedAtTick: this.updatedAtTick
      };
    }
  });
}

test('POST /agent/:agentId/heartbeat enforces auth and ownership', async () => {
  worldState.agents.clear();
  const sessions = getMemorySessions();
  sessions.clear();

  const ownerEntityId = 'entity-owner-heartbeat';
  const otherEntityId = 'entity-other-heartbeat';
  const agentId = 'agent-heartbeat';
  const oldLastUpdate = Date.now() - 240_000;
  seedAgent(agentId, ownerEntityId, oldLastUpdate);

  const ownerToken = seedSession(ownerEntityId);
  const otherToken = seedSession(otherEntityId);

  await withServer(async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/agent/${agentId}/heartbeat`, { method: 'POST' });
    assert.equal(unauth.status, 401);

    const nonOwner = await fetch(`${baseUrl}/agent/${agentId}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${otherToken}` }
    });
    assert.equal(nonOwner.status, 403);
    assert.equal(worldState.agents.get(agentId).lastUpdate, oldLastUpdate);

    const owner = await fetch(`${baseUrl}/agent/${agentId}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { success: true });
    assert.ok(worldState.agents.get(agentId).lastUpdate > oldLastUpdate);
  });

  sessions.clear();
  worldState.agents.clear();
});

test('GET /world-state no longer keeps stale agents alive', async () => {
  worldState.agents.clear();
  const sessions = getMemorySessions();
  sessions.clear();

  const entityId = 'entity-stale';
  const agentId = 'agent-stale';
  const staleLastUpdate = Date.now() - 240_000;
  seedAgent(agentId, entityId, staleLastUpdate);

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/world-state?agentId=${encodeURIComponent(agentId)}`);
    assert.equal(res.status, 200);

    await __testHooks.gameLoop();
    assert.equal(worldState.agents.has(agentId), false);
  });

  worldState.agents.clear();
});
