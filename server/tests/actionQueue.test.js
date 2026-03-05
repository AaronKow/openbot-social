const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQueueActions, createRuntimeQueue, MAX_QUEUE_ACTIONS, MAX_QUEUE_TOTAL_TICKS, MAX_TICKS_PER_ACTION } = require('../actionQueue');

process.env.NODE_ENV = 'test';
const { worldState, __testHooks } = require('../index');
const { applyQueueAction } = __testHooks;

function createAgent(id, name, position) {
  return {
    id,
    name,
    position: { ...position },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    state: 'idle',
    lastAction: null,
    connected: true,
    lastUpdate: Date.now(),
    entityId: `entity-${id}`,
    updatedAtTick: 0
  };
}

test('applyQueueAction move_to_agent moves toward target agent with bounded movement', () => {
  worldState.agents.clear();

  const mover = createAgent('agent-a', 'alpha', { x: 0, y: 0, z: 0 });
  const target = createAgent('agent-b', 'beta', { x: 40, y: 0, z: 40 });
  worldState.agents.set(mover.id, mover);
  worldState.agents.set(target.id, target);

  applyQueueAction(mover, { type: 'move_to_agent', agent_name: 'beta', requiredTicks: 1 });

  assert.equal(mover.state, 'moving');
  assert.equal(mover.lastAction.type, 'move_to_agent');
  assert.equal(mover.lastAction.agent_name, 'beta');
  assert.equal(mover.lastAction.targetAgentId, 'agent-b');

  const movedDistance = Math.sqrt(
    (mover.position.x * mover.position.x) +
    (mover.position.y * mover.position.y) +
    (mover.position.z * mover.position.z)
  );
  assert.ok(movedDistance > 0, 'expected mover to change position');
  assert.ok(movedDistance <= 5.00001, `expected movement to be clamped to max distance, got ${movedDistance}`);
});

test('applyQueueAction move_to_agent marks skipped action when target agent is missing', () => {
  worldState.agents.clear();

  const mover = createAgent('agent-c', 'gamma', { x: 10, y: 0, z: 10 });
  worldState.agents.set(mover.id, mover);
  const before = { ...mover.position };

  applyQueueAction(mover, { type: 'move_to_agent', agent_name: 'missing-agent', requiredTicks: 1 });

  assert.deepEqual(mover.position, before);
  assert.deepEqual(mover.lastAction, {
    type: 'move_to_agent',
    agent_name: 'missing-agent',
    skipped: true,
    reason: 'target_agent_not_found'
  });
});

test('normalizeQueueActions accepts valid action list', () => {
  const out = normalizeQueueActions([
    { type: 'jump', requiredTicks: 1 },
    { type: 'dance', requiredTicks: 3, style: 'funk' },
    { type: 'talk', requiredTicks: 1, message: 'hello reef' }
  ]);

  assert.equal(out.totalItems, 3);
  assert.equal(out.totalRequiredTicks, 5);
  assert.equal(out.actions[1].style, 'funk');
  assert.equal(out.actions[2].message, 'hello reef');
});

test('normalizeQueueActions rejects unsupported action', () => {
  assert.throws(() => normalizeQueueActions([{ type: 'fly' }]), /Unsupported action type/);
});

test('createRuntimeQueue initializes with first action tick budget', () => {
  const queue = createRuntimeQueue('lobster-1', [{ type: 'jump', requiredTicks: 2 }], 123);
  assert.equal(queue.entityId, 'lobster-1');
  assert.equal(queue.status, 'created');
  assert.equal(queue.remainingTicks, 2);
  assert.equal(queue.createdAtTick, 123);
});


test('normalizeQueueActions enforces queue limits', () => {
  const tooMany = Array.from({ length: MAX_QUEUE_ACTIONS + 1 }, () => ({ type: 'wait', requiredTicks: 1 }));
  assert.throws(() => normalizeQueueActions(tooMany), /Maximum/);

  const tooLongCount = Math.floor(MAX_QUEUE_TOTAL_TICKS / MAX_TICKS_PER_ACTION) + 1;
  const tooLong = Array.from({ length: tooLongCount }, () => ({ type: 'dance', requiredTicks: MAX_TICKS_PER_ACTION }));
  assert.throws(() => normalizeQueueActions(tooLong), /Total requiredTicks exceeds/);
});
