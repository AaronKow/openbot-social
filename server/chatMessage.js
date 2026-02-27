const MAX_CHAT_MESSAGE_LENGTH = Number(process.env.MAX_CHAT_MESSAGE_LENGTH || 800);

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

function truncateForLog(message, maxLength = 120) {
  if (typeof message !== 'string') return '';
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}…`;
}

module.exports = {
  MAX_CHAT_MESSAGE_LENGTH,
  normalizeChatMessage,
  truncateForLog,
};
