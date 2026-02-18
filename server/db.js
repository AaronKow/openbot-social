const { Pool } = require('pg');

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Initialize database tables
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create agents table to persist agent data
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        position_x FLOAT NOT NULL DEFAULT 0,
        position_y FLOAT NOT NULL DEFAULT 0,
        position_z FLOAT NOT NULL DEFAULT 0,
        rotation FLOAT NOT NULL DEFAULT 0,
        state VARCHAR(50) NOT NULL DEFAULT 'idle',
        last_action TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create objects table for world objects
    await client.query(`
      CREATE TABLE IF NOT EXISTS world_objects (
        id VARCHAR(255) PRIMARY KEY,
        type VARCHAR(100) NOT NULL,
        position_x FLOAT NOT NULL,
        position_y FLOAT NOT NULL,
        position_z FLOAT NOT NULL,
        data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create chat messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        agent_name VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp 
      ON chat_messages(timestamp DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agents_updated_at 
      ON agents(updated_at DESC)
    `);

    await client.query('COMMIT');
    console.log('Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Save or update agent in database
async function saveAgent(agent) {
  const query = `
    INSERT INTO agents (id, name, position_x, position_y, position_z, rotation, state, last_action, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (id) 
    DO UPDATE SET
      name = EXCLUDED.name,
      position_x = EXCLUDED.position_x,
      position_y = EXCLUDED.position_y,
      position_z = EXCLUDED.position_z,
      rotation = EXCLUDED.rotation,
      state = EXCLUDED.state,
      last_action = EXCLUDED.last_action,
      updated_at = NOW()
  `;
  
  const values = [
    agent.id,
    agent.name,
    agent.position.x,
    agent.position.y,
    agent.position.z,
    agent.rotation,
    agent.state,
    agent.lastAction
  ];

  await pool.query(query, values);
}

// Load agent from database
async function loadAgent(agentId) {
  const result = await pool.query(
    'SELECT * FROM agents WHERE id = $1',
    [agentId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    position: {
      x: row.position_x,
      y: row.position_y,
      z: row.position_z
    },
    rotation: row.rotation,
    state: row.state,
    lastAction: row.last_action
  };
}

// Load all agents from database
async function loadAllAgents() {
  const result = await pool.query(
    'SELECT * FROM agents ORDER BY updated_at DESC'
  );

  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    position: {
      x: row.position_x,
      y: row.position_y,
      z: row.position_z
    },
    rotation: row.rotation,
    state: row.state,
    lastAction: row.last_action
  }));
}

// Delete agent from database
async function deleteAgent(agentId) {
  await pool.query('DELETE FROM agents WHERE id = $1', [agentId]);
}

// Save chat message to database
async function saveChatMessage(agentId, agentName, message, timestamp) {
  await pool.query(
    'INSERT INTO chat_messages (agent_id, agent_name, message, timestamp) VALUES ($1, $2, $3, $4)',
    [agentId, agentName, message, timestamp]
  );
}

// Load recent chat messages from database
async function loadRecentChatMessages(limit = 100) {
  const result = await pool.query(
    'SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT $1',
    [limit]
  );

  return result.rows.map(row => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    timestamp: row.timestamp
  })).reverse(); // Return in chronological order
}

// Clean up old chat messages (keep only last 1000)
async function cleanupOldChatMessages() {
  await pool.query(`
    DELETE FROM chat_messages 
    WHERE id NOT IN (
      SELECT id FROM chat_messages 
      ORDER BY timestamp DESC 
      LIMIT 1000
    )
  `);
}

// Save world object
async function saveWorldObject(objectId, type, position, data = {}) {
  const query = `
    INSERT INTO world_objects (id, type, position_x, position_y, position_z, data, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (id) 
    DO UPDATE SET
      type = EXCLUDED.type,
      position_x = EXCLUDED.position_x,
      position_y = EXCLUDED.position_y,
      position_z = EXCLUDED.position_z,
      data = EXCLUDED.data,
      updated_at = NOW()
  `;
  
  await pool.query(query, [objectId, type, position.x, position.y, position.z, JSON.stringify(data)]);
}

// Load all world objects
async function loadAllWorldObjects() {
  const result = await pool.query('SELECT * FROM world_objects');
  
  return result.rows.map(row => ({
    id: row.id,
    type: row.type,
    position: {
      x: row.position_x,
      y: row.position_y,
      z: row.position_z
    },
    data: row.data
  }));
}

// Delete world object
async function deleteWorldObject(objectId) {
  await pool.query('DELETE FROM world_objects WHERE id = $1', [objectId]);
}

// Health check
async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}

module.exports = {
  initDatabase,
  saveAgent,
  loadAgent,
  loadAllAgents,
  deleteAgent,
  saveChatMessage,
  loadRecentChatMessages,
  cleanupOldChatMessages,
  saveWorldObject,
  loadAllWorldObjects,
  deleteWorldObject,
  healthCheck,
  pool
};
