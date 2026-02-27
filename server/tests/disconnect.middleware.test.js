const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, worldState, getMemorySessions } = require('../index');
const serverCrypto = require('../crypto');

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('DELETE /disconnect/:agentId enforces auth and ownership', async () => {
  worldState.agents.clear();
  const sessions = getMemorySessions();
  sessions.clear();

  const ownerEntityId = 'entity-owner';
  const otherEntityId = 'entity-other';
  const agentId = 'agent-owned-by-owner';

  worldState.agents.set(agentId, {
    id: agentId,
    name: 'owner-agent',
    entityId: ownerEntityId
  });

  const ownerToken = serverCrypto.createSessionToken(ownerEntityId).token;
  sessions.set(ownerToken, {
    revoked: false,
    expires_at: new Date(Date.now() + 60_000).toISOString()
  });

  const otherToken = serverCrypto.createSessionToken(otherEntityId).token;
  sessions.set(otherToken, {
    revoked: false,
    expires_at: new Date(Date.now() + 60_000).toISOString()
  });

  await withServer(async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/disconnect/${agentId}`, { method: 'DELETE' });
    assert.equal(unauth.status, 401);

    const nonOwner = await fetch(`${baseUrl}/disconnect/${agentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${otherToken}` }
    });
    assert.equal(nonOwner.status, 403);
    assert.equal(worldState.agents.has(agentId), true);

    const owner = await fetch(`${baseUrl}/disconnect/${agentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { success: true });
    assert.equal(worldState.agents.has(agentId), false);
  });

  sessions.clear();
  worldState.agents.clear();
});
