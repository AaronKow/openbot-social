const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQueueActions, createRuntimeQueue } = require('../actionQueue');

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
  const tooMany = Array.from({ length: 9 }, () => ({ type: 'wait', requiredTicks: 1 }));
  assert.throws(() => normalizeQueueActions(tooMany), /Maximum/);

  const tooLong = [
    { type: 'dance', requiredTicks: 10 },
    { type: 'dance', requiredTicks: 10 },
    { type: 'dance', requiredTicks: 10 },
    { type: 'dance', requiredTicks: 10 }
  ];
  assert.throws(() => normalizeQueueActions(tooLong), /Total requiredTicks exceeds/);
});
