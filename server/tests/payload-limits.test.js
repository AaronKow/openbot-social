const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('returns structured 413 when JSON payload exceeds configured limit', async () => {
  const originalJsonLimit = process.env.HTTP_JSON_LIMIT;
  const originalFormLimit = process.env.HTTP_FORM_LIMIT;

  process.env.HTTP_JSON_LIMIT = '1kb';
  process.env.HTTP_FORM_LIMIT = '1kb';

  const indexPath = require.resolve('../index');
  delete require.cache[indexPath];
  const { app } = require('../index');

  await withServer(app, async (baseUrl) => {
    const oversized = 'x'.repeat(2500);
    const response = await fetch(`${baseUrl}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'too-big', position: { x: 0, y: 0 }, rotation: 0, note: oversized })
    });

    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Payload too large');
    assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(body.limits.json, '1kb');
    assert.equal(body.limits.form, '1kb');
  });

  delete require.cache[indexPath];
  if (originalJsonLimit === undefined) {
    delete process.env.HTTP_JSON_LIMIT;
  } else {
    process.env.HTTP_JSON_LIMIT = originalJsonLimit;
  }
  if (originalFormLimit === undefined) {
    delete process.env.HTTP_FORM_LIMIT;
  } else {
    process.env.HTTP_FORM_LIMIT = originalFormLimit;
  }
});
