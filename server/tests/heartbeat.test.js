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



test('POST /move allows movement onto expansion tile beyond base bounds', async () => {
  worldState.agents.clear();
  worldState.expansionTiles = [{ id: 'expansion-move', x: 101, z: 50 }];
  const sessions = getMemorySessions();
  sessions.clear();

  const entityId = 'entity-expanded-move';
  const agentId = 'agent-expanded-move';
  seedAgent(agentId, entityId, Date.now());
  const agent = worldState.agents.get(agentId);
  agent.position = { x: 99.5, y: 0, z: 50 };

  const token = seedSession(entityId);

  await withServer(async (baseUrl) => {
    const moveRes = await fetch(`${baseUrl}/move`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentId,
        position: { x: 101.3, y: 0, z: 50 }
      })
    });

    assert.equal(moveRes.status, 200);
    const payload = await moveRes.json();
    assert.equal(payload.success, true);
    assert.ok(worldState.agents.get(agentId).position.x > 100);
    assert.ok(worldState.agents.get(agentId).position.x <= 101.5);
  });

  worldState.expansionTiles = [];
  worldState.agents.clear();
  sessions.clear();
});

test('GET /world-state delta clamps limit to server max', async () => {
  worldState.agents.clear();
  worldState.agentChangeHistory.clear();
  worldState.tick = 12;
  worldState.deltaHistoryMinTick = 0;

  const changedAgentIds = [];
  for (let i = 0; i < 501; i += 1) {
    const agentId = `agent-limit-${i}`;
    changedAgentIds.push(agentId);
    seedAgent(agentId, `entity-limit-${i}`, Date.now());
  }

  worldState.agentChangeHistory.set(10, {
    changed: new Set(changedAgentIds),
    removed: new Set()
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/world-state?delta=true&sinceTick=9&limit=999`);
    assert.equal(res.status, 200);

    const payload = await res.json();
    assert.equal(payload.isDelta, true);
    assert.equal(payload.changedAgentsTotal, 501);
    assert.equal(payload.agents.length, 500);
    assert.equal(payload.deltaTruncated, true);
    assert.equal(payload.deltaLimitApplied, true);
  });

  worldState.agents.clear();
  worldState.agentChangeHistory.clear();
});

test('GET /world-state delta without limit keeps existing behavior', async () => {
  worldState.agents.clear();
  worldState.agentChangeHistory.clear();
  worldState.tick = 22;
  worldState.deltaHistoryMinTick = 0;

  const changedAgentIds = [];
  for (let i = 0; i < 3; i += 1) {
    const agentId = `agent-unlimited-${i}`;
    changedAgentIds.push(agentId);
    seedAgent(agentId, `entity-unlimited-${i}`, Date.now());
  }

  worldState.agentChangeHistory.set(20, {
    changed: new Set(changedAgentIds),
    removed: new Set()
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/world-state?delta=true&sinceTick=19`);
    assert.equal(res.status, 200);

    const payload = await res.json();
    assert.equal(payload.isDelta, true);
    assert.equal(payload.changedAgentsTotal, 3);
    assert.equal(payload.agents.length, 3);
    assert.equal(payload.deltaTruncated, false);
    assert.equal(payload.deltaLimitApplied, undefined);
  });

  worldState.agents.clear();
  worldState.agentChangeHistory.clear();
});



test('GET /world-state includes traversable bounds metadata including expansion tiles', async () => {
  worldState.agents.clear();
  worldState.expansionTiles = [{ id: 'expansion-world-state', x: 104, z: -2 }];

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/world-state`);
    assert.equal(res.status, 200);

    const payload = await res.json();
    assert.equal(typeof payload.traversableBounds, 'object');
    assert.equal(payload.traversableBounds.maxX, 104.5);
    assert.equal(payload.traversableBounds.minZ, -2.5);
    assert.equal(payload.traversableBounds.baseMaxX, 100);
    assert.equal(payload.traversableBounds.expansionTilesCount, 1);
  });

  worldState.expansionTiles = [];
});

test('GET /world-state and /status expose worldTime day/night metadata', async () => {
  worldState.agents.clear();
  worldState.agentChangeHistory.clear();
  worldState.tick = 0;
  worldState.worldCreatedAt = Date.now() - (2 * 60 * 1000);

  await withServer(async (baseUrl) => {
    const worldRes = await fetch(`${baseUrl}/world-state`);
    assert.equal(worldRes.status, 200);
    const worldPayload = await worldRes.json();
    assert.equal(typeof worldPayload.worldTime, 'object');
    assert.ok(worldPayload.worldTime.day >= 1);
    assert.equal(typeof worldPayload.worldTime.timeHours, 'number');
    assert.ok(['night', 'morning', 'day', 'dusk'].includes(worldPayload.worldTime.dayPhase));
    assert.ok(worldPayload.worldTime.cycleSeconds >= 60);

    const statusRes = await fetch(`${baseUrl}/status`);
    assert.equal(statusRes.status, 200);
    const statusPayload = await statusRes.json();
    assert.equal(typeof statusPayload.worldTime, 'object');
    assert.ok(['night', 'morning', 'day', 'dusk'].includes(statusPayload.worldTime.dayPhase));
  });
});
