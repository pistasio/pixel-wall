import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const origin = 'https://pixel-club.github.io';
const endpoint = 'https://pixel-wall-api.example.workers.dev/api/submissions';
const schema = readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8');

// Execute the Worker's SQL against SQLite, with D1's documented result shapes.
// This catches invalid queries, uniqueness errors, transaction behavior, and bindings.
class D1SQLite {
  constructor({ capacity, overflowCapacity } = {}) {
    this.sql = new DatabaseSync(':memory:');
    // Production capacity is a fixed SQL constant. Only the fixture substitutes a small ceiling.
    let fixtureSchema = capacity === undefined ? schema : schema.replace('>= 40000', `>= ${capacity}`);
    if (overflowCapacity !== undefined) fixtureSchema = fixtureSchema.replace('>= 10000', `>= ${overflowCapacity}`);
    this.sql.exec(fixtureSchema);
  }

  prepare(query) {
    const sql = this.sql;
    function prepared(values = []) {
      return {
        bind: (...bindings) => prepared(bindings),
        async first(column) {
          const row = sql.prepare(query).get(...values) ?? null;
          return column ? row?.[column] ?? null : row;
        },
        async run() { return this.execute(); },
        execute() {
          const before = sql.prepare('SELECT total_changes() AS n').get().n;
          const results = sql.prepare(query).all(...values);
          const changes = sql.prepare('SELECT total_changes() AS n').get().n - before;
          return { results, success: true, meta: { changes } };
        },
      };
    }
    return prepared();
  }

  async batch(statements) {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.execute());
      this.sql.exec('COMMIT');
      return results;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture(t, options) {
  const DB = new D1SQLite(options);
  t.after(() => DB.sql.close());
  const env = { DB, ADMIN_KEY: randomBytes(32).toString('hex'), ALLOWED_ORIGINS: origin };
  return { env, DB };
}

function artwork(overrides = {}) {
  const grid = Array.from({ length: 25 }, () => Array(25).fill('#FFFFFF'));
  grid[2][7] = '#9c7bea';
  return { grid, clientSubmissionId: randomUUID(), name: ' River ', studentId: ' club-42 ', ...overrides };
}

function request(method, body, options = {}) {
  const headers = { 'CF-Connecting-IP': '192.0.2.45', ...options.headers };
  if (options.origin !== null) headers.Origin = options.origin ?? origin;
  if (body !== undefined && !Object.hasOwn(headers, 'Content-Type')) headers['Content-Type'] = 'application/json';
  return new Request(options.url ?? endpoint, {
    method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

function enableMockEmail(env, send) {
  env.OVERFLOW_EMAIL = { send };
  env.OVERFLOW_TO = 'club-inbox@example.edu';
  env.OVERFLOW_FROM = 'pixel-wall@example.edu';
}

test('Worker stores grid data and private metadata, and authenticated pagination renders the complete data', async (t) => {
  const { env } = fixture(t);
  const saved = await worker.fetch(request('POST', artwork()), env);
  assert.equal(saved.status, 201);
  const receipt = await saved.json();
  assert.match(receipt.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(receipt.createdAt)));
  assert.deepEqual(Object.keys(receipt).sort(), ['createdAt', 'id']);
  await worker.fetch(request('POST', artwork({ name: 'Morgan' })), env);
  const page = await worker.fetch(request('GET', undefined, {
    url: `${endpoint}?limit=1&offset=0`, headers: { 'X-Admin-Key': env.ADMIN_KEY },
  }), env);
  assert.equal(page.status, 200);
  const listing = await page.json();
  assert.equal(listing.total, 2);
  assert.equal(listing.hasMore, true);
  assert.equal(listing.submissions.length, 1);
  assert.equal(listing.submissions[0].grid.length, 25);
  assert.equal(listing.submissions[0].grid[2][7], '#9C7BEA');
  assert.equal(listing.submissions[0].studentId, 'club-42');
  assert.equal('fingerprint' in listing.submissions[0], false);
  assert.equal('clientSubmissionId' in listing.submissions[0], false);
  const last = await worker.fetch(request('GET', undefined, {
    url: `${endpoint}?limit=1&offset=1`, headers: { 'X-Admin-Key': env.ADMIN_KEY },
  }), env);
  assert.equal((await last.json()).hasMore, false);
});

test('Worker deduplicates normalized retries and concurrent inserts, rejecting changed payloads', async (t) => {
  const { env, DB } = fixture(t);
  const input = artwork();
  const responses = await Promise.all(Array.from({ length: 8 }, () => worker.fetch(request('POST', input), env)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
  const receipts = await Promise.all(responses.map((response) => response.json()));
  assert.ok(receipts.every((receipt) => receipt.id === receipts[0].id));
  const equivalent = { ...input, name: 'River', studentId: 'club-42', clientSubmissionId: input.clientSubmissionId.toUpperCase(),
    grid: input.grid.map((row) => row.map((color) => color.toLowerCase())) };
  assert.equal((await worker.fetch(request('POST', equivalent), env)).status, 200);
  const conflict = await worker.fetch(request('POST', { ...input, name: 'A different person' }), env);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'SUBMISSION_CONFLICT');
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM submissions').get().n, 1);
  assert.equal(DB.sql.prepare('SELECT name FROM submissions').get().name, 'River');
});

test('Worker rejects empty, malformed, oversized, and invalid submissions', async (t) => {
  const { env } = fixture(t);
  const cases = [
    [artwork({ grid: Array.from({ length: 25 }, () => Array(25).fill('#FFFFFF')) }), 422, 'EMPTY_ARTWORK'],
    [artwork({ grid: [] }), 422, 'INVALID_SUBMISSION'],
    [artwork({ clientSubmissionId: 'bad-reference' }), 422, 'INVALID_REFERENCE'],
    [artwork({ name: 'x'.repeat(61) }), 422, 'INVALID_SUBMISSION'],
    [artwork({ studentId: 'bad\u0000id' }), 422, 'INVALID_SUBMISSION'],
    ['{bad json', 400, 'INVALID_JSON'],
    ['x'.repeat(16_385), 413, 'BODY_TOO_LARGE'],
  ];
  for (const [body, status, code] of cases) {
    const result = await worker.fetch(request('POST', body), env);
    assert.equal(result.status, status);
    assert.equal((await result.json()).code, code);
  }
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }]) {
    assert.equal((await worker.fetch(request('POST', artwork(), { headers }), env)).status, 415);
  }
});

test('Worker caps the actual streamed body even when Content-Length lies', async (t) => {
  const { env, DB } = fixture(t);
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(9_000).fill(65)); },
    cancel() { cancelled = true; },
  });
  const response = await worker.fetch(new Request(endpoint, {
    method: 'POST', body, duplex: 'half',
    headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.45', 'Content-Type': 'application/json', 'Content-Length': '1' },
  }), env);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM submissions').get().n, 0);
});

test('Worker CORS allows only configured origins and narrow preflight methods and headers', async (t) => {
  const { env } = fixture(t);
  for (const foreignOrigin of [null, 'null', 'https://pixel-club.github.io.attacker.example', 'http://pixel-club.github.io']) {
    const denied = await worker.fetch(request('POST', artwork(), { origin: foreignOrigin }), env);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.has('Access-Control-Allow-Origin'), false);
  }
  const accepted = await worker.fetch(request('OPTIONS', undefined, {
    headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  }), env);
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(accepted.headers.get('Access-Control-Allow-Methods'), 'POST');
  assert.equal(accepted.headers.has('Access-Control-Allow-Credentials'), false);
  for (const headers of [
    { 'Access-Control-Request-Method': 'DELETE' },
    { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-admin-key' },
    { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  ]) assert.equal((await worker.fetch(request('OPTIONS', undefined, { headers }), env)).status, 403);
  const adminPreflight = await worker.fetch(request('OPTIONS', undefined, {
    headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-admin-key' },
  }), env);
  assert.equal(adminPreflight.status, 204);
});

test('Worker protects organizer data, permits authenticated CLI reads, and validates pagination', async (t) => {
  const { env } = fixture(t);
  for (const key of ['', randomBytes(32).toString('hex'), `${env.ADMIN_KEY}extra`]) {
    assert.equal((await worker.fetch(request('GET', undefined, { headers: { 'X-Admin-Key': key } }), env)).status, 401);
  }
  const cli = await worker.fetch(request('GET', undefined, { origin: null, headers: { 'X-Admin-Key': env.ADMIN_KEY } }), env);
  assert.equal(cli.status, 200);
  assert.equal(cli.headers.has('Access-Control-Allow-Origin'), false);
  assert.deepEqual(await cli.json(), { submissions: [], total: 0, hasMore: false });
  assert.equal((await worker.fetch(request('GET', undefined, {
    origin: 'https://untrusted.example', headers: { 'X-Admin-Key': env.ADMIN_KEY },
  }), env)).status, 403);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=99999999999999999999', 'limit=1%20OR%201=1']) {
    assert.equal((await worker.fetch(request('GET', undefined, {
      url: `${endpoint}?${query}`, headers: { 'X-Admin-Key': env.ADMIN_KEY },
    }), env)).status, 400);
  }
});

test('Worker counters are atomic, shared across instances, separated by purpose, and contain no raw IP', async (t) => {
  const { env, DB } = fixture(t);
  assert.equal((await worker.fetch(request('POST', artwork()), env)).status, 201);
  DB.sql.prepare('UPDATE rate_limits SET count = 598').run();
  const attempts = await Promise.all(Array.from({ length: 4 }, () => worker.fetch(request('POST', 'ignored', {
    headers: { 'Content-Type': 'text/plain' },
  }), { ...env })));
  assert.deepEqual(attempts.map((response) => response.status).sort(), [415, 415, 429, 429]);
  for (const response of attempts.filter((item) => item.status === 429)) {
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
    assert.ok(Number(response.headers.get('Retry-After')) <= 60);
  }
  assert.equal((await worker.fetch(request('GET', undefined, { headers: { 'X-Admin-Key': env.ADMIN_KEY } }), env)).status, 200);
  assert.equal((await worker.fetch(request('POST', artwork(), { headers: { 'CF-Connecting-IP': '192.0.2.46' } }), env)).status, 201);
  const rows = DB.sql.prepare('SELECT * FROM rate_limits').all();
  assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.key)));
  assert.equal(JSON.stringify(rows).includes('192.0.2.'), false);
  DB.sql.prepare('UPDATE rate_limits SET window_start = window_start - 60').run();
  assert.equal((await worker.fetch(request('POST', artwork()), env)).status, 201);
});

test('Worker stops writing blocked rate counters and delayed requests cannot rewind the current minute', async (t) => {
  const { env, DB } = fixture(t);
  const invalidMedia = () => request('POST', 'ignored', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal((await worker.fetch(invalidMedia(), env)).status, 415);
  const futureWindow = Math.floor(Date.now() / 60_000) * 60 + 120;
  DB.sql.prepare('UPDATE rate_limits SET count = 599, window_start = ?').run(futureWindow);
  assert.equal((await worker.fetch(invalidMedia(), env)).status, 415);
  let row = DB.sql.prepare('SELECT window_start, count FROM rate_limits').get();
  assert.equal(row.window_start, futureWindow);
  assert.equal(row.count, 600);
  assert.equal((await worker.fetch(invalidMedia(), env)).status, 429);
  row = DB.sql.prepare('SELECT window_start, count FROM rate_limits').get();
  assert.equal(row.window_start, futureWindow);
  assert.equal(row.count, 601);
  const before = DB.sql.prepare('SELECT total_changes() AS n').get().n;
  const blocked = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(invalidMedia(), { ...env })));
  assert.ok(blocked.every((response) => response.status === 429));
  assert.equal(DB.sql.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(DB.sql.prepare('SELECT window_start FROM rate_limits').get().window_start, futureWindow);
  DB.sql.prepare('UPDATE rate_limits SET window_start = ?').run(futureWindow - 180);
  assert.equal((await worker.fetch(invalidMedia(), env)).status, 415);
  assert.equal(DB.sql.prepare('SELECT count FROM rate_limits').get().count, 1);
});

test('Worker capacity is atomic and rejects extra artwork with a clear error while preserving existing retries', async (t) => {
  const { env, DB } = fixture(t, { capacity: 2 });
  const original = artwork();
  const first = await worker.fetch(request('POST', original), env);
  assert.equal(first.status, 201);
  const receipt = await first.json();
  const arrivals = await Promise.all(Array.from({ length: 6 }, () => worker.fetch(request('POST', artwork()), { ...env })));
  assert.deepEqual(arrivals.map((response) => response.status).sort(), [201, 507, 507, 507, 507, 507]);
  for (const response of arrivals.filter((item) => item.status === 507)) {
    const error = await response.json();
    assert.equal(error.code, 'WALL_FULL');
    assert.match(error.error, /wall is full/i);
    assert.match(error.error, /still on this device/i);
    assert.equal(error.error.includes('PIXEL_WALL_FULL'), false);
  }
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM submissions').get().n, 2);
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 2);
  const retry = await worker.fetch(request('POST', original), env);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), receipt);
  const conflict = await worker.fetch(request('POST', { ...original, name: 'Different' }), env);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'SUBMISSION_CONFLICT');
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 2);
  const organizer = await worker.fetch(request('GET', undefined, { headers: { 'X-Admin-Key': env.ADMIN_KEY } }), env);
  assert.equal((await organizer.json()).total, 2);
  // An organizer can export then delete old records; deleting frees capacity in the same transaction.
  DB.sql.prepare('DELETE FROM submissions WHERE id = ?').run(receipt.id);
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 1);
  assert.equal((await worker.fetch(request('POST', artwork()), env)).status, 201);
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 2);
});

test('Worker capacity count is initialized for existing artwork and maintained without rescanning on writes', async (t) => {
  const { env, DB } = fixture(t);
  await worker.fetch(request('POST', artwork()), env);
  await worker.fetch(request('POST', artwork()), env);
  // Reinstalling an idempotent schema must not reset the running count.
  DB.sql.exec(schema);
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 2);
  DB.sql.exec(`DROP TRIGGER submissions_capacity; DROP TRIGGER submissions_count_insert;
    DROP TRIGGER submissions_count_delete; DROP TABLE wall_state;`);
  DB.sql.exec(schema);
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 2);
  assert.equal((await worker.fetch(request('POST', artwork()), env)).status, 201);
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 3);
});

test('Optional email sends only after wall capacity is reached, with actual grid JSON and no student ID', async (t) => {
  const { env, DB } = fixture(t, { capacity: 1 });
  const messages = [];
  enableMockEmail(env, async (message) => {
    assert.equal(DB.sql.prepare('SELECT status FROM overflow_deliveries').get().status, 'pending');
    messages.push(message);
    return { messageId: 'accepted-email-reference' };
  });
  assert.equal((await worker.fetch(request('POST', artwork()), env)).status, 201);
  assert.equal(messages.length, 0);
  const input = artwork({ name: ' River 🎨 ', studentId: 'NEVER-EMAIL-THIS-PRIVATE-ID', to: 'untrusted@example.net' });
  const response = await worker.fetch(request('POST', input), env);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.delivery, 'email');
  assert.ok(Number.isFinite(Date.parse(receipt.createdAt)));
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.to, env.OVERFLOW_TO);
  assert.equal(message.from, env.OVERFLOW_FROM);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].type, 'application/json');
  const attachmentText = Buffer.from(message.attachments[0].content, 'base64').toString('utf8');
  const attachment = JSON.parse(attachmentText);
  assert.deepEqual(Object.keys(attachment).sort(), ['clientSubmissionId', 'createdAt', 'grid', 'name']);
  assert.equal(attachment.grid.length, 25);
  assert.equal(attachment.grid[2][7], '#9C7BEA');
  assert.equal(attachment.name, 'River 🎨');
  assert.equal(attachment.createdAt, receipt.createdAt);
  assert.equal(attachment.clientSubmissionId, input.clientSubmissionId);
  assert.equal(JSON.stringify(message).includes(input.studentId), false);
  assert.equal(attachmentText.includes(input.studentId), false);
  const stored = DB.sql.prepare('SELECT * FROM overflow_deliveries').get();
  assert.equal(stored.status, 'sent');
  assert.equal(JSON.stringify(stored).includes(input.studentId), false);
  assert.equal(JSON.stringify(stored).includes(attachment.name), false);
  assert.equal(DB.sql.prepare('SELECT submission_count FROM wall_state').get().submission_count, 1);
  assert.equal(DB.sql.prepare('SELECT delivery_count FROM overflow_state').get().delivery_count, 1);
  const retry = await worker.fetch(request('POST', input), env);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), receipt);
  assert.equal(messages.length, 1);
  assert.equal((await worker.fetch(request('POST', { ...input, name: 'Changed' }), env)).status, 409);
  // The original email receipt remains authoritative if ordinary storage becomes available.
  DB.sql.exec('DELETE FROM submissions');
  delete env.OVERFLOW_EMAIL;
  const later = await worker.fetch(request('POST', input), env);
  assert.equal(later.status, 200);
  assert.deepEqual(await later.json(), receipt);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM submissions').get().n, 0);
});

test('Optional email durably claims one send across concurrent retries and never claims success while pending', { timeout: 2_000 }, async (t) => {
  const { env, DB } = fixture(t, { capacity: 0 });
  let sent = 0;
  let notifyStarted;
  let accept;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const accepted = new Promise((resolve) => { accept = resolve; });
  enableMockEmail(env, async () => { sent += 1; notifyStarted(); return accepted; });
  const input = artwork();
  const first = worker.fetch(request('POST', input), env);
  await started;
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => worker.fetch(request('POST', input), { ...env })));
  assert.ok(concurrent.every((response) => response.status === 503));
  assert.ok((await Promise.all(concurrent.map((response) => response.json()))).every((result) => result.code === 'EMAIL_UNCERTAIN'));
  assert.equal(sent, 1);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM overflow_deliveries').get().n, 1);
  accept({ messageId: 'accepted-once' });
  assert.equal((await first).status, 201);
  assert.equal((await worker.fetch(request('POST', input), env)).status, 200);
  assert.equal(sent, 1);
});

test('Optional email reports definite rejection and uncertain failure without falsely succeeding or resending', async (t) => {
  for (const failure of [Object.assign(new Error('Private provider detail'), { code: 'E_RECIPIENT_NOT_ALLOWED' }), new Error('Ambiguous service failure')]) {
    const { env, DB } = fixture(t, { capacity: 0 });
    let sends = 0;
    enableMockEmail(env, async () => { sends += 1; throw failure; });
    const input = artwork();
    for (let retry = 0; retry < 2; retry += 1) {
      const response = await worker.fetch(request('POST', input), env);
      assert.equal(response.status, 503);
      const error = await response.json();
      assert.equal(error.code, failure.code ? 'EMAIL_FAILED' : 'EMAIL_UNCERTAIN');
      assert.match(error.error, /save a copy/i);
      assert.equal(error.error.includes(failure.message), false);
    }
    assert.equal(sends, 1);
    assert.equal(DB.sql.prepare('SELECT status FROM overflow_deliveries').get().status, failure.code ? 'failed' : 'pending');
  }
});

test('Optional email treats accepted-but-unrecorded sends as uncertain and does not repeat them', async (t) => {
  const { env, DB } = fixture(t, { capacity: 0 });
  const originalPrepare = DB.prepare.bind(DB);
  DB.prepare = (query) => {
    if (query.includes("SET status = 'sent'")) throw new Error('D1 unavailable after provider accepted');
    return originalPrepare(query);
  };
  let sends = 0;
  enableMockEmail(env, async () => { sends += 1; return { messageId: 'accepted-with-unknown-local-status' }; });
  const input = artwork();
  for (let retry = 0; retry < 2; retry += 1) {
    const response = await worker.fetch(request('POST', input), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'EMAIL_UNCERTAIN');
  }
  assert.equal(sends, 1);
  assert.equal(DB.sql.prepare('SELECT status FROM overflow_deliveries').get().status, 'pending');
});

test('Optional email remains disabled without complete configuration and never bypasses D1 outage', async (t) => {
  const { env, DB } = fixture(t, { capacity: 0 });
  let sends = 0;
  const send = async () => { sends += 1; return { messageId: 'should-not-be-called' }; };
  const configurations = [
    { ...env },
    { ...env, OVERFLOW_EMAIL: { send } },
    { ...env, OVERFLOW_EMAIL: { send }, OVERFLOW_TO: 'club@example.edu', OVERFLOW_FROM: 'bad\r\nBcc:other@example.edu' },
    { ...env, OVERFLOW_EMAIL: { send }, OVERFLOW_TO: 'one@example.edu,two@example.edu', OVERFLOW_FROM: 'wall@example.edu' },
  ];
  for (const configuration of configurations) assert.equal((await worker.fetch(request('POST', artwork()), configuration)).status, 507);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM overflow_deliveries').get().n, 0);
  enableMockEmail(env, send);
  const batch = DB.batch.bind(DB);
  DB.batch = async (statements) => { throw new Error('Daily D1 quota exceeded'); };
  const unavailable = await worker.fetch(request('POST', artwork()), env);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, 'SERVICE_UNAVAILABLE');
  DB.batch = batch;
  assert.equal(sends, 0);
});

test('Optional email claim storage is bounded without breaking earlier receipts', async (t) => {
  const { env, DB } = fixture(t, { capacity: 0, overflowCapacity: 1 });
  let sends = 0;
  enableMockEmail(env, async () => { sends += 1; return { messageId: 'bounded-email' }; });
  const input = artwork();
  assert.equal((await worker.fetch(request('POST', input), env)).status, 201);
  const excess = await Promise.all(Array.from({ length: 4 }, () => worker.fetch(request('POST', artwork()), env)));
  assert.ok(excess.every((response) => response.status === 507));
  assert.equal(sends, 1);
  assert.equal(DB.sql.prepare('SELECT delivery_count FROM overflow_state').get().delivery_count, 1);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM overflow_deliveries').get().n, 1);
  assert.equal((await worker.fetch(request('POST', input), env)).status, 200);
  assert.equal(sends, 1);
});

test('Worker limits failed organizer key attempts without counting successful organizer reads', async (t) => {
  const { env, DB } = fixture(t);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await worker.fetch(request('GET', undefined, { headers: { 'X-Admin-Key': env.ADMIN_KEY } }), env)).status, 200);
  }
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM rate_limits').get().n, 0);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await worker.fetch(request('GET'), env)).status, 401);
  }
  assert.equal((await worker.fetch(request('GET'), env)).status, 429);
  assert.equal((await worker.fetch(request('GET', undefined, { headers: { 'X-Admin-Key': env.ADMIN_KEY } }), env)).status, 429);
  assert.equal((await worker.fetch(request('POST', artwork()), env)).status, 201);
});

test('Worker fails closed on missing or unsafe configuration, absent client addresses, and database failures', async (t) => {
  const { env } = fixture(t);
  const configurations = [
    { ...env, DB: undefined }, { ...env, ADMIN_KEY: '' }, { ...env, ADMIN_KEY: 'a'.repeat(40) },
    { ...env, ADMIN_KEY: 'pixel-wall-local-preview-key-1234567890' }, { ...env, ALLOWED_ORIGINS: '*' },
    { ...env, ALLOWED_ORIGINS: `${origin}/pixel-wall` }, { ...env, ALLOWED_ORIGINS: 'http://example.com' },
    { ...env, ALLOWED_ORIGINS: '' }, { ...env, ALLOWED_ORIGINS: 'https://*.github.io' },
    { ...env, ALLOWED_ORIGINS: 'https://user:secret@example.com' },
  ];
  for (const config of configurations) {
    const result = await worker.fetch(request('POST', artwork()), config);
    assert.equal(result.status, 503);
    assert.equal((await result.json()).code, 'SERVICE_UNAVAILABLE');
  }
  const missingIp = request('POST', artwork());
  missingIp.headers.delete('CF-Connecting-IP');
  assert.equal((await worker.fetch(missingIp, env)).status, 503);
  const failedDB = { prepare() { throw new Error(`secret SQL failure ${env.ADMIN_KEY}`); }, batch() {} };
  const failed = await worker.fetch(request('POST', artwork()), { ...env, DB: failedDB });
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes(env.ADMIN_KEY), false);
});

test('Worker returns minimal health and security headers and removes only expired rate counters', async (t) => {
  const { env, DB } = fixture(t);
  const health = await worker.fetch(request('GET', undefined, { origin: null, url: endpoint.replace('/submissions', '/health') }), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('Cache-Control'), 'no-store');
  assert.equal(health.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(health.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal((await worker.fetch(request('POST', artwork(), { url: endpoint.replace('https:', 'http:') }), env)).status, 400);
  assert.equal((await worker.fetch(request('DELETE'), env)).status, 405);
  assert.equal((await worker.fetch(request('GET', undefined, { url: `${endpoint}/unknown` }), env)).status, 404);
  await worker.fetch(request('POST', artwork()), env);
  DB.sql.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)').run('0'.repeat(64), 0);
  await worker.scheduled({}, env);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM rate_limits').get().n, 1);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM submissions').get().n, 1);
});
