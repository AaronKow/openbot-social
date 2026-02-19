const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');
const serverCrypto = require('./crypto');
const { createEntityRouter, requireSession, optionalSession, encryptIfAuthenticated } = require('./entityRoutes');
const { createRateLimiter, createEntityRateLimiter } = require('./rateLimit');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Encrypt-Response');
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
  general: createRateLimiter('general', {}, db)
};

// ============= ENTITY & AUTH ROUTES =============
const entityRouter = createEntityRouter(db, rateLimiters);
app.use(entityRouter);

// Helper to get memory stores from entity router (for non-DB mode)
const getMemorySessions = () => entityRouter._memorySessions;
const getMemoryEntities = () => entityRouter._memoryEntities;

// Auth middleware instances
const requireAuth = requireSession(db, getMemorySessions);
const optionalAuth = optionalSession(db, getMemorySessions);
const encryptResponses = encryptIfAuthenticated(db, getMemoryEntities);

// Configuration
const PORT = process.env.PORT || 3001;
const TICK_RATE = 30; // 30 updates per second
const WORLD_SIZE = { x: 100, y: 100 }; // Ocean floor dimensions
const AGENT_TIMEOUT = 30000; // 30 seconds of inactivity before cleanup

// World State
const worldState = {
  agents: new Map(), // agentId -> agent data
  objects: new Map(), // objectId -> object data
  chatMessages: [], // Recent chat messages
  tick: 0,
  startTime: Date.now(), // Server start time for uptime calculation
  totalEntitiesCreated: 0 // Track total entities ever created
};

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
      numericId: this.numericId
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
      
      console.log(`Entity spawned: ${entityId} as agent ${agentId}`);
    } else {
      // Update existing agent
      agent.lastUpdate = Date.now();
      agent.connected = true;
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
app.post('/move', rateLimiters.move, (req, res) => {
  try {
    const { agentId, position, rotation } = req.body;
    
    if (!agentId) {
      return res.status(400).json({ 
        success: false, 
        error: 'agentId is required' 
      });
    }
    
    const agent = worldState.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ 
        success: false, 
        error: 'Agent not found' 
      });
    }
    
    // Update agent position with realistic distance clamping
    if (position) {
      agent.position = clampMovement(agent.position, position);
    }
    if (rotation !== undefined) {
      agent.rotation = Number(rotation) || 0;
    }
    agent.state = 'moving';
    agent.lastUpdate = Date.now();
    
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
app.post('/chat', rateLimiters.chat, async (req, res) => {
  try {
    const { agentId, message } = req.body;
    
    if (!agentId || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'agentId and message are required' 
      });
    }
    
    const agent = worldState.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ 
        success: false, 
        error: 'Agent not found' 
      });
    }
    
    // Add chat message to history (with entity link for conversation tracking)
    addChatMessage(agentId, agent.name, message, agent.entityId);
    console.log(`${agent.name}: ${message}`);
    
    agent.lastUpdate = Date.now();
    
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
app.post('/action', rateLimiters.action, (req, res) => {
  try {
    const { agentId, action } = req.body;
    
    if (!agentId || !action) {
      return res.status(400).json({ 
        success: false, 
        error: 'agentId and action are required' 
      });
    }
    
    const agent = worldState.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ 
        success: false, 
        error: 'Agent not found' 
      });
    }
    
    agent.lastAction = action;
    agent.lastUpdate = Date.now();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error performing action:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
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
    const { agentId } = req.query;
    
    // Update agent's last seen time if provided
    if (agentId) {
      const agent = worldState.agents.get(agentId);
      if (agent) {
        agent.lastUpdate = Date.now();
      }
    }
    
    const uptimeMs = Date.now() - worldState.startTime;
    res.json({
      tick: worldState.tick,
      uptimeMs: uptimeMs,
      uptimeFormatted: formatUptime(uptimeMs),
      serverStartTime: worldState.startTime,
      agents: Array.from(worldState.agents.values()).map(a => a.toJSON()),
      objects: Array.from(worldState.objects.values())
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
      const beforeTime = parseInt(before);
      const pageSize = Math.min(parseInt(limit) || 20, 50); // cap at 50 per request

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
app.delete('/disconnect/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    
    const agent = worldState.agents.get(agentId);
    if (agent) {
      console.log(`Agent disconnected: ${agent.name} (${agentId})`);
      worldState.agents.delete(agentId);
      res.json({ success: true });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Agent not found' 
      });
    }
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

  // Clean up inactive agents (no updates for AGENT_TIMEOUT ms)
  const now = Date.now();
  for (const [agentId, agent] of worldState.agents.entries()) {
    if (now - agent.lastUpdate > AGENT_TIMEOUT) {
      console.log(`Cleaning up inactive agent: ${agent.name} (${agentId})`);
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
    if (now - agent.lastUpdate > 1000) {
      agent.state = 'idle';
    }
  }
}

// Periodic state persistence to database (every 5 seconds)
let persistenceCounter = 0;
async function persistState() {
  if (!process.env.DATABASE_URL) return;
  
  persistenceCounter++;
  
  // Save all agents to database every 5 seconds
  if (persistenceCounter % 150 === 0) { // 150 ticks = 5 seconds at 30 tick rate
    try {
      for (const agent of worldState.agents.values()) {
        await db.saveAgent(agent);
      }
      console.log(`Persisted ${worldState.agents.size} agents to database`);
    } catch (error) {
      console.error('Error persisting state:', error);
    }
  }
  
  // Clean up old chat messages every minute
  if (persistenceCounter % 1800 === 0) { // 1800 ticks = 60 seconds
    try {
      await db.cleanupOldChatMessages();
    } catch (error) {
      console.error('Error cleaning up chat messages:', error);
    }
  }

  // Clean up expired sessions every 5 minutes
  if (persistenceCounter % 9000 === 0) { // 9000 ticks = 5 minutes
    try {
      await db.cleanupExpiredSessions();
      await db.cleanupRateLimits();
    } catch (error) {
      console.error('Error cleaning up sessions/rate limits:', error);
    }
  }
}

// Start game loop
setInterval(() => {
  gameLoop();
  persistState();
}, 1000 / TICK_RATE);

// Status API endpoint
app.get('/status', async (req, res) => {
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
    database: dbHealthy !== null ? (dbHealthy ? 'connected' : 'disconnected') : 'disabled'
  });
});

// Get all agents (alias for compatibility)
app.get('/agents', (req, res) => {
  res.json({
    agents: Array.from(worldState.agents.values()).map(a => a.toJSON())
  });
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

      // Load total entity count
      try {
        worldState.totalEntitiesCreated = await db.getEntityCount();
        console.log(`Total entities created: ${worldState.totalEntitiesCreated}`);
      } catch (e) {
        console.warn('Could not load entity count:', e.message);
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

startServer();
