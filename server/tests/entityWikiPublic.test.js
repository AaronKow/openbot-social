const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEntityWikiPublic } = require('../entityWikiPublic');

test('buildEntityWikiPublic returns null when entity does not exist', async () => {
  const fakeDb = {
    async getEntity() { return null; }
  };
  const worldState = { agents: new Map() };
  const out = await buildEntityWikiPublic('missing', worldState, fakeDb);
  assert.equal(out, null);
});

test('buildEntityWikiPublic returns complete bounded wiki payload', async () => {
  const now = Date.now();
  const fakeDb = {
    async getEntity(entityId) {
      return {
        entity_id: entityId,
        entity_name: entityId,
        entity_type: 'lobster',
        numeric_id: 11,
        created_at: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
      };
    },
    async getEntityInterests() {
      return [
        { interest: 'ocean politics', weight: 40 },
        { interest: 'deep-sea mysteries', weight: 35 },
        { interest: 'music', weight: 25 }
      ];
    },
    async getRecentEntityReflectionsPublic() {
      return [
        {
          date: '2026-02-24',
          dailySummary: 'Strong social day',
          goalProgress: { responsiveness: 0.9, exploration: 0.6 },
          memoryUpdates: { nextFocus: 'follow up with reef-bot' },
          createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
        }
      ];
    },
    async getRecentChatMessagesByAgentName() {
      return [
        { agentName: 'alpha-lobster', message: '@reef-bot hello', timestamp: now - 20_000 },
        { agentName: 'alpha-lobster', message: '@reef-bot update?', timestamp: now - 10_000 }
      ];
    },
    async getTopConversationPartnersByAgentName() {
      return [
        {
          entityId: 'reef-bot',
          messagesExchanged: 24,
          sentMentions: 12,
          receivedMentions: 10,
          lastInteractionAt: now - 60_000
        },
        {
          entityId: 'tidal-friend',
          messagesExchanged: 8,
          sentMentions: 3,
          receivedMentions: 2,
          lastInteractionAt: now - 120_000
        }
      ];
    }
  };

  const worldState = {
    agents: new Map([
      ['a1', { id: 'a1', entityId: 'alpha-lobster', state: 'chatting', lastAction: { type: 'chat' }, lastUpdate: now }]
    ])
  };

  const wiki = await buildEntityWikiPublic('alpha-lobster', worldState, fakeDb);
  assert.equal(wiki.identity.entityId, 'alpha-lobster');
  assert.equal(wiki.currentState.online, true);
  assert.ok(Array.isArray(wiki.cognition.interests));
  assert.ok(wiki.cognition.longTermGoals.length <= 4);
  assert.ok(wiki.cognition.shortTermGoals.length <= 4);
  assert.ok(wiki.social.relationships.length <= 8);
  assert.ok(wiki.social.relationshipGraph.nodes.length <= 9);
  assert.ok(wiki.social.relationshipGraph.edges.length <= 8);
  assert.ok(wiki.social.reputationScore.value >= 0 && wiki.social.reputationScore.value <= 100);
  assert.ok(wiki.timeline.length <= 20);
});


test('buildEntityWikiPublic prefers persisted goals snapshot when available', async () => {
  const now = Date.now();
  const fakeDb = {
    async getEntity(entityId) {
      return {
        entity_id: entityId,
        entity_name: entityId,
        entity_type: 'lobster',
        created_at: new Date(now - 10_000).toISOString()
      };
    },
    async getEntityInterests() {
      return [{ interest: 'currents', weight: 100 }];
    },
    async getRecentEntityReflectionsPublic() {
      return [];
    },
    async getRecentChatMessagesByAgentName() {
      return [];
    },
    async getTopConversationPartnersByAgentName() {
      return [];
    },
    async getLatestEntityGoalSnapshot() {
      return {
        longTermGoals: [{ label: 'Build a coral coalition', source: 'gpt-4o-mini' }],
        shortTermGoals: [{ label: 'Send 3 outreach pings', source: 'gpt-4o-mini' }],
        source: 'ai-v1',
        generatedAt: new Date(now - 60_000).toISOString()
      };
    }
  };

  const wiki = await buildEntityWikiPublic('alpha-lobster', { agents: new Map() }, fakeDb);
  assert.deepEqual(wiki.cognition.longTermGoals, [{ label: 'Build a coral coalition', source: 'gpt-4o-mini' }]);
  assert.deepEqual(wiki.cognition.shortTermGoals, [{ label: 'Send 3 outreach pings', source: 'gpt-4o-mini' }]);
  assert.ok(wiki.meta.sources.includes('entity_goal_snapshots'));
});

test('buildEntityWikiPublic does not write goal snapshots in wiki read path', async () => {
  const now = Date.now();
  let writeCalls = 0;
  const fakeDb = {
    async getEntity(entityId) {
      return {
        entity_id: entityId,
        entity_name: entityId,
        entity_type: 'lobster',
        created_at: new Date(now - 10_000).toISOString()
      };
    },
    async getEntityInterests() {
      return [{ interest: 'ocean politics', weight: 100 }];
    },
    async getRecentEntityReflectionsPublic() {
      return [];
    },
    async getRecentChatMessagesByAgentName() {
      return [];
    },
    async getTopConversationPartnersByAgentName() {
      return [];
    },
    async getLatestEntityGoalSnapshot() {
      return null;
    },
    async saveEntityGoalSnapshot() {
      writeCalls += 1;
    }
  };

  const wiki = await buildEntityWikiPublic('alpha-lobster', { agents: new Map() }, fakeDb);
  assert.equal(writeCalls, 0);
  assert.ok(wiki.cognition.longTermGoals.length > 0);
});


test('buildEntityWikiPublic uses in-memory goal snapshot fallback when DB is unavailable', async () => {
  const now = Date.now();
  const memoryEntity = {
    entity_id: 'alpha-lobster',
    entity_name: 'alpha-lobster',
    entity_type: 'lobster',
    created_at: new Date(now - 1000).toISOString()
  };

  const wiki = await buildEntityWikiPublic('alpha-lobster', { agents: new Map() }, null, {
    memoryEntity,
    memoryInterests: [{ interest: 'currents', weight: 100 }],
    memoryGoalSnapshot: {
      longTermGoals: [{ label: 'Expand reef diplomacy', source: 'entity-agent' }],
      shortTermGoals: [{ label: 'Check in with reef-bot', source: 'entity-agent' }],
      source: 'entity-agent-v1'
    }
  });

  assert.deepEqual(wiki.cognition.longTermGoals, [{ label: 'Expand reef diplomacy', source: 'entity-agent' }]);
  assert.deepEqual(wiki.cognition.shortTermGoals, [{ label: 'Check in with reef-bot', source: 'entity-agent' }]);
});


test('buildEntityWikiPublic includes current action sequence for lobster queue', async () => {
  const now = Date.now();
  const memoryEntity = {
    entity_id: 'alpha-lobster',
    entity_name: 'alpha-lobster',
    entity_type: 'lobster',
    created_at: new Date(now - 1000).toISOString()
  };

  const wiki = await buildEntityWikiPublic('alpha-lobster', { agents: new Map() }, null, {
    memoryEntity,
    memoryInterests: [{ interest: 'currents', weight: 100 }],
    runtimeActionQueue: {
      queueId: 'queue-1',
      status: 'running',
      currentIndex: 1,
      remainingTicks: 2,
      totalRequiredTicks: 5,
      totalItems: 3,
      actions: [
        { type: 'jump', requiredTicks: 1 },
        { type: 'dance', requiredTicks: 3 },
        { type: 'emoji', requiredTicks: 1 }
      ]
    }
  });

  assert.equal(wiki.currentState.actionSequence.queueId, 'queue-1');
  assert.equal(wiki.currentState.actionSequence.currentAction.type, 'dance');
  assert.equal(wiki.currentState.actionSequence.sequence.length, 3);
  assert.equal(wiki.currentState.actionSequence.sequence[0].status, 'completed');
  assert.equal(wiki.currentState.actionSequence.sequence[1].status, 'running');
  assert.equal(wiki.currentState.actionSequence.sequence[2].status, 'pending');
  assert.ok(wiki.meta.sources.includes('entity_action_queues'));
});
