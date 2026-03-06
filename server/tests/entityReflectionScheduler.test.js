const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const entityReflectionSummary = require('../entityReflectionSummary');
const { __testHooks } = require('../index');

function withDatabaseUrl(value, run) {
  const previous = process.env.DATABASE_URL;
  if (value === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = value;
  }

  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previous;
      }
    });
}

test('runEntityReflectionCheckCycle skips when database is disabled', async () => {
  await withDatabaseUrl(undefined, async () => {
    const result = await __testHooks.runEntityReflectionCheckCycle();
    assert.deepEqual(result, { skipped: true, reason: 'database_disabled' });
    assert.equal(__testHooks.getEntityReflectionSchedulerState().isEntityReflectionCheckRunning, false);
  });
});

test('runEntityReflectionCheckCycle executes summarizer and returns success payload', async () => {
  await withDatabaseUrl('postgres://localhost/testdb', async () => {
    const original = entityReflectionSummary.checkAndSummarizeEntityReflections;
    entityReflectionSummary.checkAndSummarizeEntityReflections = async () => ({ triggered: true, message: 'ok' });

    try {
      const result = await __testHooks.runEntityReflectionCheckCycle();
      assert.equal(result.skipped, false);
      assert.equal(result.result.triggered, true);
      assert.equal(result.result.message, 'ok');
      assert.equal(typeof result.durationMs, 'number');
      assert.equal(__testHooks.getEntityReflectionSchedulerState().isEntityReflectionCheckRunning, false);
    } finally {
      entityReflectionSummary.checkAndSummarizeEntityReflections = original;
    }
  });
});

test('runEntityReflectionCheckCycle prevents overlapping runs', async () => {
  await withDatabaseUrl('postgres://localhost/testdb', async () => {
    const original = entityReflectionSummary.checkAndSummarizeEntityReflections;
    let resolveRun;
    const firstRun = new Promise((resolve) => {
      resolveRun = resolve;
    });

    entityReflectionSummary.checkAndSummarizeEntityReflections = () => firstRun;

    try {
      const pending = __testHooks.runEntityReflectionCheckCycle();
      assert.equal(__testHooks.getEntityReflectionSchedulerState().isEntityReflectionCheckRunning, true);

      const overlapResult = await __testHooks.runEntityReflectionCheckCycle();
      assert.deepEqual(overlapResult, { skipped: true, reason: 'in_flight' });

      resolveRun({ triggered: false, message: 'done' });
      await pending;
      assert.equal(__testHooks.getEntityReflectionSchedulerState().isEntityReflectionCheckRunning, false);
    } finally {
      entityReflectionSummary.checkAndSummarizeEntityReflections = original;
    }
  });
});

test('scheduleEntityReflectionChecks only starts when database is enabled', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  const calls = [];
  global.setInterval = (fn, intervalMs) => {
    calls.push({ fn, intervalMs });
    return { unref() {} };
  };
  global.clearInterval = () => {};

  try {
    await withDatabaseUrl(undefined, async () => {
      const timer = __testHooks.scheduleEntityReflectionChecks();
      assert.equal(timer, null);
    });

    await withDatabaseUrl('postgres://localhost/testdb', async () => {
      const timer = __testHooks.scheduleEntityReflectionChecks();
      assert.ok(timer);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].intervalMs, __testHooks.ENTITY_REFLECTION_CHECK_INTERVAL_MS);
    assert.equal(typeof calls[0].fn, 'function');
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});
