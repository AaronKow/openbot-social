const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const { worldState, __testHooks } = require('../index');

const {
  applyQueueAction,
  applyActionRewardAndPressure,
  noteRuntimeAction,
  noteRuntimeCounter,
  getRuntimeTelemetryRecord,
  getInMemoryWorldBehaviorMetricsByDay,
  getDailyFrontierContracts,
  deriveMissionAwarePairingHints,
  noteRecommendationRuntimeEvent,
  getAggregatedRecommendationRuntimeMetrics,
  isEntityUnderChatGuardrail,
  runtimeDailyTelemetry,
  recommendationRuntimeStats
} = __testHooks;

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
    energy: 100,
    sleeping: false,
    reputation: 0,
    updatedAtTick: 0,
    skills: {
      scout: { level: 1, xp: 0, cooldown: 0 },
      forage: { level: 1, xp: 0, cooldown: 0 },
      shellGuard: { level: 1, xp: 0, cooldown: 0 },
      builder: { level: 1, xp: 0, cooldown: 0 }
    }
  };
}

test.beforeEach(() => {
  worldState.agents.clear();
  worldState.expansionTiles = [];
  worldState.objects.clear();
  runtimeDailyTelemetry.clear();
  recommendationRuntimeStats.clear();
});

test('reward pressure tracks objective chain and raises objective gate for stationary social loops', () => {
  const agent = createAgent('policy-a', 'policy-a', { x: 0, y: 0, z: 0 });

  applyActionRewardAndPressure(agent, 'move', { displacement: 1.4 });
  const repAfterMove = Number(agent.reputation || 0);
  assert.equal(agent.objectiveChain, 1);
  assert.equal(agent.objectiveStreak, 1);
  assert.equal(agent.lastMeaningfulAction, 'move');
  assert.ok(repAfterMove >= 1);

  applyActionRewardAndPressure(agent, 'harvest', { displacement: 0.2 });
  assert.equal(agent.objectiveChain, 2);
  assert.equal(agent.objectiveStreak, 2);
  assert.ok(Number(agent.reputation || 0) > repAfterMove);

  for (let i = 0; i < 12; i += 1) {
    noteRuntimeAction(agent.entityId, 'chat');
    noteRuntimeCounter(agent.entityId, 'chatWithoutDisplacement', 1);
  }
  agent.stationarySocialStreak = 1;
  applyActionRewardAndPressure(agent, 'chat', { displacement: 0.0 });

  assert.equal(isEntityUnderChatGuardrail(agent.entityId), true);
  assert.equal(agent.objectiveGateRequired, true);
});

test('queue talk is skipped when objective-required guardrail is active', () => {
  const agent = createAgent('policy-b', 'policy-b', { x: 4, y: 0, z: 4 });
  agent.objectiveGateRequired = true;
  worldState.agents.set(agent.id, agent);

  applyQueueAction(agent, { type: 'talk', message: 'still chatting', requiredTicks: 1 });

  assert.equal(agent.lastAction?.type, 'talk');
  assert.equal(agent.lastAction?.skipped, true);
  assert.equal(agent.lastAction?.reason, 'objective_required_by_guardrail');
});

test('in-memory world behavior metrics include objective share pressure inputs', () => {
  const entityId = 'entity-policy-metrics';
  noteRuntimeAction(entityId, 'chat');
  noteRuntimeAction(entityId, 'chat');
  noteRuntimeAction(entityId, 'move');
  noteRuntimeAction(entityId, 'harvest');
  noteRuntimeCounter(entityId, 'chatWithoutDisplacement', 1);
  noteRuntimeCounter(entityId, 'expansionCount', 3);
  noteRuntimeCounter(entityId, 'distanceTraveled', 10);

  const record = getRuntimeTelemetryRecord(entityId);
  assert.ok(record);
  const rows = getInMemoryWorldBehaviorMetricsByDay(1);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.expansionCount, 3);
  assert.equal(row.distanceTraveled, 10);
  assert.equal(row.socialOnlyActionRatio, 0.5);
  assert.equal(row.idleChatRatio, 0.5);
});

test('daily frontier contracts are generated with zones, targets, and bonuses', () => {
  worldState.expansionTiles = [
    { id: 'tile-a', x: 0, z: 0 },
    { id: 'tile-b', x: 1, z: 0 }
  ];
  worldState.objects.set('rock-a', { id: 'rock-a', type: 'rock', position: { x: 12, z: 12 } });
  worldState.objects.set('kelp-a', { id: 'kelp-a', type: 'kelp', position: { x: -10, z: -14 } });

  const contracts = getDailyFrontierContracts(3);
  assert.ok(Array.isArray(contracts));
  assert.ok(contracts.length >= 1 && contracts.length <= 3);
  for (const contract of contracts) {
    assert.match(String(contract.zone || ''), /^sector-\d-\d$/);
    assert.equal(Number.isFinite(Number(contract.target?.x)), true);
    assert.equal(Number.isFinite(Number(contract.target?.z)), true);
    assert.ok(Number(contract.bonusMultiplier || 0) >= 1);
  }
});

test('mission-aware pairing hints prefer complementary builder/forager roles near frontier', () => {
  const requester = createAgent('pair-requester', 'pair-requester', { x: 0, y: 0, z: 0 });
  requester.entityId = 'entity-requester';
  requester.skills.builder.level = 5;
  requester.skills.forage.level = 2;
  const forager = createAgent('pair-forager', 'pair-forager', { x: 12, y: 0, z: 12 });
  forager.entityId = 'entity-forager';
  forager.skills.builder.level = 1;
  forager.skills.forage.level = 6;
  worldState.agents.set(requester.id, requester);
  worldState.agents.set(forager.id, forager);

  const hints = deriveMissionAwarePairingHints('entity-requester', [
    { targetArea: { zone: 'sector-2-2', x: 10, z: 10 }, actionHint: { target: { x: 10, z: 10 } } }
  ]);

  assert.equal(hints.length, 1);
  assert.equal(hints[0].requesterRole, 'builder');
  assert.equal(hints[0].desiredRole, 'forager');
  assert.equal(hints[0].collaboratorEntityId, 'entity-forager');
});

test('recommendation runtime metrics aggregate acceptance/follow-through and mission lift', () => {
  noteRecommendationRuntimeEvent('entity-metric', 'expansion', 'shown');
  noteRecommendationRuntimeEvent('entity-metric', 'expansion', 'shown');
  noteRecommendationRuntimeEvent('entity-metric', 'expansion', 'accepted');
  noteRecommendationRuntimeEvent('entity-metric', 'exploration', 'follow_through', { missionLiftApplied: true });
  noteRecommendationRuntimeEvent('entity-metric', 'exploration', 'accepted');

  const metrics = getAggregatedRecommendationRuntimeMetrics(['expansion', 'exploration']);
  assert.equal(metrics.shownCount, 2);
  assert.equal(metrics.acceptedCount, 2);
  assert.equal(metrics.followThroughCount, 1);
  assert.equal(metrics.missionLiftCount, 1);
  assert.equal(metrics.acceptanceRate, 1);
  assert.equal(metrics.followThroughRate, 0.5);
  assert.equal(metrics.missionLiftPerFollowThrough, 1);
});
