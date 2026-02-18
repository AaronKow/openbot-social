/**
 * Crypto utilities for RSA key verification, AES-256 encryption,
 * and JWT session token management.
 * 
 * Security model:
 * - Agent generates RSA key pair locally (private key never leaves agent)
 * - Agent sends public key during entity creation
 * - Server verifies ownership via RSA challenge-response
 * - Session tokens (JWT) issued after authentication
 * - All sensitive responses encrypted with AES-256 using shared key derived from RSA
 */

const crypto = require('crypto');

// ============= RSA UTILITIES =============

/**
 * Validate that a PEM-encoded public key is a valid RSA key (2048+ bits).
 * @param {string} publicKeyPem - PEM-encoded RSA public key
 * @returns {{ valid: boolean, error?: string, bits?: number }}
 */
function validatePublicKey(publicKeyPem) {
  try {
    const keyObject = crypto.createPublicKey(publicKeyPem);
    const keyDetails = keyObject.export({ type: 'spki', format: 'der' });
    
    // Check it's RSA
    if (keyObject.asymmetricKeyType !== 'rsa') {
      return { valid: false, error: 'Key must be RSA type' };
    }
    
    // Check minimum key size (2048 bits)
    const keySize = keyObject.asymmetricKeySize;
    if (keySize && keySize < 256) { // 256 bytes = 2048 bits
      return { valid: false, error: 'RSA key must be at least 2048 bits' };
    }
    
    return { valid: true, bits: keySize ? keySize * 8 : 2048 };
  } catch (error) {
    return { valid: false, error: `Invalid public key: ${error.message}` };
  }
}

/**
 * Generate a SHA-256 fingerprint of a public key.
 * @param {string} publicKeyPem - PEM-encoded RSA public key
 * @returns {string} Hex-encoded SHA-256 fingerprint
 */
function getPublicKeyFingerprint(publicKeyPem) {
  const normalized = publicKeyPem.trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate a random challenge string for RSA authentication.
 * @returns {{ challenge: string, timestamp: number }}
 */
function generateChallenge() {
  const challenge = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();
  return { challenge, timestamp };
}

/**
 * Verify an RSA signature against a challenge.
 * @param {string} publicKeyPem - PEM-encoded RSA public key
 * @param {string} challenge - The challenge string that was signed
 * @param {string} signatureBase64 - Base64-encoded RSA signature
 * @returns {boolean} True if signature is valid
 */
function verifySignature(publicKeyPem, challenge, signatureBase64) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(challenge);
    verify.end();
    return verify.verify(publicKeyPem, signatureBase64, 'base64');
  } catch (error) {
    return false;
  }
}

// ============= JWT SESSION TOKENS =============

// Server-side secret for JWT signing (generated on startup, or from env)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY_HOURS = parseInt(process.env.JWT_EXPIRY_HOURS || '24', 10);

/**
 * Create a JWT-like session token.
 * Uses HMAC-SHA256 for signing.
 * @param {string} entityId - Entity identifier
 * @param {object} [extra] - Additional claims
 * @returns {{ token: string, expiresAt: Date }}
 */
function createSessionToken(entityId, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (JWT_EXPIRY_HOURS * 3600);
  
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: entityId,
    iat: now,
    exp: expiresAt,
    jti: crypto.randomBytes(16).toString('hex'),
    ...extra
  })).toString('base64url');
  
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  
  const token = `${header}.${payload}.${signature}`;
  const expiresAtDate = new Date(expiresAt * 1000);
  
  return { token, expiresAt: expiresAtDate };
}

/**
 * Verify and decode a JWT session token.
 * @param {string} token - JWT token string
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
function verifySessionToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid token format' };
    }
    
    const [header, payload, signature] = parts;
    
    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    
    if (!crypto.timingSafeEqual(
      Buffer.from(signature, 'base64url'),
      Buffer.from(expectedSignature, 'base64url')
    )) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    // Decode payload
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    
    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return { valid: false, error: 'Token expired' };
    }
    
    return { valid: true, payload: decoded };
  } catch (error) {
    return { valid: false, error: `Token verification failed: ${error.message}` };
  }
}

// ============= AES-256 RESPONSE ENCRYPTION =============

/**
 * Encrypt data with AES-256-GCM using a key derived from the entity's public key.
 * The AES key is encrypted with RSA so only the private key holder can decrypt.
 * 
 * @param {string|object} data - Data to encrypt (will be JSON-stringified if object)
 * @param {string} publicKeyPem - PEM-encoded RSA public key of the recipient
 * @returns {{ encryptedData: string, encryptedKey: string, iv: string, authTag: string }}
 */
function encryptResponse(data, publicKeyPem) {
  try {
    // Generate a random AES-256 key for this response
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    
    // Encrypt the data with AES-256-GCM
    const plaintext = typeof data === 'object' ? JSON.stringify(data) : String(data);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    // Encrypt the AES key with the entity's RSA public key
    const encryptedKey = crypto.publicEncrypt(
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      aesKey
    ).toString('base64');
    
    return {
      encryptedData: encrypted,
      encryptedKey: encryptedKey,
      iv: iv.toString('base64'),
      authTag: authTag
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Create a challenge-response payload for entity authentication.
 * The challenge is encrypted with the entity's public key so only
 * the private key holder can decrypt and sign it.
 * 
 * @param {string} publicKeyPem - PEM-encoded RSA public key
 * @returns {{ encryptedChallenge: string, challengeId: string, expiresAt: number }}
 */
function createAuthChallenge(publicKeyPem) {
  const challenge = crypto.randomBytes(32).toString('hex');
  const challengeId = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minute expiry
  
  // Encrypt challenge with public key
  const encryptedChallenge = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(challenge, 'hex')
  ).toString('base64');
  
  return {
    challenge,          // Store server-side for verification
    encryptedChallenge, // Send to client
    challengeId,
    expiresAt
  };
}

module.exports = {
  // RSA
  validatePublicKey,
  getPublicKeyFingerprint,
  generateChallenge,
  verifySignature,
  // JWT
  createSessionToken,
  verifySessionToken,
  JWT_EXPIRY_HOURS,
  // AES
  encryptResponse,
  // Auth challenge
  createAuthChallenge
};
