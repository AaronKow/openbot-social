const test = require('node:test');
const assert = require('node:assert/strict');

const reflectionSummary = require('../entityReflectionSummary');
const db = require('../db');

test('summarizeLocally returns no-activity fallback when there are no messages', () => {
  const result = reflectionSummary.summarizeLocally('lobster-1', '2026-01-01', []);

  assert.match(result.dailySummary, /no recorded conversation activity/);
  assert.equal(result.goalProgress.responsiveness, 0);
  assert.deepEqual(result.memoryUpdates.lessons, ['No interactions captured for this date']);
});

test('summarizeLocally computes partner and time window details', () => {
  const base = Date.parse('2026-01-03T09:15:00.000Z');
  const result = reflectionSummary.summarizeLocally('lobster-2', '2026-01-03', [
    { agentName: 'lobster-2', timestamp: base },
    { agentName: 'reef-friend', timestamp: base + 10 * 60 * 1000 },
    { agentName: 'reef-friend', timestamp: base + 20 * 60 * 1000 },
    { agentName: 'kelp-bot', timestamp: base + 30 * 60 * 1000 }
  ]);

  assert.match(result.dailySummary, /posted 4 message\(s\)/);
  assert.match(result.dailySummary, /09:15–09:45 UTC/);
  assert.equal(result.goalProgress.responsiveness, 20);
  assert.equal(result.goalProgress.socialBreadth, 2);
  assert.deepEqual(result.memoryUpdates.likelyPartners, ['reef-friend', 'kelp-bot']);
  assert.match(result.socialSummary, /2 unique partner\(s\)/);
});

test('checkAndSummarizeEntityReflections returns early when database is disabled', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const result = await reflectionSummary.checkAndSummarizeEntityReflections();
    assert.deepEqual(result, { triggered: false, message: 'Database not configured' });
  } finally {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test('checkAndSummarizeEntityReflections processes unsummarized days and saves summaries', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalGetUnsummarized = db.getUnsummarizedEntityDays;
  const originalGetMessages = db.getConversationMessagesForEntityDateRange;
  const originalSaveReflection = db.saveEntityDailyReflection;
  const originalGetRuntimeStat = db.getEntityRuntimeDailyStat;

  process.env.DATABASE_URL = 'postgres://unit-test';

  const saved = [];
  db.getUnsummarizedEntityDays = async () => [
    { entityId: 'lobster-a', date: '2026-01-05' },
    { entityId: 'lobster-b', date: new Date('2026-01-06T00:00:00.000Z') }
  ];
  db.getConversationMessagesForEntityDateRange = async (entityId) => {
    if (entityId === 'lobster-a') {
      return [{ agentName: 'friend-1', timestamp: Date.parse('2026-01-05T12:00:00.000Z') }];
    }
    return [];
  };
  db.saveEntityDailyReflection = async (...args) => {
    saved.push(args);
  };
  db.getEntityRuntimeDailyStat = async () => ({
    ticksTotal: 10,
    idleTicks: 3,
    socialActions: 2,
    objectiveActions: 5,
    uniqueSectors: 4,
    expansionTilesPlaced: 1,
    queueCompleted: 1,
    queueFailed: 0,
    queueExpired: 0,
    queueCancelled: 0,
    queueFailureReasons: {}
  });

  try {
    const result = await reflectionSummary.checkAndSummarizeEntityReflections();
    assert.deepEqual(result, {
      triggered: true,
      message: 'Summarized 1 entity-day(s) with local summarizer'
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0][0], 'lobster-a');
    assert.equal(saved[0][1], '2026-01-05');
    assert.equal(saved[0][3], 1);
  } finally {
    process.env.DATABASE_URL = originalDatabaseUrl;
    db.getUnsummarizedEntityDays = originalGetUnsummarized;
    db.getConversationMessagesForEntityDateRange = originalGetMessages;
    db.saveEntityDailyReflection = originalSaveReflection;
    db.getEntityRuntimeDailyStat = originalGetRuntimeStat;
  }
});


test('summarizeLocally carries runtime telemetry ratios and queue quality', () => {
  const base = Date.parse('2026-01-08T08:00:00.000Z');
  const telemetry = {
    idleTimeRatio: 0.62,
    socialActionRatio: 0.2,
    objectiveActionRatio: 0.8,
    uniqueSectors: 14,
    expansionTilesPlaced: 2,
    queueCompleted: 4,
    queueFailed: 1,
    queueExpired: 2,
    queueCancelled: 0,
    queueFailureReasons: { expired_tick_budget: 2, no_active_agent: 1 }
  };

  const result = reflectionSummary.summarizeLocally('lobster-telemetry', '2026-01-08', [
    { agentName: 'friend', timestamp: base }
  ], telemetry);

  assert.equal(result.goalProgress.idleTimeRatio, 0.62);
  assert.equal(result.goalProgress.socialActionRatio, 0.2);
  assert.equal(result.goalProgress.objectiveActionRatio, 0.8);
  assert.equal(result.goalProgress.uniqueSectorCoveragePerDay, 14);
  assert.equal(result.goalProgress.expansionTilesPlacedPerDay, 2);
  assert.equal(result.memoryUpdates.queueCompletionQuality.expired, 2);
  assert.equal(result.memoryUpdates.queueCompletionQuality.failureReasons.expired_tick_budget, 2);
});
