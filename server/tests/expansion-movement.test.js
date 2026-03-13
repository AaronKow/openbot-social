const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { worldState, __testHooks } = require('../index');

function resetExpansionState() {
  worldState.expansionTiles = [];
  worldState.mapExpansionLevel = 0;
}

test.afterEach(() => {
  resetExpansionState();
});

test('validatePosition clamps to base world bounds when expansion movement is disabled', () => {
  resetExpansionState();
  worldState.expansionTiles.push({ id: 'exp-1', x: 103, z: 100 });
  worldState.mapExpansionLevel = worldState.expansionTiles.length;

  const point = __testHooks.validatePosition({ x: 103.4, y: 2, z: 100 });

  assert.equal(point.x, 100);
  assert.equal(point.z, 100);
});

test('validatePosition allows traversal on expansion tiles when expansion movement is enabled', () => {
  resetExpansionState();
  worldState.expansionTiles.push({ id: 'exp-1', x: 103, z: 100 });
  worldState.mapExpansionLevel = worldState.expansionTiles.length;

  const point = __testHooks.validatePosition({ x: 103.4, y: 2, z: 100 }, { allowExpansion: true });

  assert.equal(point.x, 103.4);
  assert.equal(point.z, 100);
});

test('clampMovement respects max move distance while allowing expansion-enabled travel', () => {
  resetExpansionState();
  worldState.expansionTiles.push({ id: 'exp-1', x: 106, z: 100 });
  worldState.mapExpansionLevel = worldState.expansionTiles.length;

  const next = __testHooks.clampMovement(
    { x: 100, y: 0, z: 100 },
    { x: 106.5, y: 0, z: 100 },
    { allowExpansion: true }
  );

  assert.equal(next.x, 105.5);
  assert.equal(next.z, 100);
});

test('world boundary resolver expands only when expansion is included', () => {
  resetExpansionState();
  worldState.expansionTiles.push({ id: 'exp-west', x: -2, z: 50 });
  worldState.expansionTiles.push({ id: 'exp-east', x: 103, z: 102 });
  worldState.mapExpansionLevel = worldState.expansionTiles.length;

  const base = __testHooks.resolveNavigableBounds({ includeExpansion: false });
  const expanded = __testHooks.resolveNavigableBounds({ includeExpansion: true });

  assert.deepEqual(base, { minX: 0, maxX: 100, minZ: 0, maxZ: 100 });
  assert.equal(expanded.minX, -2.5);
  assert.equal(expanded.maxX, 103.5);
  assert.equal(expanded.maxZ, 102.5);
});
