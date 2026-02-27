const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const serverCrypto = require('../crypto');


function loadCryptoWithExpiry(expiryHours) {
  const previousExpiry = process.env.JWT_EXPIRY_HOURS;

  if (expiryHours === undefined) {
    delete process.env.JWT_EXPIRY_HOURS;
  } else {
    process.env.JWT_EXPIRY_HOURS = expiryHours;
  }

  delete require.cache[require.resolve('../crypto')];
  const loaded = require('../crypto');

  if (previousExpiry === undefined) {
    delete process.env.JWT_EXPIRY_HOURS;
  } else {
    process.env.JWT_EXPIRY_HOURS = previousExpiry;
  }

  return loaded;
}

test('validatePublicKey accepts generated RSA public key', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });

  const result = serverCrypto.validatePublicKey(pem);
  assert.equal(result.valid, true);
});

test('challenge/signature roundtrip verifies successfully', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const challenge = serverCrypto.generateChallenge();
  const signature = crypto.sign('sha256', Buffer.from(challenge.challenge), privateKey).toString('base64');

  const verified = serverCrypto.verifySignature(pubPem, challenge.challenge, signature);
  assert.equal(verified, true);
});

test('session token can be created and verified', () => {
  const tokenResult = serverCrypto.createSessionToken('entity-123');
  const result = serverCrypto.verifySessionToken(tokenResult.token);

  assert.equal(result.valid, true);
  assert.equal(result.payload.sub, 'entity-123');
});

test('encryptResponse + createAuthChallenge produce decryptable payloads', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const encrypted = serverCrypto.encryptResponse({ ok: true, nested: { count: 2 } }, pubPem);
  const decryptedKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(encrypted.encryptedKey, 'base64')
  );

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    decryptedKey,
    Buffer.from(encrypted.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  let plaintext = decipher.update(encrypted.encryptedData, 'base64', 'utf8');
  plaintext += decipher.final('utf8');

  assert.deepEqual(JSON.parse(plaintext), { ok: true, nested: { count: 2 } });

  const challenge = serverCrypto.createAuthChallenge(pubPem);
  const decryptedChallenge = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(challenge.encryptedChallenge, 'base64')
  ).toString('hex');

  assert.equal(decryptedChallenge, challenge.challenge);
});


test('invalid JWT_EXPIRY_HOURS falls back to 24 hours for token expiry', () => {
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;

  try {
    const cryptoWithInvalidExpiry = loadCryptoWithExpiry('not-a-number');
    const session = cryptoWithInvalidExpiry.createSessionToken('entity-invalid-expiry');

    assert.equal(cryptoWithInvalidExpiry.JWT_EXPIRY_HOURS, 24);

    const expectedSeconds = 24 * 60 * 60 * 1000;
    assert.equal(session.expiresAt.getTime(), Date.now() + expectedSeconds);

    Date.now = () => 1_700_000_000_000 + expectedSeconds + 1_000;
    const verification = cryptoWithInvalidExpiry.verifySessionToken(session.token);
    assert.equal(verification.valid, false);
    assert.match(verification.error, /expired/i);
  } finally {
    Date.now = originalNow;
  }
});

test('non-positive JWT_EXPIRY_HOURS also falls back to 24 hours', () => {
  const cryptoWithZeroExpiry = loadCryptoWithExpiry('0');
  const session = cryptoWithZeroExpiry.createSessionToken('entity-zero-expiry');
  const verification = cryptoWithZeroExpiry.verifySessionToken(session.token);

  assert.equal(cryptoWithZeroExpiry.JWT_EXPIRY_HOURS, 24);
  assert.equal(verification.valid, true);
});
