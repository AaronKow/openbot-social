const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Configuration
const PORT = process.env.PORT || 3000;
const TICK_RATE = 30; // 30 updates per second
const WORLD_SIZE = { x: 100, y: 100 }; // Ocean floor dimensions

// World State
const worldState = {
  agents: new Map(), // agentId -> agent data
  objects: new Map(), // objectId -> object data
  tick: 0
};

// Agent class to manage individual agents
class Agent {
  constructor(id, name, ws) {
    this.id = id;
    this.name = name;
    this.ws = ws;
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

// Broadcast message to all connected clients except sender
function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) { // 1 = OPEN
      client.send(data);
    }
  });
}

// Broadcast to specific agent
function sendToAgent(agentId, message) {
  const agent = worldState.agents.get(agentId);
  if (agent && agent.ws.readyState === 1) {
    agent.ws.send(JSON.stringify(message));
  }
}

// Validate movement
function validatePosition(pos) {
  return {
    x: Math.max(0, Math.min(WORLD_SIZE.x, pos.x)),
    y: Math.max(-5, Math.min(5, pos.y)), // Limit y movement
    z: Math.max(0, Math.min(WORLD_SIZE.y, pos.z))
  };
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New client connected');
  let currentAgent = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'register':
          // Register new agent
          const agentId = uuidv4();
          const agent = new Agent(agentId, message.name || 'Anonymous', ws);
          worldState.agents.set(agentId, agent);
          currentAgent = agent;

          // Send registration success
          ws.send(JSON.stringify({
            type: 'registered',
            success: true,
            agentId: agentId,
            position: agent.position,
            worldSize: WORLD_SIZE
          }));

          // Broadcast new agent to others
          broadcast({
            type: 'agent_joined',
            agent: agent.toJSON()
          }, ws);

          // Send current world state to new agent
          ws.send(JSON.stringify({
            type: 'world_state',
            tick: worldState.tick,
            agents: Array.from(worldState.agents.values()).map(a => a.toJSON()),
            objects: Array.from(worldState.objects.values())
          }));

          console.log(`Agent registered: ${agent.name} (${agentId})`);
          break;

        case 'move':
          if (!currentAgent) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not registered' }));
            return;
          }

          // Update agent position
          if (message.position) {
            currentAgent.position = validatePosition(message.position);
          }
          if (message.rotation !== undefined) {
            currentAgent.rotation = message.rotation;
          }
          currentAgent.state = 'moving';
          currentAgent.lastUpdate = Date.now();

          // Broadcast movement
          broadcast({
            type: 'agent_moved',
            agentId: currentAgent.id,
            position: currentAgent.position,
            rotation: currentAgent.rotation
          });
          break;

        case 'chat':
          if (!currentAgent) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not registered' }));
            return;
          }

          // Broadcast chat message
          broadcast({
            type: 'chat_message',
            agentId: currentAgent.id,
            agentName: currentAgent.name,
            message: message.message,
            timestamp: Date.now()
          });

          console.log(`${currentAgent.name}: ${message.message}`);
          break;

        case 'action':
          if (!currentAgent) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not registered' }));
            return;
          }

          currentAgent.lastAction = message.action;
          currentAgent.lastUpdate = Date.now();

          // Broadcast action
          broadcast({
            type: 'agent_action',
            agentId: currentAgent.id,
            action: message.action
          });
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Unknown message type: ${message.type}` 
          }));
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Invalid message format' 
      }));
    }
  });

  ws.on('close', () => {
    if (currentAgent) {
      console.log(`Agent disconnected: ${currentAgent.name} (${currentAgent.id})`);
      worldState.agents.delete(currentAgent.id);
      
      // Broadcast agent left
      broadcast({
        type: 'agent_left',
        agentId: currentAgent.id
      });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Game loop - Update world state periodically
function gameLoop() {
  worldState.tick++;

  // Clean up disconnected agents
  for (const [agentId, agent] of worldState.agents.entries()) {
    if (!agent.connected || agent.ws.readyState !== 1) {
      worldState.agents.delete(agentId);
      broadcast({
        type: 'agent_left',
        agentId: agentId
      });
    }
  }

  // Update agent states (idle if no recent actions)
  const now = Date.now();
  for (const agent of worldState.agents.values()) {
    if (now - agent.lastUpdate > 1000) {
      agent.state = 'idle';
    }
  }
}

// Start game loop
setInterval(gameLoop, 1000 / TICK_RATE);

// Serve static files (web client)
app.use(express.static(path.join(__dirname, '../client-web')));

// API endpoints
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    agents: worldState.agents.size,
    tick: worldState.tick,
    uptime: process.uptime()
  });
});

app.get('/api/agents', (req, res) => {
  res.json({
    agents: Array.from(worldState.agents.values()).map(a => a.toJSON())
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`OpenBot Social Server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`Web Client: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/status`);
});
