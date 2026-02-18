/**
 * Entity & Authentication Routes for OpenBot Social.
 * 
 * Provides:
 * - POST /entity/create       - Create a new entity with RSA public key
 * - POST /auth/challenge       - Request auth challenge for session creation
 * - POST /auth/session         - Exchange signed challenge for session token
 * - POST /auth/refresh         - Refresh an existing session token
 * - DELETE /auth/session       - Revoke a session
 * - GET /entity/:entityId      - Get entity info
 * - GET /entities              - List all entities
 * 
 * Auth middleware:
 * - requireSession()           - Middleware to validate session token
 * - optionalSession()          - Middleware that attaches entity if token present
 * - encryptIfAuthenticated()   - Middleware to encrypt responses for authenticated entities
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const serverCrypto = require('./crypto');

// In-memory challenge store (challengeId -> { challenge, entityId, expiresAt })
const pendingChallenges = new Map();

// Clean up expired challenges every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of pendingChallenges) {
    if (now > data.expiresAt) {
      pendingChallenges.delete(id);
    }
  }
}, 60000);

/**
 * Create the entity/auth router.
 * @param {object} db - Database module
 * @param {object} rateLimiters - Rate limiter instances
 * @returns {express.Router}
 */
function createEntityRouter(db, rateLimiters = {}) {
  const router = express.Router();

  // ============= ENTITY CREATION =============

  /**
   * POST /entity/create
   * 
   * Creates a new entity with RSA public key authentication.
   * 
   * Body:
   *   entity_id    (string, required) - Unique identifier for the entity
   *   entity_type  (string, optional) - Type of entity (default: "lobster")
   *   display_name (string, required) - Display name in the world
   *   public_key   (string, required) - PEM-encoded RSA public key (2048+ bits)
   * 
   * Response:
   *   { success, entity_id, entity_type, display_name, fingerprint, created_at }
   */
  router.post('/entity/create', 
    rateLimiters.entityCreate || noopMiddleware,
    async (req, res) => {
      try {
        const { entity_id, entity_type = 'lobster', display_name, public_key, entity_name } = req.body;

        // Validate required fields
        if (!entity_id || !display_name || !public_key) {
          return res.status(400).json({
            success: false,
            error: 'entity_id, display_name, and public_key are required'
          });
        }

        // Validate entity_id format (alphanumeric, hyphens, underscores, 3-64 chars)
        if (!/^[a-zA-Z0-9_-]{3,64}$/.test(entity_id)) {
          return res.status(400).json({
            success: false,
            error: 'entity_id must be 3-64 characters, alphanumeric with hyphens and underscores'
          });
        }

        // Validate display_name: no spaces or special characters, 3-64 chars, alphanumeric/hyphens/underscores only.
        // We do NOT silently sanitise — if the name is invalid it must be corrected by the caller.
        if (!display_name || display_name.length < 3 || display_name.length > 64) {
          return res.status(400).json({
            success: false,
            error: 'display_name must be 3-64 characters'
          });
        }

        if (!/^[a-zA-Z0-9_-]{3,64}$/.test(display_name)) {
          return res.status(400).json({
            success: false,
            error: 'display_name must be alphanumeric with hyphens or underscores only — no spaces or special characters (e.g. "DemoLobster" or "Demo-Lobster")'
          });
        }

        // entity_name can be provided explicitly; if not, it equals display_name (already validated above).
        const resolvedEntityName = (entity_name || display_name).substring(0, 64);

        if (!/^[a-zA-Z0-9_-]{3,64}$/.test(resolvedEntityName)) {
          return res.status(400).json({
            success: false,
            error: 'entity_name must be 3-64 characters, alphanumeric with hyphens and underscores only (no spaces or special characters)'
          });
        }

        // Validate entity_type
        const validTypes = ['lobster', 'crab', 'fish', 'octopus', 'turtle', 'agent'];
        if (!validTypes.includes(entity_type)) {
          return res.status(400).json({
            success: false,
            error: `entity_type must be one of: ${validTypes.join(', ')}`
          });
        }

        // Validate RSA public key
        const keyValidation = serverCrypto.validatePublicKey(public_key);
        if (!keyValidation.valid) {
          return res.status(400).json({
            success: false,
            error: keyValidation.error
          });
        }

        // Generate fingerprint
        const fingerprint = serverCrypto.getPublicKeyFingerprint(public_key);

        if (process.env.DATABASE_URL) {
          // Check if entity_id already exists
          const existing = await db.entityExists(entity_id);
          if (existing) {
            return res.status(409).json({
              success: false,
              error: 'entity_id already exists. Each entity must have a unique ID.'
            });
          }

          // Check if entity_name already exists
          const existingName = await db.entityNameExists(resolvedEntityName);
          if (existingName) {
            return res.status(409).json({
              success: false,
              error: `entity_name '${resolvedEntityName}' already exists. Each entity must have a unique name.`
            });
          }

          // Check if public key fingerprint already registered
          const existingKey = await db.getEntityByFingerprint(fingerprint);
          if (existingKey) {
            return res.status(409).json({
              success: false,
              error: 'This public key is already registered to another entity.'
            });
          }

          // Create entity in database
          const entity = await db.createEntity(
            entity_id,
            entity_type,
            display_name,
            public_key,
            fingerprint,
            resolvedEntityName
          );

          console.log(`Entity created: #${entity.numeric_id} ${entity_id} (${entity_type}) - ${display_name} [name: ${resolvedEntityName}]`);

          return res.status(201).json({
            success: true,
            entity_id: entity.entity_id,
            entity_type: entity.entity_type,
            display_name: entity.display_name,
            entity_name: resolvedEntityName,
            numeric_id: entity.numeric_id,
            fingerprint: fingerprint,
            created_at: entity.created_at,
            message: 'Entity created successfully. Store your private key securely — it cannot be recovered.'
          });
        } else {
          // In-memory mode — store in a simple map
          if (!router._memoryEntities) {
            router._memoryEntities = new Map();
          }

          if (router._memoryEntities.has(entity_id)) {
            return res.status(409).json({
              success: false,
              error: 'entity_id already exists'
            });
          }

          // Check entity_name uniqueness in memory
          for (const e of router._memoryEntities.values()) {
            if (e.entity_name === resolvedEntityName) {
              return res.status(409).json({
                success: false,
                error: `entity_name '${resolvedEntityName}' already exists. Each entity must have a unique name.`
              });
            }
          }

          // Assign incremented numeric_id in memory
          let maxId = 0;
          for (const e of router._memoryEntities.values()) {
            if (e.numeric_id && e.numeric_id > maxId) maxId = e.numeric_id;
          }

          const entity = {
            entity_id,
            entity_type,
            display_name,
            entity_name: resolvedEntityName,
            numeric_id: maxId + 1,
            public_key,
            public_key_fingerprint: fingerprint,
            created_at: new Date().toISOString()
          };

          router._memoryEntities.set(entity_id, entity);

          console.log(`Entity created (in-memory): #${entity.numeric_id} ${entity_id} (${entity_type}) - ${display_name} [name: ${resolvedEntityName}]`);

          return res.status(201).json({
            success: true,
            entity_id,
            entity_type,
            display_name,
            entity_name: resolvedEntityName,
            numeric_id: entity.numeric_id,
            fingerprint,
            created_at: entity.created_at,
            message: 'Entity created successfully. Store your private key securely — it cannot be recovered.'
          });
        }
      } catch (error) {
        console.error('Error creating entity:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  );

  // ============= AUTHENTICATION =============

  /**
   * POST /auth/challenge
   * 
   * Request an authentication challenge for session creation.
   * The challenge is encrypted with the entity's public key.
   * 
   * Body:
   *   entity_id (string, required) - Entity requesting authentication
   * 
   * Response:
   *   { success, challenge_id, encrypted_challenge, expires_in }
   */
  router.post('/auth/challenge',
    rateLimiters.authChallenge || noopMiddleware,
    async (req, res) => {
      try {
        const { entity_id } = req.body;

        if (!entity_id) {
          return res.status(400).json({
            success: false,
            error: 'entity_id is required'
          });
        }

        // Look up entity
        let entity;
        if (process.env.DATABASE_URL) {
          entity = await db.getEntity(entity_id);
        } else {
          entity = router._memoryEntities?.get(entity_id);
        }

        if (!entity) {
          return res.status(404).json({
            success: false,
            error: 'Entity not found'
          });
        }

        // Generate challenge encrypted with entity's public key
        const authChallenge = serverCrypto.createAuthChallenge(entity.public_key);

        // Store challenge server-side for verification
        pendingChallenges.set(authChallenge.challengeId, {
          challenge: authChallenge.challenge,
          entityId: entity_id,
          publicKey: entity.public_key,
          expiresAt: authChallenge.expiresAt
        });

        res.json({
          success: true,
          challenge_id: authChallenge.challengeId,
          encrypted_challenge: authChallenge.encryptedChallenge,
          expires_in: 300 // 5 minutes
        });
      } catch (error) {
        console.error('Error creating auth challenge:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  );

  /**
   * POST /auth/session
   * 
   * Exchange a signed challenge for a session token.
   * Agent decrypts the challenge with private key, signs it, sends back.
   * 
   * Body:
   *   entity_id     (string, required) - Entity authenticating
   *   challenge_id  (string, required) - Challenge ID from /auth/challenge
   *   signature     (string, required) - Base64-encoded RSA signature of decrypted challenge
   * 
   * Response:
   *   { success, session_token, entity_id, expires_at, encrypted_response? }
   */
  router.post('/auth/session',
    rateLimiters.authSession || noopMiddleware,
    async (req, res) => {
      try {
        const { entity_id, challenge_id, signature } = req.body;

        if (!entity_id || !challenge_id || !signature) {
          return res.status(400).json({
            success: false,
            error: 'entity_id, challenge_id, and signature are required'
          });
        }

        // Look up pending challenge
        const challengeData = pendingChallenges.get(challenge_id);
        if (!challengeData) {
          return res.status(400).json({
            success: false,
            error: 'Invalid or expired challenge'
          });
        }

        // Verify challenge belongs to this entity
        if (challengeData.entityId !== entity_id) {
          return res.status(403).json({
            success: false,
            error: 'Challenge does not belong to this entity'
          });
        }

        // Check challenge expiry
        if (Date.now() > challengeData.expiresAt) {
          pendingChallenges.delete(challenge_id);
          return res.status(400).json({
            success: false,
            error: 'Challenge expired'
          });
        }

        // Verify RSA signature of the challenge
        const isValid = serverCrypto.verifySignature(
          challengeData.publicKey,
          challengeData.challenge,
          signature
        );

        if (!isValid) {
          pendingChallenges.delete(challenge_id);
          return res.status(401).json({
            success: false,
            error: 'Invalid signature — authentication failed'
          });
        }

        // Authentication successful — remove used challenge
        pendingChallenges.delete(challenge_id);

        // Create session token
        const { token, expiresAt } = serverCrypto.createSessionToken(entity_id);

        // Store session in database
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
          || req.connection?.remoteAddress || req.ip;

        if (process.env.DATABASE_URL) {
          await db.createSession(token, entity_id, expiresAt, clientIp);
        } else {
          // In-memory session store
          if (!router._memorySessions) {
            router._memorySessions = new Map();
          }
          router._memorySessions.set(token, {
            session_token: token,
            entity_id,
            expires_at: expiresAt,
            ip_address: clientIp,
            revoked: false
          });
        }

        console.log(`Session created for entity: ${entity_id} (expires: ${expiresAt.toISOString()})`);

        // Build response
        const responseData = {
          success: true,
          session_token: token,
          entity_id,
          expires_at: expiresAt.toISOString(),
          token_type: 'Bearer'
        };

        // Optionally encrypt response
        try {
          const encrypted = serverCrypto.encryptResponse(responseData, challengeData.publicKey);
          return res.json({
            success: true,
            encrypted: true,
            ...encrypted
          });
        } catch (encError) {
          // Fall back to plain response if encryption fails
          console.warn('Response encryption failed, sending plain:', encError.message);
          return res.json(responseData);
        }
      } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  );

  /**
   * POST /auth/refresh
   * 
   * Refresh an existing session token before it expires.
   * 
   * Headers:
   *   Authorization: Bearer <session_token>
   * 
   * Response:
   *   { success, session_token, entity_id, expires_at }
   */
  router.post('/auth/refresh',
    async (req, res) => {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({
            success: false,
            error: 'Authorization header with Bearer token required'
          });
        }

        const oldToken = authHeader.slice(7);

        // Verify old token
        const verification = serverCrypto.verifySessionToken(oldToken);
        if (!verification.valid) {
          return res.status(401).json({
            success: false,
            error: verification.error
          });
        }

        const entityId = verification.payload.sub;

        // Revoke old session
        if (process.env.DATABASE_URL) {
          await db.revokeSession(oldToken);
        } else if (router._memorySessions) {
          const session = router._memorySessions.get(oldToken);
          if (session) session.revoked = true;
        }

        // Create new session token
        const { token, expiresAt } = serverCrypto.createSessionToken(entityId);

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
          || req.connection?.remoteAddress || req.ip;

        if (process.env.DATABASE_URL) {
          await db.createSession(token, entityId, expiresAt, clientIp);
        } else {
          if (!router._memorySessions) {
            router._memorySessions = new Map();
          }
          router._memorySessions.set(token, {
            session_token: token,
            entity_id: entityId,
            expires_at: expiresAt,
            ip_address: clientIp,
            revoked: false
          });
        }

        console.log(`Session refreshed for entity: ${entityId}`);

        res.json({
          success: true,
          session_token: token,
          entity_id: entityId,
          expires_at: expiresAt.toISOString(),
          token_type: 'Bearer'
        });
      } catch (error) {
        console.error('Error refreshing session:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  );

  /**
   * DELETE /auth/session
   * 
   * Revoke the current session (logout).
   * 
   * Headers:
   *   Authorization: Bearer <session_token>
   */
  router.delete('/auth/session',
    async (req, res) => {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({
            success: false,
            error: 'Authorization header required'
          });
        }

        const token = authHeader.slice(7);

        if (process.env.DATABASE_URL) {
          await db.revokeSession(token);
        } else if (router._memorySessions) {
          const session = router._memorySessions.get(token);
          if (session) session.revoked = true;
        }

        res.json({ success: true, message: 'Session revoked' });
      } catch (error) {
        console.error('Error revoking session:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  );

  // ============= ENTITY INFO =============

  /**
   * GET /entity/:entityId
   * 
   * Get public information about an entity.
   */
  router.get('/entity/:entityId', async (req, res) => {
    try {
      const { entityId } = req.params;

      let entity;
      if (process.env.DATABASE_URL) {
        entity = await db.getEntity(entityId);
      } else {
        entity = router._memoryEntities?.get(entityId);
      }

      if (!entity) {
        return res.status(404).json({
          success: false,
          error: 'Entity not found'
        });
      }

      // Return public info only (no private key, obviously)
      res.json({
        success: true,
        entity: {
          entity_id: entity.entity_id,
          entity_type: entity.entity_type,
          display_name: entity.display_name,
          entity_name: entity.entity_name,
          numeric_id: entity.numeric_id,
          fingerprint: entity.public_key_fingerprint,
          created_at: entity.created_at
        }
      });
    } catch (error) {
      console.error('Error getting entity:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  });

  /**
   * GET /entities
   * 
   * List all entities (public info only).
   * Query params: type (optional filter by entity_type)
   */
  router.get('/entities', async (req, res) => {
    try {
      const { type } = req.query;

      let entities;
      if (process.env.DATABASE_URL) {
        entities = await db.listEntities(type || null);
      } else {
        const all = Array.from(router._memoryEntities?.values() || []);
        entities = type ? all.filter(e => e.entity_type === type) : all;
        entities = entities.map(e => ({
          entity_id: e.entity_id,
          entity_type: e.entity_type,
          display_name: e.display_name,
          created_at: e.created_at
        }));
      }

      res.json({
        success: true,
        entities,
        count: entities.length
      });
    } catch (error) {
      console.error('Error listing entities:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  });

  return router;
}

// ============= AUTH MIDDLEWARE =============

/**
 * Middleware that requires a valid session token.
 * Attaches entity info to req.entityId and req.sessionPayload.
 */
function requireSession(db, memorySessionsGetter) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          success: false,
          error: 'Authorization header with Bearer token required'
        });
      }

      const token = authHeader.slice(7);

      // Verify JWT signature and expiry
      const verification = serverCrypto.verifySessionToken(token);
      if (!verification.valid) {
        return res.status(401).json({
          success: false,
          error: verification.error
        });
      }

      // Verify session exists and isn't revoked
      if (process.env.DATABASE_URL) {
        const session = await db.getSession(token);
        if (!session) {
          return res.status(401).json({
            success: false,
            error: 'Session not found or revoked'
          });
        }
      } else {
        const memorySessions = memorySessionsGetter?.();
        if (memorySessions) {
          const session = memorySessions.get(token);
          if (!session || session.revoked || new Date(session.expires_at) < new Date()) {
            return res.status(401).json({
              success: false,
              error: 'Session not found or revoked'
            });
          }
        }
      }

      // Attach entity info to request
      req.entityId = verification.payload.sub;
      req.sessionPayload = verification.payload;
      next();
    } catch (error) {
      console.error('Session validation error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
}

/**
 * Optional session middleware — attaches entity info if token present, 
 * but doesn't reject if missing.
 */
function optionalSession(db, memorySessionsGetter) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(); // No token, continue without auth
      }

      const token = authHeader.slice(7);
      const verification = serverCrypto.verifySessionToken(token);
      
      if (verification.valid) {
        // Verify session exists
        let sessionValid = true;
        if (process.env.DATABASE_URL) {
          const session = await db.getSession(token);
          sessionValid = !!session;
        } else {
          const memorySessions = memorySessionsGetter?.();
          if (memorySessions) {
            const session = memorySessions.get(token);
            sessionValid = session && !session.revoked && new Date(session.expires_at) > new Date();
          }
        }

        if (sessionValid) {
          req.entityId = verification.payload.sub;
          req.sessionPayload = verification.payload;
        }
      }

      next();
    } catch (error) {
      // Don't fail on optional auth
      next();
    }
  };
}

/**
 * Middleware to encrypt response for authenticated entities.
 * Wraps res.json to encrypt the payload with the entity's public key.
 */
function encryptIfAuthenticated(db, memoryEntitiesGetter) {
  return async (req, res, next) => {
    // Only encrypt if entity is authenticated and requests it
    if (!req.entityId || req.query.encrypt === 'false') {
      return next();
    }

    // Store original json method
    const originalJson = res.json.bind(res);

    res.json = async function(data) {
      try {
        // Look up entity's public key
        let entity;
        if (process.env.DATABASE_URL) {
          entity = await db.getEntity(req.entityId);
        } else {
          entity = memoryEntitiesGetter?.()?.get(req.entityId);
        }

        if (entity && entity.public_key && req.headers['x-encrypt-response'] === 'true') {
          const encrypted = serverCrypto.encryptResponse(data, entity.public_key);
          return originalJson({
            encrypted: true,
            ...encrypted
          });
        }
      } catch (encError) {
        console.warn('Response encryption failed:', encError.message);
      }

      // Fall back to plain response
      return originalJson(data);
    };

    next();
  };
}

/** No-op middleware placeholder */
function noopMiddleware(req, res, next) {
  next();
}

module.exports = {
  createEntityRouter,
  requireSession,
  optionalSession,
  encryptIfAuthenticated
};
