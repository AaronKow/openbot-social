const MAX_CHAT_MESSAGE_LENGTH = Number(process.env.MAX_CHAT_MESSAGE_LENGTH || 800);
const CHAT_DUPLICATE_WINDOW_MS = Number(process.env.CHAT_DUPLICATE_WINDOW_MS || 45_000);

const CHAT_FILLER_WORDS = new Set([
  'a', 'an', 'and', 'are', 'be', 'but', 'for', 'from', 'hey', 'hi', 'i', 'im', 'is',
  'it', 'me', 'my', 'no', 'of', 'oh', 'ok', 'okay', 'on', 'or', 'the', 'to', 'uh',
  'um', 'wait', 'we', 'you', 'yo', 'yes'
]);

function normalizeChatMessage(rawMessage) {
  if (typeof rawMessage !== 'string') {
    throw new Error('message must be a string');
  }

  const message = rawMessage.trim();
  if (!message) {
    throw new Error('message must not be empty');
  }

  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new Error(`message exceeds max length of ${MAX_CHAT_MESSAGE_LENGTH}`);
  }

  return message;
}

function canonicalizeChatMessage(rawMessage) {
  if (typeof rawMessage !== 'string') return '';
  return rawMessage
    .toLowerCase()
    .replace(/@[a-z0-9_-]+/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLowSignalChatMessage(message) {
  const canonical = canonicalizeChatMessage(message);
  if (!canonical) return true;

  if (canonical.length < 6) return true;

  const tokens = canonical.split(' ').filter(Boolean);
  const contentTokens = tokens.filter(token => !CHAT_FILLER_WORDS.has(token));
  const hasLongContentToken = contentTokens.some(token => token.length >= 3);

  if (!hasLongContentToken) return true;

  return false;
}

function findDuplicateMessageByAgent(recentMessages, agentId, message, nowMs = Date.now()) {
  if (!Array.isArray(recentMessages) || !agentId) return null;

  const incomingCanonical = canonicalizeChatMessage(message);
  if (!incomingCanonical) return null;

  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const entry = recentMessages[i];
    if (!entry || entry.agentId !== agentId) continue;

    const ageMs = nowMs - Number(entry.timestamp || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0) continue;
    if (ageMs > CHAT_DUPLICATE_WINDOW_MS) break;

    const existingCanonical = canonicalizeChatMessage(entry.message || '');
    if (existingCanonical && existingCanonical === incomingCanonical) {
      return {
        duplicateOf: entry,
        retryAfterMs: Math.max(0, CHAT_DUPLICATE_WINDOW_MS - ageMs)
      };
    }
  }

  return null;
}

function truncateForLog(message, maxLength = 120) {
  if (typeof message !== 'string') return '';
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}…`;
}

module.exports = {
  CHAT_DUPLICATE_WINDOW_MS,
  canonicalizeChatMessage,
  findDuplicateMessageByAgent,
  isLowSignalChatMessage,
  MAX_CHAT_MESSAGE_LENGTH,
  normalizeChatMessage,
  truncateForLog,
};
