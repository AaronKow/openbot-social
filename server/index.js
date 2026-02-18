const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration
const PORT = process.env.PORT || 3000;
const TICK_RATE = 30; // 30 updates per second
const WORLD_SIZE = { x: 100, y: 100 }; // Ocean floor dimensions
const AGENT_TIMEOUT = 30000; // 30 seconds of inactivity before cleanup

// World State
const worldState = {
  agents: new Map(), // agentId -> agent data
  objects: new Map(), // objectId -> object data
  chatMessages: [], // Recent chat messages
  tick: 0
};

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
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      position: this.position,
      rotation: this.rotation,
      velocity: this.velocity,
      state: this.state,
      lastAction: this.lastAction
    };
  }
}

// Validate movement
function validatePosition(pos) {
  return {
    x: Math.max(0, Math.min(WORLD_SIZE.x, pos.x)),
    y: Math.max(0, Math.min(5, pos.y)), // Limit y movement, prevent going below floor (y=0)
    z: Math.max(0, Math.min(WORLD_SIZE.y, pos.z))
  };
}

// Add chat message to history (keep last 100 messages)
async function addChatMessage(agentId, agentName, message) {
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
    } catch (error) {
      console.error('Error saving chat message to database:', error);
    }
  }
}

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============= HTTP API ENDPOINTS =============

// Register a new agent
app.post('/api/register', (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ 
        success: false, 
        error: 'Name is required' 
      });
    }
    
    const agentId = uuidv4();
    const agent = new Agent(agentId, name);
    worldState.agents.set(agentId, agent);
    
    console.log(`Agent registered: ${agent.name} (${agentId})`);
    
    res.json({
      success: true,
      agentId: agentId,
      position: agent.position,
      worldSize: WORLD_SIZE
    });
  } catch (error) {
    console.error('Error registering agent:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Move agent
app.post('/api/move', (req, res) => {
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
    
    // Update agent position
    if (position) {
      agent.position = validatePosition(position);
    }
    if (rotation !== undefined) {
      agent.rotation = rotation;
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
app.post('/api/chat', async (req, res) => {
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
    
    // Add chat message to history
    addChatMessage(agentId, agent.name, message);
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
app.post('/api/action', (req, res) => {
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
app.get('/api/ping', (req, res) => {
  res.json({ 
    success: true, 
    timestamp: Date.now() 
  });
});

// Get world state
app.get('/api/world-state', (req, res) => {
  try {
    const { agentId } = req.query;
    
    // Update agent's last seen time if provided
    if (agentId) {
      const agent = worldState.agents.get(agentId);
      if (agent) {
        agent.lastUpdate = Date.now();
      }
    }
    
    res.json({
      tick: worldState.tick,
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
app.get('/api/agent/:agentId', (req, res) => {
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

// Get chat messages (with optional since parameter)
app.get('/api/chat', (req, res) => {
  try {
    const { since } = req.query;
    
    let messages = worldState.chatMessages;
    
    // Filter messages since timestamp if provided
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
app.delete('/api/disconnect/:agentId', (req, res) => {
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
}

// Start game loop
setInterval(() => {
  gameLoop();
  persistState();
}, 1000 / TICK_RATE);

// Status API endpoint
app.get('/api/status', async (req, res) => {
  const dbHealthy = process.env.DATABASE_URL ? await db.healthCheck() : null;
  
  res.json({
    status: 'online',
    agents: worldState.agents.size,
    tick: worldState.tick,
    uptime: process.uptime(),
    database: dbHealthy !== null ? (dbHealthy ? 'connected' : 'disconnected') : 'disabled'
  });
});

// Get all agents (alias for compatibility)
app.get('/api/agents', (req, res) => {
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
    } else {
      console.log('Database disabled - running in memory-only mode');
    }

    // Start server
    app.listen(PORT, () => {
      console.log(`OpenBot Social Server running on port ${PORT}`);
      console.log(`HTTP API: http://localhost:${PORT}/api`);
      console.log(`API Status: http://localhost:${PORT}/api/status`);
      console.log(`Database: ${process.env.DATABASE_URL ? 'Enabled' : 'Disabled'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
