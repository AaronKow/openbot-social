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

test('saveAgentsBatch writes one upsert query with all persisted fields', async () => {
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
    await db.saveAgentsBatch([
      {
        id: 'agent-1',
        name: 'Agent One',
        position: { x: 1, y: 2, z: 3 },
        rotation: 0.5,
        state: 'walking',
        lastAction: 'moved to point A'
      },
      {
        id: 'agent-2',
        name: 'Agent Two',
        position: { x: 4, y: 5, z: 6 },
        rotation: 1.5,
        state: 'idle',
        lastAction: 'observing'
      }
    ]);

    assert.equal(calls[0].sql, 'BEGIN');
    assert.ok(calls[1].sql.includes('INSERT INTO agents'));
    assert.ok(calls[1].sql.includes('ON CONFLICT (id)'));
    assert.ok(calls[1].sql.includes('position_x'));
    assert.ok(calls[1].sql.includes('rotation = EXCLUDED.rotation'));
    assert.ok(calls[1].sql.includes('state = EXCLUDED.state'));
    assert.ok(calls[1].sql.includes('last_action = EXCLUDED.last_action'));
    assert.deepEqual(calls[1].params, [
      'agent-1', 'Agent One', 1, 2, 3, 0.5, 'walking', 'moved to point A',
      'agent-2', 'Agent Two', 4, 5, 6, 1.5, 'idle', 'observing'
    ]);
    assert.equal(calls[2].sql, 'COMMIT');
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('saveAgentsBatch updates existing rows with new values', async () => {
  const rowsById = new Map([
    ['agent-1', {
      id: 'agent-1',
      name: 'Old Name',
      position_x: 0,
      position_y: 0,
      position_z: 0,
      rotation: 0,
      state: 'idle',
      last_action: 'none'
    }]
  ]);

  const originalQuery = db.pool.query;
  const originalConnect = db.pool.connect;

  db.pool.connect = async () => ({
    async query(sql, params) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (!sql.includes('INSERT INTO agents')) {
        throw new Error('Unexpected SQL in test client');
      }

      for (let i = 0; i < params.length; i += 8) {
        rowsById.set(params[i], {
          id: params[i],
          name: params[i + 1],
          position_x: params[i + 2],
          position_y: params[i + 3],
          position_z: params[i + 4],
          rotation: params[i + 5],
          state: params[i + 6],
          last_action: params[i + 7]
        });
      }

      return { rows: [] };
    },
    release() {}
  });

  db.pool.query = async (sql, params) => {
    if (sql.startsWith('SELECT * FROM agents WHERE id =')) {
      const row = rowsById.get(params[0]);
      return { rows: row ? [row] : [] };
    }

    throw new Error('Unexpected SQL in test pool query');
  };

  try {
    await db.saveAgentsBatch([
      {
        id: 'agent-1',
        name: 'Updated Name',
        position: { x: 10, y: 11, z: 12 },
        rotation: 2.25,
        state: 'running',
        lastAction: 'dash'
      }
    ]);

    const loaded = await db.loadAgent('agent-1');
    assert.deepEqual(loaded, {
      id: 'agent-1',
      name: 'Updated Name',
      position: { x: 10, y: 11, z: 12 },
      rotation: 2.25,
      state: 'running',
      lastAction: 'dash'
    });
  } finally {
    db.pool.query = originalQuery;
    db.pool.connect = originalConnect;
  }
});

test('saveAgentsBatch rolls back transaction on query failure', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('INSERT INTO agents')) {
        throw new Error('forced failure');
      }
      return { rows: [] };
    },
    release() {}
  };

  const originalConnect = db.pool.connect;
  db.pool.connect = async () => fakeClient;

  try {
    await assert.rejects(
      () => db.saveAgentsBatch([
        {
          id: 'agent-err',
          name: 'Bad Agent',
          position: { x: 0, y: 0, z: 0 },
          rotation: 0,
          state: 'idle',
          lastAction: 'none'
        }
      ]),
      /forced failure/
    );

    assert.deepEqual(calls.slice(0, 3), ['BEGIN', calls[1], 'ROLLBACK']);
    assert.ok(calls[1].includes('INSERT INTO agents'));
  } finally {
    db.pool.connect = originalConnect;
  }
});
