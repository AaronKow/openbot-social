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
