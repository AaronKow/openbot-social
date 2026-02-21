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
        numeric_id SERIAL,
        entity_id VARCHAR(255) PRIMARY KEY,
        entity_type VARCHAR(100) NOT NULL DEFAULT 'lobster',
        display_name VARCHAR(255) NOT NULL,
        entity_name VARCHAR(64) NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        public_key_fingerprint VARCHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add entity_name column if missing (migration for existing DBs)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE entities ADD COLUMN IF NOT EXISTS entity_name VARCHAR(64) UNIQUE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);

    // Add numeric_id column if missing (migration for existing DBs)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE entities ADD COLUMN IF NOT EXISTS numeric_id SERIAL;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);

    // Create conversation_messages table for per-entity conversation history 
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id SERIAL PRIMARY KEY,
        entity_id VARCHAR(255) NOT NULL,
        agent_id VARCHAR(255) NOT NULL,
        agent_name VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    // Create activity_summaries table for AI-generated daily summaries
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_summaries (
        id SERIAL PRIMARY KEY,
        summary_date DATE NOT NULL UNIQUE,
        daily_summary TEXT NOT NULL,
        hourly_summaries JSONB NOT NULL DEFAULT '{}',
        chat_count INTEGER NOT NULL DEFAULT 0,
        active_agents INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create summary_trigger_lock table (single-row lock)
    await client.query(`
      CREATE TABLE IF NOT EXISTS summary_trigger_lock (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        is_running BOOLEAN DEFAULT FALSE,
        last_triggered_at TIMESTAMP,
        last_completed_at TIMESTAMP
      )
    `);

    // Ensure the single lock row exists
    await client.query(`
      INSERT INTO summary_trigger_lock (id, is_running)
      VALUES (1, FALSE)
      ON CONFLICT (id) DO NOTHING
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
      CREATE INDEX IF NOT EXISTS idx_entities_name 
      ON entities(entity_name)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_entity 
      ON conversation_messages(entity_id, timestamp DESC)
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_activity_summaries_date 
      ON activity_summaries(summary_date DESC)
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
    timestamp: parseInt(row.timestamp, 10)
  })).reverse(); // Return in chronological order
}

// Get up to `limit` messages with timestamp < beforeTimestamp (for client lazy-loading)
async function getChatMessagesBefore(beforeTimestamp, limit = 20) {
  const result = await pool.query(
    'SELECT * FROM chat_messages WHERE timestamp < $1 ORDER BY timestamp DESC LIMIT $2',
    [beforeTimestamp, limit]
  );

  return result.rows.map(row => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    timestamp: parseInt(row.timestamp, 10)
  })).reverse(); // Return in chronological order (oldest first)
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

// Create a new entity (with entity_name for unique naming)
async function createEntity(entityId, entityType, publicKey, publicKeyFingerprint, entityName) {
  const query = `
    INSERT INTO entities (entity_id, entity_type, display_name, public_key, public_key_fingerprint, entity_name)
    VALUES ($1, $2, $1, $3, $4, $5)
    RETURNING *, numeric_id
  `;
  const result = await pool.query(query, [entityId, entityType, publicKey, publicKeyFingerprint, entityName || entityId]);
  return result.rows[0];
}

// Check if entity_name already exists
async function entityNameExists(entityName) {
  const result = await pool.query('SELECT 1 FROM entities WHERE entity_name = $1', [entityName]);
  return result.rows.length > 0;
}

// Save a conversation message for a specific entity
async function saveConversationMessage(entityId, agentId, agentName, message, timestamp) {
  await pool.query(
    'INSERT INTO conversation_messages (entity_id, agent_id, agent_name, message, timestamp) VALUES ($1, $2, $3, $4, $5)',
    [entityId, agentId, agentName, message, timestamp]
  );
}

// Load conversation messages for an entity
async function loadConversationMessages(entityId, limit = 100) {
  const result = await pool.query(
    'SELECT * FROM conversation_messages WHERE entity_id = $1 ORDER BY timestamp DESC LIMIT $2',
    [entityId, limit]
  );
  return result.rows.map(row => ({
    entityId: row.entity_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    timestamp: parseInt(row.timestamp)
  })).reverse();
}

// Get total number of entities ever created
async function getEntityCount() {
  const result = await pool.query('SELECT COUNT(*) as count FROM entities');
  return parseInt(result.rows[0].count);
}

// Get active agent count (requires checking spawned agents - not a DB operation, handled in index.js)

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
  let query = 'SELECT entity_id, entity_type, entity_name, numeric_id, created_at FROM entities';
  const params = [];
  if (entityType) {
    query += ' WHERE entity_type = $1';
    params.push(entityType);
  }
  query += ' ORDER BY numeric_id ASC';
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

// ============= ACTIVITY SUMMARY FUNCTIONS =============

// Get chat messages for a specific date range (timestamps in ms)
async function getChatMessagesForDateRange(startTimestamp, endTimestamp) {
  const result = await pool.query(
    `SELECT agent_id, agent_name, message, timestamp 
     FROM chat_messages 
     WHERE timestamp >= $1 AND timestamp < $2 
     ORDER BY timestamp ASC`,
    [startTimestamp, endTimestamp]
  );
  return result.rows.map(row => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    timestamp: parseInt(row.timestamp, 10)
  }));
}

// Save a daily activity summary
async function saveDailySummary(summaryDate, dailySummary, hourlySummaries, chatCount, activeAgents) {
  await pool.query(
    `INSERT INTO activity_summaries (summary_date, daily_summary, hourly_summaries, chat_count, active_agents)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (summary_date) DO UPDATE SET
       daily_summary = EXCLUDED.daily_summary,
       hourly_summaries = EXCLUDED.hourly_summaries,
       chat_count = EXCLUDED.chat_count,
       active_agents = EXCLUDED.active_agents,
       created_at = CURRENT_TIMESTAMP`,
    [summaryDate, dailySummary, JSON.stringify(hourlySummaries), chatCount, activeAgents]
  );
}

// Get summaries for the most recent N days
async function getActivitySummaries(limit = 14) {
  const result = await pool.query(
    `SELECT summary_date, daily_summary, hourly_summaries, chat_count, active_agents, created_at
     FROM activity_summaries
     ORDER BY summary_date DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    date: row.summary_date,
    dailySummary: row.daily_summary,
    hourlySummaries: row.hourly_summaries,
    chatCount: row.chat_count,
    activeAgents: row.active_agents,
    createdAt: row.created_at
  }));
}

// Check if a specific day already has a summary
async function hasSummaryForDate(summaryDate) {
  const result = await pool.query(
    'SELECT 1 FROM activity_summaries WHERE summary_date = $1',
    [summaryDate]
  );
  return result.rows.length > 0;
}

// Get distinct dates that have chat messages but no summary (max 7 at a time to limit work)
async function getUnsummarizedDays(beforeDate) {
  const result = await pool.query(
    `SELECT DISTINCT chat_date FROM (
       SELECT DATE(TO_TIMESTAMP(timestamp / 1000.0)) AS chat_date
       FROM chat_messages
       WHERE timestamp < $1
     ) AS dates
     WHERE chat_date < $2
       AND chat_date NOT IN (
         SELECT summary_date FROM activity_summaries
       )
     ORDER BY chat_date ASC
     LIMIT 7`,
    [
      new Date(beforeDate + 'T00:00:00.000Z').getTime(), // use index on timestamp
      beforeDate
    ]
  );
  return result.rows.map(row => row.chat_date);
}

// Attempt to acquire the summary trigger lock (returns true if acquired)
async function acquireSummaryLock() {
  const result = await pool.query(
    `UPDATE summary_trigger_lock
     SET is_running = TRUE, last_triggered_at = NOW()
     WHERE id = 1
       AND (is_running = FALSE
            OR last_triggered_at < NOW() - INTERVAL '10 minutes')
     RETURNING *`
  );
  return result.rows.length > 0;
}

// Release the summary trigger lock
async function releaseSummaryLock() {
  await pool.query(
    `UPDATE summary_trigger_lock
     SET is_running = FALSE, last_completed_at = NOW()
     WHERE id = 1`
  );
}

// Check if the summary lock is currently active and recent
async function isSummaryLockActive() {
  const result = await pool.query(
    `SELECT is_running, last_triggered_at FROM summary_trigger_lock WHERE id = 1`
  );
  if (result.rows.length === 0) return false;
  const row = result.rows[0];
  if (!row.is_running) return false;
  // Consider stale if > 10 minutes
  const triggeredAt = new Date(row.last_triggered_at);
  return (Date.now() - triggeredAt.getTime()) < 10 * 60 * 1000;
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
  getChatMessagesBefore,
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
  entityNameExists,
  listEntities,
  getEntityCount,
  // Conversation functions
  saveConversationMessage,
  loadConversationMessages,
  // Session functions
  createSession,
  getSession,
  revokeSession,
  revokeAllSessions,
  cleanupExpiredSessions,
  // Rate limit functions
  checkRateLimit,
  cleanupRateLimits,
  // Activity summary functions
  getChatMessagesForDateRange,
  saveDailySummary,
  getActivitySummaries,
  hasSummaryForDate,
  getUnsummarizedDays,
  acquireSummaryLock,
  releaseSummaryLock,
  isSummaryLockActive
};
