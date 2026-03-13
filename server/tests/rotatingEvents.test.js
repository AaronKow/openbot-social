const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const { worldState, __testHooks } = require('../index');

function createAgent(id, entityId) {
  return {
    id,
    name: id,
    position: { x: 50, y: 0, z: 50 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    state: 'idle',
    entityId,
    inventory: { rock: 0, kelp: 0, seaweed: 0 },
    skills: {
      scout: { level: 1, xp: 0, cooldown: 0 },
      forage: { level: 1, xp: 0, cooldown: 0 },
      shellGuard: { level: 1, xp: 0, cooldown: 0 },
      builder: { level: 1, xp: 0, cooldown: 0 }
    },
    reputation: 0
  };
}

test('updateRotatingEvents ensures one active event per rotating type', () => {
  worldState.rotatingEvents = [];
  __testHooks.updateRotatingEvents();

  const active = worldState.rotatingEvents.filter((event) => event.status === 'active');
  const types = new Set(active.map((event) => event.type));

  assert.equal(active.length, 3);
  assert.deepEqual(types, new Set(['hazard_zone', 'rescue_beacon', 'migration_signal']));
});

test('applyRotatingEventActionHooks grants reward bundle once per event participant', () => {
  const now = Date.now();
  worldState.rotatingEvents = [{
    id: 'evt-hazard-test',
    type: 'hazard_zone',
    status: 'active',
    center: { x: 50, y: 0, z: 50 },
    radius: 12,
    objective: { action: 'defend', description: 'defend area' },
    participants: {},
    rewardsGranted: {},
    startedAt: now,
    expiresAt: now + 30000,
    cooldownUntil: now + 60000
  }];

  const agent = createAgent('agent-event', 'entity-event');
  const resultsFirst = __testHooks.applyRotatingEventActionHooks(agent, 'defend', { position: agent.position });
  const resultsSecond = __testHooks.applyRotatingEventActionHooks(agent, 'defend', { position: agent.position });

  assert.equal(resultsFirst.length, 1);
  assert.equal(resultsSecond.length, 1);
  assert.ok(agent.reputation >= 3);
  assert.equal(agent.reputation, 3);
  assert.ok(agent.skills.shellGuard.xp > 0);
  const inventoryTotal = Object.values(agent.inventory).reduce((sum, value) => sum + Number(value || 0), 0);
  assert.ok(inventoryTotal >= 1);

  const event = worldState.rotatingEvents[0];
  assert.equal(event.participants['entity-event'], 2);
  assert.ok(event.rewardsGranted['entity-event']);
});

test('updateRotatingEvents moves active hazard_zone centers over time', () => {
  const now = Date.now();
  worldState.rotatingEvents = [{
    id: 'evt-hazard-move',
    type: 'hazard_zone',
    status: 'active',
    center: { x: 50, y: 0, z: 50 },
    radius: 9,
    objective: { action: 'defend', description: 'defend area' },
    participants: {},
    rewardsGranted: {},
    startedAt: now,
    expiresAt: now + 30000,
    cooldownUntil: now + 60000
  }];

  const initial = { ...worldState.rotatingEvents[0].center };

  for (let i = 0; i < 24; i += 1) {
    __testHooks.updateRotatingEvents();
  }

  const moved = worldState.rotatingEvents.find((event) => event.id === 'evt-hazard-move');
  assert.ok(moved);
  const dx = Math.abs(Number(moved.center.x) - Number(initial.x));
  const dz = Math.abs(Number(moved.center.z) - Number(initial.z));
  assert.ok((dx + dz) > 0.001);
});
