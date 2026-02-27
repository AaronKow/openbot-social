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
const { normalizeChatMessage, truncateForLog } = require('./chatMessage');

const app = express();

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    if (reqPath.startsWith('/disconnect/')) return true;
    if (/^\/entity\/[^/]+\/(action-queue|interests|daily-reflections|goal-snapshots)(?:\/.*)?$/.test(reqPath)) return true;
    return false;
  }

  if (normalizedMethod === 'POST' && (reqPath === '/spawn' || reqPath === '/move' || reqPath === '/action')) return true;
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
  entityCreate: createRateLimiter('entity_create', {}, db),
  authChallenge: createRateLimiter('auth_challenge', {}, db),
  authSession: createRateLimiter('auth_session', {}, db),
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
const TICK_RATE = 30; // 30 updates per second
const TICK_INTERVAL_MS = 1000 / TICK_RATE;
const WORLD_SIZE = { x: 100, y: 100 }; // Ocean floor dimensions
const AGENT_TIMEOUT = Number(process.env.AGENT_TIMEOUT || 180000); // 3 minutes by default
const WORLD_STATE_DELTA_TICK_WINDOW = Number(process.env.WORLD_STATE_DELTA_TICK_WINDOW || (TICK_RATE * 60));

// World State
const worldState = {
  agents: new Map(), // agentId -> agent data
  objects: new Map(), // objectId -> object data
  chatMessages: [], // Recent chat messages
  tick: 0,
  startTime: Date.now(), // Server start time for uptime calculation
  worldCreatedAt: Date.now(), // Earliest persistent world signal (entity/chat/agent creation)
  totalEntitiesCreated: 0, // Track total entities ever created
  agentChangeHistory: new Map(), // tick -> { changed: Set<agentId>, removed: Set<agentId> }
  deltaHistoryMinTick: 0
};

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
}

function markAgentRemoved(agentId) {
  if (!agentId) return;
  const bucket = getTickChangeBucket(worldState.tick);
  bucket.changed.delete(agentId);
  bucket.removed.add(agentId);
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

function getWorldStateMeta() {
  const uptimeMs = Date.now() - worldState.startTime;
  return {
    tick: worldState.tick,
    uptimeMs,
    uptimeFormatted: formatUptime(uptimeMs),
    serverStartTime: worldState.startTime,
    worldCreatedAt: worldState.worldCreatedAt,
    totalEntitiesCreated: worldState.totalEntitiesCreated,
    objects: Array.from(worldState.objects.values())
  };
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
const QUEUE_TERMINAL_RETENTION_MS = Number(process.env.ACTION_QUEUE_TERMINAL_RETENTION_MS || 120000);

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
      updatedAtTick: this.updatedAtTick
    };
  }
}

// Validate movement position (clamp to world bounds)
function validatePosition(pos) {
  return {
    x: Math.max(0, Math.min(WORLD_SIZE.x, Number(pos.x) || 0)),
    y: Math.max(0, Math.min(5, Number(pos.y) || 0)),
    z: Math.max(0, Math.min(WORLD_SIZE.y, Number(pos.z) || 0))
  };
}

// Clamp movement to realistic distance from current position
function clampMovement(currentPos, targetPos) {
  const validated = validatePosition(targetPos);
  const dx = validated.x - currentPos.x;
  const dy = validated.y - currentPos.y;
  const dz = validated.z - currentPos.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (distance <= MAX_MOVE_DISTANCE) {
    return validated;
  }

  // Scale down to max distance
  const scale = MAX_MOVE_DISTANCE / distance;
  return validatePosition({
    x: currentPos.x + dx * scale,
    y: currentPos.y + dy * scale,
    z: currentPos.z + dz * scale
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

// Add chat message to history (keep last 100 messages)
// Also saves conversation per-entity for full chat history
async function addChatMessage(agentId, agentName, message, entityId) {
  const timestamp = Date.now();
  worldState.chatMessages.push({
    agentId,
    agentName,
    message,
    timestamp
  });
  
  // Keep only last 100 messages in memory
  if (worldState.chatMessages.length > 100) {
    worldState.chatMessages = worldState.chatMessages.slice(-100);
  }

  // Save to database (if enabled)
  if (process.env.DATABASE_URL) {
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
    
    // Update agent position with realistic distance clamping
    if (position) {
      agent.position = clampMovement(agent.position, position);
    }
    if (rotation !== undefined) {
      agent.rotation = Number(rotation) || 0;
    }
    agent.state = 'moving';
    agent.lastUpdate = Date.now();
    markAgentUpdated(agent);
    
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
    
    const agent = getOwnedAgentOrReject(req, res, agentId);
    if (!agent) return;
    
    // Add chat message to history (with entity link for conversation tracking)
    addChatMessage(agentId, agent.name, normalizedMessage, agent.entityId);
    console.log(`${agent.name}: ${truncateForLog(normalizedMessage)}`);
    
    agent.lastUpdate = Date.now();
    markAgentUpdated(agent);
    
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
    
    agent.lastAction = action;
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

  if (action.type === 'move') {
    agent.position = clampMovement(agent.position, {
      x: action.x,
      y: action.y ?? agent.position.y,
      z: action.z
    });
    if (action.rotation !== undefined) {
      agent.rotation = Number(action.rotation) || 0;
    }
    agent.state = 'moving';
    agent.lastAction = { type: 'move', x: action.x, z: action.z };
    markAgentUpdated(agent);
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
      markAgentUpdated(agent);
      return;
    }

    addChatMessage(agent.id, agent.name, normalizedMessage, agent.entityId);
    agent.state = 'chatting';
    agent.lastAction = { type: 'talk', message: normalizedMessage };
    markAgentUpdated(agent);
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
      markAgentUpdated(agent);
      return;
    }

    const targetPosition = buildDeterministicNearbyTarget(agent, targetAgent);
    agent.position = clampMovement(agent.position, targetPosition);
    agent.state = 'moving';
    agent.lastAction = {
      type: 'move_to_agent',
      agent_name: action.agent_name,
      targetAgentId: targetAgent.id
    };
    markAgentUpdated(agent);
    return;
  }

  const payload = { ...action };
  delete payload.requiredTicks;
  agent.lastAction = payload;
  agent.state = 'acting';
  markAgentUpdated(agent);
}

async function processActionQueues() {
  if (actionQueues.size === 0) return;
  const now = Date.now();
  for (const [entityId, queue] of actionQueues.entries()) {
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
      continue;
    }

    applyQueueAction(agent, action);
    _entityWikiCache.delete(entityId);
    queue.executedActions.push({ type: action.type, tick: worldState.tick });
    queue.currentIndex += 1;

    if (queue.currentIndex >= queue.actions.length) {
      queue.status = 'completed';
      queue.completedAtTick = worldState.tick;
      queue.completedAtMs = Date.now();
      queue.remainingTicks = 0;
      persistQueueLifecycle(queue);
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
    const { agentId, sinceTick, delta, limit } = req.query;

    // Update agent's last seen time if provided
    if (agentId) {
      const agent = worldState.agents.get(agentId);
      if (agent) {
        agent.lastUpdate = Date.now();
      }
    }

    const wantsDelta = String(delta).toLowerCase() === 'true' || sinceTick !== undefined;
    const parsedSinceTick = Number.parseInt(String(sinceTick), 10);
    const hasValidSinceTick = Number.isFinite(parsedSinceTick) && parsedSinceTick >= 0;
    const parsedLimit = Number.parseInt(String(limit), 10);
    const effectiveLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;

    if (wantsDelta && hasValidSinceTick) {
      const windowMissed = parsedSinceTick < worldState.deltaHistoryMinTick;
      if (!windowMissed) {
        return res.json(buildWorldStateDelta(parsedSinceTick, effectiveLimit));
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

      // If the DB is available and in-memory doesn't have enough, query the DB
      if (process.env.DATABASE_URL && messages.length < pageSize) {
        try {
          messages = await db.getChatMessagesBefore(beforeTime, pageSize);
        } catch (e) {
          console.error('Error fetching older chat from DB:', e);
          // fall through to whatever in-memory has
          messages = messages.slice(-pageSize);
        }
      } else {
        // Slice to pageSize, keeping the most-recent messages still before the cutoff
        messages = messages.slice(-pageSize);
      }

      return res.json({ messages, hasMore: messages.length === pageSize });
    }

    // ---- Normal polling: return messages after `since` ----
    let messages = worldState.chatMessages;
    if (since) {
      const sinceTime = parseInt(since);
      messages = messages.filter(msg => msg.timestamp > sinceTime);
    }

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

  await processActionQueues();

  // Clean up inactive agents (no updates for AGENT_TIMEOUT ms)
  const now = Date.now();
  for (const [agentId, agent] of worldState.agents.entries()) {
    if (now - agent.lastUpdate > AGENT_TIMEOUT) {
      console.log(`Cleaning up inactive agent: ${agent.name} (${agentId})`);
      markAgentRemoved(agentId);
      worldState.agents.delete(agentId);
      
      // Delete from database if enabled
      if (process.env.DATABASE_URL) {
        try {
          await db.deleteAgent(agentId);
        } catch (error) {
          console.error('Error deleting agent from database:', error);
        }
      }
    }
  }

  // Update agent states (idle if no recent actions)
  for (const agent of worldState.agents.values()) {
    if (now - agent.lastUpdate > 1000 && agent.state !== 'idle') {
      agent.state = 'idle';
      markAgentUpdated(agent);
    }
  }
}

const PERSIST_FLUSH_INTERVAL_MS = 1000;
const PERSIST_AGENT_SAVE_INTERVAL_MS = 5000;
const PERSIST_CHAT_CLEANUP_INTERVAL_MS = 60000;
const PERSIST_SESSION_CLEANUP_INTERVAL_MS = 300000;

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

  // Save all agents to database every 5 seconds.
  if (!persistenceSchedulerMetrics.lastAgentSaveAt || now - persistenceSchedulerMetrics.lastAgentSaveAt >= PERSIST_AGENT_SAVE_INTERVAL_MS) {
    try {
      const agentsToPersist = Array.from(worldState.agents.values());
      await db.saveAgentsBatch(agentsToPersist);
      persistenceSchedulerMetrics.lastAgentSaveAt = now;
      console.log(`Persisted ${agentsToPersist.length} agents to database`);
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
  schedulePersistRun();
}

// Status API endpoint
app.get('/status', async (req, res) => {
  try {
    const dbHealthy = process.env.DATABASE_URL ? await db.healthCheck() : null;
    const uptimeMs = Date.now() - worldState.startTime;

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

// Public lobster wiki with derived + stored details
app.get('/entity/:entityId/wiki-public', async (req, res) => {
  const start = Date.now();
  try {
    const { entityId } = req.params;
    if (!entityId) {
      return res.status(400).json({ success: false, error: 'entityId is required' });
    }

    const cached = _entityWikiCache.get(entityId);
    if (cached && (Date.now() - cached.ts) < ENTITY_WIKI_CACHE_TTL_MS) {
      return res.json({ success: true, wiki: cached.data, cache: 'hit' });
    }

    const memoryEntity = getMemoryEntities()?.get(entityId) || null;
    const memoryInterests = app._memoryInterests?.get(entityId) || [];
    const memoryGoalSnapshot = app._memoryGoalSnapshots?.get(entityId) || null;
    const runtimeActionQueue = actionQueues.get(entityId) || null;
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
    } else {
      console.log('Database disabled - running in memory-only mode');
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
    applyQueueAction,
    findAgentByName,
    buildDeterministicNearbyTarget,
    clampMovement,
    validatePosition
  }
};
