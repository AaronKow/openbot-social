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

    // Create entities table for RSA key-authenticated entities
    await client.query(`
      CREATE TABLE IF NOT EXISTS entities (
        entity_id VARCHAR(255) PRIMARY KEY,
        entity_type VARCHAR(100) NOT NULL DEFAULT 'lobster',
        display_name VARCHAR(255) NOT NULL,
        public_key TEXT NOT NULL,
        public_key_fingerprint VARCHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create sessions table for JWT-based session management
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        session_token VARCHAR(512) NOT NULL UNIQUE,
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        revoked BOOLEAN DEFAULT FALSE,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create rate_limits table for tracking request rates
    await client.query(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        id SERIAL PRIMARY KEY,
        identifier VARCHAR(255) NOT NULL,
        action_type VARCHAR(100) NOT NULL,
        request_count INTEGER DEFAULT 1,
        window_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(identifier, action_type)
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_type 
      ON entities(entity_type)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_fingerprint 
      ON entities(public_key_fingerprint)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_entity_id 
      ON sessions(entity_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at 
      ON sessions(expires_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier 
      ON rate_limits(identifier, action_type)
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

// ============= ENTITY FUNCTIONS =============

// Create a new entity
async function createEntity(entityId, entityType, displayName, publicKey, publicKeyFingerprint) {
  const query = `
    INSERT INTO entities (entity_id, entity_type, display_name, public_key, public_key_fingerprint)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  const result = await pool.query(query, [entityId, entityType, displayName, publicKey, publicKeyFingerprint]);
  return result.rows[0];
}

// Get entity by entity_id
async function getEntity(entityId) {
  const result = await pool.query('SELECT * FROM entities WHERE entity_id = $1', [entityId]);
  return result.rows[0] || null;
}

// Get entity by public key fingerprint
async function getEntityByFingerprint(fingerprint) {
  const result = await pool.query('SELECT * FROM entities WHERE public_key_fingerprint = $1', [fingerprint]);
  return result.rows[0] || null;
}

// Check if entity_id exists
async function entityExists(entityId) {
  const result = await pool.query('SELECT 1 FROM entities WHERE entity_id = $1', [entityId]);
  return result.rows.length > 0;
}

// List all entities (with optional type filter)
async function listEntities(entityType = null) {
  let query = 'SELECT entity_id, entity_type, display_name, created_at FROM entities';
  const params = [];
  if (entityType) {
    query += ' WHERE entity_type = $1';
    params.push(entityType);
  }
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  return result.rows;
}

// ============= SESSION FUNCTIONS =============

// Create a new session
async function createSession(sessionToken, entityId, expiresAt, ipAddress) {
  const query = `
    INSERT INTO sessions (session_token, entity_id, expires_at, ip_address)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  const result = await pool.query(query, [sessionToken, entityId, expiresAt, ipAddress]);
  return result.rows[0];
}

// Get session by token
async function getSession(sessionToken) {
  const result = await pool.query(
    'SELECT * FROM sessions WHERE session_token = $1 AND revoked = FALSE AND expires_at > NOW()',
    [sessionToken]
  );
  return result.rows[0] || null;
}

// Revoke a session
async function revokeSession(sessionToken) {
  await pool.query('UPDATE sessions SET revoked = TRUE WHERE session_token = $1', [sessionToken]);
}

// Revoke all sessions for an entity
async function revokeAllSessions(entityId) {
  await pool.query('UPDATE sessions SET revoked = TRUE WHERE entity_id = $1', [entityId]);
}

// Clean up expired sessions
async function cleanupExpiredSessions() {
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW() OR revoked = TRUE');
}

// ============= RATE LIMIT FUNCTIONS =============

// Check and increment rate limit (returns { allowed: bool, remaining: int, resetAt: Date })
async function checkRateLimit(identifier, actionType, maxRequests, windowSeconds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      `SELECT request_count, window_start FROM rate_limits 
       WHERE identifier = $1 AND action_type = $2`,
      [identifier, actionType]
    );
    
    const now = new Date();
    
    if (result.rows.length === 0) {
      // First request - create entry
      await client.query(
        `INSERT INTO rate_limits (identifier, action_type, request_count, window_start)
         VALUES ($1, $2, 1, $3)`,
        [identifier, actionType, now]
      );
      await client.query('COMMIT');
      return { allowed: true, remaining: maxRequests - 1, resetAt: new Date(now.getTime() + windowSeconds * 1000) };
    }
    
    const row = result.rows[0];
    const windowStart = new Date(row.window_start);
    const windowEnd = new Date(windowStart.getTime() + windowSeconds * 1000);
    
    if (now > windowEnd) {
      // Window expired - reset
      await client.query(
        `UPDATE rate_limits SET request_count = 1, window_start = $3
         WHERE identifier = $1 AND action_type = $2`,
        [identifier, actionType, now]
      );
      await client.query('COMMIT');
      return { allowed: true, remaining: maxRequests - 1, resetAt: new Date(now.getTime() + windowSeconds * 1000) };
    }
    
    if (row.request_count >= maxRequests) {
      // Rate limit exceeded
      await client.query('COMMIT');
      return { allowed: false, remaining: 0, resetAt: windowEnd };
    }
    
    // Increment counter
    await client.query(
      `UPDATE rate_limits SET request_count = request_count + 1
       WHERE identifier = $1 AND action_type = $2`,
      [identifier, actionType]
    );
    await client.query('COMMIT');
    return { allowed: true, remaining: maxRequests - row.request_count - 1, resetAt: windowEnd };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Clean up old rate limit entries
async function cleanupRateLimits() {
  await pool.query(`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 hour'`);
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
  pool,
  // Entity functions
  createEntity,
  getEntity,
  getEntityByFingerprint,
  entityExists,
  listEntities,
  // Session functions
  createSession,
  getSession,
  revokeSession,
  revokeAllSessions,
  cleanupExpiredSessions,
  // Rate limit functions
  checkRateLimit,
  cleanupRateLimits
};
