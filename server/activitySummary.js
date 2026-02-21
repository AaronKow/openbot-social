/**
 * Activity Summary Module
 * 
 * Uses OpenAI to generate daily and hourly summaries of lobster interactions.
 * Implements smart locking to prevent duplicate summarization from concurrent requests.
 */

const db = require('./db');

// OpenAI configuration — read from env at call time so hot-reloads / late-set work
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_REQUEST_TIMEOUT_MS = 30_000; // 30s per API call
const MAX_TRANSCRIPT_CHARS = 12_000; // Cap transcript size sent to AI
const MAX_RETRIES = 2; // Retry transient failures (429, 5xx)
const RETRY_DELAY_MS = 3_000;

function getOpenAIKey() { return process.env.OPENAI_API_KEY || ''; }
function getOpenAIModel() { return process.env.OPENAI_MODEL || 'gpt-5-mini'; }

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Call OpenAI chat completions API directly (no SDK dependency needed).
 * Includes timeout, retry on transient errors, and gpt-5-mini compatible params.
 */
async function callOpenAI(systemPrompt, userPrompt, maxTokens = 2000) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured — set it in your .env file');
  }

  const model = getOpenAIModel();
  console.log(`[ActivitySummary] Calling OpenAI model=${model}, maxTokens=${maxTokens}`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);

    try {
      // Newer models (gpt-5-mini, o-series) require max_completion_tokens;
      // older models (gpt-4o, gpt-3.5) require max_tokens. Try the new param
      // first and fall back to legacy on a 400.
      const body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_completion_tokens: maxTokens,
        temperature: 0.7
      };

      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeout);

      // Retry on transient errors (rate limit or server errors)
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10) * 1000;
        const delay = Math.max(retryAfter, RETRY_DELAY_MS * (attempt + 1));
        console.warn(`[ActivitySummary] OpenAI ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[ActivitySummary] OpenAI API error ${response.status}: ${errorBody}`);

        // If the model rejects max_completion_tokens, fall back to legacy max_tokens
        if (response.status === 400 && attempt === 0 && errorBody.includes('max_completion_tokens')) {
          console.warn(`[ActivitySummary] Retrying with legacy max_tokens param`);
          delete body.max_completion_tokens;
          body.max_tokens = maxTokens;
          const retryResp = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
          });
          if (retryResp.ok) {
            const data = await retryResp.json();
            return data.choices[0].message.content.trim();
          }
          const retryError = await retryResp.text();
          console.error(`[ActivitySummary] Legacy param retry also failed ${retryResp.status}: ${retryError}`);
        }

        // Vice-versa: model rejects max_tokens → retry with max_completion_tokens only
        if (response.status === 400 && attempt === 0 && errorBody.includes('max_tokens')) {
          console.warn(`[ActivitySummary] Retrying with max_completion_tokens only`);
          delete body.max_tokens;
          body.max_completion_tokens = maxTokens;
          const retryResp = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
          });
          if (retryResp.ok) {
            const data = await retryResp.json();
            return data.choices[0].message.content.trim();
          }
          const retryError = await retryResp.text();
          console.error(`[ActivitySummary] max_completion_tokens retry also failed ${retryResp.status}: ${retryError}`);
        }

        throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        console.error(`[ActivitySummary] OpenAI returned empty content:`, JSON.stringify(data).slice(0, 500));
        throw new Error('OpenAI returned empty response content');
      }
      return content.trim();
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        if (attempt < MAX_RETRIES) {
          console.warn(`[ActivitySummary] OpenAI request timed out, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
          continue;
        }
        throw new Error('OpenAI API request timed out after retries');
      }
      // Network errors — retry
      if (attempt < MAX_RETRIES && err.code !== 'ERR_ASSERTION') {
        console.warn(`[ActivitySummary] Network error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Group chat messages by hour (0-23).
 */
function groupMessagesByHour(messages) {
  const hourGroups = {};
  for (const msg of messages) {
    const date = new Date(msg.timestamp);
    const hour = date.getUTCHours();
    if (!hourGroups[hour]) hourGroups[hour] = [];
    hourGroups[hour].push(msg);
  }
  return hourGroups;
}

/**
 * Get unique agent names from messages.
 */
function getUniqueAgents(messages) {
  const agents = new Set();
  for (const msg of messages) {
    agents.add(msg.agentName);
  }
  return Array.from(agents);
}

/**
 * Format messages into a readable transcript for the AI.
 * Caps at MAX_TRANSCRIPT_CHARS to avoid exceeding token limits.
 */
function formatTranscript(messages) {
  let transcript = '';
  let truncated = false;
  for (const msg of messages) {
    const time = new Date(msg.timestamp).toISOString().slice(11, 19);
    const line = `[${time}] ${msg.agentName}: ${msg.message}\n`;
    if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) {
      truncated = true;
      break;
    }
    transcript += line;
  }
  if (truncated) {
    transcript += `\n... (${messages.length - transcript.split('\n').length + 1} more messages truncated)`;
  }
  return transcript;
}

const SYSTEM_PROMPT = `You are an activity log writer for "OpenBot Social World" — a 3D virtual ocean-floor environment where AI lobster agents interact. Your job is to summarize what happened during specific time periods.

Write summaries that are:
- Concise but informative
- Written in a fun, engaging style that matches the ocean/lobster theme
- Focused on key interactions, conversations, and notable events
- Mentioning the participating lobsters by name

Use ocean-themed language where appropriate (e.g., "splashed into the world", "scuttled around", "clawed their way through a heated discussion").`;

/**
 * Summarize a single hour's worth of messages.
 */
async function summarizeHour(messages, hour, dateStr) {
  if (messages.length === 0) return null;

  const agents = getUniqueAgents(messages);
  const transcript = formatTranscript(messages);

  const userPrompt = `Summarize what happened during hour ${hour}:00–${hour}:59 UTC on ${dateStr} in the OpenBot Social World.

Active lobsters: ${agents.join(', ')}
Total messages: ${messages.length}

Chat transcript:
${transcript}

Write a brief 1-3 sentence summary of this hour's activity.`;

  return await callOpenAI(SYSTEM_PROMPT, userPrompt, 300);
}

/**
 * Summarize an entire day's activity.
 */
async function summarizeDay(allMessages, hourlySummaries, dateStr) {
  const agents = getUniqueAgents(allMessages);

  // Build context from hourly summaries
  const hourlyContext = Object.entries(hourlySummaries)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([hour, summary]) => `${hour}:00 UTC — ${summary}`)
    .join('\n');

  const userPrompt = `Create a daily summary for ${dateStr} in the OpenBot Social World.

Active lobsters throughout the day: ${agents.join(', ')}
Total messages: ${allMessages.length}

Hourly activity breakdown:
${hourlyContext}

Write a comprehensive 3-6 sentence summary covering the day's highlights, notable conversations, agent interactions, and overall mood/activity level.`;

  return await callOpenAI(SYSTEM_PROMPT, userPrompt, 600);
}

/**
 * Process a single day: fetch messages, generate hourly + daily summaries, save to DB.
 * Returns true if AI successfully produced all summaries, false if fallbacks were used.
 */
async function processDay(dateObj) {
  const dateStr = dateObj.toISOString().slice(0, 10); // YYYY-MM-DD

  // Calculate UTC day boundaries
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z').getTime();
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z').getTime() + 1;

  console.log(`[ActivitySummary] Processing day: ${dateStr}`);

  // Fetch all messages for this day
  const messages = await db.getChatMessagesForDateRange(startOfDay, endOfDay);

  if (messages.length === 0) {
    console.log(`[ActivitySummary] No messages found for ${dateStr}, skipping`);
    return;
  }

  console.log(`[ActivitySummary] Found ${messages.length} messages for ${dateStr}`);

  // Group by hour and generate hourly summaries
  const hourGroups = groupMessagesByHour(messages);
  const hourlySummaries = {};
  let anyHourFailed = false;

  for (const [hour, hourMessages] of Object.entries(hourGroups)) {
    try {
      const summary = await summarizeHour(hourMessages, parseInt(hour), dateStr);
      if (summary) {
        hourlySummaries[hour] = summary;
      }
    } catch (err) {
      console.error(`[ActivitySummary] Error summarizing hour ${hour} of ${dateStr}:`, err.message);
      hourlySummaries[hour] = `(${hourMessages.length} messages — summary unavailable)`;
      anyHourFailed = true;
    }
  }

  // Generate daily summary from hourly summaries
  let dailySummary;
  let dailyFailed = false;
  try {
    dailySummary = await summarizeDay(messages, hourlySummaries, dateStr);
  } catch (err) {
    console.error(`[ActivitySummary] Error generating daily summary for ${dateStr}:`, err.message);
    dailySummary = `${messages.length} messages from ${getUniqueAgents(messages).length} lobsters. (AI summary unavailable)`;
    dailyFailed = true;
  }

  const activeAgents = getUniqueAgents(messages).length;
  const aiCompleted = !anyHourFailed && !dailyFailed;

  // Save to database (with ai_completed flag so failed days can be retried)
  await db.saveDailySummary(dateStr, dailySummary, hourlySummaries, messages.length, activeAgents, aiCompleted);
  console.log(`[ActivitySummary] Saved summary for ${dateStr} (ai_completed=${aiCompleted})`);
}

/**
 * Main orchestration: check for unsummarized days and process them one by one.
 * Called by the /activity-log/check endpoint.
 * 
 * Returns: { triggered: bool, message: string }
 */
async function checkAndSummarize() {
  if (!process.env.DATABASE_URL) {
    return { triggered: false, message: 'Database not configured' };
  }

  if (!getOpenAIKey()) {
    return { triggered: false, message: 'OpenAI API key not configured' };
  }

  // Try to acquire the lock — prevents concurrent summarization
  const lockAcquired = await db.acquireSummaryLock();
  if (!lockAcquired) {
    // Another request is already handling summarization (or did recently)
    return { triggered: false, message: 'Summarization already in progress or recently completed' };
  }

  try {
    // "Today" in UTC — we only summarize completed days (before today)
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Find days with chat data but no summary, before today
    const unsummarizedDays = await db.getUnsummarizedDays(todayStr);

    if (unsummarizedDays.length === 0) {
      await db.releaseSummaryLock();
      return { triggered: false, message: 'All days are already summarized' };
    }

    console.log(`[ActivitySummary] Found ${unsummarizedDays.length} unsummarized day(s)`);

    // Process day by day (not lumped) to avoid AI errors
    let successCount = 0;
    let errorCount = 0;

    for (const dayDate of unsummarizedDays) {
      try {
        await processDay(new Date(dayDate));
        successCount++;
      } catch (err) {
        console.error(`[ActivitySummary] Failed to process ${dayDate}:`, err.message);
        errorCount++;
        // Continue with next day — don't let one failure block the rest
      }
    }

    await db.releaseSummaryLock();
    return {
      triggered: true,
      message: `Summarized ${successCount} day(s)${errorCount > 0 ? `, ${errorCount} error(s)` : ''}`
    };
  } catch (err) {
    // Always release the lock on unexpected errors
    try {
      await db.releaseSummaryLock();
    } catch (releaseErr) {
      console.error('[ActivitySummary] Error releasing lock:', releaseErr.message);
    }
    console.error('[ActivitySummary] Unexpected error:', err);
    return { triggered: false, message: 'Internal error during summarization' };
  }
}

/**
 * Get activity summaries for the frontend.
 * Returns the most recent N days of summaries.
 */
async function getActivityLog(limit = 14) {
  if (!process.env.DATABASE_URL) {
    return { summaries: [], message: 'Database not configured' };
  }

  const summaries = await db.getActivitySummaries(limit);
  return { summaries };
}

module.exports = {
  checkAndSummarize,
  getActivityLog
};
