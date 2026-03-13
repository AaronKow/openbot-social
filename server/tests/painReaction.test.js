const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const { worldState, __testHooks } = require('../index');

function createAgent(id, name = id) {
  return {
    id,
    name,
    position: { x: 50, y: 0, z: 50 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    state: 'idle',
    lastAction: null,
    lastUpdate: Date.now(),
    entityId: id,
    inventory: { rock: 0, kelp: 0, seaweed: 0 },
    skills: {},
    expansionCooldownUntilTick: 0,
    energy: 100,
    sleeping: false,
    reputation: 0,
    eventProgress: {},
    painUntilTick: 0,
    lastPainAtTick: 0,
    lastPainSourceType: null,
    lastPainDamage: 0,
    lastPainMessageAt: 0
  };
}

test('applyCombatDamageToAgent triggers pain reaction and retreat', () => {
  const agent = createAgent('pain-agent', 'Pain Agent');
  worldState.tick = 120;
  worldState.chatMessages = [];
  worldState.agentChangeHistory.clear();

  const dealt = __testHooks.applyCombatDamageToAgent(agent, 12, 'octopus', {
    sourcePosition: { x: 45, y: 0, z: 50 }
  });

  assert.ok(dealt > 0);
  assert.equal(agent.state, 'hurt');
  assert.equal(agent.lastAction?.type, 'pain_react');
  assert.equal(agent.lastPainSourceType, 'octopus');
  assert.ok(Number(agent.painUntilTick) > worldState.tick);
  assert.ok(Number(agent.position.x) > 50);
});

test('applyHazardZonePainTick damages agents inside active hazard zone', () => {
  const agent = createAgent('hazard-pain-agent', 'Hazard Agent');
  agent.position = { x: 20, y: 0, z: 20 };
  worldState.tick = 240;
  worldState.chatMessages = [];
  worldState.agentChangeHistory.clear();
  worldState.agents.clear();
  worldState.agents.set(agent.id, agent);
  worldState.rotatingEvents = [{
    id: 'evt-hazard-pain',
    type: 'hazard_zone',
    status: 'active',
    center: { x: 20, y: 0, z: 20 },
    radius: 9,
    objective: { action: 'defend' },
    participants: {},
    rewardsGranted: {},
    startedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    cooldownUntil: Date.now() + 60_000
  }];

  __testHooks.applyHazardZonePainTick(1.0);

  assert.ok(agent.energy < 100);
  assert.equal(agent.state, 'hurt');
  assert.equal(agent.lastPainSourceType, 'hazard_zone');
  assert.ok(Number(agent.painUntilTick) > worldState.tick);
});
