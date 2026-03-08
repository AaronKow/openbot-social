const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { worldState, __testHooks } = require('../index');

test('refillMapObjects fills missing map object targets including algae pallets', async () => {
  worldState.objects.clear();

  worldState.objects.set('rock-1', {
    id: 'rock-1',
    type: 'rock',
    position: { x: 10, y: 0, z: 10 },
    data: { radius: 1.3 }
  });

  const targetTotal = Object.values(__testHooks.MAP_OBJECT_TARGETS).reduce((sum, n) => sum + n, 0);
  const refillResult = await __testHooks.refillMapObjects({ persist: false });

  assert.equal(worldState.objects.size, targetTotal);
  assert.equal(refillResult.newObjects, targetTotal - 1);
  assert.equal(refillResult.refilledPallets, 0);

  const byType = { rock: 0, kelp: 0, seaweed: 0, algae_pallet: 0 };
  for (const object of worldState.objects.values()) {
    if (byType[object.type] !== undefined) {
      byType[object.type] += 1;
    }
  }

  assert.equal(byType.rock, __testHooks.MAP_OBJECT_TARGETS.rock);
  assert.equal(byType.kelp, __testHooks.MAP_OBJECT_TARGETS.kelp);
  assert.equal(byType.seaweed, __testHooks.MAP_OBJECT_TARGETS.seaweed);
  assert.equal(byType.algae_pallet, __testHooks.MAP_OBJECT_TARGETS.algae_pallet);
});
