const { v4: uuidv4 } = require('uuid');

const MAX_QUEUE_ACTIONS = Number(process.env.ACTION_QUEUE_MAX_ACTIONS || 8);
const MAX_QUEUE_TOTAL_TICKS = Number(process.env.ACTION_QUEUE_MAX_TOTAL_TICKS || 30);
const MAX_TICKS_PER_ACTION = Number(process.env.ACTION_QUEUE_MAX_TICKS_PER_ACTION || 10);

const ALLOWED_ACTIONS = new Set([
  'move', 'move_to_agent', 'jump', 'dance', 'emoji', 'talk', 'emote', 'wait'
]);

function asPositiveInt(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function validateActionItem(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Each action must be an object');
  }
  const type = String(raw.type || '').trim();
  if (!ALLOWED_ACTIONS.has(type)) {
    throw new Error(`Unsupported action type: ${type}`);
  }

  const requiredTicks = Math.min(MAX_TICKS_PER_ACTION, asPositiveInt(raw.requiredTicks, 1));
  const action = { type, requiredTicks };

  if (type === 'move') {
    const x = Number(raw.x);
    const z = Number(raw.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error('move requires numeric x and z');
    }
    action.x = x;
    action.z = z;
    if (raw.y !== undefined) action.y = Number(raw.y) || 0;
    if (raw.rotation !== undefined) action.rotation = Number(raw.rotation) || 0;
  }

  if (type === 'move_to_agent') {
    const agentName = String(raw.agent_name || raw.agentName || '').trim();
    if (!agentName) {
      throw new Error('move_to_agent requires agent_name');
    }
    action.agent_name = agentName.slice(0, 64);
  }

  if (type === 'talk') {
    const message = String(raw.message || '').trim();
    if (!message) {
      throw new Error('talk requires non-empty message');
    }
    action.message = message.slice(0, 280);
  }

  if (type === 'emoji') {
    const emoji = String(raw.emoji || '').trim();
    if (!emoji) {
      throw new Error('emoji requires emoji field');
    }
    action.emoji = emoji.slice(0, 32);
  }

  if (type === 'dance') {
    const style = String(raw.style || '').trim();
    if (style) action.style = style.slice(0, 64);
  }

  if (type === 'emote') {
    const emote = String(raw.emote || '').trim();
    action.emote = (emote || 'wave').slice(0, 64);
  }

  return action;
}

function normalizeQueueActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('actions must be a non-empty array');
  }
  if (actions.length > MAX_QUEUE_ACTIONS) {
    throw new Error(`Maximum ${MAX_QUEUE_ACTIONS} actions allowed`);
  }

  const normalized = actions.map(validateActionItem);
  const totalRequiredTicks = normalized.reduce((sum, action) => sum + action.requiredTicks, 0);
  if (totalRequiredTicks > MAX_QUEUE_TOTAL_TICKS) {
    throw new Error(`Total requiredTicks exceeds max of ${MAX_QUEUE_TOTAL_TICKS}`);
  }

  return {
    actions: normalized,
    totalRequiredTicks,
    totalItems: normalized.length,
  };
}

function createRuntimeQueue(entityId, actions, worldTick) {
  const normalized = normalizeQueueActions(actions);
  return {
    queueId: uuidv4(),
    entityId,
    status: 'created',
    actions: normalized.actions,
    totalItems: normalized.totalItems,
    totalRequiredTicks: normalized.totalRequiredTicks,
    currentIndex: 0,
    remainingTicks: normalized.actions[0] ? normalized.actions[0].requiredTicks : 0,
    startedAtTick: null,
    completedAtTick: null,
    lastError: null,
    executedActions: [],
    createdAtTick: worldTick,
  };
}

module.exports = {
  MAX_QUEUE_ACTIONS,
  MAX_QUEUE_TOTAL_TICKS,
  ALLOWED_ACTIONS,
  normalizeQueueActions,
  createRuntimeQueue,
};
