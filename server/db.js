const { Pool } = require('pg');

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

const DB_POOL_MAX = parsePositiveInt(process.env.DB_POOL_MAX, 6, 1, 20);
const DB_POOL_IDLE_TIMEOUT_MS = parsePositiveInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000, 1000, 120000);
const DB_POOL_CONNECTION_TIMEOUT_MS = parsePositiveInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 2000, 250, 30000);

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: DB_POOL_MAX,
  idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
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
        ai_completed BOOLEAN NOT NULL DEFAULT FALSE,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrations: add columns if missing (for existing DBs)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE activity_summaries ADD COLUMN IF NOT EXISTS ai_completed BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE activity_summaries ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
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

    // Create entity_daily_reflections table for per-lobster daily summaries
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_daily_reflections (
        id SERIAL PRIMARY KEY,
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        summary_date DATE NOT NULL,
        daily_summary TEXT NOT NULL,
        social_summary TEXT NOT NULL DEFAULT '',
        goal_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
        memory_updates JSONB NOT NULL DEFAULT '{}'::jsonb,
        message_count INTEGER NOT NULL DEFAULT 0,
        ai_completed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(entity_id, summary_date)
      )
    `);

    // Migrations for older DBs created before richer reflection fields existed
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE entity_daily_reflections ADD COLUMN IF NOT EXISTS social_summary TEXT NOT NULL DEFAULT '';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE entity_daily_reflections ADD COLUMN IF NOT EXISTS goal_progress JSONB NOT NULL DEFAULT '{}'::jsonb;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE entity_daily_reflections ADD COLUMN IF NOT EXISTS memory_updates JSONB NOT NULL DEFAULT '{}'::jsonb;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);

    // Create entity_interests table — stores evolving weighted interests per entity
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_interests (
        id SERIAL PRIMARY KEY,
        entity_id VARCHAR(255) NOT NULL,
        interest TEXT NOT NULL,
        weight NUMERIC(6,2) NOT NULL DEFAULT 33.33,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_entity_interests_entity FOREIGN KEY (entity_id)
          REFERENCES entities(entity_id) ON DELETE CASCADE,
        CONSTRAINT chk_weight_range CHECK (weight > 0 AND weight <= 100),
        CONSTRAINT uq_entity_interest UNIQUE (entity_id, interest)
      )
    `);


    // Create entity_goal_snapshots table for persisted goal state/history
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_goal_snapshots (
        id SERIAL PRIMARY KEY,
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        long_term_goals JSONB NOT NULL DEFAULT '[]'::jsonb,
        short_term_goals JSONB NOT NULL DEFAULT '[]'::jsonb,
        source VARCHAR(64) NOT NULL DEFAULT 'heuristic-v1',
        model VARCHAR(128) NOT NULL DEFAULT 'rules',
        generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create entity_action_queues table for durable queued action execution
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_action_queues (
        queue_id UUID PRIMARY KEY,
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        status VARCHAR(32) NOT NULL DEFAULT 'created',
        queue_spec JSONB NOT NULL,
        total_items INTEGER NOT NULL DEFAULT 0,
        total_required_ticks INTEGER NOT NULL DEFAULT 0,
        current_index INTEGER NOT NULL DEFAULT 0,
        executed_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);

    await client.query('COMMIT');
    console.log('Database bootstrap transaction completed');

    await runPostBootstrapMigrations();

    console.log('Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

const indexMigrations = [
  // Rollout order for live production upgrades (minimize impact on lobster traffic):
  // 1) Deploy code that keeps bootstrap DDL/schema checks inside BEGIN/COMMIT.
  // 2) After COMMIT, run this idempotent index migration list in small batches.
  // 3) High-traffic read paths are first and use CONCURRENTLY to avoid blocking writes.
  // 4) Lower-traffic indexes follow and can safely re-run on every deploy.
  {
    name: 'idx_chat_messages_timestamp',
    query: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp DESC)'
  },
  {
    name: 'idx_chat_messages_timestamp_id',
    query: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_timestamp_id ON chat_messages(timestamp DESC, id DESC)'
  },
  {
    name: 'idx_conversation_messages_entity',
    query: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_messages_entity ON conversation_messages(entity_id, timestamp DESC)'
  },
  {
    name: 'idx_sessions_entity_id',
    query: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_entity_id ON sessions(entity_id)'
  },
  {
    name: 'idx_sessions_expires_at',
    query: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)'
  },
  {
    name: 'idx_rate_limits_identifier',
    query: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limits_identifier ON rate_limits(identifier, action_type)'
  },
  {
    name: 'idx_agents_updated_at',
    query: 'CREATE INDEX IF NOT EXISTS idx_agents_updated_at ON agents(updated_at DESC)'
  },
  {
    name: 'idx_entities_type',
    query: 'CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)'
  },
  {
    name: 'idx_entities_fingerprint',
    query: 'CREATE INDEX IF NOT EXISTS idx_entities_fingerprint ON entities(public_key_fingerprint)'
  },
  {
    name: 'idx_entities_name',
    query: 'CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(entity_name)'
  },
  {
    name: 'idx_activity_summaries_date',
    query: 'CREATE INDEX IF NOT EXISTS idx_activity_summaries_date ON activity_summaries(summary_date DESC)'
  },
  {
    name: 'idx_entity_daily_reflections_entity_date',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_daily_reflections_entity_date ON entity_daily_reflections(entity_id, summary_date DESC)'
  },
  {
    name: 'idx_entity_interests_entity_id',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_interests_entity_id ON entity_interests(entity_id)'
  },
  {
    name: 'idx_entity_goal_snapshots_entity_generated',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_goal_snapshots_entity_generated ON entity_goal_snapshots(entity_id, generated_at DESC)'
  },
  {
    name: 'idx_entity_action_queues_entity_created',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_action_queues_entity_created ON entity_action_queues(entity_id, created_at DESC)'
  }
];

async function runPostBootstrapMigrations() {
  for (const migration of indexMigrations) {
    await pool.query(migration.query);
    console.log(`Applied index migration: ${migration.name}`);
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

// Save or update multiple agents in a single database round trip.
async function saveAgentsBatch(agents) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const values = [];
    const placeholders = agents.map((agent, index) => {
      const offset = index * 8;
      values.push(
        agent.id,
        agent.name,
        agent.position.x,
        agent.position.y,
        agent.position.z,
        agent.rotation,
        agent.state,
        agent.lastAction
      );

      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW())`;
    });

    const query = `
      INSERT INTO agents (id, name, position_x, position_y, position_z, rotation, state, last_action, updated_at)
      VALUES ${placeholders.join(', ')}
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

    await client.query(query, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

async function deleteAgentsBatch(agentIds) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return;
  }

  await pool.query('DELETE FROM agents WHERE id = ANY($1::varchar[])', [agentIds]);
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

// Get up to `limit` messages with timestamp > sinceTimestamp (for polling catch-up)
async function getChatMessagesAfter(sinceTimestamp, limit = 100) {
  const result = await pool.query(
    'SELECT * FROM chat_messages WHERE timestamp > $1 ORDER BY timestamp ASC, id ASC LIMIT $2',
    [sinceTimestamp, limit]
  );

  return result.rows.map(row => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    timestamp: parseInt(row.timestamp, 10)
  }));
}

// Clean up old chat messages (keep only last 10000)
async function cleanupOldChatMessages() {
  const retainedRows = 10000;
  const deleteBatchSize = 5000;

  const cutoffResult = await pool.query(
    `SELECT timestamp, id
     FROM chat_messages
     ORDER BY timestamp DESC, id DESC
     OFFSET $1
     LIMIT 1`,
    [retainedRows - 1]
  );

  if (cutoffResult.rows.length === 0) {
    return;
  }

  const { timestamp: cutoffTimestamp, id: cutoffId } = cutoffResult.rows[0];

  await pool.query(
    `WITH deletable AS (
      SELECT id
      FROM chat_messages
      WHERE timestamp < $1
         OR (timestamp = $1 AND id < $2)
      ORDER BY timestamp ASC, id ASC
      LIMIT $3
    )
    DELETE FROM chat_messages
    WHERE id IN (SELECT id FROM deletable)`,
    [cutoffTimestamp, cutoffId, deleteBatchSize]
  );
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

async function getWorldCreatedAt() {
  const result = await pool.query(`
    SELECT MIN(ts) AS world_created_at
    FROM (
      SELECT MIN(timestamp)::bigint AS ts FROM chat_messages
      UNION ALL
      SELECT (EXTRACT(EPOCH FROM MIN(created_at)) * 1000)::bigint AS ts FROM entities
      UNION ALL
      SELECT (EXTRACT(EPOCH FROM MIN(created_at)) * 1000)::bigint AS ts FROM agents
      UNION ALL
      SELECT (EXTRACT(EPOCH FROM MIN(created_at)) * 1000)::bigint AS ts FROM world_objects
      UNION ALL
      SELECT (EXTRACT(EPOCH FROM MIN(created_at)) * 1000)::bigint AS ts FROM activity_summaries
      UNION ALL
      SELECT (EXTRACT(EPOCH FROM MIN(created_at)) * 1000)::bigint AS ts FROM entity_daily_reflections
    ) AS world_signals
    WHERE ts IS NOT NULL
  `);

  const value = result.rows?.[0]?.world_created_at;
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  const now = new Date();
  const result = await pool.query(
    `WITH attempt AS (
      INSERT INTO rate_limits (identifier, action_type, request_count, window_start)
      VALUES ($1, $2, 1, $3)
      ON CONFLICT (identifier, action_type)
      DO UPDATE SET
        request_count = CASE
          WHEN rate_limits.window_start <= ($3 - ($5 * INTERVAL '1 second')) THEN 1
          ELSE rate_limits.request_count + 1
        END,
        window_start = CASE
          WHEN rate_limits.window_start <= ($3 - ($5 * INTERVAL '1 second')) THEN $3
          ELSE rate_limits.window_start
        END
      WHERE rate_limits.window_start <= ($3 - ($5 * INTERVAL '1 second'))
         OR rate_limits.request_count < $4
      RETURNING request_count, window_start, TRUE AS allowed
    ),
    blocked AS (
      SELECT request_count, window_start, FALSE AS allowed
      FROM rate_limits
      WHERE identifier = $1
        AND action_type = $2
        AND NOT EXISTS (SELECT 1 FROM attempt)
    )
    SELECT request_count, window_start, allowed FROM attempt
    UNION ALL
    SELECT request_count, window_start, allowed FROM blocked
    LIMIT 1`,
    [identifier, actionType, now, maxRequests, windowSeconds]
  );

  const row = result.rows[0];
  const windowStart = new Date(row.window_start);
  const resetAt = new Date(windowStart.getTime() + windowSeconds * 1000);

  return {
    allowed: row.allowed,
    remaining: row.allowed ? Math.max(0, maxRequests - row.request_count) : 0,
    resetAt
  };
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

// Get recent chat messages authored by a given agent/entity name
async function getRecentChatMessagesByAgentName(agentName, limit = 300) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 1000));
  const result = await pool.query(
    `SELECT agent_id, agent_name, message, timestamp
     FROM chat_messages
     WHERE agent_name = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [agentName, safeLimit]
  );
  return result.rows.map(row => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    timestamp: parseInt(row.timestamp, 10)
  }));
}

// Public-safe reflections for wiki views
async function getRecentEntityReflectionsPublic(entityId, limit = 30) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 90));
  const result = await pool.query(
    `SELECT summary_date, daily_summary, social_summary, goal_progress, memory_updates, message_count, created_at
     FROM entity_daily_reflections
     WHERE entity_id = $1
     ORDER BY summary_date DESC
     LIMIT $2`,
    [entityId, safeLimit]
  );
  return result.rows.map(row => ({
    date: row.summary_date instanceof Date
      ? row.summary_date.toISOString().slice(0, 10)
      : String(row.summary_date).slice(0, 10),
    dailySummary: row.daily_summary,
    socialSummary: row.social_summary || '',
    goalProgress: row.goal_progress || {},
    memoryUpdates: row.memory_updates || {},
    messageCount: row.message_count || 0,
    createdAt: row.created_at
  }));
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

// Aggregate top relationship candidates from recent chat history
async function getTopConversationPartnersByAgentName(agentName, limit = 8) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const scanWindow = 1200;
  const result = await pool.query(
    `SELECT agent_name, message, timestamp
     FROM chat_messages
     ORDER BY timestamp DESC
     LIMIT $1`,
    [scanWindow]
  );

  const partners = new Map();
  const touch = (partnerName, mode, ts) => {
    if (!partnerName || partnerName === agentName) return;
    const slot = partners.get(partnerName) || {
      entityId: partnerName,
      messagesExchanged: 0,
      sentMentions: 0,
      receivedMentions: 0,
      lastInteractionAt: 0
    };
    slot.messagesExchanged += 1;
    if (mode === 'sent') slot.sentMentions += 1;
    if (mode === 'received') slot.receivedMentions += 1;
    slot.lastInteractionAt = Math.max(slot.lastInteractionAt, Number(ts) || 0);
    partners.set(partnerName, slot);
  };

  for (const row of result.rows) {
    const speaker = row.agent_name;
    const message = row.message || '';
    const ts = parseInt(row.timestamp, 10);
    if (speaker === agentName) {
      for (const target of parseMentionTargets(message)) {
        touch(target, 'sent', ts);
      }
    } else if (mentionMatchesName(message, agentName)) {
      touch(speaker, 'received', ts);
    }
  }

  return [...partners.values()]
    .sort((a, b) => {
      if (b.messagesExchanged !== a.messagesExchanged) return b.messagesExchanged - a.messagesExchanged;
      return b.lastInteractionAt - a.lastInteractionAt;
    })
    .slice(0, safeLimit);
}

// Save a daily activity summary (aiCompleted = true if AI generated, false if fallback)
async function saveDailySummary(summaryDate, dailySummary, hourlySummaries, chatCount, activeAgents, aiCompleted = false) {
  await pool.query(
    `INSERT INTO activity_summaries (summary_date, daily_summary, hourly_summaries, chat_count, active_agents, ai_completed, retry_count)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN 0 ELSE 1 END)
     ON CONFLICT (summary_date) DO UPDATE SET
       daily_summary = EXCLUDED.daily_summary,
       hourly_summaries = EXCLUDED.hourly_summaries,
       chat_count = EXCLUDED.chat_count,
       active_agents = EXCLUDED.active_agents,
       ai_completed = EXCLUDED.ai_completed,
       -- On success reset counter; on failure increment so we stop after 3 tries
       retry_count = CASE
         WHEN EXCLUDED.ai_completed = TRUE THEN 0
         ELSE activity_summaries.retry_count + 1
       END,
       created_at = CURRENT_TIMESTAMP`,
    [summaryDate, dailySummary, JSON.stringify(hourlySummaries), chatCount, activeAgents, aiCompleted]
  );
}

// Get summaries for the most recent N days
async function getActivitySummaries(limit = 14) {
  const result = await pool.query(
    `SELECT summary_date, daily_summary, hourly_summaries, chat_count, active_agents, ai_completed, created_at
     FROM activity_summaries
     ORDER BY summary_date DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => {
    // Normalize date to YYYY-MM-DD string (pg returns Date objects for DATE columns)
    let dateStr;
    if (row.summary_date instanceof Date) {
      dateStr = row.summary_date.toISOString().slice(0, 10);
    } else {
      dateStr = String(row.summary_date).slice(0, 10);
    }
    return {
      date: dateStr,
      dailySummary: row.daily_summary,
      hourlySummaries: row.hourly_summaries,
      chatCount: row.chat_count,
      activeAgents: row.active_agents,
      aiCompleted: row.ai_completed,
      createdAt: row.created_at
    };
  });
}

// Check if a specific day already has a summary
async function hasSummaryForDate(summaryDate) {
  const result = await pool.query(
    'SELECT 1 FROM activity_summaries WHERE summary_date = $1',
    [summaryDate]
  );
  return result.rows.length > 0;
}

// Get distinct dates that have chat messages but no successful AI summary (max 7 at a time)
// Includes days with no summary AND days where ai_completed = FALSE (fallback saved)
async function getUnsummarizedDays(beforeDate) {
  const result = await pool.query(
    `SELECT DISTINCT chat_date FROM (
       SELECT DATE(TO_TIMESTAMP(timestamp / 1000.0)) AS chat_date
       FROM chat_messages
       WHERE timestamp < $1
     ) AS dates
     WHERE chat_date < $2
       AND chat_date NOT IN (
         -- Skip days that are fully summarized OR have hit the retry cap (3 failures)
         SELECT summary_date FROM activity_summaries
         WHERE ai_completed = TRUE OR retry_count >= 3
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

// Get unsummarized (entity_id, date) pairs from per-entity conversation history (max 50)
async function getUnsummarizedEntityDays(beforeDate) {
  const result = await pool.query(
    `SELECT entity_id, convo_date FROM (
       SELECT entity_id, DATE(TO_TIMESTAMP(timestamp / 1000.0)) AS convo_date
       FROM conversation_messages
       WHERE timestamp < $1
       GROUP BY entity_id, DATE(TO_TIMESTAMP(timestamp / 1000.0))
     ) AS entity_dates
     WHERE convo_date < $2
       AND (entity_id, convo_date) NOT IN (
         SELECT entity_id, summary_date
         FROM entity_daily_reflections
         WHERE ai_completed = TRUE
       )
     ORDER BY convo_date ASC
     LIMIT 50`,
    [
      new Date(beforeDate + 'T00:00:00.000Z').getTime(),
      beforeDate
    ]
  );

  return result.rows.map(row => ({
    entityId: row.entity_id,
    date: row.convo_date
  }));
}

// Fetch per-entity conversation messages for a UTC date range
async function getConversationMessagesForEntityDateRange(entityId, startTimestamp, endTimestamp) {
  const result = await pool.query(
    `SELECT agent_name, message, timestamp
     FROM conversation_messages
     WHERE entity_id = $1 AND timestamp >= $2 AND timestamp < $3
     ORDER BY timestamp ASC`,
    [entityId, startTimestamp, endTimestamp]
  );

  return result.rows.map(row => ({
    agentName: row.agent_name,
    message: row.message,
    timestamp: parseInt(row.timestamp, 10)
  }));
}

// Save/update per-entity daily reflection summary
async function saveEntityDailyReflection(
  entityId,
  summaryDate,
  dailySummary,
  messageCount,
  aiCompleted = false,
  socialSummary = '',
  goalProgress = {},
  memoryUpdates = {}
) {
  await pool.query(
    `INSERT INTO entity_daily_reflections (
       entity_id, summary_date, daily_summary, social_summary, goal_progress, memory_updates, message_count, ai_completed
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (entity_id, summary_date) DO UPDATE SET
       daily_summary = CASE
         WHEN NULLIF(BTRIM(EXCLUDED.daily_summary), '') IS NOT NULL THEN EXCLUDED.daily_summary
         ELSE entity_daily_reflections.daily_summary
       END,
       social_summary = CASE
         WHEN NULLIF(BTRIM(EXCLUDED.social_summary), '') IS NOT NULL THEN EXCLUDED.social_summary
         ELSE entity_daily_reflections.social_summary
       END,
       goal_progress = CASE
         WHEN EXCLUDED.goal_progress <> '{}'::jsonb THEN EXCLUDED.goal_progress
         ELSE entity_daily_reflections.goal_progress
       END,
       memory_updates = CASE
         WHEN EXCLUDED.memory_updates <> '{}'::jsonb THEN EXCLUDED.memory_updates
         ELSE entity_daily_reflections.memory_updates
       END,
       message_count = GREATEST(entity_daily_reflections.message_count, EXCLUDED.message_count),
       ai_completed = (entity_daily_reflections.ai_completed OR EXCLUDED.ai_completed),
       created_at = CURRENT_TIMESTAMP`,
    [
      entityId,
      summaryDate,
      dailySummary,
      socialSummary || '',
      goalProgress || {},
      memoryUpdates || {},
      messageCount,
      aiCompleted
    ]
  );
}

// Get most recent per-entity daily reflection summaries
async function getEntityDailyReflections(entityId, limit = 30) {
  const result = await pool.query(
    `SELECT summary_date, daily_summary, social_summary, goal_progress, memory_updates, message_count, ai_completed, created_at
     FROM entity_daily_reflections
     WHERE entity_id = $1
     ORDER BY summary_date DESC
     LIMIT $2`,
    [entityId, limit]
  );

  return result.rows.map(row => ({
    date: row.summary_date instanceof Date
      ? row.summary_date.toISOString().slice(0, 10)
      : String(row.summary_date).slice(0, 10),
    dailySummary: row.daily_summary,
    socialSummary: row.social_summary || '',
    goalProgress: row.goal_progress || {},
    memoryUpdates: row.memory_updates || {},
    messageCount: row.message_count,
    aiCompleted: row.ai_completed,
    createdAt: row.created_at
  }));
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


async function getLatestEntityGoalSnapshot(entityId) {
  const result = await pool.query(
    `SELECT long_term_goals, short_term_goals, source, model, generated_at
     FROM entity_goal_snapshots
     WHERE entity_id = $1
     ORDER BY generated_at DESC
     LIMIT 1`,
    [entityId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    longTermGoals: Array.isArray(row.long_term_goals) ? row.long_term_goals : [],
    shortTermGoals: Array.isArray(row.short_term_goals) ? row.short_term_goals : [],
    source: row.source || 'persisted',
    model: row.model || null,
    generatedAt: row.generated_at
  };
}

async function saveEntityGoalSnapshot(entityId, payload = {}) {
  const longTermGoals = Array.isArray(payload.longTermGoals) ? payload.longTermGoals.slice(0, 4) : [];
  const shortTermGoals = Array.isArray(payload.shortTermGoals) ? payload.shortTermGoals.slice(0, 4) : [];

  await pool.query(
    `INSERT INTO entity_goal_snapshots (entity_id, long_term_goals, short_term_goals, source, model)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entityId,
      JSON.stringify(longTermGoals),
      JSON.stringify(shortTermGoals),
      payload.source || 'heuristic-v1',
      payload.model || 'rules'
    ]
  );
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



// Save action queue lifecycle row
async function saveEntityActionQueue(queue) {
  await pool.query(
    `INSERT INTO entity_action_queues (
       queue_id, entity_id, status, queue_spec, total_items, total_required_ticks,
       current_index, executed_count, last_error, started_at, completed_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (queue_id) DO UPDATE SET
       status = EXCLUDED.status,
       current_index = EXCLUDED.current_index,
       executed_count = EXCLUDED.executed_count,
       last_error = EXCLUDED.last_error,
       started_at = COALESCE(EXCLUDED.started_at, entity_action_queues.started_at),
       completed_at = EXCLUDED.completed_at`,
    [
      queue.queueId,
      queue.entityId,
      queue.status,
      JSON.stringify({ actions: queue.actions || [] }),
      Number(queue.totalItems || 0),
      Number(queue.totalRequiredTicks || 0),
      Number(queue.currentIndex || 0),
      Number((queue.executedActions || []).length),
      queue.lastError || null,
      queue.startedAt ? new Date(queue.startedAt) : null,
      queue.completedAt ? new Date(queue.completedAt) : null,
    ]
  );
}

async function getRecentEntityActionQueues(entityId, limit = 10) {
  const result = await pool.query(
    `SELECT queue_id, status, queue_spec, total_items, total_required_ticks, current_index, executed_count, last_error, created_at, started_at, completed_at
     FROM entity_action_queues
     WHERE entity_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [entityId, limit]
  );
  return result.rows.map((row) => ({
    queueId: row.queue_id,
    status: row.status,
    queueSpec: row.queue_spec,
    totalItems: row.total_items,
    totalRequiredTicks: row.total_required_ticks,
    currentIndex: row.current_index,
    executedCount: row.executed_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

// ── Entity Interest functions ─────────────────────────────────────────────

/**
 * Get all interests for an entity, ordered by weight descending.
 */
async function getEntityInterests(entityId) {
  const result = await pool.query(
    `SELECT interest, weight::float FROM entity_interests
     WHERE entity_id = $1 ORDER BY weight DESC`,
    [entityId]
  );
  return result.rows; // [{ interest, weight }]
}

/**
 * Atomic full-replace of an entity's interests.
 * Validates: max 5 interests, positive weights, sum ≈ 100.
 * Normalises weights server-side to ensure exact 100.0 sum.
 */
async function setEntityInterests(entityId, interests) {
  if (!Array.isArray(interests) || interests.length === 0) {
    throw new Error('interests must be a non-empty array');
  }
  if (interests.length > 5) {
    throw new Error('Maximum 5 interests allowed');
  }
  // Validate each item
  for (const item of interests) {
    if (!item.interest || typeof item.interest !== 'string' || !item.interest.trim()) {
      throw new Error('Each interest must have a non-empty string');
    }
    if (typeof item.weight !== 'number' || item.weight <= 0) {
      throw new Error('Each weight must be a positive number');
    }
  }
  // Server-side normalisation to exactly 100.0
  const rawTotal = interests.reduce((s, i) => s + i.weight, 0);
  if (rawTotal <= 0) throw new Error('Total weight must be positive');
  const normalised = interests.map(i => ({
    interest: i.interest.trim().substring(0, 500),
    weight: Math.round((i.weight / rawTotal) * 10000) / 100,   // 2 dp
  }));
  // Fix rounding drift — add remainder to heaviest
  const sumNow = normalised.reduce((s, i) => s + i.weight, 0);
  const drift = Math.round((100.0 - sumNow) * 100) / 100;
  if (drift !== 0) {
    const heaviest = normalised.reduce((a, b) => a.weight >= b.weight ? a : b);
    heaviest.weight = Math.round((heaviest.weight + drift) * 100) / 100;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM entity_interests WHERE entity_id = $1',
      [entityId]
    );
    for (const item of normalised) {
      await client.query(
        `INSERT INTO entity_interests (entity_id, interest, weight, updated_at)
         VALUES ($1, $2, $3, NOW())`,
        [entityId, item.interest, item.weight]
      );
    }
    await client.query('COMMIT');
    return normalised;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  initDatabase,
  saveAgent,
  saveAgentsBatch,
  loadAgent,
  loadAllAgents,
  deleteAgent,
  deleteAgentsBatch,
  saveChatMessage,
  loadRecentChatMessages,
  getChatMessagesBefore,
  getChatMessagesAfter,
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
  getWorldCreatedAt,
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
  getRecentChatMessagesByAgentName,
  getRecentEntityReflectionsPublic,
  getTopConversationPartnersByAgentName,
  saveDailySummary,
  getActivitySummaries,
  hasSummaryForDate,
  getUnsummarizedDays,
  getUnsummarizedEntityDays,
  getConversationMessagesForEntityDateRange,
  saveEntityDailyReflection,
  getEntityDailyReflections,
  acquireSummaryLock,
  releaseSummaryLock,
  isSummaryLockActive,
  getLatestEntityGoalSnapshot,
  saveEntityGoalSnapshot,
  // Action queue functions
  saveEntityActionQueue,
  getRecentEntityActionQueues,
  // Entity interest functions
  getEntityInterests,
  setEntityInterests
};
