const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');
const serverCrypto = require('./crypto');
const { createEntityRouter, requireSession, optionalSession, encryptIfAuthenticated } = require('./entityRoutes');
const { createRateLimiter, createEntityRateLimiter } = require('./rateLimit');
const activitySummary = require('./activitySummary');
const entityReflectionSummary = require('./entityReflectionSummary');
const { buildEntityWikiPublic } = require('./entityWikiPublic');
const { createRuntimeQueue, MAX_QUEUE_ACTIONS, MAX_QUEUE_TOTAL_TICKS } = require('./actionQueue');
const {
  findDuplicateMessageByAgent,
  isLowSignalChatMessage,
  normalizeChatMessage,
  truncateForLog
} = require('./chatMessage');

const app = express();

function getBodyLimit(envKey, fallback) {
  const configured = process.env[envKey];
  if (typeof configured !== 'string' || !configured.trim()) {
    return fallback;
  }
  return configured.trim();
}

function getPositiveNumber(envKey, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[envKey];
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    if (raw !== undefined) {
      console.warn(`[runtime-config] invalid ${envKey}=${JSON.stringify(raw)}; using default ${fallback}`);
    }
    return fallback;
  }

  return parsed;
}

// Reflection + goal snapshot payloads are intentionally compact (typically < 20kb after route-level trimming),
// so a 256kb default keeps current behavior while adding protection against abusive request sizes.
const HTTP_JSON_LIMIT = getBodyLimit('HTTP_JSON_LIMIT', '256kb');
const HTTP_FORM_LIMIT = getBodyLimit('HTTP_FORM_LIMIT', '256kb');

function parseTrustProxy(value) {
  if (value === undefined) return false;
  const lowered = String(value).trim().toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  const asNumber = Number(lowered);
  if (!Number.isNaN(asNumber)) return asNumber;
  return value;
}

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// Middleware
app.use(express.json({ limit: HTTP_JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: HTTP_FORM_LIMIT }));

function parseCorsAllowedOrigins(value) {
  if (!value || !value.trim()) {
    return null;
  }

  return new Set(
    value
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

const corsAllowedOrigins = parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);

function isNonPublicCorsPath(req) {
  const { method, path: reqPath } = req;
  const normalizedMethod = method.toUpperCase();

  if (normalizedMethod === 'OPTIONS') {
    if (reqPath === '/spawn' || reqPath === '/move' || reqPath === '/action') return true;
    if (/^\/agent\/[^/]+\/heartbeat$/.test(reqPath)) return true;
    if (reqPath.startsWith('/disconnect/')) return true;
    if (/^\/entity\/[^/]+\/(action-queue|interests|daily-reflections|goal-snapshots)(?:\/.*)?$/.test(reqPath)) return true;
    return false;
  }

  if (normalizedMethod === 'POST' && (reqPath === '/spawn' || reqPath === '/move' || reqPath === '/action')) return true;
  if (normalizedMethod === 'POST' && /^\/agent\/[^/]+\/heartbeat$/.test(reqPath)) return true;
  if (normalizedMethod === 'DELETE' && reqPath.startsWith('/disconnect/')) return true;

  if (
    /^\/entity\/[^/]+\/(action-queue|interests|daily-reflections|goal-snapshots)(?:\/.*)?$/.test(reqPath)
  ) {
    return true;
  }

  return false;
}

// Enable CORS with optional allowlist support
app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const allowAllOrigins = corsAllowedOrigins === null;
  const originAllowed = allowAllOrigins || (requestOrigin && corsAllowedOrigins.has(requestOrigin));

  if (originAllowed) {
    res.header('Access-Control-Allow-Origin', allowAllOrigins ? '*' : requestOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Encrypt-Response');
    if (!allowAllOrigins) {
      res.header('Vary', 'Origin');
    }
  } else if (requestOrigin && isNonPublicCorsPath(req)) {
    return res.status(403).json({
      success: false,
      error: 'Origin not allowed'
    });
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============= RATE LIMITERS =============
const rateLimiters = {
  entityCreate: createRateLimiter('entity_create', { onError: 'deny' }, db),
  authChallenge: createRateLimiter('auth_challenge', { onError: 'deny' }, db),
  authSession: createRateLimiter('auth_session', { onError: 'deny' }, db),
  chat: createEntityRateLimiter('chat', db),
  move: createEntityRateLimiter('move', db),
  action: createEntityRateLimiter('action', db),
  summaryCheck: createRateLimiter('summary_check', {}, db),
  general: createRateLimiter('general', {}, db)
};

// ============= ENTITY & AUTH ROUTES =============
const entityRouter = createEntityRouter(db, rateLimiters);
app.use(entityRouter);

// Helper to get memory stores from entity router (for non-DB mode)
const getMemorySessions = () => {
  if (!entityRouter._memorySessions) {
    entityRouter._memorySessions = new Map();
  }
  return entityRouter._memorySessions;
};
const getMemoryEntities = () => entityRouter._memoryEntities;
const getMemoryDailyReflections = () => {
  if (!app._memoryDailyReflections) {
    app._memoryDailyReflections = new Map();
  }
  return app._memoryDailyReflections;
};

// Auth middleware instances
const requireAuth = requireSession(db, getMemorySessions);
const optionalAuth = optionalSession(db, getMemorySessions);
const encryptResponses = encryptIfAuthenticated(db, getMemoryEntities);

// Attach optional auth context globally so authenticated requests can opt-in to encrypted JSON responses.
app.use(optionalAuth);
app.use(encryptResponses);

// Configuration
const PORT = process.env.PORT || 3001;
const TICK_RATE = getPositiveNumber('TICK_RATE', 30, 5, 60); // 30 updates per second
const TICK_INTERVAL_MS = 1000 / TICK_RATE;
const DAY_NIGHT_CYCLE_SECONDS = 24 * 60 * 60;
const WORLD_SIZE = { x: 100, y: 100 }; // Ocean floor dimensions
const MAP_EDGE_BUFFER = 1.35;
const AGENT_TIMEOUT = Number(process.env.AGENT_TIMEOUT || 180000); // 3 minutes by default
const WORLD_STATE_DELTA_TICK_WINDOW = Number(process.env.WORLD_STATE_DELTA_TICK_WINDOW || (TICK_RATE * 60));
const MAX_WORLD_STATE_LIMIT = Number(process.env.MAX_WORLD_STATE_LIMIT || 500);
const MAP_REFILL_INTERVAL_MS = Number(process.env.MAP_REFILL_INTERVAL_MS || 15 * 60 * 1000);
const ALGAE_PALLET_REFILL_INTERVAL_MS = Number(process.env.ALGAE_PALLET_REFILL_INTERVAL_MS || 5 * 60 * 1000);
const MAP_OBJECT_TARGETS = Object.freeze({
  rock: Number(process.env.MAP_ROCK_TARGET || 20),
  kelp: Number(process.env.MAP_KELP_TARGET || 8),
  seaweed: Number(process.env.MAP_SEAWEED_TARGET || 7),
  algae_pallet: Number(process.env.MAP_ALGAE_PALLET_TARGET || 6)
});
const AGENT_ENERGY_MAX = 100;
const AGENT_ENERGY_MIN = 0;
const AGENT_ENERGY_COLLAPSE_THRESHOLD = Number(process.env.AGENT_ENERGY_COLLAPSE_THRESHOLD || 12);
const AGENT_ENERGY_WAKE_THRESHOLD = Number(process.env.AGENT_ENERGY_WAKE_THRESHOLD || 72);
const AGENT_ENERGY_IDLE_DRAIN_PER_SEC = Number(process.env.AGENT_ENERGY_IDLE_DRAIN_PER_SEC || 0.06);
const AGENT_ENERGY_STATE_DRAIN_PER_SEC = Object.freeze({
  moving: Number(process.env.AGENT_ENERGY_DRAIN_MOVING_PER_SEC || 0.32),
  chatting: Number(process.env.AGENT_ENERGY_DRAIN_CHATTING_PER_SEC || 0.1),
  acting: Number(process.env.AGENT_ENERGY_DRAIN_ACTING_PER_SEC || 0.2),
  jumping: Number(process.env.AGENT_ENERGY_DRAIN_JUMPING_PER_SEC || 0.26),
  dancing: Number(process.env.AGENT_ENERGY_DRAIN_DANCING_PER_SEC || 0.22),
  emoting: Number(process.env.AGENT_ENERGY_DRAIN_EMOTING_PER_SEC || 0.15)
});
const AGENT_SLEEP_RECHARGE_PER_SEC = Number(process.env.AGENT_SLEEP_RECHARGE_PER_SEC || 2.8);
const AGENT_ALGAE_CONSUME_THRESHOLD = Number(process.env.AGENT_ALGAE_CONSUME_THRESHOLD || 55);
const ALGAE_PALLET_RADIUS = Number(process.env.ALGAE_PALLET_RADIUS || 0.95);
const ALGAE_PALLET_ENERGY_PER_SERVE = Number(process.env.ALGAE_PALLET_ENERGY_PER_SERVE || 24);
const ALGAE_PALLET_MAX_SERVES = Math.max(1, Math.floor(Number(process.env.ALGAE_PALLET_MAX_SERVES || 3)));
const HARVEST_INTERACTION_BUFFER = Number(process.env.HARVEST_INTERACTION_BUFFER || 1.2);
const COMBAT_EVENTS_MAX = Math.max(40, Math.floor(Number(process.env.COMBAT_EVENTS_MAX || 220)));
const COMBAT_EVENTS_WORLD_PAYLOAD_MAX = Math.max(20, Math.floor(Number(process.env.COMBAT_EVENTS_WORLD_PAYLOAD_MAX || 80)));
const OCTOPUS_MAX_ACTIVE = Math.max(1, Math.floor(Number(process.env.OCTOPUS_MAX_ACTIVE || 2)));
const OCTOPUS_SPAWN_MIN_SEC = Math.max(60, Number(process.env.OCTOPUS_SPAWN_MIN_SEC || (15 * 60)));
const OCTOPUS_SPAWN_MAX_SEC = Math.max(OCTOPUS_SPAWN_MIN_SEC + 1, Number(process.env.OCTOPUS_SPAWN_MAX_SEC || (16 * 60)));
const OCTOPUS_MAX_HP = Math.max(20, Number(process.env.OCTOPUS_MAX_HP || 140));
const OCTOPUS_SPEED_PER_SEC = Math.max(0.5, Number(process.env.OCTOPUS_SPEED_PER_SEC || 3.2));
const OCTOPUS_MELEE_RANGE = Math.max(1.2, Number(process.env.OCTOPUS_MELEE_RANGE || 3.2));
const OCTOPUS_AOE_RANGE = Math.max(OCTOPUS_MELEE_RANGE + 0.5, Number(process.env.OCTOPUS_AOE_RANGE || 8.5));
const OCTOPUS_MELEE_COOLDOWN_SEC = Math.max(0.8, Number(process.env.OCTOPUS_MELEE_COOLDOWN_SEC || 2.6));
const OCTOPUS_AOE_COOLDOWN_SEC = Math.max(OCTOPUS_MELEE_COOLDOWN_SEC + 0.4, Number(process.env.OCTOPUS_AOE_COOLDOWN_SEC || 4.4));
const LOBSTER_COMBAT_RANGE_MELEE = Math.max(1.2, Number(process.env.LOBSTER_COMBAT_RANGE_MELEE || 4.2));
const LOBSTER_COMBAT_RANGE_LONG = Math.max(LOBSTER_COMBAT_RANGE_MELEE + 1, Number(process.env.LOBSTER_COMBAT_RANGE_LONG || 11.5));
const LOBSTER_COMBAT_AOE_RADIUS = Math.max(2.5, Number(process.env.LOBSTER_COMBAT_AOE_RADIUS || 6.8));
const LOBSTER_COMBAT_SPEED_PER_SEC = Math.max(0.8, Number(process.env.LOBSTER_COMBAT_SPEED_PER_SEC || 3.6));
const LOBSTER_COMBAT_MELEE_COOLDOWN_SEC = Math.max(0.6, Number(process.env.LOBSTER_COMBAT_MELEE_COOLDOWN_SEC || 1.35));
const LOBSTER_COMBAT_LONG_COOLDOWN_SEC = Math.max(LOBSTER_COMBAT_MELEE_COOLDOWN_SEC + 0.3, Number(process.env.LOBSTER_COMBAT_LONG_COOLDOWN_SEC || 2.4));
const LOBSTER_ATTACK_ENERGY_COST = Math.max(0.2, Number(process.env.LOBSTER_ATTACK_ENERGY_COST || 2.4));
const MAP_EXPANSION_MAX_TILES = Math.max(1, Math.floor(Number(process.env.MAP_EXPANSION_MAX_TILES || 500)));
const MAP_EXPANSION_COOLDOWN_TICKS = Math.max(1, Math.floor(Number(process.env.MAP_EXPANSION_COOLDOWN_TICKS || (TICK_RATE * 25))));
const SKILL_DEFS = Object.freeze({
  scout: { label: 'Scout', xpPerLevel: 40, maxLevel: 10, cooldownSec: 10 },
  forage: { label: 'Forage', xpPerLevel: 35, maxLevel: 10, cooldownSec: 8 },
  shellGuard: { label: 'Shell Guard', xpPerLevel: 50, maxLevel: 10, cooldownSec: 14 },
  builder: { label: 'Builder', xpPerLevel: 45, maxLevel: 10, cooldownSec: 12 }
});
const SKILL_IDS = Object.keys(SKILL_DEFS);
const SKILL_ACTION_MAP = Object.freeze({
  move: 'scout',
  move_to_agent: 'scout',
  talk: 'scout',
  chat: 'scout',
  jump: 'forage',
  dance: 'forage',
  emoji: 'forage',
  emote: 'shellGuard',
  defend: 'shellGuard',
  guard: 'shellGuard',
  wait: 'builder',
  build: 'builder',
  harvest: 'forage',
  expand_map: 'builder'
});
const SKILL_ACTION_XP = Object.freeze({
  move: 2,
  move_to_agent: 4,
  talk: 2,
  chat: 2,
  jump: 3,
  dance: 3,
  emoji: 2,
  emote: 3,
  defend: 4,
  guard: 4,
  wait: 1,
  build: 5,
  harvest: 4,
  expand_map: 8
});
const ROTATING_EVENT_TYPES = Object.freeze(['hazard_zone', 'rescue_beacon', 'migration_signal']);
const ROTATING_EVENT_DURATION_MS = Math.max(60_000, Number(process.env.ROTATING_EVENT_DURATION_MS || (3 * 60 * 1000)));
const ROTATING_EVENT_COOLDOWN_MS = Math.max(20_000, Number(process.env.ROTATING_EVENT_COOLDOWN_MS || 45_000));
const ROTATING_EVENT_RADIUS = Object.freeze({
  hazard_zone: Math.max(4, Number(process.env.HAZARD_ZONE_RADIUS || 9)),
  rescue_beacon: Math.max(4, Number(process.env.RESCUE_BEACON_RADIUS || 8)),
  migration_signal: Math.max(5, Number(process.env.MIGRATION_SIGNAL_RADIUS || 11))
});

function getPositiveIntervalMs(envKey, fallbackMs, minMs) {
  const raw = process.env[envKey];
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < minMs) {
    if (raw !== undefined) {
      console.warn(`[scheduler-config] invalid ${envKey}=${JSON.stringify(raw)}; using default ${fallbackMs}ms (min ${minMs}ms)`);
    }
    return fallbackMs;
  }

  return parsed;
}

// World State
const worldState = {
  agents: new Map(), // agentId -> agent data
  objects: new Map(), // objectId -> object data
  threats: new Map(), // threatId -> hostile NPC state
  expansionTiles: [], // shared 1x1 map growth tiles
  mapExpansionLevel: 0,
  chatMessages: [], // Recent chat messages
  combatEvents: [], // Recent combat events for client-side effects
  rotatingEvents: [], // active + recent rotating world events
  tick: 0,
  startTime: Date.now(), // Server start time for uptime calculation
  worldCreatedAt: Date.now(), // Earliest persistent world signal (entity/chat/agent creation)
  totalEntitiesCreated: 0, // Track total entities ever created
  agentChangeHistory: new Map(), // tick -> { changed: Set<agentId>, removed: Set<agentId> }
  deltaHistoryMinTick: 0,
  worldTimeState: null
};

const dirtyAgentIds = new Set();
const pendingAgentDeleteIds = new Set();
const entityRecentPositions = new Map(); // entityId -> [{x,z,tick,ts}]

function pushEntityRecentPosition(entityId, position) {
  const id = String(entityId || '').trim();
  if (!id || !position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.z))) return;
  const row = {
    x: Number(position.x),
    z: Number(position.z),
    tick: Number(worldState.tick || 0),
    ts: Date.now()
  };
  const list = entityRecentPositions.get(id) || [];
  list.push(row);
  if (list.length > 24) list.splice(0, list.length - 24);
  entityRecentPositions.set(id, list);
}

function getTickChangeBucket(tick) {
  let bucket = worldState.agentChangeHistory.get(tick);
  if (!bucket) {
    bucket = {
      changed: new Set(),
      removed: new Set()
    };
    worldState.agentChangeHistory.set(tick, bucket);
  }
  return bucket;
}

function markAgentUpdated(agent) {
  if (!agent) return;
  agent.updatedAtTick = worldState.tick;
  const bucket = getTickChangeBucket(worldState.tick);
  bucket.removed.delete(agent.id);
  bucket.changed.add(agent.id);
  pendingAgentDeleteIds.delete(agent.id);
  dirtyAgentIds.add(agent.id);
}

function markAgentRemoved(agentId) {
  if (!agentId) return;
  const bucket = getTickChangeBucket(worldState.tick);
  bucket.changed.delete(agentId);
  bucket.removed.add(agentId);
  dirtyAgentIds.delete(agentId);
  pendingAgentDeleteIds.add(agentId);
}

function pruneWorldStateDeltaHistory() {
  const cutoffTick = Math.max(0, worldState.tick - WORLD_STATE_DELTA_TICK_WINDOW + 1);
  for (const tick of worldState.agentChangeHistory.keys()) {
    if (tick < cutoffTick) {
      worldState.agentChangeHistory.delete(tick);
    }
  }
  worldState.deltaHistoryMinTick = cutoffTick;
}

function refreshWorldTimeState(nowMs = Date.now()) {
  const nextState = getWorldTimeState(nowMs);
  worldState.worldTimeState = nextState;
  return nextState;
}

function getWorldStateMeta() {
  const uptimeMs = Date.now() - worldState.startTime;
  const worldTime = worldState.worldTimeState || refreshWorldTimeState();
  return {
    tick: worldState.tick,
    uptimeMs,
    uptimeFormatted: formatUptime(uptimeMs),
    serverStartTime: worldState.startTime,
    worldCreatedAt: worldState.worldCreatedAt,
    totalEntitiesCreated: worldState.totalEntitiesCreated,
    worldTime,
    objects: Array.from(worldState.objects.values()),
    threats: Array.from(worldState.threats.values()),
    combatEvents: worldState.combatEvents.slice(-COMBAT_EVENTS_WORLD_PAYLOAD_MAX),
    events: worldState.rotatingEvents,
    expansionTiles: worldState.expansionTiles,
    mapExpansionLevel: worldState.mapExpansionLevel,
    traversableBounds: getTraversableBoundaryMetadata()
  };
}

function randomEventCenter() {
  const x = clampWorldCoordX(Math.random() * WORLD_SIZE.x);
  const z = clampWorldCoordZ(Math.random() * WORLD_SIZE.y);
  return { x, y: 0, z };
}

function getRotatingEventObjective(type, center) {
  if (type === 'hazard_zone') {
    return {
      action: 'defend',
      title: 'Stabilize Hazard Zone',
      description: 'Move into the red zone and use defend/guard actions to contain turbulence.'
    };
  }
  if (type === 'rescue_beacon') {
    return {
      action: 'talk',
      title: 'Rescue Beacon Sync',
      description: 'Approach the beacon and talk to broadcast rescue telemetry.'
    };
  }
  return {
    action: 'move',
    title: 'Migration Signal Escort',
    description: 'Follow the migration vector by moving through the highlighted corridor.'
  };
}

function createRotatingEvent(type, now = Date.now()) {
  const center = randomEventCenter();
  const radius = ROTATING_EVENT_RADIUS[type] || 8;
  const objective = getRotatingEventObjective(type, center);
  return {
    id: `evt-${type}-${uuidv4()}`,
    type,
    title: objective.title,
    description: objective.description,
    status: 'active',
    startedAt: now,
    expiresAt: now + ROTATING_EVENT_DURATION_MS,
    cooldownUntil: now + ROTATING_EVENT_DURATION_MS + ROTATING_EVENT_COOLDOWN_MS,
    center,
    radius,
    objective,
    participants: {},
    rewardsGranted: {}
  };
}

function updateRotatingEvents(now = Date.now()) {
  worldState.rotatingEvents = worldState.rotatingEvents
    .map((event) => {
      if (event.status === 'active' && now >= Number(event.expiresAt)) {
        return { ...event, status: 'cooldown' };
      }
      return event;
    })
    .filter((event) => now < Number(event.cooldownUntil || 0));

  for (const type of ROTATING_EVENT_TYPES) {
    const hasActive = worldState.rotatingEvents.some((event) => event.type === type && event.status === 'active');
    if (hasActive) continue;

    const hasCoolingEvent = worldState.rotatingEvents.some((event) => (
      event.type === type
      && event.status === 'cooldown'
      && now < Number(event.cooldownUntil || 0)
    ));
    if (hasCoolingEvent) continue;

    const nextEvent = createRotatingEvent(type, now);
    worldState.rotatingEvents.push(nextEvent);
  }
}

function grantAgentSkillXp(agent, skillId, xp) {
  if (!agent || !skillId || !Number.isFinite(xp) || xp <= 0) return;
  ensureAgentSkills(agent);
  const skill = agent.skills?.[skillId];
  const skillDef = SKILL_DEFS?.[skillId];
  if (!skill || !skillDef) return;

  skill.xp = Math.max(0, Math.floor(Number(skill.xp) || 0)) + Math.floor(xp);
  const levelXpTarget = skill.level * skillDef.xpPerLevel;
  if (skill.xp >= levelXpTarget) {
    if (skill.level < skillDef.maxLevel) {
      skill.level += 1;
    }
    skill.xp = 0;
  }
}

function applyRotatingEventActionHooks(agent, actionType, context = {}) {
  if (!agent || !actionType) return [];
  const now = Date.now();
  const position = validatePosition(context.position || agent.position || {});
  const results = [];

  for (const event of worldState.rotatingEvents) {
    if (event.status !== 'active') continue;
    const dx = Number(position.x || 0) - Number(event.center?.x || 0);
    const dz = Number(position.z || 0) - Number(event.center?.z || 0);
    const distance = Math.sqrt((dx * dx) + (dz * dz));
    if (distance > Number(event.radius || 0)) continue;

    const eventType = String(event.type || '');
    const normalized = String(actionType).toLowerCase();
    const validAction = (
      (eventType === 'hazard_zone' && ['defend', 'guard', 'emote'].includes(normalized))
      || (eventType === 'rescue_beacon' && ['talk', 'chat', 'move_to_agent'].includes(normalized))
      || (eventType === 'migration_signal' && ['move', 'move_to_agent', 'expand_map'].includes(normalized))
    );
    if (!validAction) continue;

    const participantKey = String(agent.entityId || agent.id || 'unknown');
    event.participants[participantKey] = Math.max(0, Math.floor(Number(event.participants[participantKey]) || 0)) + 1;

    if (!event.rewardsGranted[participantKey]) {
      event.rewardsGranted[participantKey] = now;
      agent.reputation = Math.max(0, Number(agent.reputation || 0)) + (eventType === 'hazard_zone' ? 3 : 2);

      const bonusResource = ['rock', 'kelp', 'seaweed'][Math.floor(Math.random() * 3)];
      ensureAgentInventory(agent);
      agent.inventory[bonusResource] = Math.max(0, Number(agent.inventory[bonusResource] || 0)) + 1;

      if (eventType === 'hazard_zone') {
        grantAgentSkillXp(agent, 'shellGuard', 12);
      } else if (eventType === 'rescue_beacon') {
        grantAgentSkillXp(agent, 'scout', 10);
      } else {
        grantAgentSkillXp(agent, 'builder', 10);
      }

      if (agent.entityId) {
        updateQuestProgress(agent.entityId, {
          moveCount: eventType === 'migration_signal' ? 1 : 0,
          cooperativeExpansionChains: eventType === 'migration_signal' ? 1 : 0,
          unexploredSectorsVisited: eventType === 'rescue_beacon' ? 1 : 0
        }).catch(() => {});
      }
    }

    results.push({
      eventId: event.id,
      eventType,
      objective: event.objective,
      distance: Number(distance.toFixed(2)),
      interactions: event.participants[participantKey],
      rewardsGranted: Boolean(event.rewardsGranted[participantKey])
    });
  }

  return results;
}

function buildWorldStateDelta(sinceTick, limit) {
  const changeTicks = Array.from(worldState.agentChangeHistory.keys())
    .filter(tick => tick > sinceTick)
    .sort((a, b) => a - b);

  const changedAgentIds = new Set();
  const removedAgentIds = new Set();

  for (const tick of changeTicks) {
    const bucket = worldState.agentChangeHistory.get(tick);
    if (!bucket) continue;

    for (const removedId of bucket.removed) {
      changedAgentIds.delete(removedId);
      removedAgentIds.add(removedId);
    }
    for (const changedId of bucket.changed) {
      removedAgentIds.delete(changedId);
      changedAgentIds.add(changedId);
    }
  }

  const allChangedAgents = Array.from(changedAgentIds)
    .map(agentId => worldState.agents.get(agentId))
    .filter(Boolean)
    .map(agent => agent.toJSON());

  const limitedAgents = limit ? allChangedAgents.slice(0, limit) : allChangedAgents;

  return {
    ...getWorldStateMeta(),
    agents: limitedAgents,
    removedAgentIds: Array.from(removedAgentIds),
    isDelta: true,
    deltaFromTick: sinceTick,
    deltaToTick: worldState.tick,
    deltaHistoryMinTick: worldState.deltaHistoryMinTick,
    changedAgentsTotal: allChangedAgents.length,
    deltaTruncated: Boolean(limit && allChangedAgents.length > limit)
  };
}

const actionQueues = new Map(); // entityId -> runtime queue
const queueLifecyclePersistBuffer = new Map(); // queueId -> snapshot
const runtimeDailyTelemetry = new Map(); // entityId::YYYY-MM-DD -> counters
const runtimeTelemetryPersistBuffer = new Map(); // entityId::YYYY-MM-DD -> counters
const SOCIAL_ACTION_TYPES = new Set(['chat', 'talk', 'emoji', 'emote', 'dance']);
const OBJECTIVE_ACTION_TYPES = new Set(['move', 'move_to_agent', 'jump', 'wait', 'harvest', 'expand_map', 'guard', 'defend', 'build']);
const QUEUE_TERMINAL_RETENTION_MS = Number(process.env.ACTION_QUEUE_TERMINAL_RETENTION_MS || 120000);
const QUEUE_EXPIRY_GRACE_TICKS = Math.max(1, Math.floor(Number(process.env.ACTION_QUEUE_EXPIRY_GRACE_TICKS || 30)));
let mapRefillTimer = null;
let mapRefillInProgress = false;
let algaePalletRefillTimer = null;
let algaePalletRefillInProgress = false;
let nextThreatSpawnInSec = randomInRange(OCTOPUS_SPAWN_MIN_SEC, OCTOPUS_SPAWN_MAX_SEC);

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function getObjectRadius(type, data = {}) {
  if (type === 'rock') return Number(data.radius) || 1.8;
  if (type === 'kelp') return Number(data.radius) || 0.9;
  if (type === 'seaweed') return Number(data.radius) || 0.7;
  if (type === 'algae_pallet') return Number(data.radius) || ALGAE_PALLET_RADIUS;
  return 0.9;
}

function clampEnergy(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return AGENT_ENERGY_MAX;
  return Math.max(AGENT_ENERGY_MIN, Math.min(AGENT_ENERGY_MAX, numeric));
}

function distance2D(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = Number(a.x || 0) - Number(b.x || 0);
  const dz = Number(a.z || 0) - Number(b.z || 0);
  return Math.sqrt((dx * dx) + (dz * dz));
}

function getTraversableBoundaryMetadata() {
  let minX = 0;
  let maxX = WORLD_SIZE.x;
  let minZ = 0;
  let maxZ = WORLD_SIZE.y;

  for (const tile of worldState.expansionTiles) {
    const tileX = Number(tile?.x);
    const tileZ = Number(tile?.z);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileZ)) continue;
    minX = Math.min(minX, tileX - 0.5);
    maxX = Math.max(maxX, tileX + 0.5);
    minZ = Math.min(minZ, tileZ - 0.5);
    maxZ = Math.max(maxZ, tileZ + 0.5);
  }

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    baseMinX: 0,
    baseMaxX: WORLD_SIZE.x,
    baseMinZ: 0,
    baseMaxZ: WORLD_SIZE.y,
    expansionTilesCount: worldState.expansionTiles.length
  };
}

function clampWorldCoordX(x) {
  const { minX, maxX } = getTraversableBoundaryMetadata();
  return Math.max(minX, Math.min(maxX, Number(x) || 0));
}

function clampWorldCoordZ(z) {
  const { minZ, maxZ } = getTraversableBoundaryMetadata();
  return Math.max(minZ, Math.min(maxZ, Number(z) || 0));
}

function isAgentCombatTargetable(agent) {
  if (!agent) return false;
  if (agent.sleeping) return false;
  return clampEnergy(agent.energy) > 0;
}

function pushCombatEvent(event) {
  if (!event || typeof event !== 'object') return;
  const enriched = {
    id: event.id || `combat-${uuidv4()}`,
    tick: worldState.tick,
    at: Date.now(),
    ...event
  };
  worldState.combatEvents.push(enriched);
  if (worldState.combatEvents.length > COMBAT_EVENTS_MAX) {
    worldState.combatEvents = worldState.combatEvents.slice(-COMBAT_EVENTS_MAX);
  }
}

function createOctopusThreat(position = {}) {
  const maxHp = OCTOPUS_MAX_HP;
  return {
    id: `threat-octopus-${uuidv4()}`,
    type: 'octopus',
    position: {
      x: clampWorldCoordX(position.x ?? randomInRange(6, WORLD_SIZE.x - 6)),
      y: 0.6,
      z: clampWorldCoordZ(position.z ?? randomInRange(6, WORLD_SIZE.y - 6))
    },
    velocity: { x: 0, z: 0 },
    hp: maxHp,
    maxHp,
    targetAgentId: null,
    state: 'hunting',
    attackCooldownSec: randomInRange(0.6, 1.8),
    spawnedAtTick: worldState.tick
  };
}

function findNearestCombatAgent(position) {
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const agent of worldState.agents.values()) {
    if (!isAgentCombatTargetable(agent)) continue;
    const d = distance2D(position, agent.position);
    if (d < nearestDistance) {
      nearest = agent;
      nearestDistance = d;
    }
  }
  return { agent: nearest, distance: nearestDistance };
}

function movePointTowards(point, target, maxStep) {
  if (!point || !target || maxStep <= 0) return;
  const dx = Number(target.x || 0) - Number(point.x || 0);
  const dz = Number(target.z || 0) - Number(point.z || 0);
  const dist = Math.sqrt((dx * dx) + (dz * dz));
  if (dist <= 0.0001) return;
  const step = Math.min(dist, maxStep);
  const next = validatePosition({
    x: Number(point.x || 0) + ((dx / dist) * step),
    y: Number(point.y || 0),
    z: Number(point.z || 0) + ((dz / dist) * step)
  });
  point.x = next.x;
  point.z = next.z;
}

function applyCombatDamageToAgent(agent, amount, sourceType = 'impact') {
  if (!agent) return 0;
  const before = clampEnergy(agent.energy);
  const damage = Math.max(0, Number(amount) || 0);
  agent.energy = clampEnergy(before - damage);
  const dealt = before - agent.energy;
  if (dealt <= 0) return 0;

  if (agent.energy <= AGENT_ENERGY_MIN) {
    agent.sleeping = true;
    agent.state = 'sleeping';
  }
  agent.lastAction = {
    type: 'combat_hit',
    sourceType,
    damage: dealt
  };
  markAgentUpdated(agent);
  return dealt;
}

function spawnLootDropsAt(position, amount = 3) {
  const resourceCounts = { rock: 0, kelp: 0, seaweed: 0 };
  for (const object of worldState.objects.values()) {
    if (resourceCounts[object.type] !== undefined) {
      resourceCounts[object.type] += 1;
    }
  }
  const crowdedByType = (
    resourceCounts.rock >= (MAP_OBJECT_TARGETS.rock || 0)
    && resourceCounts.kelp >= (MAP_OBJECT_TARGETS.kelp || 0)
    && resourceCounts.seaweed >= (MAP_OBJECT_TARGETS.seaweed || 0)
  );
  if (crowdedByType) {
    return;
  }

  const lootTypes = ['kelp', 'rock', 'seaweed', 'algae_pallet'];
  const drops = Math.max(1, Math.floor(Number(amount) || 1));
  for (let i = 0; i < drops; i += 1) {
    const type = lootTypes[Math.floor(Math.random() * lootTypes.length)];
    const dropped = buildMapObject(type);
    const jitterX = randomInRange(-2.8, 2.8);
    const jitterZ = randomInRange(-2.8, 2.8);
    dropped.position.x = clampWorldCoordX((Number(position?.x) || 50) + jitterX);
    dropped.position.z = clampWorldCoordZ((Number(position?.z) || 50) + jitterZ);
    if (type === 'algae_pallet') {
      dropped.position.y = 0.45;
      dropped.data = {
        ...dropped.data,
        servesRemaining: Math.max(1, Math.floor(randomInRange(1, ALGAE_PALLET_MAX_SERVES + 1))),
        energyPerServe: ALGAE_PALLET_ENERGY_PER_SERVE
      };
    }
    worldState.objects.set(dropped.id, dropped);
    if (process.env.DATABASE_URL) {
      db.saveWorldObject(dropped.id, dropped.type, dropped.position, dropped.data).catch((error) => {
        console.error('Failed persisting octopus loot drop:', error);
      });
    }
  }
}

function removeThreatWithLoot(threat, killedByAgentId = null) {
  if (!threat) return;
  worldState.threats.delete(threat.id);
  spawnLootDropsAt(threat.position, Math.floor(randomInRange(2, 6)));
  pushCombatEvent({
    eventType: 'threat_defeated',
    actorType: 'lobster',
    actorId: killedByAgentId,
    threatId: threat.id,
    threatType: threat.type,
    position: {
      x: Number(threat.position?.x) || 0,
      y: Number(threat.position?.y) || 0,
      z: Number(threat.position?.z) || 0
    }
  });
}

function maybeSpawnOctopusThreat(dtSeconds) {
  if (worldState.threats.size >= OCTOPUS_MAX_ACTIVE) return;
  nextThreatSpawnInSec = Math.max(0, nextThreatSpawnInSec - Math.max(0, Number(dtSeconds) || 0));
  if (nextThreatSpawnInSec > 0) return;
  const threat = createOctopusThreat();
  worldState.threats.set(threat.id, threat);
  nextThreatSpawnInSec = randomInRange(OCTOPUS_SPAWN_MIN_SEC, OCTOPUS_SPAWN_MAX_SEC);
}

function processThreatCombatTick(dtSeconds) {
  maybeSpawnOctopusThreat(dtSeconds);

  for (const threat of worldState.threats.values()) {
    threat.attackCooldownSec = Math.max(0, Number(threat.attackCooldownSec || 0) - dtSeconds);
    const { agent: nearestAgent, distance } = findNearestCombatAgent(threat.position);
    threat.targetAgentId = nearestAgent?.id || null;

    if (!nearestAgent) {
      threat.state = 'searching';
      threat.velocity.x = 0;
      threat.velocity.z = 0;
      continue;
    }

    movePointTowards(threat.position, nearestAgent.position, OCTOPUS_SPEED_PER_SEC * dtSeconds);
    const toTargetX = Number(nearestAgent.position?.x || 0) - Number(threat.position?.x || 0);
    const toTargetZ = Number(nearestAgent.position?.z || 0) - Number(threat.position?.z || 0);
    threat.velocity.x = toTargetX;
    threat.velocity.z = toTargetZ;
    threat.state = 'hunting';

    if (threat.attackCooldownSec > 0) continue;
    if (distance > OCTOPUS_AOE_RANGE) continue;

    const useLongRange = Math.random() < 0.33;
    const attackType = useLongRange ? 'long_range' : 'melee';
    const targets = useLongRange
      ? Array.from(worldState.agents.values()).filter((agent) => (
        isAgentCombatTargetable(agent) && distance2D(agent.position, threat.position) <= OCTOPUS_AOE_RANGE
      ))
      : (distance <= OCTOPUS_MELEE_RANGE && isAgentCombatTargetable(nearestAgent) ? [nearestAgent] : []);

    if (targets.length === 0) continue;

    const impacts = [];
    for (const target of targets) {
      const damage = useLongRange
        ? randomInRange(6.5, 11.5)
        : randomInRange(9.5, 16.5);
      const dealt = applyCombatDamageToAgent(target, damage, 'octopus');
      if (dealt <= 0) continue;
      impacts.push({
        targetId: target.id,
        damage: Number(dealt.toFixed(2)),
        sleeping: Boolean(target.sleeping),
        energy: Number(clampEnergy(target.energy).toFixed(2))
      });
    }

    if (impacts.length === 0) continue;
    threat.attackCooldownSec = useLongRange ? OCTOPUS_AOE_COOLDOWN_SEC : OCTOPUS_MELEE_COOLDOWN_SEC;
    threat.state = useLongRange ? 'casting' : 'striking';
    pushCombatEvent({
      eventType: 'threat_attack',
      actorType: 'octopus',
      actorId: threat.id,
      threatId: threat.id,
      attackType,
      position: { ...threat.position },
      targets: impacts
    });
  }

}

function processLobsterCombatAgainstThreats(dtSeconds) {
  if (worldState.threats.size === 0) return;
  const deadThreats = new Map(); // threatId -> killerAgentId

  for (const agent of worldState.agents.values()) {
    if (!isAgentCombatTargetable(agent)) continue;
    const attackCooldownSec = Math.max(0, Number(agent.combatCooldownSec || 0) - dtSeconds);
    agent.combatCooldownSec = attackCooldownSec;

    let nearestThreat = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const threat of worldState.threats.values()) {
      const d = distance2D(agent.position, threat.position);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearestThreat = threat;
      }
    }
    if (!nearestThreat) continue;

    if (nearestDistance > LOBSTER_COMBAT_RANGE_MELEE) {
      movePointTowards(agent.position, nearestThreat.position, LOBSTER_COMBAT_SPEED_PER_SEC * dtSeconds);
      agent.state = 'moving';
      markAgentUpdated(agent);
    }

    if (agent.combatCooldownSec > 0) continue;
    if (nearestDistance > LOBSTER_COMBAT_RANGE_LONG) continue;

    const useLongRange = Math.random() < 0.34;
    const attackType = useLongRange ? 'long_range' : 'melee';
    const targets = useLongRange
      ? Array.from(worldState.threats.values()).filter((threat) => distance2D(agent.position, threat.position) <= LOBSTER_COMBAT_AOE_RADIUS)
      : [nearestThreat];
    if (targets.length === 0) continue;

    const impacts = [];
    for (const target of targets) {
      const damage = useLongRange
        ? randomInRange(6.5, 11.5)
        : randomInRange(10.5, 18.5);
      target.hp = Math.max(0, Number(target.hp || target.maxHp || OCTOPUS_MAX_HP) - damage);
      impacts.push({
        threatId: target.id,
        damage: Number(damage.toFixed(2)),
        hp: Number(target.hp.toFixed(2)),
        maxHp: Number((target.maxHp || OCTOPUS_MAX_HP).toFixed(2))
      });
      if (target.hp <= 0) {
        deadThreats.set(target.id, agent.id);
      }
    }

    applyCombatDamageToAgent(agent, LOBSTER_ATTACK_ENERGY_COST, 'self_cost');
    agent.state = 'acting';
    agent.lastAction = {
      type: 'combat_attack',
      attackType,
      targetType: 'octopus',
      targets: impacts.map((entry) => entry.threatId)
    };
    trainAgentSkill(agent, 'defend');
    markAgentUpdated(agent);

    pushCombatEvent({
      eventType: 'lobster_attack',
      actorType: 'lobster',
      actorId: agent.id,
      attackType,
      position: { ...agent.position },
      targets: impacts
    });

    agent.combatCooldownSec = useLongRange ? LOBSTER_COMBAT_LONG_COOLDOWN_SEC : LOBSTER_COMBAT_MELEE_COOLDOWN_SEC;
  }

  for (const [threatId, killerAgentId] of deadThreats.entries()) {
    const threat = worldState.threats.get(threatId);
    if (!threat) continue;
    removeThreatWithLoot(threat, killerAgentId);
  }
}

function isObjectPlacementValid(x, z, radius) {
  for (const existing of worldState.objects.values()) {
    const existingRadius = getObjectRadius(existing.type, existing.data);
    const dx = x - existing.position.x;
    const dz = z - existing.position.z;
    const minDistance = radius + existingRadius + 0.35;
    if (Math.sqrt(dx * dx + dz * dz) < minDistance) {
      return false;
    }
  }
  return true;
}

function buildMapObject(type) {
  const radius = getObjectRadius(type, {
    radius: type === 'rock'
      ? randomInRange(0.95, 2.35)
      : type === 'kelp'
        ? randomInRange(0.75, 1.0)
        : type === 'seaweed'
          ? randomInRange(0.55, 0.85)
          : ALGAE_PALLET_RADIUS
  });
  const maxAttempts = 40;
  let x = randomInRange(2, WORLD_SIZE.x - 2);
  let z = randomInRange(2, WORLD_SIZE.y - 2);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isObjectPlacementValid(x, z, radius)) break;
    x = randomInRange(2, WORLD_SIZE.x - 2);
    z = randomInRange(2, WORLD_SIZE.y - 2);
  }

  const y = type === 'rock'
    ? randomInRange(0, 0.5)
    : type === 'kelp'
      ? randomInRange(1.5, 3.75)
      : type === 'seaweed'
        ? randomInRange(0.8, 2.25)
        : 0.45;
  const objectId = `map-${type}-${uuidv4()}`;

  return {
    id: objectId,
    type,
    position: { x, y, z },
    data: {
      radius,
      rotation: {
        x: randomInRange(0, Math.PI),
        y: randomInRange(0, Math.PI),
        z: randomInRange(0, Math.PI)
      },
      height: type === 'rock' ? null : type === 'kelp' ? randomInRange(2.5, 7.0) : type === 'seaweed' ? randomInRange(1.8, 4.5) : 0.6,
      servesRemaining: type === 'algae_pallet' ? ALGAE_PALLET_MAX_SERVES : undefined,
      energyPerServe: type === 'algae_pallet' ? ALGAE_PALLET_ENERGY_PER_SERVE : undefined,
      lastRefilledAt: type === 'algae_pallet' ? Date.now() : undefined
    }
  };
}

function refillAlgaePalletServes() {
  let changed = 0;
  for (const object of worldState.objects.values()) {
    if (object.type !== 'algae_pallet') continue;
    const currentServes = Math.max(0, Math.floor(Number(object.data?.servesRemaining) || 0));
    if (currentServes >= ALGAE_PALLET_MAX_SERVES) continue;
    object.data = {
      ...object.data,
      servesRemaining: ALGAE_PALLET_MAX_SERVES,
      lastRefilledAt: Date.now()
    };
    changed += 1;
  }
  return changed;
}

async function refillMapObjects({ persist = true } = {}) {
  const typeCounts = { rock: 0, kelp: 0, seaweed: 0, algae_pallet: 0 };
  for (const object of worldState.objects.values()) {
    if (typeCounts[object.type] !== undefined) {
      typeCounts[object.type] += 1;
    }
  }

  const newObjects = [];
  for (const [type, targetCount] of Object.entries(MAP_OBJECT_TARGETS)) {
    const missing = Math.max(0, targetCount - (typeCounts[type] || 0));
    for (let i = 0; i < missing; i += 1) {
      const mapObject = buildMapObject(type);
      worldState.objects.set(mapObject.id, mapObject);
      newObjects.push(mapObject);
    }
  }

  if (persist && process.env.DATABASE_URL && newObjects.length > 0) {
    await Promise.all(newObjects.map((object) => (
      db.saveWorldObject(object.id, object.type, object.position, object.data)
    )));
  }

  const refilledPalletCount = refillAlgaePalletServes();

  if (persist && process.env.DATABASE_URL && refilledPalletCount > 0) {
    const updates = Array.from(worldState.objects.values())
      .filter((object) => object.type === 'algae_pallet')
      .map((object) => db.saveWorldObject(object.id, object.type, object.position, object.data));
    await Promise.all(updates);
  }

  return {
    newObjects: newObjects.length,
    refilledPallets: refilledPalletCount
  };
}

function scheduleMapRefill() {
  mapRefillTimer = setTimeout(async () => {
    if (mapRefillInProgress) {
      scheduleMapRefill();
      return;
    }

    mapRefillInProgress = true;
    try {
      const refillResult = await refillMapObjects({ persist: true });
      if (refillResult.newObjects > 0 || refillResult.refilledPallets > 0) {
        console.log(`[map-refill] Added ${refillResult.newObjects} missing map object(s), refilled ${refillResult.refilledPallets} algae pallet(s)`);
      }
    } catch (error) {
      console.error('Error refilling map objects:', error);
    } finally {
      mapRefillInProgress = false;
      scheduleMapRefill();
    }
  }, MAP_REFILL_INTERVAL_MS);

  if (typeof mapRefillTimer.unref === 'function') {
    mapRefillTimer.unref();
  }
}

function scheduleAlgaePalletRefill() {
  algaePalletRefillTimer = setTimeout(async () => {
    if (algaePalletRefillInProgress) {
      scheduleAlgaePalletRefill();
      return;
    }

    algaePalletRefillInProgress = true;
    try {
      const changed = refillAlgaePalletServes();
      if (changed > 0 && process.env.DATABASE_URL) {
        const updates = Array.from(worldState.objects.values())
          .filter((object) => object.type === 'algae_pallet')
          .map((object) => db.saveWorldObject(object.id, object.type, object.position, object.data));
        await Promise.all(updates);
      }
      if (changed > 0) {
        console.log(`[algae-refill] Refilled ${changed} algae pallet(s)`);
      }
    } catch (error) {
      console.error('Error refilling algae pallets:', error);
    } finally {
      algaePalletRefillInProgress = false;
      scheduleAlgaePalletRefill();
    }
  }, ALGAE_PALLET_REFILL_INTERVAL_MS);

  if (typeof algaePalletRefillTimer.unref === 'function') {
    algaePalletRefillTimer.unref();
  }
}

// Maximum movement distance per move request (prevents teleporting)
const MAX_MOVE_DISTANCE = 5.0; // Max units an agent can move per request

// Agent class to manage individual agents
class Agent {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.position = {
      x: Math.random() * WORLD_SIZE.x,
      y: 0,
      z: Math.random() * WORLD_SIZE.y
    };
    this.rotation = 0;
    this.velocity = { x: 0, y: 0, z: 0 };
    this.state = 'idle'; // idle, moving, chatting
    this.lastAction = null;
    this.connected = true;
    this.lastUpdate = Date.now();
    this.entityId = null; // Link to authenticated entity (if any)
    this.entityType = null; // Entity type (lobster, crab, etc.)
    this.entityName = null; // Unique entity name
    this.numericId = null; // Incremented numeric ID
    this.updatedAtTick = 0;
    this.skills = createDefaultSkills();
    this.skillsNormalized = true;
    this.inventory = createDefaultInventory();
    this.expansionCooldownUntilTick = 0;
    this.energy = AGENT_ENERGY_MAX;
    this.sleeping = false;
    this.lastEnergyEventAt = 0;
    this.reputation = 0;
    this.eventProgress = {};
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      position: this.position,
      rotation: this.rotation,
      velocity: this.velocity,
      state: this.state,
      lastAction: this.lastAction,
      entityId: this.entityId,
      entityType: this.entityType,
      entityName: this.entityName,
      numericId: this.numericId,
      updatedAtTick: this.updatedAtTick,
      skills: this.skills,
      inventory: this.inventory,
      expansionCooldownUntilTick: this.expansionCooldownUntilTick,
      energy: this.energy,
      sleeping: this.sleeping,
      reputation: this.reputation,
      eventProgress: this.eventProgress
    };
  }
}

function createDefaultSkills() {
  const skills = {};
  for (const skillId of SKILL_IDS) {
    skills[skillId] = { level: 1, xp: 0, cooldown: 0 };
  }
  return skills;
}

function createDefaultInventory() {
  return {
    rock: 0,
    kelp: 0,
    seaweed: 0
  };
}

function ensureAgentSkills(agent) {
  if (!agent.skills || typeof agent.skills !== 'object') {
    agent.skills = createDefaultSkills();
  }

  for (const skillId of SKILL_IDS) {
    const existing = agent.skills[skillId] || {};
    agent.skills[skillId] = {
      level: Math.max(1, Math.floor(Number(existing.level) || 1)),
      xp: Math.max(0, Math.floor(Number(existing.xp) || 0)),
      cooldown: Math.max(0, Number(existing.cooldown) || 0)
    };
  }

  agent.skillsNormalized = true;
}

function ensureAgentInventory(agent) {
  if (!agent.inventory || typeof agent.inventory !== 'object') {
    agent.inventory = createDefaultInventory();
  }

  for (const key of ['rock', 'kelp', 'seaweed']) {
    agent.inventory[key] = Math.max(0, Math.floor(Number(agent.inventory[key]) || 0));
  }

  agent.expansionCooldownUntilTick = Math.max(0, Math.floor(Number(agent.expansionCooldownUntilTick) || 0));
}

function trainAgentSkill(agent, actionType) {
  const normalizedAction = String(actionType || '').trim().toLowerCase();
  if (!normalizedAction) return;

  ensureAgentSkills(agent);
  const skillId = SKILL_ACTION_MAP[normalizedAction] || 'scout';
  const skill = agent.skills[skillId];
  const skillDef = SKILL_DEFS[skillId];
  if (!skill || !skillDef) return;
  if (skill.cooldown > 0) return;

  const xpGain = SKILL_ACTION_XP[normalizedAction] || 2;
  skill.xp += xpGain;

  const levelXpTarget = skill.level * skillDef.xpPerLevel;
  if (skill.xp >= levelXpTarget) {
    if (skill.level < skillDef.maxLevel) {
      skill.level += 1;
    }
    skill.xp = 0;
  }

  skill.cooldown = skillDef.cooldownSec;
}

function decayAgentSkillCooldowns(agent, dtSec) {
  if (!agent.skillsNormalized) {
    ensureAgentSkills(agent);
  }

  for (const skillId of SKILL_IDS) {
    const skill = agent.skills[skillId];
    skill.cooldown = Math.max(0, skill.cooldown - dtSec);
  }
}

// Validate movement position (clamp to world bounds)
function validatePosition(pos) {
  const numericX = Number(pos?.x);
  const numericY = Number(pos?.y);
  const numericZ = Number(pos?.z);
  const rawX = Number.isFinite(numericX) ? numericX : 0;
  const rawZ = Number.isFinite(numericZ) ? numericZ : 0;
  const clampedX = clampWorldCoordX(rawX);
  const clampedZ = clampWorldCoordZ(rawZ);
  const traversable = hasGroundTileAt(clampedX, clampedZ)
    ? { x: clampedX, z: clampedZ }
    : findNearestTraversablePoint(clampedX, clampedZ);

  return {
    x: traversable.x,
    y: Math.max(0, Math.min(5, Number.isFinite(numericY) ? numericY : 0)),
    z: traversable.z
  };
}

// Clamp movement to realistic distance from current position
function clampMovement(currentPos, targetPos) {
  const normalizedCurrent = validatePosition(currentPos || {});
  const validated = validatePosition(targetPos);
  const dx = validated.x - normalizedCurrent.x;
  const dy = validated.y - normalizedCurrent.y;
  const dz = validated.z - normalizedCurrent.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (distance <= MAX_MOVE_DISTANCE) {
    return validated;
  }

  // Scale down to max distance
  const scale = MAX_MOVE_DISTANCE / distance;
  return validatePosition({
    x: normalizedCurrent.x + dx * scale,
    y: normalizedCurrent.y + dy * scale,
    z: normalizedCurrent.z + dz * scale
  });
}

function getOwnedAgentOrReject(req, res, agentId) {
  const agent = worldState.agents.get(agentId);
  if (!agent) {
    res.status(404).json({
      success: false,
      error: 'Agent not found'
    });
    return null;
  }
  if (!agent.entityId || req.entityId !== agent.entityId) {
    res.status(403).json({
      success: false,
      error: 'Forbidden'
    });
    return null;
  }
  return agent;
}

function normalizeRuntimeSkillPayload(skill) {
  const source = skill && typeof skill === 'object' ? skill : {};
  return {
    level: Math.max(1, Math.floor(Number(source.level) || 1)),
    xp: Math.max(0, Math.floor(Number(source.xp) || 0)),
    cooldown: Math.max(0, Number(source.cooldown) || 0)
  };
}

function buildRuntimeStatsPayload(agent) {
  if (!agent || typeof agent !== 'object') return null;
  ensureAgentSkills(agent);
  ensureAgentInventory(agent);

  return {
    energy: clampEnergy(agent.energy),
    sleeping: Boolean(agent.sleeping),
    capturedAt: Date.now(),
    inventory: { ...agent.inventory },
    expansionCooldownUntilTick: Math.max(0, Math.floor(Number(agent.expansionCooldownUntilTick) || 0)),
    skills: {
      scout: normalizeRuntimeSkillPayload(agent.skills?.scout),
      forage: normalizeRuntimeSkillPayload(agent.skills?.forage),
      shellGuard: normalizeRuntimeSkillPayload(agent.skills?.shellGuard),
      builder: normalizeRuntimeSkillPayload(agent.skills?.builder)
    }
  };
}

function findOnlineAgentByEntityId(entityId) {
  for (const agent of worldState.agents.values()) {
    if (agent.entityId === entityId) return agent;
  }
  return null;
}

function getAgentSectorPosition(position = {}) {
  return {
    x: Math.round(Number(position?.x) || 0),
    z: Math.round(Number(position?.z) || 0)
  };
}

function getAgentVisitedSectors(agent) {
  if (!agent) return new Set();
  if (!(agent.visitedSectors instanceof Set)) {
    agent.visitedSectors = new Set();
    const current = getAgentSectorPosition(agent.position);
    agent.visitedSectors.add(`${current.x},${current.z}`);
  }
  return agent.visitedSectors;
}

function getAgentExpansionTiles(agent) {
  if (!agent) return new Set();
  if (!(agent.expandedFrontierTiles instanceof Set)) {
    agent.expandedFrontierTiles = new Set();
  }
  return agent.expandedFrontierTiles;
}

function updateMovementExplorationQuestProgress(agent, previousPosition = {}, nextPosition = {}) {
  if (!agent?.entityId) return;

  const visitedSectors = getAgentVisitedSectors(agent);
  const beforeSector = getAgentSectorPosition(previousPosition);
  const afterSector = getAgentSectorPosition(nextPosition);
  const afterKey = `${afterSector.x},${afterSector.z}`;
  const enteredUnvisitedSector = !visitedSectors.has(afterKey);

  if (!enteredUnvisitedSector) return;

  const dx = (Number(nextPosition?.x) || 0) - (Number(previousPosition?.x) || 0);
  const dz = (Number(nextPosition?.z) || 0) - (Number(previousPosition?.z) || 0);
  const distance = Math.sqrt((dx * dx) + (dz * dz));

  visitedSectors.add(afterKey);
  visitedSectors.add(`${beforeSector.x},${beforeSector.z}`);

  updateQuestProgress(agent.entityId, {
    unexploredSectorsVisited: 1,
    unexploredTraversalDistance: distance
  }).catch(() => {});
}

function updateExpansionExplorationQuestProgress(agent, placement) {
  if (!agent?.entityId || !placement?.ok || !placement.tile) return;

  const expandedTiles = getAgentExpansionTiles(agent);
  const tileKey = `${placement.tile.x},${placement.tile.z}`;
  const isFirstExpansion = expandedTiles.size === 0;
  const isNewTileForEntity = !expandedTiles.has(tileKey);

  if (isNewTileForEntity) {
    expandedTiles.add(tileKey);
  }

  let cooperativeExpansionChains = 0;
  if (placement.tile?.ownerEntityId) {
    const adjacentEntityIds = new Set();
    const offsets = [
      [1, 0], [-1, 0], [0, 1], [0, -1]
    ];
    for (const [dx, dz] of offsets) {
      const neighbor = worldState.expansionTiles.find((tile) => (
        Number(tile?.x) === Number(placement.tile.x) + dx
        && Number(tile?.z) === Number(placement.tile.z) + dz
      ));
      if (!neighbor?.ownerEntityId || neighbor.ownerEntityId === placement.tile.ownerEntityId) continue;
      adjacentEntityIds.add(neighbor.ownerEntityId);
    }
    cooperativeExpansionChains = adjacentEntityIds.size;
  }

  updateQuestProgress(agent.entityId, {
    firstExpansionTilePlaced: isFirstExpansion ? 1 : 0,
    frontierTilesExpanded: isNewTileForEntity ? 1 : 0,
    cooperativeExpansionChains
  }).catch(() => {});
}

async function resolveEntityById(entityId) {
  const memoryEntity = getMemoryEntities()?.get(entityId) || null;
  if (memoryEntity) return memoryEntity;
  if (!process.env.DATABASE_URL) return null;
  return db.getEntity(entityId);
}

// Format uptime from milliseconds to human readable string
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);

  const parts = [];
  if (months > 0) parts.push(`${months}mo`);
  if (days % 30 > 0) parts.push(`${days % 30}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  parts.push(`${seconds % 60}s`);

  return parts.join(' ');
}

function worldPhaseFromHour(hour) {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'day';
  return 'dusk';
}

function getWorldTimeState(nowMs = Date.now()) {
  const worldAnchor = Number(worldState.worldCreatedAt) || Number(worldState.startTime) || nowMs;
  const elapsedSinceWorldStartMs = Math.max(0, nowMs - worldAnchor);
  const now = new Date(nowMs);
  const timeHours = (
    now.getUTCHours() +
    (now.getUTCMinutes() / 60) +
    (now.getUTCSeconds() / 3600) +
    (now.getUTCMilliseconds() / 3600000)
  );
  const elapsedSeconds = timeHours * 60 * 60;
  const simulatedDays = Math.floor(elapsedSinceWorldStartMs / (DAY_NIGHT_CYCLE_SECONDS * 1000));

  return {
    day: simulatedDays + 1,
    timeHours,
    dayPhase: worldPhaseFromHour(timeHours),
    cycleSeconds: DAY_NIGHT_CYCLE_SECONDS,
    elapsedSeconds,
    clockEpochMs: nowMs
  };
}

function isSystemChatMessage(chatMessage) {
  return String(chatMessage?.agentName || '').toLowerCase() === 'system';
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

function isReplyStyleMessage(message) {
  if (!message || typeof message !== 'string') return false;
  return /^\s*@([a-zA-Z0-9_-]{3,64})/.test(message);
}

async function updateQuestProgress(entityId, increments = {}) {
  if (!process.env.DATABASE_URL || !entityId) return;
  const hasIncrement = Object.values(increments).some(v => (Number(v) || 0) !== 0);
  if (!hasIncrement) return;

  const questProgressMap = {
    'daily-social-chat': { chatSent: increments.chatSent || 0 },
    'daily-explorer': { moveCount: increments.moveCount || 0 },
    'daily-queue-operator': { queueActions: increments.queueActions || 0 },
    'daily-mention-network': { mentionSent: increments.mentionSent || 0 },
    'exploration-first-expansion': { firstExpansionTilePlaced: increments.firstExpansionTilePlaced || 0 },
    'exploration-frontier-cartographer': { frontierTilesExpanded: increments.frontierTilesExpanded || 0 },
    'exploration-unseen-traverse': {
      unexploredSectorsVisited: increments.unexploredSectorsVisited || 0,
      unexploredTraversalDistance: increments.unexploredTraversalDistance || 0
    },
    'exploration-cooperative-chain': { cooperativeExpansionChains: increments.cooperativeExpansionChains || 0 }
  };

  for (const [questId, questIncrements] of Object.entries(questProgressMap)) {
    try {
      await db.incrementEntityQuestProgress(entityId, questId, questIncrements);
    } catch (error) {
      console.error('Failed quest progress update', { entityId, questId, error: error.message });
    }
  }
}

// Add chat message to history (keep last 100 messages)
// Also saves conversation per-entity for full chat history
async function addChatMessage(agentId, agentName, message, entityId, options = {}) {
  const timestamp = Date.now();
  const chatMessage = {
    agentId,
    agentName,
    message,
    timestamp
  };
  const includeInHistory = options.includeInHistory ?? !isSystemChatMessage(chatMessage);
  const persistToDatabase = options.persistToDatabase ?? includeInHistory;

  if (includeInHistory) {
    worldState.chatMessages.push(chatMessage);
    
    // Keep only last 100 messages in memory
    if (worldState.chatMessages.length > 100) {
      worldState.chatMessages = worldState.chatMessages.slice(-100);
    }
  }

  // Save to database (if enabled)
  if (persistToDatabase && process.env.DATABASE_URL) {
    try {
      await db.saveChatMessage(agentId, agentName, message, timestamp);
      // Also save to per-entity conversation history
      if (entityId) {
        await db.saveConversationMessage(entityId, agentId, agentName, message, timestamp);
      }
    } catch (error) {
      console.error('Error saving chat message to database:', error);
    }
  }

  if (entityId) {
    const mentionTargets = parseMentionTargets(message);
    const isReply = isReplyStyleMessage(message);
    const senderIncrements = {
      chatSent: 1,
      mentionSent: mentionTargets.length,
      replySent: isReply ? 1 : 0
    };

    updateQuestProgress(entityId, senderIncrements).catch(() => {});

    for (const targetName of mentionTargets) {
      const targetAgent = findAgentByName(targetName);
      if (!targetAgent?.entityId || targetAgent.entityId === entityId) continue;
      updateQuestProgress(targetAgent.entityId, { mentionReceived: 1 }).catch(() => {});
    }
  }
}

// ============= HTTP API ENDPOINTS =============

// Spawn an authenticated entity into the world
app.post('/spawn', requireAuth, async (req, res) => {
  try {
    const entityId = req.entityId; // Set by requireAuth middleware
    
    if (!entityId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }
    
    // Fetch entity info
    let entity = null;
    if (process.env.DATABASE_URL) {
      entity = await db.getEntity(entityId);
    } else {
      const memoryEntities = getMemoryEntities();
      entity = memoryEntities?.get(entityId);
    }
    
    if (!entity) {
      return res.status(404).json({
        success: false,
        error: 'Entity not found'
      });
    }
    
    // Check if already spawned
    let agent = null;
    for (const [id, a] of worldState.agents) {
      if (a.entityId === entityId) {
        agent = a;
        break;
      }
    }
    
    // Create new agent if not exists
    if (!agent) {
      const agentId = uuidv4();
      agent = new Agent(agentId, entityId);
      agent.entityId = entityId; // Link agent to entity
      agent.entityType = entity.entity_type;
      agent.entityName = entity.entity_name || null;
      agent.numericId = entity.numeric_id || null;
      worldState.agents.set(agentId, agent);
      markAgentUpdated(agent);

      console.log(`Entity spawned: ${entityId} as agent ${agentId}`);
    } else {
      // Update existing agent
      agent.lastUpdate = Date.now();
      agent.connected = true;
      markAgentUpdated(agent);
      console.log(`Entity reconnected: ${entityId}`);
    }

    agent.position = validatePosition(agent.position || {});
    pushEntityRecentPosition(agent.entityId || entityId, agent.position);
    
    res.json({
      success: true,
      agentId: agent.id,
      position: agent.position,
      worldSize: WORLD_SIZE,
      entityId: entityId,
      entityName: agent.entityName,
      numericId: agent.numericId
    });
  } catch (error) {
    console.error('Error spawning entity:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Move agent
app.post('/move', requireAuth, rateLimiters.move, (req, res) => {
  try {
    const { agentId, position, rotation } = req.body;
    
    if (!agentId) {
      return res.status(400).json({ 
        success: false, 
        error: 'agentId is required' 
      });
    }
    
    const agent = getOwnedAgentOrReject(req, res, agentId);
    if (!agent) return;

    if (agent.sleeping) {
      return res.status(409).json({
        success: false,
        error: 'Agent is sleeping to recover energy'
      });
    }
    
    // Update agent position with realistic distance clamping
    const previousPosition = { ...agent.position };
    if (position) {
      agent.position = clampMovement(agent.position, position);
      updateMovementExplorationQuestProgress(agent, previousPosition, agent.position);
      pushEntityRecentPosition(agent.entityId, agent.position);
    }
    if (rotation !== undefined) {
      agent.rotation = Number(rotation) || 0;
    }
    agent.state = 'moving';
    agent.lastUpdate = Date.now();
    markAgentUpdated(agent);
    updateQuestProgress(agent.entityId, { moveCount: 1 }).catch(() => {});
    noteRuntimeAction(agent.entityId, 'move');
    res.json({ success: true });
  } catch (error) {
    console.error('Error moving agent:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Send chat message
app.post('/chat', requireAuth, rateLimiters.chat, async (req, res) => {
  try {
    const { agentId, message } = req.body;
    
    if (!agentId) {
      return res.status(400).json({ 
        success: false, 
        error: 'agentId is required' 
      });
    }

    let normalizedMessage;
    try {
      normalizedMessage = normalizeChatMessage(message);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    if (isLowSignalChatMessage(normalizedMessage)) {
      return res.status(400).json({
        success: false,
        error: 'message is too low-signal; include a specific, meaningful statement'
      });
    }
    
    const agent = getOwnedAgentOrReject(req, res, agentId);
    if (!agent) return;

    if (agent.sleeping) {
      return res.status(409).json({
        success: false,
        error: 'Agent is sleeping to recover energy'
      });
    }

    const duplicate = findDuplicateMessageByAgent(worldState.chatMessages, agentId, normalizedMessage);
    if (duplicate) {
      return res.status(429).json({
        success: false,
        error: 'duplicate chat detected; send a different message',
        retryAfter: Math.ceil(duplicate.retryAfterMs / 1000)
      });
    }
    
    // Add chat message to history (with entity link for conversation tracking)
    addChatMessage(agentId, agent.name, normalizedMessage, agent.entityId);
    console.log(`${agent.name}: ${truncateForLog(normalizedMessage)}`);
    
    agent.lastUpdate = Date.now();
    markAgentUpdated(agent);
    noteRuntimeAction(agent.entityId, 'chat');
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending chat:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Perform action
app.post('/action', requireAuth, rateLimiters.action, (req, res) => {
  try {
    const { agentId, action } = req.body;
    
    if (!agentId || !action) {
      return res.status(400).json({ 
        success: false, 
        error: 'agentId and action are required' 
      });
    }
    
    const agent = getOwnedAgentOrReject(req, res, agentId);
    if (!agent) return;

    const actionType = typeof action === 'object' && action && action.type ? String(action.type) : String(action || '');
    if (typeof action === 'object' && action && action.type) {
      applyQueueAction(agent, action);
    } else {
      agent.lastAction = action;
      noteRuntimeAction(agent.entityId, actionType);
      trainAgentSkill(agent, actionType);
      const eventResults = applyRotatingEventActionHooks(agent, actionType, {
        position: agent.position,
        source: 'action_endpoint'
      });
      if (eventResults.length > 0) {
        agent.eventProgress = {
          ...(agent.eventProgress && typeof agent.eventProgress === 'object' ? agent.eventProgress : {}),
          updatedAt: Date.now(),
          lastActionType: actionType,
          matched: eventResults
        };
      }
      markAgentUpdated(agent);
    }
    agent.lastUpdate = Date.now();
    markAgentUpdated(agent);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error performing action:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});



function getUtcDateKey(timestampMs = Date.now()) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function getRuntimeTelemetryKey(entityId, dateKey = getUtcDateKey()) {
  return `${entityId}::${dateKey}`;
}

function ensureRuntimeTelemetryRecord(entityId, dateKey = getUtcDateKey()) {
  const key = getRuntimeTelemetryKey(entityId, dateKey);
  if (!runtimeDailyTelemetry.has(key)) {
    runtimeDailyTelemetry.set(key, {
      entityId,
      date: dateKey,
      ticksTotal: 0,
      idleTicks: 0,
      socialActions: 0,
      objectiveActions: 0,
      uniqueSectors: 0,
      expansionTilesPlaced: 0,
      queueCompleted: 0,
      queueFailed: 0,
      queueExpired: 0,
      queueCancelled: 0,
      queueFailureReasons: {}
    });
  }
  return runtimeDailyTelemetry.get(key);
}

function markRuntimeTelemetryDirty(record) {
  if (!record) return;
  runtimeTelemetryPersistBuffer.set(getRuntimeTelemetryKey(record.entityId, record.date), {
    ...record,
    queueFailureReasons: { ...(record.queueFailureReasons || {}) }
  });
}

function noteRuntimeTick(agent) {
  if (!agent?.entityId) return;
  const record = ensureRuntimeTelemetryRecord(agent.entityId);
  record.ticksTotal += 1;
  if ((agent.state || 'idle') === 'idle') {
    record.idleTicks += 1;
  }
  const visitedSectors = getAgentVisitedSectors(agent);
  record.uniqueSectors = Math.max(record.uniqueSectors, visitedSectors.size);
  markRuntimeTelemetryDirty(record);
}

function noteRuntimeAction(entityId, actionType) {
  if (!entityId) return;
  const normalized = String(actionType || '').trim().toLowerCase();
  if (!normalized) return;

  const record = ensureRuntimeTelemetryRecord(entityId);
  if (SOCIAL_ACTION_TYPES.has(normalized)) {
    record.socialActions += 1;
  }
  if (OBJECTIVE_ACTION_TYPES.has(normalized)) {
    record.objectiveActions += 1;
  }
  markRuntimeTelemetryDirty(record);
}

function noteExpansionTilePlaced(entityId, tileCount = 1) {
  if (!entityId) return;
  const record = ensureRuntimeTelemetryRecord(entityId);
  record.expansionTilesPlaced += Math.max(0, Number(tileCount) || 0);
  markRuntimeTelemetryDirty(record);
}

function noteQueueTerminalStatus(queue, status, reason = null) {
  if (!queue?.entityId) return;
  const record = ensureRuntimeTelemetryRecord(queue.entityId);
  if (status === 'completed') record.queueCompleted += 1;
  if (status === 'failed') record.queueFailed += 1;
  if (status === 'expired') record.queueExpired += 1;
  if (status === 'cancelled') record.queueCancelled += 1;
  if (reason) {
    const key = String(reason).trim().slice(0, 64) || 'unknown';
    record.queueFailureReasons[key] = (Number(record.queueFailureReasons[key]) || 0) + 1;
  }
  markRuntimeTelemetryDirty(record);
}

function toRatio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function getRuntimeTelemetrySnapshotForEntity(entityId, days = 1) {
  const rows = getInMemoryTelemetryAggregate(days);
  const row = rows.find((item) => item.entityId === entityId) || {
    entityId,
    ticksTotal: 0,
    idleTicks: 0,
    socialActions: 0,
    objectiveActions: 0,
    uniqueSectors: 0,
    expansionTilesPlaced: 0,
    queueCompleted: 0,
    queueFailed: 0,
    queueExpired: 0,
    queueCancelled: 0,
    queueFailureReasons: {}
  };
  return summarizeTelemetryEntityRow(row);
}

function summarizeTelemetryEntityRow(row) {
  const ticksTotal = Number(row.ticksTotal || 0);
  const idleTicks = Number(row.idleTicks || 0);
  const socialActions = Number(row.socialActions || 0);
  const objectiveActions = Number(row.objectiveActions || 0);
  const totalActions = socialActions + objectiveActions;

  return {
    entityId: row.entityId,
    ticksTotal,
    idleTicks,
    idleTimeRatio: toRatio(idleTicks, ticksTotal),
    socialActions,
    objectiveActions,
    socialActionRatio: toRatio(socialActions, totalActions),
    objectiveActionRatio: toRatio(objectiveActions, totalActions),
    uniqueSectorCoveragePerDay: Number(row.uniqueSectors || 0),
    expansionTilesPlacedPerDay: Number(row.expansionTilesPlaced || 0),
    queue: {
      completed: Number(row.queueCompleted || 0),
      failed: Number(row.queueFailed || 0),
      expired: Number(row.queueExpired || 0),
      cancelled: Number(row.queueCancelled || 0),
      failureReasons: row.queueFailureReasons || {}
    }
  };
}

function getInMemoryTelemetryAggregate(days = 7) {
  const safeDays = Math.max(1, Math.min(90, Number(days) || 7));
  const thresholdTs = new Date(`${getUtcDateKey()}T00:00:00.000Z`).getTime() - ((safeDays - 1) * 24 * 60 * 60 * 1000);
  const byEntity = new Map();

  for (const record of runtimeDailyTelemetry.values()) {
    const dateTs = new Date(`${record.date}T00:00:00.000Z`).getTime();
    if (dateTs < thresholdTs) continue;
    if (!byEntity.has(record.entityId)) {
      byEntity.set(record.entityId, {
        entityId: record.entityId,
        ticksTotal: 0,
        idleTicks: 0,
        socialActions: 0,
        objectiveActions: 0,
        uniqueSectors: 0,
        expansionTilesPlaced: 0,
        queueCompleted: 0,
        queueFailed: 0,
        queueExpired: 0,
        queueCancelled: 0,
        queueFailureReasons: {}
      });
    }

    const target = byEntity.get(record.entityId);
    target.ticksTotal += Number(record.ticksTotal || 0);
    target.idleTicks += Number(record.idleTicks || 0);
    target.socialActions += Number(record.socialActions || 0);
    target.objectiveActions += Number(record.objectiveActions || 0);
    target.uniqueSectors += Number(record.uniqueSectors || 0);
    target.expansionTilesPlaced += Number(record.expansionTilesPlaced || 0);
    target.queueCompleted += Number(record.queueCompleted || 0);
    target.queueFailed += Number(record.queueFailed || 0);
    target.queueExpired += Number(record.queueExpired || 0);
    target.queueCancelled += Number(record.queueCancelled || 0);
    const reasons = record.queueFailureReasons || {};
    for (const [reasonKey, count] of Object.entries(reasons)) {
      target.queueFailureReasons[reasonKey] = (Number(target.queueFailureReasons[reasonKey]) || 0) + (Number(count) || 0);
    }
  }

  return Array.from(byEntity.values());
}

function getTelemetryRegressions(rows, limit = 10) {
  const scored = rows
    .map((row) => {
      const idleRatio = row.idleTimeRatio;
      const expansionScore = Math.min(1, Number(row.expansionTilesPlacedPerDay || 0) / 3);
      const queuePressure = Math.min(1, (Number(row.queue.failed || 0) + Number(row.queue.expired || 0)) / Math.max(1, Number(row.queue.completed || 0) + Number(row.queue.failed || 0) + Number(row.queue.expired || 0)));
      const score = Number((idleRatio * 0.55 + (1 - expansionScore) * 0.3 + queuePressure * 0.15).toFixed(4));
      return {
        entityId: row.entityId,
        score,
        idleTimeRatio: idleRatio,
        expansionTilesPlacedPerDay: row.expansionTilesPlacedPerDay,
        objectiveActionRatio: row.objectiveActionRatio,
        queueFailed: row.queue.failed,
        queueExpired: row.queue.expired
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(25, Number(limit) || 10)));

  return scored;
}

async function flushRuntimeTelemetryPersistBuffer() {
  if (!process.env.DATABASE_URL || runtimeTelemetryPersistBuffer.size === 0) return;
  const snapshots = Array.from(runtimeTelemetryPersistBuffer.values());
  runtimeTelemetryPersistBuffer.clear();

  for (const snapshot of snapshots) {
    try {
      await db.upsertEntityRuntimeDailyStats(snapshot.entityId, snapshot.date, snapshot);
    } catch (error) {
      console.error('Error persisting runtime telemetry snapshot:', error);
      runtimeTelemetryPersistBuffer.set(getRuntimeTelemetryKey(snapshot.entityId, snapshot.date), snapshot);
    }
  }
}

function serializeQueue(queue) {
  if (!queue) return null;
  return {
    queueId: queue.queueId,
    entityId: queue.entityId,
    status: queue.status,
    totalItems: queue.totalItems,
    totalRequiredTicks: queue.totalRequiredTicks,
    currentIndex: queue.currentIndex,
    remainingTicks: queue.remainingTicks,
    startedAtTick: queue.startedAtTick,
    completedAtTick: queue.completedAtTick,
    lastError: queue.lastError,
    executedActions: queue.executedActions,
    limits: {
      maxActions: MAX_QUEUE_ACTIONS,
      maxTotalTicks: MAX_QUEUE_TOTAL_TICKS
    }
  };
}

function queueLifecycleSnapshot(queue) {
  return {
    ...queue,
    startedAt: queue.startedAtTick !== null ? Date.now() : null,
    completedAt: queue.completedAtTick !== null ? Date.now() : null,
  };
}

function persistQueueLifecycle(queue) {
  if (!process.env.DATABASE_URL || !queue) return;
  queueLifecyclePersistBuffer.set(queue.queueId, queueLifecycleSnapshot(queue));
}

async function flushQueueLifecyclePersistBuffer() {
  if (!process.env.DATABASE_URL || queueLifecyclePersistBuffer.size === 0) return;
  const snapshots = Array.from(queueLifecyclePersistBuffer.values());
  queueLifecyclePersistBuffer.clear();

  for (const snapshot of snapshots) {
    try {
      await db.saveEntityActionQueue(snapshot);
    } catch (error) {
      console.error('Error persisting action queue lifecycle:', error);
      queueLifecyclePersistBuffer.set(snapshot.queueId, snapshot);
    }
  }
}

function findAgentByEntityId(entityId) {
  for (const agent of worldState.agents.values()) {
    if (agent.entityId === entityId) return agent;
  }
  return null;
}

function findAgentByName(name) {
  const targetName = String(name || '').trim();
  if (!targetName) return null;
  for (const candidate of worldState.agents.values()) {
    if (candidate.name === targetName) return candidate;
  }
  return null;
}

function findNearestAvailableAlgaePallet(agent) {
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const object of worldState.objects.values()) {
    if (object.type !== 'algae_pallet') continue;
    const servesRemaining = Math.max(0, Math.floor(Number(object.data?.servesRemaining) || 0));
    if (servesRemaining <= 0) continue;
    const distance = distance2D(agent.position, object.position);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = object;
    }
  }

  return { pallet: nearest, distance: nearestDistance };
}

function inventoryHasExpandCost(inventory) {
  if (!inventory || typeof inventory !== 'object') return false;
  return ['rock', 'kelp', 'seaweed'].every((key) => Number(inventory[key] || 0) >= 1);
}

function deductExpandCost(inventory) {
  for (const key of ['rock', 'kelp', 'seaweed']) {
    inventory[key] = Math.max(0, Math.floor(Number(inventory[key] || 0) - 1));
  }
}

function findNearestHarvestableObject(agent, requestedType = null, requestedObjectId = null) {
  const requested = requestedType ? String(requestedType).trim().toLowerCase() : null;
  const allowed = new Set(['rock', 'kelp', 'seaweed']);
  if (requested && !allowed.has(requested)) return { object: null, distance: Number.POSITIVE_INFINITY };

  if (requestedObjectId) {
    const object = worldState.objects.get(requestedObjectId);
    if (!object) return { object: null, distance: Number.POSITIVE_INFINITY };
    if (!allowed.has(object.type)) return { object: null, distance: Number.POSITIVE_INFINITY };
    if (requested && object.type !== requested) return { object: null, distance: Number.POSITIVE_INFINITY };
    return {
      object,
      distance: distance2D(agent.position, object.position)
    };
  }

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const object of worldState.objects.values()) {
    if (!allowed.has(object.type)) continue;
    if (requested && object.type !== requested) continue;
    const distance = distance2D(agent.position, object.position);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = object;
    }
  }
  return { object: nearest, distance: nearestDistance };
}

function tileKey(x, z) {
  return `${x},${z}`;
}

function hasExpansionTileAt(x, z) {
  const tileX = Math.round(Number(x));
  const tileZ = Math.round(Number(z));
  return worldState.expansionTiles.some((tile) => tile.x === tileX && tile.z === tileZ);
}

function isBaseWorldTile(x, z) {
  return x >= 0 && x <= WORLD_SIZE.x && z >= 0 && z <= WORLD_SIZE.y;
}

function hasGroundTileAt(x, z) {
  if (isBaseWorldTile(x, z)) return true;
  return hasExpansionTileAt(x, z);
}

function findNearestTraversablePoint(x, z) {
  const fromX = Number.isFinite(Number(x)) ? Number(x) : 0;
  const fromZ = Number.isFinite(Number(z)) ? Number(z) : 0;

  let best = {
    x: Math.max(0, Math.min(WORLD_SIZE.x, fromX)),
    z: Math.max(0, Math.min(WORLD_SIZE.y, fromZ))
  };
  let bestDistanceSq = ((best.x - fromX) ** 2) + ((best.z - fromZ) ** 2);

  for (const tile of worldState.expansionTiles) {
    const tileX = Number(tile?.x);
    const tileZ = Number(tile?.z);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileZ)) continue;
    const candidateX = Math.max(tileX - 0.5, Math.min(tileX + 0.5, fromX));
    const candidateZ = Math.max(tileZ - 0.5, Math.min(tileZ + 0.5, fromZ));
    const distanceSq = ((candidateX - fromX) ** 2) + ((candidateZ - fromZ) ** 2);
    if (distanceSq < bestDistanceSq) {
      best = { x: candidateX, z: candidateZ };
      bestDistanceSq = distanceSq;
    }
  }

  return best;
}

function hasAdjacentGroundTile(x, z) {
  const offsets = [
    [1, 0], [-1, 0], [0, 1], [0, -1]
  ];
  return offsets.some(([dx, dz]) => hasGroundTileAt(x + dx, z + dz));
}

function chooseExpansionTileForAgent(agent, preferred = null) {
  const candidates = [];

  if (preferred && Number.isFinite(Number(preferred.x)) && Number.isFinite(Number(preferred.z))) {
    candidates.push({
      x: Math.round(Number(preferred.x)),
      z: Math.round(Number(preferred.z))
    });
  }

  const originX = Math.round(Number(agent.position?.x) || 0);
  const originZ = Math.round(Number(agent.position?.z) || 0);
  for (let ring = 0; ring <= 5; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.abs(dx) + Math.abs(dz) !== ring) continue;
        candidates.push({ x: originX + dx, z: originZ + dz });
      }
    }
  }

  for (const candidate of candidates) {
    const { x, z } = candidate;
    if (isBaseWorldTile(x, z)) continue;
    if (hasExpansionTileAt(x, z)) continue;
    if (!hasAdjacentGroundTile(x, z)) continue;
    return candidate;
  }

  return null;
}

function addExpansionTile(agent, preferred = null) {
  if (worldState.expansionTiles.length >= MAP_EXPANSION_MAX_TILES) {
    return { ok: false, reason: 'max_tiles_reached' };
  }

  const selected = chooseExpansionTileForAgent(agent, preferred);
  if (!selected) {
    return { ok: false, reason: 'no_valid_adjacent_tile' };
  }

  const tile = {
    id: `expansion-${uuidv4()}`,
    x: selected.x,
    z: selected.z,
    ownerAgentId: agent.id,
    ownerEntityId: agent.entityId || null,
    createdAt: Date.now(),
    tick: worldState.tick
  };

  worldState.expansionTiles.push(tile);
  if (worldState.expansionTiles.length > MAP_EXPANSION_MAX_TILES) {
    worldState.expansionTiles = worldState.expansionTiles.slice(-MAP_EXPANSION_MAX_TILES);
  }
  worldState.mapExpansionLevel = worldState.expansionTiles.length;

  return { ok: true, tile };
}

function applyAgentEnergyTick(agent, dtSeconds, worldPhase = 'day') {
  if (!agent) return;

  const now = Date.now();
  const currentEnergy = clampEnergy(agent.energy);
  let nextEnergy = currentEnergy;
  const stateKey = String(agent.state || '').toLowerCase();

  if (agent.sleeping) {
    const sleepRecoveryMultiplier = worldPhase === 'night' ? 1.1 : 1;
    nextEnergy = clampEnergy(currentEnergy + (AGENT_SLEEP_RECHARGE_PER_SEC * sleepRecoveryMultiplier * dtSeconds));
    if (nextEnergy >= AGENT_ENERGY_WAKE_THRESHOLD) {
      agent.sleeping = false;
      if (stateKey === 'sleeping') {
        agent.state = 'idle';
      }
      if (now - agent.lastEnergyEventAt > 5000) {
        agent.lastEnergyEventAt = now;
        addChatMessage(agent.id, 'system', `${agent.name} woke up after recharging energy.`, null);
      }
    }
  } else {
    const baseDrain = AGENT_ENERGY_IDLE_DRAIN_PER_SEC;
    const stateDrain = AGENT_ENERGY_STATE_DRAIN_PER_SEC[stateKey] || 0;
    const phaseEnergyDrainMultiplier = worldPhase === 'night' ? 1.25 : worldPhase === 'dusk' ? 1.1 : 1;
    nextEnergy = clampEnergy(currentEnergy - ((baseDrain + stateDrain) * phaseEnergyDrainMultiplier * dtSeconds));
    if (nextEnergy <= AGENT_ENERGY_COLLAPSE_THRESHOLD) {
      agent.sleeping = true;
      agent.state = 'sleeping';
      if (now - agent.lastEnergyEventAt > 5000) {
        agent.lastEnergyEventAt = now;
        addChatMessage(agent.id, 'system', `${agent.name} is low on energy and fell asleep.`, null);
      }
    }
  }

  if (!agent.sleeping && nextEnergy < AGENT_ALGAE_CONSUME_THRESHOLD) {
    const nearest = findNearestAvailableAlgaePallet(agent);
    if (nearest.pallet && nearest.distance <= (getObjectRadius('algae_pallet', nearest.pallet.data) + 1.2)) {
      const energyGain = Number(nearest.pallet.data?.energyPerServe) || ALGAE_PALLET_ENERGY_PER_SERVE;
      nextEnergy = clampEnergy(nextEnergy + energyGain);
      nearest.pallet.data = {
        ...nearest.pallet.data,
        servesRemaining: Math.max(0, (Math.floor(Number(nearest.pallet.data?.servesRemaining) || 0) - 1)),
        lastConsumedAt: now
      };
    }
  }

  agent.energy = nextEnergy;
}

function buildDeterministicNearbyTarget(agent, targetAgent) {
  const seed = `${agent?.id || ''}:${targetAgent?.id || ''}:${targetAgent?.name || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash * 31) + seed.charCodeAt(i)) >>> 0;
  }

  const offsetX = ((hash & 0xff) / 255 - 0.5) * 2;
  const offsetZ = (((hash >> 8) & 0xff) / 255 - 0.5) * 2;

  return validatePosition({
    x: targetAgent.position.x + offsetX,
    y: targetAgent.position.y,
    z: targetAgent.position.z + offsetZ
  });
}

function applyQueueAction(agent, action) {
  if (!agent || !action) return;
  ensureAgentInventory(agent);

  if (agent.sleeping) {
    agent.lastAction = {
      type: action.type,
      skipped: true,
      reason: 'sleeping_recovering_energy'
    };
    markAgentUpdated(agent);
    return;
  }

  const finishAction = (actionType) => {
    trainAgentSkill(agent, actionType);
    const eventResults = applyRotatingEventActionHooks(agent, actionType, {
      position: agent.position,
      source: 'action_queue'
    });
    if (eventResults.length > 0) {
      agent.eventProgress = {
        ...(agent.eventProgress && typeof agent.eventProgress === 'object' ? agent.eventProgress : {}),
        updatedAt: Date.now(),
        lastActionType: actionType,
        matched: eventResults
      };
    }
    markAgentUpdated(agent);
  };

  if (action.type === 'move') {
    const previousPosition = { ...agent.position };
    agent.position = clampMovement(agent.position, {
      x: action.x,
      y: action.y ?? agent.position.y,
      z: action.z
    });
    updateMovementExplorationQuestProgress(agent, previousPosition, agent.position);
    pushEntityRecentPosition(agent.entityId, agent.position);
    if (action.rotation !== undefined) {
      agent.rotation = Number(action.rotation) || 0;
    }
    agent.state = 'moving';
    agent.lastAction = { type: 'move', x: action.x, z: action.z };
    finishAction('move');
    return;
  }

  if (action.type === 'talk') {
    let normalizedMessage;
    try {
      normalizedMessage = normalizeChatMessage(action.message);
    } catch (error) {
      normalizedMessage = null;
    }

    if (!normalizedMessage) {
      agent.lastAction = { type: 'talk', skipped: true, reason: 'invalid_message' };
      finishAction('talk');
      return;
    }

    addChatMessage(agent.id, agent.name, normalizedMessage, agent.entityId);
    agent.state = 'chatting';
    agent.lastAction = { type: 'talk', message: normalizedMessage };
    finishAction('talk');
    return;
  }

  if (action.type === 'move_to_agent') {
    const targetAgent = findAgentByName(action.agent_name);
    if (!targetAgent) {
      agent.lastAction = {
        type: 'move_to_agent',
        agent_name: action.agent_name,
        skipped: true,
        reason: 'target_agent_not_found'
      };
      finishAction('move_to_agent');
      return;
    }

    const targetPosition = buildDeterministicNearbyTarget(agent, targetAgent);
    const previousPosition = { ...agent.position };
    agent.position = clampMovement(agent.position, targetPosition);
    updateMovementExplorationQuestProgress(agent, previousPosition, agent.position);
    pushEntityRecentPosition(agent.entityId, agent.position);
    agent.state = 'moving';
    agent.lastAction = {
      type: 'move_to_agent',
      agent_name: action.agent_name,
      targetAgentId: targetAgent.id
    };
    finishAction('move_to_agent');
    return;
  }

  if (action.type === 'jump') {
    const jumpPayload = {
      type: 'jump',
      height: Number.isFinite(Number(action.height)) ? Number(action.height) : 1,
      durationTicks: Math.max(1, Math.floor(Number(action.durationTicks) || Number(action.requiredTicks) || 1)),
    };
    if (action.style) {
      jumpPayload.style = String(action.style).slice(0, 64);
    }
    agent.state = 'jumping';
    agent.lastAction = jumpPayload;
    finishAction('jump');
    return;
  }

  if (action.type === 'dance') {
    const dancePayload = {
      type: 'dance',
      style: String(action.style || 'idle-groove').slice(0, 64),
      durationTicks: Math.max(1, Math.floor(Number(action.durationTicks) || Number(action.requiredTicks) || 1)),
    };
    if (action.tempo !== undefined) {
      const tempo = Number(action.tempo);
      if (Number.isFinite(tempo)) {
        dancePayload.tempo = tempo;
      }
    }
    agent.state = 'dancing';
    agent.lastAction = dancePayload;
    finishAction('dance');
    return;
  }

  if (action.type === 'emote') {
    const emotePayload = {
      type: 'emote',
      emote: String(action.emote || 'wave').slice(0, 64),
      durationTicks: Math.max(1, Math.floor(Number(action.durationTicks) || Number(action.requiredTicks) || 1)),
    };
    if (action.intensity !== undefined) {
      const intensity = Number(action.intensity);
      if (Number.isFinite(intensity)) {
        emotePayload.intensity = intensity;
      }
    }
    agent.state = 'emoting';
    agent.lastAction = emotePayload;
    finishAction('emote');
    return;
  }

  if (action.type === 'harvest') {
    const { object, distance } = findNearestHarvestableObject(agent, action.resourceType, action.objectId);
    if (!object) {
      agent.lastAction = {
        type: 'harvest',
        skipped: true,
        reason: 'resource_not_found'
      };
      finishAction('harvest');
      return;
    }

    const interactionRange = getObjectRadius(object.type, object.data) + HARVEST_INTERACTION_BUFFER;
    if (distance > interactionRange) {
      agent.lastAction = {
        type: 'harvest',
        skipped: true,
        reason: 'resource_out_of_range',
        targetObjectId: object.id
      };
      finishAction('harvest');
      return;
    }

    const harvestedType = object.type;
    agent.inventory[harvestedType] = Math.max(0, Math.floor(Number(agent.inventory[harvestedType]) || 0)) + 1;
    worldState.objects.delete(object.id);
    if (process.env.DATABASE_URL) {
      db.deleteWorldObject(object.id).catch((error) => {
        console.error('Failed deleting harvested world object:', error);
      });
    }
    agent.state = 'acting';
    agent.lastAction = {
      type: 'harvest',
      resourceType: harvestedType,
      objectId: object.id,
      inventory: { ...agent.inventory }
    };
    finishAction('harvest');
    return;
  }

  if (action.type === 'expand_map') {
    if (worldState.tick < agent.expansionCooldownUntilTick) {
      agent.lastAction = {
        type: 'expand_map',
        skipped: true,
        reason: 'cooldown_active',
        cooldownUntilTick: agent.expansionCooldownUntilTick
      };
      finishAction('expand_map');
      return;
    }

    if (!inventoryHasExpandCost(agent.inventory)) {
      agent.lastAction = {
        type: 'expand_map',
        skipped: true,
        reason: 'insufficient_inventory',
        inventory: { ...agent.inventory }
      };
      finishAction('expand_map');
      return;
    }

    const placement = addExpansionTile(agent, {
      x: action.x,
      z: action.z
    });
    if (!placement.ok) {
      agent.lastAction = {
        type: 'expand_map',
        skipped: true,
        reason: placement.reason || 'placement_failed'
      };
      finishAction('expand_map');
      return;
    }

    deductExpandCost(agent.inventory);
    updateExpansionExplorationQuestProgress(agent, placement);
    noteExpansionTilePlaced(agent.entityId, 1);
    agent.expansionCooldownUntilTick = worldState.tick + MAP_EXPANSION_COOLDOWN_TICKS;
    agent.state = 'acting';
    agent.lastAction = {
      type: 'expand_map',
      tile: placement.tile,
      inventory: { ...agent.inventory },
      cooldownUntilTick: agent.expansionCooldownUntilTick
    };
    finishAction('expand_map');
    return;
  }

  const payload = { ...action };
  delete payload.requiredTicks;
  agent.lastAction = payload;
  agent.state = 'acting';
  noteRuntimeAction(agent.entityId, action.type);
  finishAction(action.type);
}

async function processActionQueues() {
  if (actionQueues.size === 0) return;
  const now = Date.now();
  for (const [entityId, queue] of actionQueues.entries()) {
    if (queue.expiresAtTick !== null && queue.expiresAtTick !== undefined && worldState.tick > queue.expiresAtTick) {
      queue.status = 'expired';
      queue.lastError = 'Action queue expired past tick budget';
      queue.completedAtTick = worldState.tick;
      queue.completedAtMs = now;
      persistQueueLifecycle(queue);
      noteQueueTerminalStatus(queue, 'expired', 'expired_tick_budget');
      actionQueues.delete(entityId);
      continue;
    }

    if (queue.status !== 'running') {
      if (queue.completedAtMs && now - queue.completedAtMs > QUEUE_TERMINAL_RETENTION_MS) {
        actionQueues.delete(entityId);
      }
      continue;
    }

    if (queue.currentIndex >= queue.actions.length) {
      queue.status = 'completed';
      queue.completedAtTick = worldState.tick;
      queue.completedAtMs = Date.now();
      persistQueueLifecycle(queue);
      noteQueueTerminalStatus(queue, 'completed');
      continue;
    }

    queue.remainingTicks -= 1;
    if (queue.remainingTicks > 0) continue;

    const action = queue.actions[queue.currentIndex];
    const agent = findAgentByEntityId(entityId);
    if (!agent) {
      queue.status = 'failed';
      queue.lastError = 'No active agent for entity';
      queue.completedAtTick = worldState.tick;
      queue.completedAtMs = Date.now();
      persistQueueLifecycle(queue);
      noteQueueTerminalStatus(queue, 'failed', 'no_active_agent');
      continue;
    }

    applyQueueAction(agent, action);
    updateQuestProgress(entityId, { queueActions: 1 }).catch(() => {});
    _entityWikiCache.delete(entityId);
    queue.executedActions.push({ type: action.type, tick: worldState.tick });
    queue.currentIndex += 1;

    if (queue.currentIndex >= queue.actions.length) {
      queue.status = 'completed';
      queue.completedAtTick = worldState.tick;
      queue.completedAtMs = Date.now();
      queue.remainingTicks = 0;
      persistQueueLifecycle(queue);
      noteQueueTerminalStatus(queue, 'completed');
      continue;
    }

    queue.remainingTicks = queue.actions[queue.currentIndex].requiredTicks;
  }
}

function sanitizeGoalList(goals, fallbackSource = 'entity-agent') {
  if (!Array.isArray(goals)) return null;
  const sanitized = [];
  const seen = new Set();
  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') continue;
    const rawLabel = typeof goal.label === 'string' ? goal.label.trim() : '';
    if (!rawLabel || seen.has(rawLabel)) continue;
    sanitized.push({
      label: rawLabel.slice(0, 280),
      source: (typeof goal.source === 'string' && goal.source.trim() ? goal.source.trim() : fallbackSource).slice(0, 64)
    });
    seen.add(rawLabel);
    if (sanitized.length >= 4) break;
  }
  return sanitized;
}

function calculateReflectionStreak(reflections) {
  if (!Array.isArray(reflections) || reflections.length === 0) return 0;
  const dates = reflections
    .map(item => String(item?.date || '').slice(0, 10))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));
  if (dates.length === 0) return 0;

  let streak = 0;
  let cursor = new Date(`${dates[0]}T00:00:00Z`);
  for (const dateText of dates) {
    const candidate = new Date(`${dateText}T00:00:00Z`);
    if (candidate.getTime() === cursor.getTime()) {
      streak += 1;
      cursor = new Date(cursor.getTime() - (24 * 60 * 60 * 1000));
      continue;
    }
    if (candidate.getTime() < cursor.getTime()) {
      break;
    }
  }
  return streak;
}

async function syncDynamicQuestSignals(entityId) {
  if (!process.env.DATABASE_URL || !entityId) {
    return { reflectionCount: 0, reflectionStreak: 0, shortTermGoalCount: 0 };
  }

  const reflections = await db.getEntityDailyReflections(entityId, 7);
  const reflectionCount = reflections.length;
  const reflectionStreak = calculateReflectionStreak(reflections);

  const latestGoalSnapshot = await db.getLatestEntityGoalSnapshot(entityId);
  const shortTermGoalCount = Array.isArray(latestGoalSnapshot?.shortTermGoals)
    ? latestGoalSnapshot.shortTermGoals.length
    : 0;

  await db.ensureEntityQuest(entityId, 'dynamic-reflection-consistency', {
    reflectionEntries: Math.max(reflectionCount, reflectionStreak)
  });
  await db.ensureEntityQuest(entityId, 'dynamic-goal-clarity', {
    shortTermGoals: shortTermGoalCount
  });
  await db.setEntityQuestProgress(entityId, 'dynamic-reflection-consistency', {
    reflectionEntries: Math.max(reflectionCount, reflectionStreak)
  });
  await db.setEntityQuestProgress(entityId, 'dynamic-goal-clarity', {
    shortTermGoals: shortTermGoalCount
  });

  return { reflectionCount, reflectionStreak, shortTermGoalCount };
}

app.get('/entity/:entityId/quests', optionalAuth, async (req, res) => {
  try {
    const { entityId } = req.params;

    if (process.env.DATABASE_URL) {
      await syncDynamicQuestSignals(entityId);
      const summary = await db.getEntityQuestSummary(entityId);
      const runtimeAgent = findOnlineAgentByEntityId(entityId);
      const visitedSectors = runtimeAgent?.visitedSectors instanceof Set ? runtimeAgent.visitedSectors.size : 0;
      const expandedFrontierTiles = runtimeAgent?.expandedFrontierTiles instanceof Set ? runtimeAgent.expandedFrontierTiles.size : 0;

      return res.json({
        success: true,
        entityId,
        ...summary,
        counts: {
          active: summary.active.length,
          completed: summary.completed.length,
          claimed: summary.claimed.length
        },
        explorationSignals: {
          visitedSectors,
          expandedFrontierTiles
        }
      });
    }

    const runtimeAgent = findOnlineAgentByEntityId(entityId);
    const visitedSectors = runtimeAgent?.visitedSectors instanceof Set ? runtimeAgent.visitedSectors.size : 0;
    const expandedFrontierTiles = runtimeAgent?.expandedFrontierTiles instanceof Set ? runtimeAgent.expandedFrontierTiles.size : 0;

    return res.json({
      success: true,
      entityId,
      active: [],
      completed: [],
      claimed: [],
      counts: { active: 0, completed: 0, claimed: 0 },
      explorationSignals: {
        visitedSectors,
        expandedFrontierTiles
      }
    });
  } catch (error) {
    console.error('Failed to load quest summary:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/entity/:entityId/quests/:questId/claim', requireAuth, async (req, res) => {
  try {
    const { entityId, questId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ success: false, error: 'Quest claims require database mode' });
    }

    const claimed = await db.claimEntityQuest(entityId, questId);
    if (!claimed) {
      return res.status(409).json({
        success: false,
        error: 'Quest is not claimable (must be completed and unclaimed)'
      });
    }

    return res.json({ success: true, quest: claimed });
  } catch (error) {
    console.error('Failed to claim quest:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============= ACTION QUEUE ROUTES =============
app.get('/entity/:entityId/action-queue', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const runtimeQueue = actionQueues.get(entityId);
    let recent = [];
    if (process.env.DATABASE_URL) {
      recent = await db.getRecentEntityActionQueues(entityId, 10);
    }

    return res.json({ success: true, queue: serializeQueue(runtimeQueue), recent });
  } catch (error) {
    console.error('Error reading action queue:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/entity/:entityId/action-queue', requireAuth, rateLimiters.action, async (req, res) => {
  try {
    const { entityId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const agent = findAgentByEntityId(entityId);
    if (!agent) {
      return res.status(409).json({ success: false, error: 'Entity must be spawned before creating a queue' });
    }

    const { actions, mode } = req.body || {};
    const queue = createRuntimeQueue(entityId, actions, worldState.tick);

    if (mode !== 'replace' && actionQueues.has(entityId)) {
      return res.status(409).json({ success: false, error: 'Queue already exists. Use mode=replace to overwrite.' });
    }

    // Start queue immediately on creation so callers don't need a second
    // /execute call. This prevents large CREATED/PENDING queues from sitting
    // idle forever when clients submit but never execute.
    queue.status = 'running';
    queue.startedAtTick = worldState.tick;
    queue.remainingTicks = queue.actions[queue.currentIndex]?.requiredTicks || 0;
    queue.expiresAtTick = worldState.tick + queue.totalRequiredTicks + QUEUE_EXPIRY_GRACE_TICKS;

    actionQueues.set(entityId, queue);
    persistQueueLifecycle(queue);
    _entityWikiCache.delete(entityId);

    return res.status(201).json({ success: true, queue: serializeQueue(queue) });
  } catch (error) {
    console.error('Error creating action queue:', error);
    return res.status(400).json({ success: false, error: error.message || 'Invalid queue request' });
  }
});

app.post('/entity/:entityId/action-queue/execute', requireAuth, rateLimiters.action, async (req, res) => {
  try {
    const { entityId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const queue = actionQueues.get(entityId);
    if (!queue) {
      return res.status(404).json({ success: false, error: 'No queue found' });
    }
    if (queue.status === 'running') {
      return res.json({ success: true, queue: serializeQueue(queue) });
    }

    queue.status = 'running';
    queue.startedAtTick = worldState.tick;
    queue.remainingTicks = queue.actions[queue.currentIndex]?.requiredTicks || 0;
    queue.expiresAtTick = worldState.tick + queue.totalRequiredTicks + QUEUE_EXPIRY_GRACE_TICKS;
    persistQueueLifecycle(queue);
    _entityWikiCache.delete(entityId);

    return res.json({ success: true, queue: serializeQueue(queue) });
  } catch (error) {
    console.error('Error starting action queue:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/entity/:entityId/action-queue/cancel', requireAuth, rateLimiters.action, async (req, res) => {
  try {
    const { entityId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const queue = actionQueues.get(entityId);
    if (!queue) {
      return res.status(404).json({ success: false, error: 'No queue found' });
    }

    queue.status = 'cancelled';
    queue.completedAtTick = worldState.tick;
    queue.completedAtMs = Date.now();
    queue.lastError = null;
    persistQueueLifecycle(queue);
    noteQueueTerminalStatus(queue, 'cancelled');
    _entityWikiCache.delete(entityId);

    return res.json({ success: true, queue: serializeQueue(queue) });
  } catch (error) {
    console.error('Error cancelling action queue:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============= ENTITY INTEREST ROUTES =============

/**
 * GET /entity/:entityId/interests
 * Returns the entity's current interests with weights.
 * Requires valid session token.
 */
app.get('/entity/:entityId/interests', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;

    // Only allow entities to read their own interests
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    let interests;
    if (process.env.DATABASE_URL) {
      interests = await db.getEntityInterests(entityId);
    } else {
      // In-memory fallback
      if (!app._memoryInterests) app._memoryInterests = new Map();
      interests = app._memoryInterests.get(entityId) || [];
    }

    res.json({ success: true, interests });
  } catch (error) {
    console.error('Error getting entity interests:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /entity/:entityId/interests
 * Atomic full-replace of entity interests.
 * Body: { interests: [{ interest: string, weight: number }, ...] }
 * Constraints: max 5 interests, weights > 0, normalised to sum = 100.
 * Requires valid session token.
 */
app.post('/entity/:entityId/interests', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;

    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const { interests } = req.body;
    if (!Array.isArray(interests) || interests.length === 0) {
      return res.status(400).json({ success: false, error: 'interests must be a non-empty array' });
    }
    if (interests.length > 5) {
      return res.status(400).json({ success: false, error: 'Maximum 5 interests allowed' });
    }
    for (const item of interests) {
      if (!item.interest || typeof item.interest !== 'string' || !item.interest.trim()) {
        return res.status(400).json({ success: false, error: 'Each interest must have a non-empty string' });
      }
      if (typeof item.weight !== 'number' || item.weight <= 0) {
        return res.status(400).json({ success: false, error: 'Each weight must be a positive number' });
      }
    }

    let normalised;
    if (process.env.DATABASE_URL) {
      normalised = await db.setEntityInterests(entityId, interests);
    } else {
      // In-memory fallback — normalise weights client-side
      if (!app._memoryInterests) app._memoryInterests = new Map();
      const rawTotal = interests.reduce((s, i) => s + i.weight, 0);
      normalised = interests.map(i => ({
        interest: i.interest.trim().substring(0, 500),
        weight: Math.round((i.weight / rawTotal) * 10000) / 100,
      }));
      const sumNow = normalised.reduce((s, i) => s + i.weight, 0);
      const drift = Math.round((100.0 - sumNow) * 100) / 100;
      if (drift !== 0) {
        const heaviest = normalised.reduce((a, b) => a.weight >= b.weight ? a : b);
        heaviest.weight = Math.round((heaviest.weight + drift) * 100) / 100;
      }
      app._memoryInterests.set(entityId, normalised);
    }

    res.json({ success: true, interests: normalised });
  } catch (error) {
    console.error('Error setting entity interests:', error);
    if (error.message && (error.message.includes('Maximum') || error.message.includes('must'))) {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Ping endpoint
app.get('/ping', (req, res) => {
  res.json({ 
    success: true, 
    timestamp: Date.now() 
  });
});

// Get world state
app.get('/world-state', (req, res) => {
  try {
    // Preserve previous behavior: stale agents are cleaned up before world-state responses.
    runAgentMaintenance();

    const { sinceTick, delta, limit } = req.query;

    const wantsDelta = String(delta).toLowerCase() === 'true' || sinceTick !== undefined;
    const parsedSinceTick = Number.parseInt(String(sinceTick), 10);
    const hasValidSinceTick = Number.isFinite(parsedSinceTick) && parsedSinceTick >= 0;
    const parsedLimit = Number.parseInt(String(limit), 10);
    const hasNumericLimit = Number.isFinite(parsedLimit);
    const effectiveLimit = hasNumericLimit
      ? Math.max(1, Math.min(parsedLimit, MAX_WORLD_STATE_LIMIT))
      : null;
    const deltaLimitApplied = hasNumericLimit && effectiveLimit !== parsedLimit;

    if (wantsDelta && hasValidSinceTick) {
      const windowMissed = parsedSinceTick < worldState.deltaHistoryMinTick;
      if (!windowMissed) {
        return res.json({
          ...buildWorldStateDelta(parsedSinceTick, effectiveLimit),
          ...(deltaLimitApplied ? { deltaLimitApplied: true } : {})
        });
      }

      const fullPayload = {
        ...getWorldStateMeta(),
        agents: Array.from(worldState.agents.values()).map(a => a.toJSON()),
        isDelta: false,
        deltaRequested: true,
        deltaFromTick: parsedSinceTick,
        deltaWindowMissed: true,
        deltaHistoryMinTick: worldState.deltaHistoryMinTick,
        removedAgentIds: []
      };
      return res.json(fullPayload);
    }

    res.json({
      ...getWorldStateMeta(),
      agents: Array.from(worldState.agents.values()).map(a => a.toJSON())
    });
  } catch (error) {
    console.error('Error getting world state:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

app.post('/agent/:agentId/heartbeat', requireAuth, (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = getOwnedAgentOrReject(req, res, agentId);
    if (!agent) return;

    agent.lastUpdate = Date.now();

    res.json({ success: true });
  } catch (error) {
    console.error('Error processing heartbeat:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get specific agent
app.get('/agent/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    
    const agent = worldState.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ 
        success: false, 
        error: 'Agent not found' 
      });
    }
    
    res.json(agent.toJSON());
  } catch (error) {
    console.error('Error getting agent:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Get chat messages (with optional since/before parameters)
app.get('/chat', async (req, res) => {
  try {
    const { since, before, limit } = req.query;

    // ---- Lazy-loading: return up to `limit` messages older than `before` ----
    if (before) {
      const beforeRaw = String(before).trim();
      const beforeTime = Number.parseInt(beforeRaw, 10);
      if (!Number.isFinite(beforeTime) || beforeTime <= 0 || !/^\d+$/.test(beforeRaw)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid `before` query parameter: expected a positive integer timestamp'
        });
      }

      let pageSize = 20;
      if (limit !== undefined) {
        const limitRaw = String(limit).trim();
        const parsedLimit = Number.parseInt(limitRaw, 10);

        if (!Number.isFinite(parsedLimit) || !/^\d+$/.test(limitRaw)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid `limit` query parameter: expected a numeric value'
          });
        }

        pageSize = parsedLimit;
      }

      pageSize = Math.min(Math.max(pageSize, 1), 50); // clamp to safe per-request bounds

      // Search the in-memory store first (most recent 100 msgs)
      let messages = worldState.chatMessages.filter(msg => msg.timestamp < beforeTime);
      let hasMore = false;

      // If the DB is available and in-memory doesn't have enough, query the DB
      if (process.env.DATABASE_URL && messages.length < pageSize) {
        try {
          // Backfill non-system rows across a few bounded DB batches so
          // pagination doesn't prematurely stop on system-heavy windows.
          const maxDbBatches = 3;
          const batchSize = pageSize;
          let cursor = beforeTime;
          let collected = [];
          let exhausted = false;

          for (let i = 0; i < maxDbBatches && collected.length < pageSize; i += 1) {
            const batch = await db.getChatMessagesBefore(cursor, batchSize);
            if (!batch.length) {
              exhausted = true;
              break;
            }

            const nonSystem = batch.filter(msg => !isSystemChatMessage(msg));
            collected = nonSystem.concat(collected);

            const oldestTimestamp = Number.parseInt(batch[0]?.timestamp, 10);
            if (!Number.isFinite(oldestTimestamp) || oldestTimestamp <= 0) {
              exhausted = true;
              break;
            }
            cursor = oldestTimestamp;
          }

          messages = collected.slice(-pageSize);
          hasMore = !exhausted;
        } catch (e) {
          console.error('Error fetching older chat from DB:', e);
          // fall through to whatever in-memory has
          messages = messages.slice(-pageSize).filter(msg => !isSystemChatMessage(msg));
          hasMore = messages.length === pageSize;
        }
      } else {
        // Slice to pageSize, keeping the most-recent messages still before the cutoff
        messages = messages.slice(-pageSize).filter(msg => !isSystemChatMessage(msg));
        if (messages.length > 0) {
          const oldestVisibleTs = Number.parseInt(messages[0]?.timestamp, 10);
          hasMore = Number.isFinite(oldestVisibleTs) && worldState.chatMessages.some(
            msg => msg.timestamp < oldestVisibleTs && !isSystemChatMessage(msg)
          );
        }
      }

      return res.json({ messages, hasMore });
    }

    // ---- Normal polling: return messages after `since` ----
    const defaultSinceLimit = 100;
    const maxSinceLimit = 1000;
    let sinceLimit = defaultSinceLimit;

    if (limit !== undefined) {
      const limitRaw = String(limit).trim();
      const parsedLimit = Number.parseInt(limitRaw, 10);

      if (!Number.isFinite(parsedLimit) || !/^\d+$/.test(limitRaw)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid `limit` query parameter: expected a numeric value'
        });
      }

      sinceLimit = Math.min(Math.max(parsedLimit, 1), maxSinceLimit);
    }

    let messages = worldState.chatMessages;
    if (since !== undefined) {
      const sinceRaw = String(since).trim();
      const sinceTime = Number.parseInt(sinceRaw, 10);
      if (!Number.isFinite(sinceTime) || sinceTime < 0 || !/^\d+$/.test(sinceRaw)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid `since` query parameter: expected a non-negative integer timestamp'
        });
      }

      const memoryMessages = worldState.chatMessages.filter(msg => msg.timestamp > sinceTime);
      if (process.env.DATABASE_URL) {
        try {
          messages = await db.getChatMessagesAfter(sinceTime, sinceLimit);
        } catch (e) {
          console.error('Error fetching recent chat from DB:', e);
          messages = memoryMessages.slice(-sinceLimit);
        }
      } else {
        messages = memoryMessages.slice(-sinceLimit);
      }
    }

    messages = messages.filter(msg => !isSystemChatMessage(msg));

    res.json({ messages });
  } catch (error) {
    console.error('Error getting chat messages:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Disconnect agent (optional cleanup endpoint)
app.delete('/disconnect/:agentId', requireAuth, (req, res) => {
  try {
    const { agentId } = req.params;

    const agent = getOwnedAgentOrReject(req, res, agentId);
    if (!agent) return;

    if (agent.entityId !== req.entityId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
    }

    console.log(`Agent disconnected: ${agent.name} (${agentId})`);
    markAgentRemoved(agentId);
    worldState.agents.delete(agentId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error disconnecting agent:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Game loop - Update world state periodically
async function gameLoop() {
  worldState.tick++;
  pruneWorldStateDeltaHistory();
  const dtSeconds = TICK_INTERVAL_MS / 1000;
  const worldTime = refreshWorldTimeState();
  updateRotatingEvents();

  for (const agent of worldState.agents.values()) {
    ensureAgentInventory(agent);
    decayAgentSkillCooldowns(agent, TICK_INTERVAL_MS / 1000);
    applyAgentEnergyTick(agent, dtSeconds, worldTime.dayPhase);
    noteRuntimeTick(agent);
    markAgentUpdated(agent);
  }

  await processActionQueues();
  processLobsterCombatAgainstThreats(dtSeconds);
  processThreatCombatTick(dtSeconds);
}

function runAgentMaintenance() {
  const now = Date.now();

  for (const [agentId, agent] of worldState.agents.entries()) {
    if (now - agent.lastUpdate > AGENT_TIMEOUT) {
      console.log(`Cleaning up inactive agent: ${agent.name} (${agentId})`);
      markAgentRemoved(agentId);
      worldState.agents.delete(agentId);
      continue;
    }

    // Update agent states (idle if no recent actions)
    if (now - agent.lastUpdate > 1000 && agent.state !== 'idle') {
      agent.state = 'idle';
      markAgentUpdated(agent);
    }
  }
}

const PERSIST_FLUSH_INTERVAL_MS = getPositiveIntervalMs('PERSIST_FLUSH_INTERVAL_MS', 1000, 250);
const PERSIST_AGENT_SAVE_INTERVAL_MS = getPositiveIntervalMs('PERSIST_AGENT_SAVE_INTERVAL_MS', 5000, 1000);
const PERSIST_CHAT_CLEANUP_INTERVAL_MS = getPositiveIntervalMs('PERSIST_CHAT_CLEANUP_INTERVAL_MS', 60000, 10000);
const PERSIST_SESSION_CLEANUP_INTERVAL_MS = getPositiveIntervalMs('PERSIST_SESSION_CLEANUP_INTERVAL_MS', 300000, 60000);
const ENTITY_REFLECTION_CHECK_INTERVAL_MS = getPositiveIntervalMs('ENTITY_REFLECTION_CHECK_INTERVAL_MS', 10 * 60 * 1000, 60 * 1000);
const LEADERBOARD_CHECK_INTERVAL_MS = getPositiveIntervalMs('LEADERBOARD_CHECK_INTERVAL_MS', 10 * 60 * 1000, 60 * 1000);
const AGENT_MAINTENANCE_INTERVAL_MS = getPositiveIntervalMs('AGENT_MAINTENANCE_INTERVAL_MS', 1000, 250);

const tickSchedulerMetrics = {
  lastTickDurationMs: 0,
  maxTickDurationMs: 0,
  skippedTicks: 0
};

const persistenceSchedulerMetrics = {
  lastRunDurationMs: 0,
  maxRunDurationMs: 0,
  skippedRuns: 0,
  lastAgentSaveAt: 0,
  lastChatCleanupAt: 0,
  lastSessionCleanupAt: 0
};

let tickInProgress = false;
let tickQueued = false;
let nextTickAt = Date.now() + TICK_INTERVAL_MS;
let tickTimer = null;

let isPersistRunning = false;
let persistTimer = null;
let agentMaintenanceTimer = null;
let entityReflectionCheckTimer = null;
let isEntityReflectionCheckRunning = false;
let leaderboardCheckTimer = null;
let isLeaderboardCheckRunning = false;

function getCurrentSeasonId(date = new Date()) {
  const month = date.getUTCMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
}

const LEADERBOARD_CACHE_TTL_MS = 60_000;
let _leaderboardCache = null;
let _leaderboardCacheTime = 0;
let _lastLeaderboardCheckTriggerTime = 0;

async function runLeaderboardCheckCycle() {
  if (!process.env.DATABASE_URL) return { skipped: true, reason: 'database_disabled' };
  if (isLeaderboardCheckRunning) return { skipped: true, reason: 'in_flight' };

  isLeaderboardCheckRunning = true;
  const startedAt = Date.now();

  try {
    const gotLock = await db.acquireLeaderboardLock();
    if (!gotLock) {
      return { skipped: true, reason: 'lock_busy' };
    }

    const seasonId = getCurrentSeasonId();
    const leaderboard = await db.getCurrentLeaderboard(25);
    const snapshotCount = await db.saveSeasonalLeaderboardSnapshot(seasonId, leaderboard, new Date());
    _leaderboardCache = {
      seasonId,
      policy: {
        reset: 'Season resets every UTC quarter (Q1/Q2/Q3/Q4) and archives current standings into snapshots.'
      },
      leaderboard
    };
    _leaderboardCacheTime = Date.now();
    return { triggered: true, seasonId, snapshotCount, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { triggered: false, error: error.message, durationMs: Date.now() - startedAt };
  } finally {
    await db.releaseLeaderboardLock().catch(() => {});
    isLeaderboardCheckRunning = false;
  }
}

function scheduleLeaderboardChecks() {
  if (!process.env.DATABASE_URL) return null;
  leaderboardCheckTimer = setInterval(() => {
    runLeaderboardCheckCycle();
  }, LEADERBOARD_CHECK_INTERVAL_MS);
  if (typeof leaderboardCheckTimer.unref === 'function') leaderboardCheckTimer.unref();
  return leaderboardCheckTimer;
}

function scheduleAgentMaintenance() {
  agentMaintenanceTimer = setInterval(runAgentMaintenance, AGENT_MAINTENANCE_INTERVAL_MS);

  if (typeof agentMaintenanceTimer.unref === 'function') {
    agentMaintenanceTimer.unref();
  }
}

async function runEntityReflectionCheckCycle() {
  if (!process.env.DATABASE_URL) {
    return { skipped: true, reason: 'database_disabled' };
  }

  if (isEntityReflectionCheckRunning) {
    console.log('[entity-reflection-scheduler] skipped (in_flight)');
    return { skipped: true, reason: 'in_flight' };
  }

  isEntityReflectionCheckRunning = true;
  const startedAt = Date.now();

  try {
    const result = await entityReflectionSummary.checkAndSummarizeEntityReflections();
    const durationMs = Date.now() - startedAt;
    console.log('[entity-reflection-scheduler] success', {
      durationMs,
      triggered: Boolean(result?.triggered),
      message: result?.message || null
    });
    return { skipped: false, durationMs, result };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    console.error('[entity-reflection-scheduler] failure', {
      durationMs,
      error: error?.message || String(error)
    });
    return { skipped: false, durationMs, error };
  } finally {
    isEntityReflectionCheckRunning = false;
  }
}

function scheduleEntityReflectionChecks() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  entityReflectionCheckTimer = setInterval(() => {
    runEntityReflectionCheckCycle();
  }, ENTITY_REFLECTION_CHECK_INTERVAL_MS);

  if (typeof entityReflectionCheckTimer.unref === 'function') {
    entityReflectionCheckTimer.unref();
  }

  console.log('[entity-reflection-scheduler] started', {
    intervalMs: ENTITY_REFLECTION_CHECK_INTERVAL_MS
  });

  return entityReflectionCheckTimer;
}

function scheduleNextTick() {
  const delayMs = Math.max(0, nextTickAt - Date.now());
  tickTimer = setTimeout(runScheduledTick, delayMs);

  if (typeof tickTimer.unref === 'function') {
    tickTimer.unref();
  }
}

function schedulePersistRun() {
  persistTimer = setTimeout(runPersistenceCycle, PERSIST_FLUSH_INTERVAL_MS);

  if (typeof persistTimer.unref === 'function') {
    persistTimer.unref();
  }
}

async function runPersistenceCycle() {
  if (isPersistRunning) {
    persistenceSchedulerMetrics.skippedRuns++;
    schedulePersistRun();
    return;
  }

  isPersistRunning = true;
  const startedAt = Date.now();

  try {
    await persistState();
  } catch (error) {
    console.error('Error during persistence cycle:', error);
  } finally {
    const runDurationMs = Date.now() - startedAt;
    persistenceSchedulerMetrics.lastRunDurationMs = runDurationMs;
    persistenceSchedulerMetrics.maxRunDurationMs = Math.max(persistenceSchedulerMetrics.maxRunDurationMs, runDurationMs);
    isPersistRunning = false;
  }

  schedulePersistRun();
}

async function runScheduledTick() {
  if (tickInProgress) {
    tickQueued = true;
    tickSchedulerMetrics.skippedTicks++;
    nextTickAt += TICK_INTERVAL_MS;
    scheduleNextTick();
    return;
  }

  tickInProgress = true;
  const tickStartedAt = Date.now();

  try {
    await gameLoop();
  } catch (error) {
    console.error('Error during scheduled tick:', error);
  } finally {
    const tickDurationMs = Date.now() - tickStartedAt;
    tickSchedulerMetrics.lastTickDurationMs = tickDurationMs;
    tickSchedulerMetrics.maxTickDurationMs = Math.max(tickSchedulerMetrics.maxTickDurationMs, tickDurationMs);
    tickInProgress = false;
  }

  const now = Date.now();
  nextTickAt += TICK_INTERVAL_MS;

  if (now > nextTickAt) {
    const missedTicks = Math.floor((now - nextTickAt) / TICK_INTERVAL_MS) + 1;
    tickSchedulerMetrics.skippedTicks += missedTicks;
    nextTickAt += missedTicks * TICK_INTERVAL_MS;
  }

  if (worldState.tick > 0 && worldState.tick % (TICK_RATE * 10) === 0) {
    console.log(
      `[tick-scheduler] tick=${worldState.tick} lastDurationMs=${tickSchedulerMetrics.lastTickDurationMs} maxDurationMs=${tickSchedulerMetrics.maxTickDurationMs} skippedTicks=${tickSchedulerMetrics.skippedTicks}`
    );
  }

  if (tickQueued) {
    tickQueued = false;
    nextTickAt = Math.min(nextTickAt, Date.now());
  }

  scheduleNextTick();
}

// Periodic state persistence
async function persistState() {
  if (!process.env.DATABASE_URL) return;

  const now = Date.now();

  // Flush queued lifecycle updates every second.
  await flushQueueLifecyclePersistBuffer();
  await flushRuntimeTelemetryPersistBuffer();

  // Delete removed agents in one DB call to avoid per-tick blocking I/O.
  if (pendingAgentDeleteIds.size > 0) {
    const deleteIds = Array.from(pendingAgentDeleteIds);
    try {
      await db.deleteAgentsBatch(deleteIds);
      for (const agentId of deleteIds) {
        pendingAgentDeleteIds.delete(agentId);
      }
    } catch (error) {
      console.error('Error deleting removed agents via batch delete:', error);
    }
  }

  // Save dirty agents to database on configured cadence.
  if (!persistenceSchedulerMetrics.lastAgentSaveAt || now - persistenceSchedulerMetrics.lastAgentSaveAt >= PERSIST_AGENT_SAVE_INTERVAL_MS) {
    try {
      if (dirtyAgentIds.size > 0) {
        const dirtyIds = Array.from(dirtyAgentIds);
        const agentsToPersist = dirtyIds
          .map((agentId) => worldState.agents.get(agentId))
          .filter(Boolean);

        await db.saveAgentsBatch(agentsToPersist);

        for (const agentId of dirtyIds) {
          const agent = worldState.agents.get(agentId);
          if (agent) {
            dirtyAgentIds.delete(agentId);
          }
        }

        console.log(`Persisted ${agentsToPersist.length} dirty agents to database`);
      }

      persistenceSchedulerMetrics.lastAgentSaveAt = now;
    } catch (error) {
      console.error('Error persisting state via batch save:', error);
    }
  }

  // Clean up old chat messages every minute.
  if (!persistenceSchedulerMetrics.lastChatCleanupAt || now - persistenceSchedulerMetrics.lastChatCleanupAt >= PERSIST_CHAT_CLEANUP_INTERVAL_MS) {
    try {
      await db.cleanupOldChatMessages();
      persistenceSchedulerMetrics.lastChatCleanupAt = now;
    } catch (error) {
      console.error('Error cleaning up chat messages:', error);
    }
  }

  // Clean up expired sessions every 5 minutes.
  if (!persistenceSchedulerMetrics.lastSessionCleanupAt || now - persistenceSchedulerMetrics.lastSessionCleanupAt >= PERSIST_SESSION_CLEANUP_INTERVAL_MS) {
    try {
      await db.cleanupExpiredSessions();
      await db.cleanupRateLimits();
      persistenceSchedulerMetrics.lastSessionCleanupAt = now;
    } catch (error) {
      console.error('Error cleaning up sessions/rate limits:', error);
    }
  }
}

// Start game loop and persistence with non-overlapping async schedulers
if (process.env.NODE_ENV !== 'test') {
  scheduleNextTick();
  scheduleAgentMaintenance();
  if (process.env.DATABASE_URL) {
    schedulePersistRun();
  }
  scheduleMapRefill();
  scheduleAlgaePalletRefill();
  scheduleEntityReflectionChecks();
  scheduleLeaderboardChecks();
}

// Status API endpoint
app.get('/status', async (req, res) => {
  try {
    const dbHealthy = process.env.DATABASE_URL ? await db.healthCheck() : null;
    const uptimeMs = Date.now() - worldState.startTime;
    const worldTime = worldState.worldTimeState || refreshWorldTimeState();

    // Count total entities created
    let totalEntities = worldState.totalEntitiesCreated;
    if (process.env.DATABASE_URL) {
      try {
        totalEntities = await db.getEntityCount();
      } catch (e) {
        // fallback to cached count
      }
    }

    res.json({
      status: 'online',
      activeAgents: worldState.agents.size,
      totalEntitiesCreated: totalEntities,
      tick: worldState.tick,
      uptime: process.uptime(),
      uptimeFormatted: formatUptime(uptimeMs),
      uptimeMs: uptimeMs,
      serverStartTime: worldState.startTime,
      worldCreatedAt: worldState.worldCreatedAt,
      worldTime,
      database: dbHealthy !== null ? (dbHealthy ? 'connected' : 'disconnected') : 'disabled',
      tickScheduler: {
        intervalMs: TICK_INTERVAL_MS,
        isTickRunning: tickInProgress,
        lastTickDurationMs: tickSchedulerMetrics.lastTickDurationMs,
        maxTickDurationMs: tickSchedulerMetrics.maxTickDurationMs,
        skippedTicks: tickSchedulerMetrics.skippedTicks
      },
      persistenceScheduler: {
        intervalMs: PERSIST_FLUSH_INTERVAL_MS,
        isRunning: isPersistRunning,
        lastRunDurationMs: persistenceSchedulerMetrics.lastRunDurationMs,
        maxRunDurationMs: persistenceSchedulerMetrics.maxRunDurationMs,
        skippedRuns: persistenceSchedulerMetrics.skippedRuns,
        lastAgentSaveAt: persistenceSchedulerMetrics.lastAgentSaveAt,
        lastChatCleanupAt: persistenceSchedulerMetrics.lastChatCleanupAt,
        lastSessionCleanupAt: persistenceSchedulerMetrics.lastSessionCleanupAt
      }
    });
  } catch (error) {
    console.error('Status endpoint error:', error);
    const safeStartTime = worldState.startTime || Date.now();
    const safeUptimeMs = Math.max(0, Date.now() - safeStartTime);
    const worldTime = worldState.worldTimeState || refreshWorldTimeState();
    return res.status(503).json({
      status: 'degraded',
      activeAgents: worldState.agents?.size ?? 0,
      totalEntitiesCreated: worldState.totalEntitiesCreated ?? 0,
      tick: worldState.tick ?? 0,
      uptime: Number.isFinite(process.uptime()) ? process.uptime() : 0,
      uptimeFormatted: formatUptime(safeUptimeMs),
      uptimeMs: safeUptimeMs,
      serverStartTime: safeStartTime,
      worldCreatedAt: worldState.worldCreatedAt || safeStartTime,
      worldTime,
      database: process.env.DATABASE_URL ? 'disconnected' : 'disabled',
      tickScheduler: {
        intervalMs: TICK_INTERVAL_MS,
        isTickRunning: Boolean(tickInProgress),
        lastTickDurationMs: tickSchedulerMetrics.lastTickDurationMs ?? 0,
        maxTickDurationMs: tickSchedulerMetrics.maxTickDurationMs ?? 0,
        skippedTicks: tickSchedulerMetrics.skippedTicks ?? 0
      },
      persistenceScheduler: {
        intervalMs: PERSIST_FLUSH_INTERVAL_MS,
        isRunning: Boolean(isPersistRunning),
        lastRunDurationMs: persistenceSchedulerMetrics.lastRunDurationMs ?? 0,
        maxRunDurationMs: persistenceSchedulerMetrics.maxRunDurationMs ?? 0,
        skippedRuns: persistenceSchedulerMetrics.skippedRuns ?? 0,
        lastAgentSaveAt: persistenceSchedulerMetrics.lastAgentSaveAt ?? null,
        lastChatCleanupAt: persistenceSchedulerMetrics.lastChatCleanupAt ?? null,
        lastSessionCleanupAt: persistenceSchedulerMetrics.lastSessionCleanupAt ?? null
      }
    });
  }
});

// Get all agents (alias for compatibility)
app.get('/agents', (req, res) => {
  res.json({
    agents: Array.from(worldState.agents.values()).map(a => a.toJSON())
  });
});

// ============= ACTIVITY LOG ENDPOINTS =============

// In-memory cache for activity log (avoids DB hit on every request from thousands of visitors)
let _activityLogCache = null;
let _activityLogCacheTime = 0;
const ACTIVITY_LOG_CACHE_TTL = 60_000; // 1 minute

// In-memory throttle for the /check endpoint (supplement to DB lock)
let _lastCheckTriggerTime = 0;
const CHECK_THROTTLE_MS = 30_000; // At most one real check every 30s

// Public lobster wiki cache (small TTL to reduce DB aggregation churn)
const ENTITY_WIKI_CACHE_TTL_MS = 60_000;
const _entityWikiCache = new Map(); // entityId -> { ts, data }

// Get activity summaries (daily + hourly) for the frontend — cached
app.get('/activity-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 14, 60);

    // Serve from cache if fresh
    if (_activityLogCache && (Date.now() - _activityLogCacheTime) < ACTIVITY_LOG_CACHE_TTL
        && _activityLogCache._limit >= limit) {
      return res.json(_activityLogCache.data);
    }

    const result = await activitySummary.getActivityLog(limit);

    // Update cache
    _activityLogCache = { data: result, _limit: limit };
    _activityLogCacheTime = Date.now();

    res.json(result);
  } catch (error) {
    console.error('Error fetching activity log:', error);
    res.status(500).json({ summaries: [], error: 'Internal server error' });
  }
});

// Trigger summarization check (called once by frontend on page load)
// Throttled in-memory + DB lock to handle thousands of concurrent visitors
app.post('/activity-log/check', rateLimiters.summaryCheck, async (req, res) => {
  try {
    const now = Date.now();

    // In-memory throttle: if another check ran very recently, skip entirely
    if (now - _lastCheckTriggerTime < CHECK_THROTTLE_MS) {
      return res.json({ triggered: false, message: 'Check was performed recently' });
    }
    _lastCheckTriggerTime = now;

    // Run summarization (has its own DB-level lock for safety)
    const result = await activitySummary.checkAndSummarize();

    // Invalidate the activity log cache if new summaries were created
    if (result.triggered) {
      _activityLogCache = null;
    }

    res.json(result);
  } catch (error) {
    console.error('Error checking activity log:', error);
    res.status(500).json({ triggered: false, message: 'Internal server error' });
  }
});

app.post('/leaderboard/check', rateLimiters.summaryCheck, async (req, res) => {
  try {
    const now = Date.now();
    if (now - _lastLeaderboardCheckTriggerTime < CHECK_THROTTLE_MS) {
      return res.json({ triggered: false, message: 'Leaderboard check was performed recently' });
    }
    _lastLeaderboardCheckTriggerTime = now;
    const result = await runLeaderboardCheckCycle();
    res.json(result);
  } catch (error) {
    console.error('Error checking leaderboard:', error);
    res.status(500).json({ triggered: false, message: 'Internal server error' });
  }
});

app.get('/leaderboard/current', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 25, 100));
    if (_leaderboardCache && (Date.now() - _leaderboardCacheTime) < LEADERBOARD_CACHE_TTL_MS) {
      return res.json({ success: true, ..._leaderboardCache, cache: 'hit' });
    }

    const seasonId = getCurrentSeasonId();
    const leaderboard = process.env.DATABASE_URL ? await db.getCurrentLeaderboard(limit) : [];
    const payload = {
      seasonId,
      policy: {
        reset: 'Season resets every UTC quarter (Q1/Q2/Q3/Q4), with archival snapshots captured by periodic leaderboard checks.'
      },
      leaderboard
    };

    _leaderboardCache = payload;
    _leaderboardCacheTime = Date.now();
    res.json({ success: true, ...payload, cache: 'miss' });
  } catch (error) {
    console.error('Error loading current leaderboard:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


app.get('/entity/:entityId/recommendations', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;
    const typeRaw = String(req.query.type || 'conversation').toLowerCase();
    const type = typeRaw === 'collab'
      ? 'collab'
      : (typeRaw === 'expansion'
        ? 'expansion'
        : (typeRaw === 'exploration' ? 'exploration' : 'conversation'));

    if (!entityId) {
      return res.status(400).json({ success: false, error: 'entityId is required' });
    }
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Can only read your own recommendations' });
    }

    const dbAdapter = process.env.DATABASE_URL ? db : null;
    if (!dbAdapter || typeof dbAdapter.getRecommendationCandidates !== 'function') {
      return res.json({ success: true, entityId, type, recommendations: [], metrics: {} });
    }

    const wiki = type !== 'expansion'
      ? await buildEntityWikiPublic(entityId, worldState, dbAdapter, {
        memoryEntity: getMemoryEntities()?.get(entityId) || null,
        memoryInterests: app._memoryInterests?.get(entityId) || [],
        memoryGoalSnapshot: app._memoryGoalSnapshots?.get(entityId) || null,
        runtimeActionQueue: actionQueues.get(entityId) || null,
        recommendationType: type,
        recentPositionHistory: entityRecentPositions.get(entityId) || []
      })
      : null;

    const recommendations = type === 'expansion'
      ? await (typeof db.getSpatialRecommendationHints === 'function'
        ? db.getSpatialRecommendationHints(entityId, 6)
        : Promise.resolve([]))
      : (Array.isArray(wiki?.social?.suggestedConnections)
        ? wiki.social.suggestedConnections
        : []);

    await Promise.all(
      recommendations
        .slice(0, 6)
        .filter((candidate) => candidate && typeof candidate.entityId === 'string' && candidate.entityId.trim())
        .map((candidate) => (
          db.trackRecommendationEvent(entityId, candidate.entityId, type, 'shown', {
            score: candidate.score,
            source: 'recommendations-endpoint'
          }).catch(() => null)
        ))
    );

    const metrics = typeof db.getRecommendationMetrics === 'function'
      ? await db.getRecommendationMetrics(entityId, type, 30)
      : {};

    return res.json({
      success: true,
      entityId,
      type,
      generatedAt: new Date().toISOString(),
      recommendations,
      metrics,
    });
  } catch (error) {
    console.error('Error loading recommendations:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/entity/:entityId/recommendations/events', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;
    const candidateEntityId = String(req.body?.candidateEntityId || '').trim();
    const typeRaw = String(req.body?.type || 'conversation').toLowerCase();
    const type = typeRaw === 'collab'
      ? 'collab'
      : (typeRaw === 'expansion'
        ? 'expansion'
        : (typeRaw === 'exploration' ? 'exploration' : 'conversation'));
    const eventType = String(req.body?.eventType || '').trim().toLowerCase();

    if (!entityId) return res.status(400).json({ success: false, error: 'entityId is required' });
    if (req.entityId !== entityId) return res.status(403).json({ success: false, error: 'Can only write your own recommendation events' });
    if (!candidateEntityId) return res.status(400).json({ success: false, error: 'candidateEntityId is required' });
    if (!['accepted', 'follow_through'].includes(eventType)) {
      return res.status(400).json({ success: false, error: 'eventType must be accepted or follow_through' });
    }

    if (process.env.DATABASE_URL && typeof db.trackRecommendationEvent === 'function') {
      await db.trackRecommendationEvent(entityId, candidateEntityId, type, eventType, {
        source: 'client-event',
        userAgent: req.get('user-agent') || null
      });
    }

    const metrics = (process.env.DATABASE_URL && typeof db.getRecommendationMetrics === 'function')
      ? await db.getRecommendationMetrics(entityId, type, 30)
      : {};

    res.json({ success: true, entityId, candidateEntityId, type, eventType, metrics });
  } catch (error) {
    console.error('Error tracking recommendation event:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/entity/:entityId/achievements', async (req, res) => {
  try {
    const { entityId } = req.params;
    if (!entityId) return res.status(400).json({ success: false, error: 'entityId is required' });
    if (!process.env.DATABASE_URL) {
      return res.json({ success: true, entityId, level: 1, xp: 0, earnedBadges: [], telemetry: {} });
    }

    const achievements = await db.evaluateAndAwardEntityBadges(entityId);
    if (!achievements) {
      return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    res.json({
      success: true,
      entityId,
      level: achievements.level,
      xp: achievements.xp,
      earnedBadges: achievements.earnedBadges || [],
      telemetry: {
        responseConsistency: achievements.responseConsistency,
        mentionsReplied: achievements.mentionsReplied,
        mentionsReceived: achievements.mentionsReceived,
        socialBreadth: achievements.uniqueRelationships,
        activeDays: achievements.activeDays,
        activeStreakDays: achievements.activeStreakDays
      }
    });
  } catch (error) {
    console.error('Error loading entity achievements:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Public lobster wiki with derived + stored details
app.get('/entity/:entityId/wiki-public', async (req, res) => {
  const start = Date.now();
  try {
    const { entityId } = req.params;
    const refreshFlag = String(req.query.refresh || '').trim().toLowerCase();
    const forceRefresh = refreshFlag === '1' || refreshFlag === 'true';
    const now = Date.now();
    if (!entityId) {
      return res.status(400).json({ success: false, error: 'entityId is required' });
    }

    const cached = _entityWikiCache.get(entityId);
    const cacheAgeMs = cached ? (now - cached.ts) : Number.POSITIVE_INFINITY;
    const cacheFresh = Boolean(cached && cacheAgeMs < ENTITY_WIKI_CACHE_TTL_MS);
    if (cacheFresh) {
      if (!forceRefresh) {
        return res.json({ success: true, wiki: cached.data, cache: 'hit' });
      }
      return res.json({ success: true, wiki: cached.data, cache: 'hit', refreshThrottled: true });
    }

    const memoryEntity = getMemoryEntities()?.get(entityId) || null;
    const memoryInterests = app._memoryInterests?.get(entityId) || [];
    const memoryGoalSnapshot = app._memoryGoalSnapshots?.get(entityId) || null;
    let runtimeActionQueue = actionQueues.get(entityId) || null;
    if (
      runtimeActionQueue
      && runtimeActionQueue.expiresAtTick !== null
      && runtimeActionQueue.expiresAtTick !== undefined
      && worldState.tick > Number(runtimeActionQueue.expiresAtTick)
    ) {
      runtimeActionQueue.status = 'expired';
      runtimeActionQueue.lastError = 'Action queue expired past tick budget';
      runtimeActionQueue.completedAtTick = worldState.tick;
      runtimeActionQueue.completedAtMs = Date.now();
      persistQueueLifecycle(runtimeActionQueue);
      noteQueueTerminalStatus(runtimeActionQueue, 'expired', 'expired_tick_budget');
      actionQueues.delete(entityId);
      runtimeActionQueue = null;
    }
    const dbAdapter = process.env.DATABASE_URL ? db : null;

    const wiki = await buildEntityWikiPublic(entityId, worldState, dbAdapter, {
      memoryEntity,
      memoryInterests,
      memoryGoalSnapshot,
      runtimeActionQueue
    });
    if (!wiki) {
      return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    _entityWikiCache.set(entityId, { ts: Date.now(), data: wiki });
    res.json({ success: true, wiki, cache: 'miss' });
    console.log(`[wiki-public] entity=${entityId} cache=miss ms=${Date.now() - start}`);
  } catch (error) {
    console.error('Error fetching wiki public payload:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Lightweight real-time runtime stats for a single lobster entity.
app.get('/entity/:entityId/runtime-stats', async (req, res) => {
  try {
    const { entityId } = req.params;
    if (!entityId) {
      return res.status(400).json({ success: false, error: 'entityId is required' });
    }

    const onlineAgent = findOnlineAgentByEntityId(entityId);
    if (onlineAgent) {
      const lastAction = onlineAgent.lastAction
        ? {
          ...(typeof onlineAgent.lastAction === 'object' && onlineAgent.lastAction
            ? onlineAgent.lastAction
            : { type: onlineAgent.lastAction || 'none' }),
          timestamp: onlineAgent.lastUpdate || Date.now()
        }
        : null;
      return res.json({
        success: true,
        entityId,
        tick: worldState.tick,
        online: true,
        agentId: onlineAgent.id,
        state: onlineAgent.state || 'idle',
        lastAction,
        runtime: buildRuntimeStatsPayload(onlineAgent),
        telemetry: getRuntimeTelemetrySnapshotForEntity(entityId, 1),
        expansion: {
          mapExpansionLevel: worldState.mapExpansionLevel,
          expansionTilesCount: worldState.expansionTiles.length,
          maxTiles: MAP_EXPANSION_MAX_TILES
        }
      });
    }

    const entity = await resolveEntityById(entityId);
    if (!entity) {
      return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    return res.json({
      success: true,
      entityId,
      tick: worldState.tick,
      online: false,
      agentId: null,
      state: 'offline',
      lastAction: null,
      runtime: null,
      telemetry: getRuntimeTelemetrySnapshotForEntity(entityId, 1),
      expansion: {
        mapExpansionLevel: worldState.mapExpansionLevel,
        expansionTilesCount: worldState.expansionTiles.length,
        maxTiles: MAP_EXPANSION_MAX_TILES
      }
    });
  } catch (error) {
    console.error('Error fetching runtime stats:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


app.get('/observer/telemetry/entity-runtime-aggregate', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

    const sourceRows = process.env.DATABASE_URL
      ? await db.getEntityTelemetryAggregate(days, limit)
      : getInMemoryTelemetryAggregate(days).slice(0, limit);

    const entities = sourceRows.map(summarizeTelemetryEntityRow);
    const totals = summarizeTelemetryEntityRow({
      entityId: 'all',
      ticksTotal: entities.reduce((sum, row) => sum + row.ticksTotal, 0),
      idleTicks: entities.reduce((sum, row) => sum + row.idleTicks, 0),
      socialActions: entities.reduce((sum, row) => sum + row.socialActions, 0),
      objectiveActions: entities.reduce((sum, row) => sum + row.objectiveActions, 0),
      uniqueSectors: entities.reduce((sum, row) => sum + row.uniqueSectorCoveragePerDay, 0),
      expansionTilesPlaced: entities.reduce((sum, row) => sum + row.expansionTilesPlacedPerDay, 0),
      queueCompleted: entities.reduce((sum, row) => sum + row.queue.completed, 0),
      queueFailed: entities.reduce((sum, row) => sum + row.queue.failed, 0),
      queueExpired: entities.reduce((sum, row) => sum + row.queue.expired, 0),
      queueCancelled: entities.reduce((sum, row) => sum + row.queue.cancelled, 0),
      queueFailureReasons: entities.reduce((acc, row) => {
        for (const [reason, count] of Object.entries(row.queue.failureReasons || {})) {
          acc[reason] = (Number(acc[reason]) || 0) + (Number(count) || 0);
        }
        return acc;
      }, {})
    });

    return res.json({
      success: true,
      windowDays: days,
      generatedAt: new Date().toISOString(),
      entityCount: entities.length,
      totals,
      entities,
      topRegressions: getTelemetryRegressions(entities, 10)
    });
  } catch (error) {
    console.error('Error loading aggregated entity telemetry:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get per-entity daily reflections
app.get('/entity/:entityId/daily-reflections', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden: can only access your own reflections' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 30, 90);
    let summaries;
    if (process.env.DATABASE_URL) {
      summaries = await entityReflectionSummary.getEntityReflections(entityId, limit);
    } else {
      const reflectionsByEntity = getMemoryDailyReflections();
      const entityReflections = reflectionsByEntity.get(entityId);
      summaries = entityReflections
        ? Array.from(entityReflections.values())
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, limit)
        : [];
    }
    res.json({ success: true, summaries });
  } catch (error) {
    console.error('Error fetching entity daily reflections:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// Allow an entity to submit its own daily reflection (self-managed summaries)
app.post('/entity/:entityId/daily-reflections', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden: can only write your own reflections' });
    }

    const { summaryDate, dailySummary, messageCount, socialSummary, goalProgress, memoryUpdates } = req.body || {};
    if (!summaryDate || typeof summaryDate !== 'string') {
      return res.status(400).json({ success: false, error: 'summaryDate (YYYY-MM-DD) is required' });
    }
    if (!dailySummary || typeof dailySummary !== 'string' || !dailySummary.trim()) {
      return res.status(400).json({ success: false, error: 'dailySummary is required' });
    }

    const safeCount = Number.isFinite(Number(messageCount)) ? Math.max(0, parseInt(messageCount, 10)) : 0;
    const safeDailySummary = dailySummary.trim().slice(0, 4000);
    const safeSocialSummary = typeof socialSummary === 'string' ? socialSummary.trim().slice(0, 2000) : '';
    const safeGoalProgress = goalProgress && typeof goalProgress === 'object' ? goalProgress : {};
    const safeMemoryUpdates = memoryUpdates && typeof memoryUpdates === 'object' ? memoryUpdates : {};

    if (process.env.DATABASE_URL) {
      await db.saveEntityDailyReflection(
        entityId,
        summaryDate,
        safeDailySummary,
        safeCount,
        true,
        safeSocialSummary,
        safeGoalProgress,
        safeMemoryUpdates
      );
    } else {
      const reflectionsByEntity = getMemoryDailyReflections();
      if (!reflectionsByEntity.has(entityId)) {
        reflectionsByEntity.set(entityId, new Map());
      }
      const entityReflections = reflectionsByEntity.get(entityId);
      entityReflections.set(summaryDate, {
        date: summaryDate,
        dailySummary: safeDailySummary,
        socialSummary: safeSocialSummary,
        goalProgress: safeGoalProgress,
        memoryUpdates: safeMemoryUpdates,
        messageCount: safeCount,
        aiCompleted: true,
        createdAt: new Date().toISOString()
      });
    }

    res.json({ success: true, entityId, summaryDate });
  } catch (error) {
    console.error('Error saving entity daily reflection:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// Allow an entity to submit its own goal snapshot (designed for lobster-owned daily scheduler)
app.post('/entity/:entityId/goal-snapshots', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;
    if (req.entityId !== entityId) {
      return res.status(403).json({ success: false, error: 'Forbidden: can only write your own goals' });
    }

    const { longTermGoals, shortTermGoals, source, model } = req.body || {};
    const safeLongTerm = sanitizeGoalList(longTermGoals, 'entity-agent');
    const safeShortTerm = sanitizeGoalList(shortTermGoals, 'entity-agent');

    if (!safeLongTerm || !safeShortTerm) {
      return res.status(400).json({ success: false, error: 'longTermGoals and shortTermGoals must be arrays' });
    }

    if (safeLongTerm.length === 0 && safeShortTerm.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one goal is required' });
    }

    if (process.env.DATABASE_URL) {
      await db.saveEntityGoalSnapshot(entityId, {
        longTermGoals: safeLongTerm,
        shortTermGoals: safeShortTerm,
        source: typeof source === 'string' && source.trim() ? source.trim().slice(0, 64) : 'entity-agent-v1',
        model: typeof model === 'string' && model.trim() ? model.trim().slice(0, 128) : 'unknown'
      });
    } else {
      if (!app._memoryGoalSnapshots) app._memoryGoalSnapshots = new Map();
      app._memoryGoalSnapshots.set(entityId, {
        longTermGoals: safeLongTerm,
        shortTermGoals: safeShortTerm,
        source: typeof source === 'string' && source.trim() ? source.trim().slice(0, 64) : 'entity-agent-v1',
        model: typeof model === 'string' && model.trim() ? model.trim().slice(0, 128) : 'unknown',
        generatedAt: new Date().toISOString()
      });
    }

    _entityWikiCache.delete(entityId);
    res.json({ success: true, entityId });
  } catch (error) {
    console.error('Error saving entity goals snapshot:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Trigger entity reflection summarization
app.post('/entity-reflections/check', rateLimiters.summaryCheck, async (req, res) => {
  try {
    const result = await entityReflectionSummary.checkAndSummarizeEntityReflections();
    res.json(result);
  } catch (error) {
    console.error('Error checking entity reflections:', error);
    res.status(500).json({ triggered: false, message: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Payload too large',
      code: 'PAYLOAD_TOO_LARGE',
      limits: {
        json: HTTP_JSON_LIMIT,
        form: HTTP_FORM_LIMIT
      }
    });
  }

  return next(err);
});

// Initialize and start server
async function startServer() {
  try {
    // Initialize database if DATABASE_URL is set
    if (process.env.DATABASE_URL) {
      console.log('Initializing database...');
      await db.initDatabase();
      
      // Load recent chat messages from database
      const recentMessages = await db.loadRecentChatMessages(100);
      worldState.chatMessages = recentMessages;
      console.log(`Loaded ${recentMessages.length} chat messages from database`);

      // Load total entity count + earliest world creation signal concurrently
      const [entityCountResult, worldCreatedAtResult] = await Promise.allSettled([
        db.getEntityCount(),
        db.getWorldCreatedAt()
      ]);

      if (entityCountResult.status === 'fulfilled') {
        worldState.totalEntitiesCreated = entityCountResult.value;
        console.log(`Total entities created: ${worldState.totalEntitiesCreated}`);
      } else {
        console.warn('Could not load entity count:', entityCountResult.reason?.message || entityCountResult.reason);
      }

      if (worldCreatedAtResult.status === 'fulfilled' && worldCreatedAtResult.value) {
        worldState.worldCreatedAt = worldCreatedAtResult.value;
        console.log(`World created at: ${new Date(worldState.worldCreatedAt).toISOString()}`);
      } else if (worldCreatedAtResult.status === 'rejected') {
        console.warn('Could not load world creation timestamp:', worldCreatedAtResult.reason?.message || worldCreatedAtResult.reason);
      }

      try {
        const persistedWorldObjects = await db.loadAllWorldObjects();
        for (const object of persistedWorldObjects) {
          worldState.objects.set(object.id, object);
        }
        const addedCount = await refillMapObjects({ persist: true });
        console.log(`Loaded ${persistedWorldObjects.length} world objects from database (${addedCount} added to fill missing map items)`);
      } catch (error) {
        console.warn('Could not load/refill map objects:', error?.message || error);
      }
    } else {
      console.log('Database disabled - running in memory-only mode');
      await refillMapObjects({ persist: false });
    }

    // Start server
    app.listen(PORT, () => {
      console.log(`OpenBot Social Server running on port ${PORT}`);
      console.log(`HTTP API: http://localhost:${PORT}/`);
      console.log(`API Status: http://localhost:${PORT}/status`);
      console.log(`Database: ${process.env.DATABASE_URL ? 'Enabled' : 'Disabled'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  worldState,
  getMemorySessions,
  __testHooks: {
    gameLoop,
    processActionQueues,
    actionQueues,
    applyQueueAction,
    findAgentByName,
    buildDeterministicNearbyTarget,
    clampMovement,
    validatePosition,
    refillMapObjects,
    MAP_OBJECT_TARGETS,
    runAgentMaintenance,
    runEntityReflectionCheckCycle,
    scheduleEntityReflectionChecks,
    ENTITY_REFLECTION_CHECK_INTERVAL_MS,
    updateRotatingEvents,
    applyRotatingEventActionHooks,
    getEntityReflectionSchedulerState: () => ({
      isEntityReflectionCheckRunning
    })
  }
};
