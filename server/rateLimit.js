/**
 * Rate limiting middleware for OpenBot Social.
 * 
 * Supports both in-memory (no DB) and database-backed rate limiting.
 * Tracks by IP address and optionally by entity_id.
 * 
 * Rate limits per action type:
 * - entity_create:  5 per hour per IP
 * - auth_challenge: 20 per hour per IP  
 * - auth_session:   30 per hour per IP
 * - chat:          60 per minute per entity
 * - move:         120 per minute per entity
 * - action:        60 per minute per entity
 * - general:       300 per minute per IP
 */

// In-memory rate limit store (used when no database)
const memoryStore = new Map();

// Rate limit configurations
const RATE_LIMITS = {
  entity_create: { maxRequests: 5, windowSeconds: 3600 },    // 5/hour
  auth_challenge: { maxRequests: 20, windowSeconds: 3600 },   // 20/hour
  auth_session: { maxRequests: 30, windowSeconds: 3600 },     // 30/hour
  chat: { maxRequests: 60, windowSeconds: 60 },               // 60/min
  move: { maxRequests: 120, windowSeconds: 60 },              // 120/min
  action: { maxRequests: 60, windowSeconds: 60 },             // 60/min
  general: { maxRequests: 300, windowSeconds: 60 }            // 300/min
};

/**
 * Get client IP address from request.
 * Supports proxy forwarding headers.
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.connection?.remoteAddress 
    || req.ip 
    || 'unknown';
}

/**
 * In-memory rate limit check.
 */
function checkMemoryRateLimit(identifier, actionType, maxRequests, windowSeconds) {
  const key = `${identifier}:${actionType}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  
  let entry = memoryStore.get(key);
  
  if (!entry || (now - entry.windowStart) > windowMs) {
    // New window
    entry = { count: 1, windowStart: now };
    memoryStore.set(key, entry);
    return { 
      allowed: true, 
      remaining: maxRequests - 1, 
      resetAt: new Date(now + windowMs) 
    };
  }
  
  if (entry.count >= maxRequests) {
    return { 
      allowed: false, 
      remaining: 0, 
      resetAt: new Date(entry.windowStart + windowMs) 
    };
  }
  
  entry.count++;
  return { 
    allowed: true, 
    remaining: maxRequests - entry.count, 
    resetAt: new Date(entry.windowStart + windowMs) 
  };
}

// Periodically clean up expired memory entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    // Remove entries older than 2 hours
    if (now - entry.windowStart > 7200000) {
      memoryStore.delete(key);
    }
  }
}, 300000);

/**
 * Create rate limiting middleware for a specific action type.
 * 
 * @param {string} actionType - One of the keys in RATE_LIMITS
 * @param {object} [options] - Override options
 * @param {string} [options.identifierFn] - Function to extract identifier from request
 * @param {object} [db] - Database module (optional, falls back to memory)
 * @returns {Function} Express middleware
 */
function createRateLimiter(actionType, options = {}, db = null) {
  const config = RATE_LIMITS[actionType] || RATE_LIMITS.general;
  
  return async (req, res, next) => {
    try {
      // Determine identifier (IP by default, entity_id if provided)
      let identifier;
      if (options.identifierFn) {
        identifier = options.identifierFn(req);
      } else {
        identifier = getClientIp(req);
      }
      
      let result;
      
      if (db && process.env.DATABASE_URL) {
        // Use database-backed rate limiting
        result = await db.checkRateLimit(
          identifier, 
          actionType, 
          config.maxRequests, 
          config.windowSeconds
        );
      } else {
        // Use in-memory rate limiting
        result = checkMemoryRateLimit(
          identifier, 
          actionType, 
          config.maxRequests, 
          config.windowSeconds
        );
      }
      
      // Set rate limit headers
      res.set('X-RateLimit-Limit', String(config.maxRequests));
      res.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
      res.set('X-RateLimit-Reset', String(Math.floor(result.resetAt.getTime() / 1000)));
      
      if (!result.allowed) {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
          limit: config.maxRequests,
          windowSeconds: config.windowSeconds
        });
      }
      
      next();
    } catch (error) {
      console.error(`Rate limit check error for ${actionType}:`, error);
      // On error, allow the request (fail open)
      next();
    }
  };
}

/**
 * Create entity-based rate limiter (uses entity_id from body or session).
 */
function createEntityRateLimiter(actionType, db = null) {
  return createRateLimiter(actionType, {
    identifierFn: (req) => {
      // Try to get entity_id from various sources
      return req.body?.entityId 
        || req.entityId  // Set by auth middleware
        || req.body?.agentId 
        || getClientIp(req);
    }
  }, db);
}

module.exports = {
  createRateLimiter,
  createEntityRateLimiter,
  getClientIp,
  RATE_LIMITS
};
