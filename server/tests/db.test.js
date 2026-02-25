const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');

test('setEntityInterests validates payload constraints', async () => {
  await assert.rejects(() => db.setEntityInterests('e1', []), /non-empty array/);
  await assert.rejects(
    () => db.setEntityInterests('e1', new Array(6).fill({ interest: 'x', weight: 1 })),
    /Maximum 5 interests/
  );
  await assert.rejects(
    () => db.setEntityInterests('e1', [{ interest: '', weight: 1 }]),
    /non-empty string/
  );
  await assert.rejects(
    () => db.setEntityInterests('e1', [{ interest: 'valid', weight: 0 }]),
    /positive number/
  );
});

test('setEntityInterests normalizes to 100 and writes via transaction', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release() {}
  };

  const originalConnect = db.pool.connect;
  db.pool.connect = async () => fakeClient;

  try {
    const normalized = await db.setEntityInterests('entity-42', [
      { interest: 'history', weight: 20 },
      { interest: 'science', weight: 30 },
      { interest: 'music', weight: 50 }
    ]);

    const sum = normalized.reduce((acc, i) => acc + i.weight, 0);
    assert.equal(Math.round(sum * 100) / 100, 100);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls[1].sql.includes('DELETE FROM entity_interests'), true);
    assert.equal(calls.filter(c => c.sql.includes('INSERT INTO entity_interests')).length, 3);
    assert.equal(calls[calls.length - 1].sql, 'COMMIT');
  } finally {
    db.pool.connect = originalConnect;
  }
});


test('saveEntityGoalSnapshot persists bounded long/short goals', async () => {
  const calls = [];
  const originalQuery = db.pool.query;
  db.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  };

  try {
    await db.saveEntityGoalSnapshot('entity-77', {
      longTermGoals: [
        { label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }
      ],
      shortTermGoals: [
        { label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }, { label: '5' }
      ],
      source: 'entity-agent-v1',
      model: 'gpt-4o-mini'
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].sql.includes('INSERT INTO entity_goal_snapshots'));
    const longTermPayload = JSON.parse(calls[0].params[1]);
    const shortTermPayload = JSON.parse(calls[0].params[2]);
    assert.equal(longTermPayload.length, 4);
    assert.equal(shortTermPayload.length, 4);
  } finally {
    db.pool.query = originalQuery;
  }
});
