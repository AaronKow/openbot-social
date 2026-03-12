const { ALLOWED_ACTIONS } = require('./actionQueue');

const TERMINAL_QUEUE_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);
const WIKI_VISIBLE_TERMINAL_QUEUE_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const RELATIONSHIP_EXCLUDED_ENTITY_IDS = new Set(['system']);

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function formatLabel(key) {
  return String(key || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function toTs(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMentionTargets(message) {
  if (!message || typeof message !== 'string') return [];
  const targets = new Set();
  const regex = /@([a-zA-Z0-9_-]{3,64})/g;
  let match;
  while ((match = regex.exec(message)) !== null) {
    targets.add(match[1]);
  }
  return [...targets];
}

function mentionMatchesName(message, name) {
  if (!message || !name) return false;
  const lowered = String(message).toLowerCase();
  const full = `@${String(name).toLowerCase()}`;
  if (lowered.includes(full)) return true;
  const base = String(name).split('-')[0].split('_')[0];
  if (base.length >= 3 && lowered.includes(`@${base.toLowerCase()}`)) return true;
  return false;
}

function deriveLongTermGoals(interests, reflections, recentOwnChats) {
  const goals = [];

  for (const row of reflections) {
    const gp = row.goalProgress || {};
    for (const [key, value] of Object.entries(gp)) {
      goals.push({
        label: `Improve ${formatLabel(key)}`,
        score: Number.isFinite(Number(value)) ? Number(value) : 0.5,
        source: 'stored'
      });
    }
  }

  if (!goals.length) {
    for (const interest of interests.slice(0, 3)) {
      goals.push({
        label: `Deepen expertise in ${interest.interest}`,
        score: clamp01((interest.weight || 0) / 100),
        source: 'derived'
      });
    }
  }

  if (recentOwnChats.length > 0) {
    const days = new Set(
      recentOwnChats.map(m => new Date(Number(m.timestamp || 0)).toISOString().slice(0, 10))
    ).size;
    goals.push({
      label: 'Maintain consistent daily presence',
      score: clamp01(days / 7),
      source: 'derived'
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const g of goals.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    if (!seen.has(g.label)) {
      deduped.push({ label: g.label, source: g.source || 'derived' });
      seen.add(g.label);
    }
    if (deduped.length >= 4) break;
  }
  return deduped;
}

function deriveShortTermGoals(reflections, relationships, currentState) {
  const goals = [];
  const recentReflections = reflections.slice(0, 3);
  for (const row of recentReflections) {
    const mu = row.memoryUpdates || {};
    if (typeof mu.nextFocus === 'string' && mu.nextFocus.trim()) {
      goals.push({ label: formatLabel(mu.nextFocus.trim()), source: 'stored' });
    }
  }

  if (relationships.length) {
    goals.push({ label: `Follow up with ${relationships[0].entityId}`, source: 'derived' });
  } else {
    goals.push({ label: 'Initiate new conversations nearby', source: 'derived' });
  }

  if (currentState.online && currentState.state === 'idle') {
    goals.push({ label: 'Shift from idle to active interaction', source: 'derived' });
  }

  const deduped = [];
  const seen = new Set();
  for (const goal of goals) {
    if (!seen.has(goal.label)) {
      deduped.push(goal);
      seen.add(goal.label);
    }
    if (deduped.length >= 4) break;
  }
  return deduped;
}

function normalizeGoalEntries(goals, fallbackSource = 'persisted') {
  if (!Array.isArray(goals)) return [];
  return goals
    .map(goal => {
      if (!goal || typeof goal !== 'object') return null;
      const label = typeof goal.label === 'string' ? goal.label.trim() : '';
      if (!label) return null;
      return {
        label,
        source: typeof goal.source === 'string' && goal.source.trim()
          ? goal.source.trim()
          : fallbackSource
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function deriveRelationships(rawPartners) {
  const now = Date.now();
  return (rawPartners || []).map(partner => {
    const entityId = String(partner.entityId || '').trim();
    if (!entityId) return null;
    if (RELATIONSHIP_EXCLUDED_ENTITY_IDS.has(entityId.toLowerCase())) return null;

    const messagesExchanged = Number(partner.messagesExchanged || 0);
    const sentMentions = Number(partner.sentMentions || 0);
    const receivedMentions = Number(partner.receivedMentions || 0);
    const lastTs = Number(partner.lastInteractionAt || 0);

    const freq = clamp01(messagesExchanged / 20);
    const hoursAgo = Math.max(0, (now - lastTs) / (1000 * 60 * 60));
    const recency = clamp01(Math.exp(-hoursAgo / 72));
    const totalMentions = sentMentions + receivedMentions;
    const reciprocity = totalMentions > 0
      ? clamp01(1 - Math.abs(sentMentions - receivedMentions) / totalMentions)
      : 0;

    const score = clamp01(0.5 * freq + 0.3 * recency + 0.2 * reciprocity);
    return {
      entityId,
      score: Number(score.toFixed(2)),
      messagesExchanged,
      lastInteractionAt: lastTs,
      sentMentions,
      receivedMentions
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 8);
}

function deriveReputation(relationships, recentOwnChats) {
  const totalReceived = relationships.reduce((s, r) => s + r.receivedMentions, 0);
  const totalSent = relationships.reduce((s, r) => s + r.sentMentions, 0);
  const responsiveness = totalReceived > 0
    ? clamp01(totalSent / totalReceived)
    : (recentOwnChats.length > 0 ? 0.6 : 0.2);

  const activeDays = new Set(
    recentOwnChats.map(m => new Date(Number(m.timestamp || 0)).toISOString().slice(0, 10))
  ).size;
  const consistency = clamp01(activeDays / 7);
  const socialBreadth = clamp01(relationships.length / 8);

  const value = Math.round((0.35 * responsiveness + 0.35 * consistency + 0.30 * socialBreadth) * 100);
  let band = 'Low';
  if (value >= 85) band = 'Excellent';
  else if (value >= 70) band = 'Good';
  else if (value >= 40) band = 'Fair';

  return {
    value,
    band,
    explain: 'Derived from responsiveness, consistency, and social breadth'
  };
}

function buildRelationshipGraph(selfId, relationships) {
  const nodes = [{ id: selfId, label: selfId, kind: 'self' }];
  const edges = [];
  for (const rel of relationships.slice(0, 8)) {
    nodes.push({ id: rel.entityId, label: rel.entityId, kind: 'partner' });
    edges.push({ source: selfId, target: rel.entityId, weight: rel.score });
  }
  return { nodes, edges };
}

function buildTimeline(entity, currentState, reflections, recentOwnChats) {
  const limitsByType = {
    identity: 1,
    state: 1,
    reflection: 8,
    chat: 10
  };
  const compareByRecency = (a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts;
    if (a.type !== b.type) return String(a.type).localeCompare(String(b.type));
    return String(a.title || '').localeCompare(String(b.title || ''));
  };
  const events = [];
  const createdTs = toTs(entity.created_at || entity.createdAt);
  if (createdTs) {
    events.push({
      ts: createdTs,
      type: 'identity',
      title: 'Entity created',
      detail: `${entity.entity_id} joined the world`
    });
  }

  for (const row of reflections.slice(0, 12)) {
    const ts = toTs(row.createdAt) || toTs(row.date);
    if (!ts) continue;
    events.push({
      ts,
      type: 'reflection',
      title: 'Daily reflection recorded',
      detail: row.dailySummary || 'Reflection stored'
    });
  }

  const buckets = new Map();
  for (const m of recentOwnChats) {
    const ts = Number(m.timestamp || 0);
    if (!ts) continue;
    const bucketTs = Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);
    buckets.set(bucketTs, (buckets.get(bucketTs) || 0) + 1);
  }
  for (const [bucketTs, count] of buckets.entries()) {
    if (count >= 5) {
      events.push({
        ts: bucketTs,
        type: 'chat',
        title: 'Conversation spike',
        detail: `${count} messages in 15m`
      });
    }
  }

  if (currentState.online) {
    events.push({
      ts: Date.now(),
      type: 'state',
      title: 'Currently online',
      detail: `State: ${currentState.state || 'unknown'}`
    });
  }

  const byType = new Map();
  for (const event of events) {
    if (!byType.has(event.type)) byType.set(event.type, []);
    byType.get(event.type).push(event);
  }

  const selected = [];
  for (const [type, limit] of Object.entries(limitsByType)) {
    const typedEvents = (byType.get(type) || []).sort(compareByRecency).slice(0, limit);
    selected.push(...typedEvents);
  }

  return selected.sort(compareByRecency);
}


function summarizeActionQueue(queue, worldTick = null) {
  if (!queue || typeof queue !== 'object' || !Array.isArray(queue.actions)) {
    return null;
  }

  const status = String(queue.status || 'unknown').toLowerCase();
  if (status === 'expired') {
    return null;
  }


  const expiresAtTick = Number(queue.expiresAtTick);
  const tick = Number(worldTick);
  if (Number.isFinite(expiresAtTick) && Number.isFinite(tick) && tick > expiresAtTick) {
    return null;
  }

  const current = queue.actions[queue.currentIndex] || null;
  return {
    queueId: queue.queueId || null,
    status,
    currentIndex: Number(queue.currentIndex || 0),
    totalItems: Number(queue.totalItems || queue.actions.length || 0),
    remainingTicks: Number(queue.remainingTicks || 0),
    totalRequiredTicks: Number(queue.totalRequiredTicks || 0),
    currentAction: current ? { type: current.type, requiredTicks: Number(current.requiredTicks || 1) } : null,
    sequence: queue.actions.map((a, idx) => ({
      index: idx,
      type: a.type,
      requiredTicks: Number(a.requiredTicks || 1),
      status: idx < Number(queue.currentIndex || 0)
        ? 'completed'
        : idx === Number(queue.currentIndex || 0) && status === 'running'
          ? 'running'
          : (status === 'cancelled' || status === 'failed') && idx === Number(queue.currentIndex || 0)
            ? status
            : 'pending'
    }))
  };
}

function summarizePersistedActionQueue(queue) {
  if (!queue || typeof queue !== 'object') return null;
  const status = String(queue.status || '').toLowerCase();
  if (!TERMINAL_QUEUE_STATUSES.has(status)) return null;
  if (!WIKI_VISIBLE_TERMINAL_QUEUE_STATUSES.has(status)) return null;

  const rawActions = Array.isArray(queue?.queueSpec?.actions) ? queue.queueSpec.actions : [];
  const actions = rawActions.filter((action) => (
    action
    && typeof action === 'object'
    && typeof action.type === 'string'
    && ALLOWED_ACTIONS.has(action.type)
  ));
  if (actions.length === 0) return null;

  const currentIndex = Math.max(0, Math.min(Number(queue.currentIndex || 0), actions.length));

  return {
    queueId: queue.queueId || null,
    status,
    currentIndex,
    totalItems: Number(queue.totalItems || actions.length || 0),
    remainingTicks: 0,
    totalRequiredTicks: Number(queue.totalRequiredTicks || 0),
    currentAction: null,
    sequence: actions.map((a, idx) => ({
      index: idx,
      type: a.type,
      requiredTicks: Number(a.requiredTicks || 1),
      status: status === 'completed'
        ? 'completed'
        : idx < currentIndex
          ? 'completed'
          : idx === currentIndex
            ? status
            : 'pending'
    }))
  };
}

function normalizeRuntimeSkill(skill) {
  const source = skill && typeof skill === 'object' ? skill : {};
  return {
    level: Math.max(1, Math.floor(Number(source.level) || 1)),
    xp: Math.max(0, Math.floor(Number(source.xp) || 0)),
    cooldown: Math.max(0, Number(source.cooldown) || 0)
  };
}

function summarizeRuntimeState(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const runtimeSkills = agent.skills && typeof agent.skills === 'object' ? agent.skills : {};
  const parsedEnergy = Number(agent.energy);

  return {
    energy: Number.isFinite(parsedEnergy) ? parsedEnergy : null,
    sleeping: Boolean(agent.sleeping),
    capturedAt: Date.now(),
    skills: {
      scout: normalizeRuntimeSkill(runtimeSkills.scout),
      forage: normalizeRuntimeSkill(runtimeSkills.forage),
      shellGuard: normalizeRuntimeSkill(runtimeSkills.shellGuard),
      builder: normalizeRuntimeSkill(runtimeSkills.builder)
    }
  };
}

async function buildEntityWikiPublic(entityId, worldState, db, options = {}) {
  let entity = options.memoryEntity || null;
  if (!entity && db && typeof db.getEntity === 'function') {
    entity = await db.getEntity(entityId);
  }
  if (!entity) return null;

  const onlineAgent = Array.from((worldState && worldState.agents ? worldState.agents.values() : []))
    .find(a => a.entityId === entityId);

  const runtimeActionQueue = options.runtimeActionQueue || null;
  const runtimeActionSequence = summarizeActionQueue(runtimeActionQueue, worldState?.tick);
  const agentName = entity.entity_name || entity.entity_id || entityId;
  const interestsPromise = db && typeof db.getEntityInterests === 'function'
    ? db.getEntityInterests(entityId)
    : Promise.resolve(Array.isArray(options.memoryInterests) ? options.memoryInterests : []);
  const reflectionsPromise = db && typeof db.getRecentEntityReflectionsPublic === 'function'
    ? db.getRecentEntityReflectionsPublic(entityId, 30)
    : Promise.resolve([]);
  const recentOwnChatsPromise = db && typeof db.getRecentChatMessagesByAgentName === 'function'
    ? db.getRecentChatMessagesByAgentName(agentName, 300)
    : Promise.resolve([]);
  const rawPartnersPromise = db && typeof db.getTopConversationPartnersByAgentName === 'function'
    ? db.getTopConversationPartnersByAgentName(agentName, 8)
    : Promise.resolve(null);
  const goalsSnapshotPromise = db && typeof db.getLatestEntityGoalSnapshot === 'function'
    ? db.getLatestEntityGoalSnapshot(entityId).catch(error => {
      // Keep wiki route resilient if goal snapshots are unavailable.
      console.warn(`[wiki-public] failed to read goals snapshot for ${entityId}:`, error.message);
      return null;
    })
    : Promise.resolve(options.memoryGoalSnapshot && typeof options.memoryGoalSnapshot === 'object' ? options.memoryGoalSnapshot : null);

  const achievementsPromise = db && typeof db.getEntityAchievements === 'function'
    ? db.getEntityAchievements(entityId).catch(error => {
      console.warn(`[wiki-public] failed to read achievements for ${entityId}:`, error.message);
      return null;
    })
    : Promise.resolve(null);
  const earnedBadgesPromise = db && typeof db.getEntityBadges === 'function'
    ? db.getEntityBadges(entityId).catch(error => {
      console.warn(`[wiki-public] failed to read badges for ${entityId}:`, error.message);
      return [];
    })
    : Promise.resolve([]);
  const actionSequencePromise = runtimeActionSequence
    ? Promise.resolve(runtimeActionSequence)
    : (db && typeof db.getRecentEntityActionQueues === 'function'
      ? db.getRecentEntityActionQueues(entityId, 5)
        .then(recentQueues => {
          if (!Array.isArray(recentQueues) || recentQueues.length === 0) return null;
          for (const queue of recentQueues) {
            const summary = summarizePersistedActionQueue(queue);
            if (summary) return summary;
          }
          return null;
        })
        .catch(error => {
          console.warn(`[wiki-public] failed to read recent action queues for ${entityId}:`, error.message);
          return null;
        })
      : Promise.resolve(null));

  let [interests, reflections, recentOwnChats, rawPartners, goalsSnapshot, actionSequence, achievements, earnedBadges] = await Promise.all([
    interestsPromise,
    reflectionsPromise,
    recentOwnChatsPromise,
    rawPartnersPromise,
    goalsSnapshotPromise,
    actionSequencePromise,
    achievementsPromise,
    earnedBadgesPromise
  ]);

  if (!Array.isArray(rawPartners)) {
    const relMap = new Map();
    for (const msg of recentOwnChats) {
      for (const target of parseMentionTargets(msg.message)) {
        const s = relMap.get(target) || {
          entityId: target,
          messagesExchanged: 0,
          sentMentions: 0,
          receivedMentions: 0,
          lastInteractionAt: 0
        };
        s.messagesExchanged += 1;
        s.sentMentions += 1;
        s.lastInteractionAt = Math.max(s.lastInteractionAt, Number(msg.timestamp || 0));
        relMap.set(target, s);
      }
    }
    rawPartners = [...relMap.values()];
  }

  const currentState = {
    online: Boolean(onlineAgent),
    agentId: onlineAgent ? onlineAgent.id : null,
    state: onlineAgent ? onlineAgent.state : 'offline',
    lastAction: onlineAgent
      ? {
        ...(typeof onlineAgent.lastAction === 'object' && onlineAgent.lastAction ? onlineAgent.lastAction : { type: onlineAgent.lastAction || 'none' }),
        timestamp: onlineAgent.lastUpdate || Date.now()
      }
      : null,
    runtime: summarizeRuntimeState(onlineAgent),
    actionSequence
  };

  return composeEntityWikiPublic({
    entityId,
    entity,
    currentState,
    interests,
    reflections,
    recentOwnChats,
    rawPartners,
    goalsSnapshot,
    actionSequence,
    achievements,
    earnedBadges
  });
}

function composeEntityWikiPublic({
  entityId,
  entity,
  currentState,
  interests,
  reflections,
  recentOwnChats,
  rawPartners,
  goalsSnapshot,
  actionSequence,
  achievements,
  earnedBadges
}) {
  const relationships = deriveRelationships(rawPartners);

  const derivedLongTermGoals = deriveLongTermGoals(interests, reflections, recentOwnChats);
  const derivedShortTermGoals = deriveShortTermGoals(reflections, relationships, currentState);

  const longTermGoals = goalsSnapshot
    ? normalizeGoalEntries(goalsSnapshot.longTermGoals, goalsSnapshot.source || 'persisted')
    : derivedLongTermGoals;
  const shortTermGoals = goalsSnapshot
    ? normalizeGoalEntries(goalsSnapshot.shortTermGoals, goalsSnapshot.source || 'persisted')
    : derivedShortTermGoals;

  const relationshipGraph = buildRelationshipGraph(entityId, relationships);
  const reputationScore = deriveReputation(relationships, recentOwnChats);
  const timeline = buildTimeline(entity, currentState, reflections, recentOwnChats);

  return {
    identity: {
      entityId: entity.entity_id || entityId,
      entityName: entity.entity_name || entity.entity_id || entityId,
      numericId: entity.numeric_id || null,
      entityType: entity.entity_type || 'lobster',
      createdAt: entity.created_at || null,
      level: Number(achievements?.level || 1),
      xp: Number(achievements?.xp || 0),
      earnedBadges: Array.isArray(earnedBadges) ? earnedBadges : []
    },
    currentState,
    cognition: {
      interests: interests.map(i => ({
        interest: i.interest,
        weight: Number(i.weight)
      })),
      longTermGoals,
      shortTermGoals
    },
    social: {
      relationships,
      relationshipGraph,
      reputationScore
    },
    timeline,
    meta: {
      generatedAt: new Date().toISOString(),
      sources: [
        'entity',
        'world-state',
        'entity_interests',
        'entity_daily_reflections',
        'chat_messages',
        ...(goalsSnapshot ? ['entity_goal_snapshots'] : []),
        ...(actionSequence ? ['entity_action_queues'] : [])
      ],
      privacy: 'public'
    }
  };
}

module.exports = {
  buildEntityWikiPublic,
  // Exposed for unit testing deterministic derivation boundaries
  _private: {
    deriveRelationships,
    deriveReputation,
    mentionMatchesName,
    summarizeActionQueue,
    composeEntityWikiPublic
  }
};
