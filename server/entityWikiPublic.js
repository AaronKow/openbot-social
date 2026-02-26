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
      entityId: partner.entityId,
      score: Number(score.toFixed(2)),
      messagesExchanged,
      lastInteractionAt: lastTs,
      sentMentions,
      receivedMentions
    };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
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

  return events
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);
}


function summarizeActionQueue(queue) {
  if (!queue || typeof queue !== 'object' || !Array.isArray(queue.actions)) {
    return null;
  }

  const current = queue.actions[queue.currentIndex] || null;
  return {
    queueId: queue.queueId || null,
    status: queue.status || 'unknown',
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
        : idx === Number(queue.currentIndex || 0) && queue.status === 'running'
          ? 'running'
          : (queue.status === 'cancelled' || queue.status === 'failed') && idx === Number(queue.currentIndex || 0)
            ? queue.status
            : 'pending'
    }))
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

  const actionSequence = summarizeActionQueue(options.runtimeActionQueue || null);

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
    actionSequence
  };

  let interests = [];
  if (db && typeof db.getEntityInterests === 'function') {
    interests = await db.getEntityInterests(entityId);
  } else if (Array.isArray(options.memoryInterests)) {
    interests = options.memoryInterests;
  }

  let reflections = [];
  if (db && typeof db.getRecentEntityReflectionsPublic === 'function') {
    reflections = await db.getRecentEntityReflectionsPublic(entityId, 30);
  }

  const agentName = entity.entity_name || entity.entity_id || entityId;
  let recentOwnChats = [];
  if (db && typeof db.getRecentChatMessagesByAgentName === 'function') {
    recentOwnChats = await db.getRecentChatMessagesByAgentName(agentName, 300);
  }

  let rawPartners = [];
  if (db && typeof db.getTopConversationPartnersByAgentName === 'function') {
    rawPartners = await db.getTopConversationPartnersByAgentName(agentName, 8);
  } else {
    // fallback from available chat messages
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

  const relationships = deriveRelationships(rawPartners);

  const derivedLongTermGoals = deriveLongTermGoals(interests, reflections, recentOwnChats);
  const derivedShortTermGoals = deriveShortTermGoals(reflections, relationships, currentState);

  let goalsSnapshot = null;
  if (db && typeof db.getLatestEntityGoalSnapshot === 'function') {
    try {
      goalsSnapshot = await db.getLatestEntityGoalSnapshot(entityId);
    } catch (error) {
      // Keep wiki route resilient if goal snapshots are unavailable.
      console.warn(`[wiki-public] failed to read goals snapshot for ${entityId}:`, error.message);
    }
  } else if (options.memoryGoalSnapshot && typeof options.memoryGoalSnapshot === 'object') {
    goalsSnapshot = options.memoryGoalSnapshot;
  }

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
      createdAt: entity.created_at || null
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
    summarizeActionQueue
  }
};
