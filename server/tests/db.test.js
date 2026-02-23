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
