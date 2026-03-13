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

    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_recommendation_events (
        id SERIAL PRIMARY KEY,
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        candidate_entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        recommendation_type VARCHAR(32) NOT NULL DEFAULT 'conversation',
        event_type VARCHAR(32) NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    // Quest catalog (global quest definitions)
    await client.query(`
      CREATE TABLE IF NOT EXISTS quest_catalog (
        quest_id VARCHAR(128) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        category VARCHAR(64) NOT NULL,
        target_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        reward_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Per-entity quest state/progress
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_quests (
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        quest_id VARCHAR(128) NOT NULL REFERENCES quest_catalog(quest_id) ON DELETE CASCADE,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        PRIMARY KEY (entity_id, quest_id)
      )
    `);

    // Earned badges derived from telemetry and seasonal systems
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_badges (
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        badge_key VARCHAR(128) NOT NULL,
        awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (entity_id, badge_key)
      )
    `);

    // Archived leaderboard snapshots by season
    await client.query(`
      CREATE TABLE IF NOT EXISTS seasonal_leaderboard_snapshots (
        season_id VARCHAR(32) NOT NULL,
        entity_id VARCHAR(255) NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        score INTEGER NOT NULL DEFAULT 0,
        rank INTEGER NOT NULL,
        computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (season_id, entity_id)
      )
    `);

    // Single-row lock/state table for leaderboard check trigger
    await client.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_trigger_lock (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        is_running BOOLEAN DEFAULT FALSE,
        last_computed_at TIMESTAMP,
        last_season_id VARCHAR(32),
        last_snapshot_at TIMESTAMP
      )
    `);

    await client.query(`
      INSERT INTO leaderboard_trigger_lock (id, is_running)
      VALUES (1, FALSE)
      ON CONFLICT (id) DO NOTHING
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
    name: 'idx_entity_recommendation_events_entity_type_created',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_recommendation_events_entity_type_created ON entity_recommendation_events(entity_id, recommendation_type, created_at DESC)'
  },
  {
    name: 'idx_entity_recommendation_events_candidate_type_created',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_recommendation_events_candidate_type_created ON entity_recommendation_events(candidate_entity_id, recommendation_type, created_at DESC)'
  },
  {
    name: 'idx_entity_goal_snapshots_entity_generated',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_goal_snapshots_entity_generated ON entity_goal_snapshots(entity_id, generated_at DESC)'
  },
  {
    name: 'idx_entity_action_queues_entity_created',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_action_queues_entity_created ON entity_action_queues(entity_id, created_at DESC)'
  },
  {
    name: 'idx_entity_quests_entity_status',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_quests_entity_status ON entity_quests(entity_id, status, started_at DESC)'
  },
  {
    name: 'idx_entity_badges_awarded_at',
    query: 'CREATE INDEX IF NOT EXISTS idx_entity_badges_awarded_at ON entity_badges(awarded_at DESC)'
  },
  {
    name: 'idx_seasonal_leaderboard_snapshots_lookup',
    query: 'CREATE INDEX IF NOT EXISTS idx_seasonal_leaderboard_snapshots_lookup ON seasonal_leaderboard_snapshots(season_id, rank ASC, score DESC)'
  }
];

async function runPostBootstrapMigrations() {
  for (const migration of indexMigrations) {
    await pool.query(migration.query);
    console.log(`Applied index migration: ${migration.name}`);
  }

  await ensureQuestCatalog();
}

const QUEST_SEED_CATALOG = Object.freeze([
  {
    questId: 'daily-social-chat',
    title: 'Social Spark',
    description: 'Send 5 meaningful chat messages.',
    category: 'social',
    target: { chatSent: 5 },
    reward: { shells: 15, badge: 'social-spark' }
  },
  {
    questId: 'daily-explorer',
    title: 'Explorer Loop',
    description: 'Complete 10 movement actions.',
    category: 'exploration',
    target: { moveCount: 10 },
    reward: { shells: 12, badge: 'explorer-loop' }
  },
  {
    questId: 'exploration-first-expansion',
    title: 'First Frontier Stake',
    description: 'Place your first expansion tile on the frontier.',
    category: 'exploration',
    target: { firstExpansionTilePlaced: 1 },
    reward: { shells: 10, badge: 'first-frontier-stake' }
  },
  {
    questId: 'exploration-frontier-cartographer',
    title: 'Frontier Cartographer',
    description: 'Expand 8 unique frontier tiles.',
    category: 'exploration',
    target: { frontierTilesExpanded: 8 },
    reward: { shells: 20, badge: 'frontier-cartographer' }
  },
  {
    questId: 'exploration-unseen-traverse',
    title: 'Unseen Traverse',
    description: 'Travel 40 units while entering unexplored sectors.',
    category: 'exploration',
    target: { unexploredTraversalDistance: 40 },
    reward: { shells: 22, badge: 'unseen-traverse' }
  },
  {
    questId: 'exploration-cooperative-chain',
    title: 'Chain Reaction',
    description: 'Create 3 cooperative expansion links with other entities.',
    category: 'exploration',
    target: { cooperativeExpansionChains: 3 },
    reward: { shells: 24, badge: 'chain-reaction' }
  },
  {
    questId: 'daily-queue-operator',
    title: 'Queue Operator',
    description: 'Execute 6 queued actions.',
    category: 'consistency',
    target: { queueActions: 6 },
    reward: { shells: 10, badge: 'queue-operator' }
  },
  {
    questId: 'daily-mention-network',
    title: 'Network Builder',
    description: 'Mention or reply to other lobsters 3 times.',
    category: 'social',
    target: { mentionSent: 3 },
    reward: { shells: 16, badge: 'network-builder' }
  },
  {
    questId: 'dynamic-reflection-consistency',
    title: 'Reflective Current',
    description: 'Maintain daily reflection consistency over the latest 3 entries.',
    category: 'consistency',
    target: { reflectionEntries: 3 },
    reward: { shells: 18, badge: 'reflective-current' }
  },
  {
    questId: 'dynamic-goal-clarity',
    title: 'Goal Clarity',
    description: 'Maintain at least 2 short-term goals in your latest snapshot.',
    category: 'consistency',
    target: { shortTermGoals: 2 },
    reward: { shells: 14, badge: 'goal-clarity' }
  }
]);

async function ensureQuestCatalog() {
  for (const quest of QUEST_SEED_CATALOG) {
    await pool.query(
      `INSERT INTO quest_catalog (quest_id, title, description, category, target_json, reward_json, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
       ON CONFLICT (quest_id) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         target_json = EXCLUDED.target_json,
         reward_json = EXCLUDED.reward_json,
         is_active = TRUE,
         updated_at = NOW()`,
      [quest.questId, quest.title, quest.description, quest.category, JSON.stringify(quest.target), JSON.stringify(quest.reward)]
    );
  }
}

function questTargetsMet(progress, target) {
  const p = progress && typeof progress === 'object' ? progress : {};
  const t = target && typeof target === 'object' ? target : {};
  const entries = Object.entries(t);
  if (entries.length === 0) return false;
  return entries.every(([key, required]) => {
    const needed = Number(required) || 0;
    return (Number(p[key]) || 0) >= needed;
  });
}

async function ensureEntityQuest(entityId, questId, initialProgress = {}) {
  await pool.query(
    `INSERT INTO entity_quests (entity_id, quest_id, status, progress_json)
     VALUES ($1, $2, 'active', $3)
     ON CONFLICT (entity_id, quest_id) DO NOTHING`,
    [entityId, questId, JSON.stringify(initialProgress || {})]
  );
}

async function incrementEntityQuestProgress(entityId, questId, increments = {}) {
  const catalog = await pool.query(
    `SELECT target_json FROM quest_catalog WHERE quest_id = $1 AND is_active = TRUE`,
    [questId]
  );
  if (catalog.rows.length === 0) return null;

  await ensureEntityQuest(entityId, questId);

  const state = await pool.query(
    `SELECT status, progress_json FROM entity_quests WHERE entity_id = $1 AND quest_id = $2`,
    [entityId, questId]
  );
  if (state.rows.length === 0) return null;
  const row = state.rows[0];
  if (row.status === 'claimed') {
    return { questId, status: 'claimed', progress: row.progress_json || {} };
  }

  const progress = { ...(row.progress_json || {}) };
  for (const [key, value] of Object.entries(increments || {})) {
    const delta = Number(value) || 0;
    if (!delta) continue;
    progress[key] = Math.max(0, (Number(progress[key]) || 0) + delta);
  }

  const target = catalog.rows[0].target_json || {};
  const completed = questTargetsMet(progress, target);
  const nextStatus = completed ? 'completed' : (row.status || 'active');

  await pool.query(
    `UPDATE entity_quests
     SET status = $3,
         progress_json = $4,
         completed_at = CASE WHEN $3 = 'completed' AND completed_at IS NULL THEN NOW() ELSE completed_at END
     WHERE entity_id = $1 AND quest_id = $2`,
    [entityId, questId, nextStatus, JSON.stringify(progress)]
  );

  return { questId, status: nextStatus, progress };
}

async function setEntityQuestProgress(entityId, questId, progress = {}) {
  const catalog = await pool.query(
    `SELECT target_json FROM quest_catalog WHERE quest_id = $1 AND is_active = TRUE`,
    [questId]
  );
  if (catalog.rows.length === 0) return null;

  await ensureEntityQuest(entityId, questId, progress);
  const state = await pool.query(
    `SELECT status FROM entity_quests WHERE entity_id = $1 AND quest_id = $2`,
    [entityId, questId]
  );
  if (state.rows.length === 0) return null;
  if (state.rows[0].status === 'claimed') return { questId, status: 'claimed', progress };

  const target = catalog.rows[0].target_json || {};
  const completed = questTargetsMet(progress, target);
  const nextStatus = completed ? 'completed' : 'active';

  await pool.query(
    `UPDATE entity_quests
     SET status = $3,
         progress_json = $4,
         completed_at = CASE
           WHEN $3 = 'completed' AND completed_at IS NULL THEN NOW()
           WHEN $3 = 'active' THEN NULL
           ELSE completed_at
         END
     WHERE entity_id = $1 AND quest_id = $2`,
    [entityId, questId, nextStatus, JSON.stringify(progress || {})]
  );

  return { questId, status: nextStatus, progress };
}

async function getEntityQuestSummary(entityId) {
  const result = await pool.query(
    `SELECT q.quest_id, q.title, q.description, q.category, q.target_json, q.reward_json,
            eq.status, eq.progress_json, eq.started_at, eq.completed_at
     FROM quest_catalog q
     LEFT JOIN entity_quests eq
       ON eq.quest_id = q.quest_id
      AND eq.entity_id = $1
     WHERE q.is_active = TRUE
     ORDER BY q.category ASC, q.quest_id ASC`,
    [entityId]
  );

  const active = [];
  const completed = [];
  const claimed = [];

  for (const row of result.rows) {
    const item = {
      questId: row.quest_id,
      title: row.title,
      description: row.description,
      category: row.category,
      target: row.target_json || {},
      reward: row.reward_json || {},
      status: row.status || 'active',
      progress: row.progress_json || {},
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null
    };

    if (item.status === 'claimed') claimed.push(item);
    else if (item.status === 'completed') completed.push(item);
    else active.push(item);
  }

  return { active, completed, claimed };
}

async function claimEntityQuest(entityId, questId) {
  const result = await pool.query(
    `UPDATE entity_quests
     SET status = 'claimed'
     WHERE entity_id = $1
       AND quest_id = $2
       AND status = 'completed'
     RETURNING entity_id, quest_id, status, progress_json, completed_at`,
    [entityId, questId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    entityId: row.entity_id,
    questId: row.quest_id,
    status: row.status,
    progress: row.progress_json || {},
    completedAt: row.completed_at || null
  };
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



function normalizeRecommendationType(recommendationType = 'conversation') {
  const raw = String(recommendationType || 'conversation').toLowerCase();
  if (raw === 'collab') return 'collab';
  if (raw === 'expansion') return 'expansion';
  return 'conversation';
}

async function getRecommendationCandidates(entityId, recommendationType = 'conversation', limit = 12) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 40));
  const type = normalizeRecommendationType(recommendationType);

  const result = await pool.query(
    `WITH me AS (
       SELECT entity_id, COALESCE(entity_name, entity_id) AS entity_name
       FROM entities
       WHERE entity_id = $1
     ),
     my_interests AS (
       SELECT LOWER(TRIM(interest)) AS interest, weight::float AS weight
       FROM entity_interests
       WHERE entity_id = $1
     ),
     candidate_interests AS (
       SELECT ei.entity_id, LOWER(TRIM(ei.interest)) AS interest, ei.weight::float AS weight
       FROM entity_interests ei
       WHERE ei.entity_id <> $1
     ),
     interest_overlap AS (
       SELECT
         ci.entity_id,
         COALESCE(SUM(LEAST(mi.weight, ci.weight)), 0)::float AS overlap_weight,
         COUNT(*)::int AS shared_interest_count,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT ci.interest), NULL) AS shared_interests
       FROM candidate_interests ci
       JOIN my_interests mi ON mi.interest = ci.interest
       GROUP BY ci.entity_id
     ),
     interactions AS (
       SELECT
         e.entity_id,
         COUNT(*) FILTER (
           WHERE cm.timestamp > (EXTRACT(EPOCH FROM NOW() - INTERVAL '14 days') * 1000)::bigint
         )::int AS recent_interactions_14d,
         MAX(cm.timestamp)::bigint AS last_interaction_at,
         COALESCE(COUNT(*) FILTER (WHERE cm.agent_name = m.entity_name), 0)::int AS my_msgs,
         COALESCE(COUNT(*) FILTER (WHERE cm.agent_name = e.entity_name), 0)::int AS their_msgs
       FROM entities e
       CROSS JOIN me m
       LEFT JOIN chat_messages cm
         ON (
           (cm.agent_name = m.entity_name AND cm.message ILIKE ('%@' || e.entity_name || '%'))
           OR
           (cm.agent_name = e.entity_name AND cm.message ILIKE ('%@' || m.entity_name || '%'))
         )
       WHERE e.entity_id <> $1
       GROUP BY e.entity_id
     ),
     mention_graph AS (
       SELECT
         e.entity_id,
         COUNT(*) FILTER (
           WHERE cm.message ILIKE ('%@' || e.entity_name || '%')
             AND cm.agent_name <> e.entity_name
             AND cm.timestamp > (EXTRACT(EPOCH FROM NOW() - INTERVAL '21 days') * 1000)::bigint
         )::int AS inbound_mentions_21d,
         COUNT(DISTINCT cm.agent_name) FILTER (
           WHERE cm.message ILIKE ('%@' || e.entity_name || '%')
             AND cm.agent_name <> e.entity_name
             AND cm.timestamp > (EXTRACT(EPOCH FROM NOW() - INTERVAL '21 days') * 1000)::bigint
         )::int AS unique_mentioners_21d
       FROM entities e
       LEFT JOIN chat_messages cm ON cm.timestamp > (EXTRACT(EPOCH FROM NOW() - INTERVAL '21 days') * 1000)::bigint
       WHERE e.entity_id <> $1
       GROUP BY e.entity_id
     )
     SELECT
       e.entity_id,
       COALESCE(e.entity_name, e.entity_id) AS entity_name,
       COALESCE(io.overlap_weight, 0)::float AS overlap_weight,
       COALESCE(io.shared_interest_count, 0)::int AS shared_interest_count,
       COALESCE(io.shared_interests, ARRAY[]::text[]) AS shared_interests,
       COALESCE(i.recent_interactions_14d, 0)::int AS recent_interactions_14d,
       i.last_interaction_at,
       COALESCE(mg.inbound_mentions_21d, 0)::int AS inbound_mentions_21d,
       COALESCE(mg.unique_mentioners_21d, 0)::int AS unique_mentioners_21d,
       COALESCE(i.my_msgs, 0)::int AS my_msgs,
       COALESCE(i.their_msgs, 0)::int AS their_msgs
     FROM entities e
     LEFT JOIN interest_overlap io ON io.entity_id = e.entity_id
     LEFT JOIN interactions i ON i.entity_id = e.entity_id
     LEFT JOIN mention_graph mg ON mg.entity_id = e.entity_id
     WHERE e.entity_id <> $1
       AND e.entity_type = 'lobster'
     ORDER BY
       CASE WHEN $2 = 'collab' THEN COALESCE(io.overlap_weight, 0) * 1.2 ELSE COALESCE(io.overlap_weight, 0) END DESC,
       COALESCE(mg.unique_mentioners_21d, 0) DESC,
       COALESCE(i.last_interaction_at, 0) ASC
     LIMIT $3`,
    [entityId, type, safeLimit]
  );

  return result.rows.map((row) => ({
    entityId: row.entity_id,
    entityName: row.entity_name,
    overlapWeight: Number(row.overlap_weight) || 0,
    sharedInterestCount: Number(row.shared_interest_count) || 0,
    sharedInterests: Array.isArray(row.shared_interests) ? row.shared_interests : [],
    recentInteractions14d: Number(row.recent_interactions_14d) || 0,
    lastInteractionAt: row.last_interaction_at ? Number(row.last_interaction_at) : null,
    inboundMentions21d: Number(row.inbound_mentions_21d) || 0,
    uniqueMentioners21d: Number(row.unique_mentioners_21d) || 0,
    myMsgs: Number(row.my_msgs) || 0,
    theirMsgs: Number(row.their_msgs) || 0,
  }));
}

async function getSpatialRecommendationHints(entityId, limit = 4) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 4, 8));

  const frontierResult = await pool.query(
    `WITH world_points AS (
       SELECT position_x::float AS x, position_z::float AS z, LOWER(COALESCE(type, '')) AS type
       FROM world_objects
       WHERE position_x IS NOT NULL
         AND position_z IS NOT NULL
     ),
     bounds AS (
       SELECT
         COALESCE(MIN(x), -80)::float AS min_x,
         COALESCE(MAX(x), 80)::float AS max_x,
         COALESCE(MIN(z), -80)::float AS min_z,
         COALESCE(MAX(z), 80)::float AS max_z
       FROM world_points
     ),
     grid AS (
       SELECT
         gx,
         gz,
         b.min_x + ((b.max_x - b.min_x + 1) / 6.0) * gx AS start_x,
         b.min_x + ((b.max_x - b.min_x + 1) / 6.0) * (gx + 1) AS end_x,
         b.min_z + ((b.max_z - b.min_z + 1) / 6.0) * gz AS start_z,
         b.min_z + ((b.max_z - b.min_z + 1) / 6.0) * (gz + 1) AS end_z
       FROM bounds b
       CROSS JOIN generate_series(0, 5) AS gx
       CROSS JOIN generate_series(0, 5) AS gz
     )
     SELECT
       g.gx,
       g.gz,
       ((g.start_x + g.end_x) / 2.0)::float AS target_x,
       ((g.start_z + g.end_z) / 2.0)::float AS target_z,
       COUNT(w.*)::int AS object_density,
       COUNT(*) FILTER (WHERE LOWER(COALESCE(w.type, '')) IN ('rock', 'kelp', 'seaweed'))::int AS resource_density
     FROM grid g
     LEFT JOIN world_points w
       ON w.x >= g.start_x AND w.x < g.end_x
      AND w.z >= g.start_z AND w.z < g.end_z
     GROUP BY g.gx, g.gz, g.start_x, g.end_x, g.start_z, g.end_z
     ORDER BY object_density ASC, resource_density DESC
     LIMIT $1`,
    [safeLimit]
  );

  const progressionResult = await pool.query(
    `WITH my_reflection AS (
       SELECT
         COALESCE((goal_progress->>'builder')::float, 0)::float AS my_builder,
         COALESCE((goal_progress->>'build')::float, 0)::float AS my_build,
         COALESCE((goal_progress->>'forage')::float, 0)::float AS my_forage,
         COALESCE((goal_progress->>'harvest')::float, 0)::float AS my_harvest
       FROM entity_daily_reflections
       WHERE entity_id = $1
       ORDER BY summary_date DESC
       LIMIT 1
     )
     SELECT
       e.entity_id,
       COALESCE(e.entity_name, e.entity_id) AS entity_name,
       COALESCE((r.goal_progress->>'builder')::float, 0)::float AS builder_progress,
       COALESCE((r.goal_progress->>'build')::float, 0)::float AS build_progress,
       COALESCE((r.goal_progress->>'forage')::float, 0)::float AS forage_progress,
       COALESCE((r.goal_progress->>'harvest')::float, 0)::float AS harvest_progress,
       COALESCE(SUM(CASE
         WHEN LOWER(TRIM(i.interest)) LIKE '%build%' OR LOWER(TRIM(i.interest)) LIKE '%craft%' THEN i.weight::float
         WHEN LOWER(TRIM(i.interest)) LIKE '%forage%' OR LOWER(TRIM(i.interest)) LIKE '%harvest%' THEN i.weight::float
         ELSE 0
       END), 0)::float AS progression_interest_weight
     FROM entities e
     LEFT JOIN LATERAL (
       SELECT goal_progress
       FROM entity_daily_reflections r
       WHERE r.entity_id = e.entity_id
       ORDER BY summary_date DESC
       LIMIT 1
     ) r ON TRUE
     LEFT JOIN entity_interests i ON i.entity_id = e.entity_id
     LEFT JOIN my_reflection m ON TRUE
     WHERE e.entity_id <> $1
       AND e.entity_type = 'lobster'
     GROUP BY e.entity_id, e.entity_name, r.goal_progress, m.my_builder, m.my_build, m.my_forage, m.my_harvest
     ORDER BY
       ABS((COALESCE((r.goal_progress->>'builder')::float, 0) + COALESCE((r.goal_progress->>'build')::float, 0)) - (COALESCE(m.my_builder, 0) + COALESCE(m.my_build, 0))) DESC,
       ABS((COALESCE((r.goal_progress->>'forage')::float, 0) + COALESCE((r.goal_progress->>'harvest')::float, 0)) - (COALESCE(m.my_forage, 0) + COALESCE(m.my_harvest, 0))) DESC,
       progression_interest_weight DESC
     LIMIT 4`,
    [entityId]
  );

  const allies = progressionResult.rows.map((row) => ({
    entityId: row.entity_id,
    entityName: row.entity_name,
    builderProgress: Number((Number(row.builder_progress || 0) + Number(row.build_progress || 0)).toFixed(3)),
    forageProgress: Number((Number(row.forage_progress || 0) + Number(row.harvest_progress || 0)).toFixed(3)),
    progressionInterestWeight: Number(row.progression_interest_weight || 0),
  }));

  return frontierResult.rows.map((row, idx) => {
    const zone = `sector-${row.gx}-${row.gz}`;
    const objectDensity = Number(row.object_density || 0);
    const resourceDensity = Number(row.resource_density || 0);
    const collaborator = allies[idx % Math.max(1, allies.length)] || null;
    const rationale = [
      `Under-explored frontier ${zone} (density ${objectDensity}).`,
      resourceDensity > 0
        ? `Nearby resource opportunities detected (${resourceDensity} harvest nodes).`
        : 'Low known resource density: scout for new harvest nodes and expansion lanes.',
      collaborator
        ? `Coordinate with ${collaborator.entityName} for complementary build/forage progression.`
        : 'Seek a nearby collaborator with complementary build/forage progression.'
    ];
    return {
      recommendationType: 'expansion',
      score: Number((Math.max(0.1, 1 - (objectDensity / 14)) + Math.min(0.9, resourceDensity / 6)).toFixed(3)),
      targetArea: {
        zone,
        x: Number(Number(row.target_x).toFixed(2)),
        z: Number(Number(row.target_z).toFixed(2)),
      },
      rationale,
      collaborator,
      actionHint: {
        action: resourceDensity > 0 ? 'move_and_harvest_then_expand' : 'move_and_expand',
        target: {
          x: Number(Number(row.target_x).toFixed(2)),
          z: Number(Number(row.target_z).toFixed(2)),
        },
        rationale: rationale.join(' ')
      }
    };
  });
}

async function scoreInteractionNovelty(entityId, candidateEntityIds = [], recommendationType = 'conversation') {
  const ids = Array.from(new Set((candidateEntityIds || []).filter(Boolean).map(String)));
  if (ids.length === 0) return [];
  const type = normalizeRecommendationType(recommendationType);

  const result = await pool.query(
    `WITH target_candidates AS (
      SELECT UNNEST($2::text[]) AS candidate_entity_id
    )
    SELECT
      tc.candidate_entity_id,
      COUNT(*) FILTER (WHERE ere.event_type = 'shown')::int AS shown_count,
      COUNT(*) FILTER (WHERE ere.event_type = 'accepted')::int AS accepted_count,
      COUNT(*) FILTER (WHERE ere.event_type = 'follow_through')::int AS follow_through_count,
      MAX(ere.created_at) AS last_event_at
    FROM target_candidates tc
    LEFT JOIN entity_recommendation_events ere
      ON ere.entity_id = $1
     AND ere.candidate_entity_id = tc.candidate_entity_id
     AND ere.recommendation_type = $3
    GROUP BY tc.candidate_entity_id`,
    [entityId, ids, type]
  );

  return result.rows.map((row) => {
    const shown = Number(row.shown_count) || 0;
    const accepted = Number(row.accepted_count) || 0;
    const follow = Number(row.follow_through_count) || 0;
    const acceptanceRate = shown > 0 ? accepted / shown : 0;
    const followThroughRate = accepted > 0 ? follow / accepted : 0;
    const novelty = Math.max(0, 1 - Math.min(1, shown / 6));
    return {
      candidateEntityId: row.candidate_entity_id,
      shownCount: shown,
      acceptedCount: accepted,
      followThroughCount: follow,
      acceptanceRate: Number(acceptanceRate.toFixed(3)),
      followThroughRate: Number(followThroughRate.toFixed(3)),
      noveltyScore: Number(novelty.toFixed(3)),
      lastEventAt: row.last_event_at || null,
    };
  });
}

async function trackRecommendationEvent(entityId, candidateEntityId, recommendationType = 'conversation', eventType = 'shown', metadata = {}) {
  if (!entityId || !candidateEntityId || !eventType) return;
  const type = normalizeRecommendationType(recommendationType);
  const safeEventType = String(eventType).trim().toLowerCase();
  if (!['shown', 'accepted', 'follow_through'].includes(safeEventType)) return;

  await pool.query(
    `INSERT INTO entity_recommendation_events (entity_id, candidate_entity_id, recommendation_type, event_type, metadata_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityId, candidateEntityId, type, safeEventType, JSON.stringify(metadata || {})]
  );
}

async function getRecommendationMetrics(entityId, recommendationType = 'conversation', windowDays = 30) {
  const type = normalizeRecommendationType(recommendationType);
  const safeDays = Math.max(1, Math.min(Number(windowDays) || 30, 120));
  const result = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE event_type = 'shown')::int AS shown_count,
      COUNT(*) FILTER (WHERE event_type = 'accepted')::int AS accepted_count,
      COUNT(*) FILTER (WHERE event_type = 'follow_through')::int AS follow_through_count
     FROM entity_recommendation_events
     WHERE entity_id = $1
       AND recommendation_type = $2
       AND created_at >= NOW() - ($3::text || ' days')::interval`,
    [entityId, type, String(safeDays)]
  );

  const row = result.rows[0] || {};
  const shown = Number(row.shown_count) || 0;
  const accepted = Number(row.accepted_count) || 0;
  const follow = Number(row.follow_through_count) || 0;
  return {
    shownCount: shown,
    acceptedCount: accepted,
    followThroughCount: follow,
    acceptanceRate: shown > 0 ? Number((accepted / shown).toFixed(3)) : 0,
    followThroughRate: accepted > 0 ? Number((follow / accepted).toFixed(3)) : 0,
  };
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


function computeUtcDateKeyFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function computeActiveDayStreak(dayKeys) {
  const keys = Array.isArray(dayKeys) ? dayKeys.filter(Boolean) : [];
  if (!keys.length) return 0;
  const unique = [...new Set(keys)].sort().reverse();
  let streak = 0;
  let prev = null;
  for (const key of unique) {
    const ts = Date.parse(`${key}T00:00:00.000Z`);
    if (!Number.isFinite(ts)) continue;
    if (prev === null) {
      streak = 1;
      prev = ts;
      continue;
    }
    const diffDays = Math.round((prev - ts) / (24 * 60 * 60 * 1000));
    if (diffDays === 1) {
      streak += 1;
      prev = ts;
      continue;
    }
    break;
  }
  return streak;
}

async function getEntityAchievements(entityId) {
  const entity = await getEntity(entityId);
  if (!entity) return null;

  const entityName = entity.entity_name || entity.entity_id;
  const scanWindow = 2400;
  const result = await pool.query(
    `SELECT agent_name, message, timestamp
     FROM chat_messages
     ORDER BY timestamp DESC
     LIMIT $1`,
    [scanWindow]
  );

  let mentionsReceived = 0;
  let mentionsSent = 0;
  const relationshipSet = new Set();
  const activeDayKeys = [];

  for (const row of result.rows) {
    const speaker = row.agent_name;
    const message = row.message || '';
    const ts = parseInt(row.timestamp, 10);

    if (speaker === entityName) {
      const mentions = parseMentionTargets(message);
      if (mentions.length > 0) {
        mentionsSent += mentions.length;
        for (const target of mentions) {
          if (target !== entityName) relationshipSet.add(target);
        }
      }
      const dayKey = computeUtcDateKeyFromMs(ts);
      if (dayKey) activeDayKeys.push(dayKey);
    } else if (mentionMatchesName(message, entityName)) {
      mentionsReceived += 1;
      if (speaker && speaker !== entityName) relationshipSet.add(speaker);
    }
  }

  const uniqueRelationships = relationshipSet.size;
  const activeDays = new Set(activeDayKeys).size;
  const activeStreakDays = computeActiveDayStreak(activeDayKeys);
  const responseConsistency = mentionsReceived > 0
    ? Math.min(1, mentionsSent / mentionsReceived)
    : (mentionsSent > 0 ? 1 : 0);

  const xp = Math.round(
    responseConsistency * 120
    + uniqueRelationships * 25
    + activeDays * 14
    + activeStreakDays * 30
  );
  const level = Math.max(1, Math.floor(xp / 120) + 1);

  return {
    entityId,
    entityName,
    level,
    xp,
    responseConsistency: Number(responseConsistency.toFixed(3)),
    mentionsReplied: mentionsSent,
    mentionsReceived,
    uniqueRelationships,
    activeDays,
    activeStreakDays
  };
}

async function awardEntityBadge(entityId, badgeKey, metadata = {}) {
  const result = await pool.query(
    `INSERT INTO entity_badges (entity_id, badge_key, metadata_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (entity_id, badge_key) DO UPDATE SET
       metadata_json = EXCLUDED.metadata_json,
       awarded_at = entity_badges.awarded_at
     RETURNING entity_id, badge_key, awarded_at, metadata_json`,
    [entityId, badgeKey, JSON.stringify(metadata || {})]
  );
  const row = result.rows[0];
  return {
    entityId: row.entity_id,
    badgeKey: row.badge_key,
    awardedAt: row.awarded_at,
    metadata: row.metadata_json || {}
  };
}

async function getEntityBadges(entityId) {
  const result = await pool.query(
    `SELECT badge_key, awarded_at, metadata_json
     FROM entity_badges
     WHERE entity_id = $1
     ORDER BY awarded_at DESC, badge_key ASC`,
    [entityId]
  );
  return result.rows.map(row => ({
    badgeKey: row.badge_key,
    awardedAt: row.awarded_at,
    metadata: row.metadata_json || {}
  }));
}

function deriveBadgeAwardsFromTelemetry(metrics) {
  const awards = [];
  if (!metrics || typeof metrics !== 'object') return awards;

  if (metrics.mentionsReceived >= 5 && metrics.responseConsistency >= 0.8) {
    awards.push({
      badgeKey: 'response-consistency',
      reason: 'Maintained strong mention reply consistency',
      threshold: { mentionsReceivedMin: 5, responseConsistencyMin: 0.8 }
    });
  }

  if (metrics.uniqueRelationships >= 8) {
    awards.push({
      badgeKey: 'social-breadth',
      reason: 'Built a broad social graph with unique relationships',
      threshold: { uniqueRelationshipsMin: 8 }
    });
  }

  if (metrics.activeStreakDays >= 5) {
    awards.push({
      badgeKey: 'activity-streak',
      reason: 'Maintained a multi-day activity streak',
      threshold: { activeStreakDaysMin: 5 }
    });
  }

  return awards;
}

async function evaluateAndAwardEntityBadges(entityId) {
  const metrics = await getEntityAchievements(entityId);
  if (!metrics) return null;
  const derivedAwards = deriveBadgeAwardsFromTelemetry(metrics);

  for (const award of derivedAwards) {
    await awardEntityBadge(entityId, award.badgeKey, {
      reason: award.reason,
      threshold: award.threshold,
      telemetry: {
        responseConsistency: metrics.responseConsistency,
        mentionsReceived: metrics.mentionsReceived,
        uniqueRelationships: metrics.uniqueRelationships,
        activeStreakDays: metrics.activeStreakDays,
        evaluatedAt: new Date().toISOString()
      }
    });
  }

  const earnedBadges = await getEntityBadges(entityId);
  return {
    ...metrics,
    earnedBadges,
    derivedBadgeAwards: derivedAwards
  };
}

async function getCurrentLeaderboard(limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const entities = await listEntities('lobster');
  const rows = [];

  for (const entity of entities) {
    const metrics = await evaluateAndAwardEntityBadges(entity.entity_id);
    if (!metrics) continue;
    const score = Math.round(
      metrics.xp
      + (metrics.uniqueRelationships * 8)
      + (metrics.activeStreakDays * 20)
      + (metrics.responseConsistency * 60)
    );

    rows.push({
      entityId: entity.entity_id,
      entityName: entity.entity_name || entity.entity_id,
      level: metrics.level,
      xp: metrics.xp,
      score,
      activeStreakDays: metrics.activeStreakDays,
      uniqueRelationships: metrics.uniqueRelationships,
      responseConsistency: metrics.responseConsistency,
      earnedBadges: metrics.earnedBadges
    });
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.level !== a.level) return b.level - a.level;
    return String(a.entityName).localeCompare(String(b.entityName));
  });

  return rows.slice(0, safeLimit).map((row, idx) => ({
    ...row,
    rank: idx + 1
  }));
}

async function saveSeasonalLeaderboardSnapshot(seasonId, leaderboard, computedAt = new Date()) {
  if (!seasonId || !Array.isArray(leaderboard) || leaderboard.length === 0) {
    return 0;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of leaderboard) {
      await client.query(
        `INSERT INTO seasonal_leaderboard_snapshots (season_id, entity_id, score, rank, computed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (season_id, entity_id) DO UPDATE SET
           score = EXCLUDED.score,
           rank = EXCLUDED.rank,
           computed_at = EXCLUDED.computed_at`,
        [seasonId, row.entityId, Number(row.score) || 0, Number(row.rank) || 0, computedAt]
      );
    }
    await client.query(
      `UPDATE leaderboard_trigger_lock
       SET last_snapshot_at = $1,
           last_season_id = $2
       WHERE id = 1`,
      [computedAt, seasonId]
    );
    await client.query('COMMIT');
    return leaderboard.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function acquireLeaderboardLock() {
  const result = await pool.query(
    `UPDATE leaderboard_trigger_lock
     SET is_running = TRUE,
         last_computed_at = NOW()
     WHERE id = 1 AND is_running = FALSE
     RETURNING id`
  );
  return result.rows.length > 0;
}

async function releaseLeaderboardLock() {
  await pool.query(
    `UPDATE leaderboard_trigger_lock
     SET is_running = FALSE,
         last_computed_at = NOW()
     WHERE id = 1`
  );
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
  getEntityAchievements,
  getEntityBadges,
  evaluateAndAwardEntityBadges,
  getCurrentLeaderboard,
  saveSeasonalLeaderboardSnapshot,
  acquireLeaderboardLock,
  releaseLeaderboardLock,
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
  ensureEntityQuest,
  incrementEntityQuestProgress,
  setEntityQuestProgress,
  getEntityQuestSummary,
  claimEntityQuest,
  // Entity interest functions
  getEntityInterests,
  setEntityInterests,
  // Recommendation functions
  getRecommendationCandidates,
  getSpatialRecommendationHints,
  scoreInteractionNovelty,
  trackRecommendationEvent,
  getRecommendationMetrics
};
