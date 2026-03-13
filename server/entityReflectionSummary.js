/**
 * Entity Reflection Summary Module
 *
 * Per-lobster daily summaries with zero centralized model spend.
 * Each lobster can still work normally even if summaries are missing.
 */

const db = require('./db');

function summarizeLocally(entityId, dateStr, messages, telemetry = null) {
  if (!messages.length) {
    return {
      dailySummary: `${entityId} had no recorded conversation activity on ${dateStr}.`,
      socialSummary: 'No social interactions detected.',
      goalProgress: { responsiveness: 0, exploration: 0 },
      memoryUpdates: {
        lessons: ['No interactions captured for this date'],
        runtimeTelemetry: telemetry || null
      }
    };
  }

  const uniquePartners = new Set();
  let firstTs = messages[0].timestamp;
  let lastTs = messages[0].timestamp;

  for (const msg of messages) {
    if (msg.agentName && msg.agentName !== entityId) uniquePartners.add(msg.agentName);
    if (msg.timestamp < firstTs) firstTs = msg.timestamp;
    if (msg.timestamp > lastTs) lastTs = msg.timestamp;
  }

  const firstTime = new Date(firstTs).toISOString().slice(11, 16);
  const lastTime = new Date(lastTs).toISOString().slice(11, 16);
  const partners = [...uniquePartners].slice(0, 5);
  const partnerText = partners.length ? partners.join(', ') : 'no clearly identified partners';

  return {
    dailySummary:
      `${entityId} posted ${messages.length} message(s) on ${dateStr} between ${firstTime}–${lastTime} UTC. ` +
      `Summary generation is local-only by design (no centralized OpenAI credit spend).`,
    socialSummary: `It interacted with ${uniquePartners.size} unique partner(s): ${partnerText}.`,
    goalProgress: {
      responsiveness: Math.min(100, messages.length * 5),
      socialBreadth: uniquePartners.size,
      idleTimeRatio: Number(telemetry?.idleTimeRatio || 0),
      socialActionRatio: Number(telemetry?.socialActionRatio || 0),
      objectiveActionRatio: Number(telemetry?.objectiveActionRatio || 0),
      uniqueSectorCoveragePerDay: Number(telemetry?.uniqueSectors || 0),
      expansionTilesPlacedPerDay: Number(telemetry?.expansionTilesPlaced || 0)
    },
    memoryUpdates: {
      likelyPartners: partners,
      nextFocus: uniquePartners.size === 0 ? 'initiate more chats' : 'continue partner follow-ups',
      queueCompletionQuality: telemetry ? {
        completed: Number(telemetry.queueCompleted || 0),
        failed: Number(telemetry.queueFailed || 0),
        expired: Number(telemetry.queueExpired || 0),
        cancelled: Number(telemetry.queueCancelled || 0),
        failureReasons: telemetry.queueFailureReasons || {}
      } : null
    }
  };
}

async function processEntityDay(entityId, dateStr) {
  const start = new Date(dateStr + 'T00:00:00.000Z').getTime();
  const end = new Date(dateStr + 'T23:59:59.999Z').getTime() + 1;

  const messages = await db.getConversationMessagesForEntityDateRange(entityId, start, end);
  if (messages.length === 0) return false;

  let telemetry = null;
  if (typeof db.getEntityRuntimeDailyStat === 'function') {
    const stat = await db.getEntityRuntimeDailyStat(entityId, 1);
    const totalActions = Number(stat.socialActions || 0) + Number(stat.objectiveActions || 0);
    telemetry = {
      ...stat,
      idleTimeRatio: stat.ticksTotal > 0 ? Number((stat.idleTicks / stat.ticksTotal).toFixed(4)) : 0,
      socialActionRatio: totalActions > 0 ? Number((stat.socialActions / totalActions).toFixed(4)) : 0,
      objectiveActionRatio: totalActions > 0 ? Number((stat.objectiveActions / totalActions).toFixed(4)) : 0
    };
  }

  const summary = summarizeLocally(entityId, dateStr, messages, telemetry);
  await db.saveEntityDailyReflection(
    entityId,
    dateStr,
    summary.dailySummary,
    messages.length,
    true,
    summary.socialSummary,
    summary.goalProgress,
    summary.memoryUpdates
  );
  return true;
}

async function checkAndSummarizeEntityReflections() {
  if (!process.env.DATABASE_URL) {
    return { triggered: false, message: 'Database not configured' };
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const targets = await db.getUnsummarizedEntityDays(todayStr);

  if (targets.length === 0) {
    return { triggered: false, message: 'All entity days are already summarized' };
  }

  let processed = 0;
  for (const t of targets) {
    const dateStr = t.date instanceof Date ? t.date.toISOString().slice(0, 10) : String(t.date).slice(0, 10);
    const ok = await processEntityDay(t.entityId, dateStr);
    if (ok) processed++;
  }

  return { triggered: processed > 0, message: `Summarized ${processed} entity-day(s) with local summarizer` };
}

async function getEntityReflections(entityId, limit = 30) {
  return db.getEntityDailyReflections(entityId, limit);
}

module.exports = {
  checkAndSummarizeEntityReflections,
  getEntityReflections,
  summarizeLocally
};
