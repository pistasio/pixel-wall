import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer, createAppServer } from '../server.mjs';

const ADMIN_KEY = 'test-organizer-secret-32-characters-long';

function artwork(overrides = {}) {
  const grid = Array.from({ length: 25 }, () => Array(25).fill('#FFFFFF'));
  grid[3][7] = '#6b59d3';
  return { grid, name: '  Pixel maker  ', studentId: '  CLUB-42  ', clientSubmissionId: randomUUID(), ...overrides };
}

async function createFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-wall-test-'));
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Pixel Wall</title>');
  await writeFile(join(publicDir, 'admin.html'), '<!doctype html><title>Submissions</title>');
  await writeFile(join(directory, 'private.txt'), 'do not serve this');
  const serverOptions = {
    databasePath: join(directory, 'data', 'pixel-wall.sqlite'), publicDir,
    adminKey: ADMIN_KEY, port: 0, host: '127.0.0.1', ...options,
  };
  let server = await startServer(serverOptions);
  let origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  t.after(async () => {
    if (server.listening) await close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get origin() { return origin; },
    get: (path, headers = {}) => fetch(origin + path, { headers }),
    post: (body, headers = {}) => fetch(origin + '/api/submissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }),
    list: (query = '') => fetch(origin + '/api/submissions' + query, { headers: { 'X-Admin-Key': ADMIN_KEY } }),
    async restart() {
      await close();
      server = await startServer(serverOptions);
      origin = `http://127.0.0.1:${server.address().port}`;
    },
  };
}

test('stores complete grids on disk, normalizes colors and metadata, and survives reopening', async (t) => {
  const fixture = await createFixture(t);
  const submission = artwork();
  const response = await fixture.post(submission);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(created.createdAt)));
  assert.deepEqual(Object.keys(created).sort(), ['createdAt', 'id']);
  await fixture.restart();
  const stored = await (await fixture.list()).json();
  assert.equal(stored.total, 1);
  assert.equal(stored.hasMore, false);
  assert.equal(stored.submissions[0].id, created.id);
  assert.equal(stored.submissions[0].createdAt, created.createdAt);
  assert.equal(stored.submissions[0].name, 'Pixel maker');
  assert.equal(stored.submissions[0].studentId, 'CLUB-42');
  assert.deepEqual(stored.submissions[0].grid, submission.grid.map((row) => row.map((color) => color.toUpperCase())));
  const databaseBytes = await readFile(join(fixture.directory, 'data', 'pixel-wall.sqlite'));
  assert.equal(databaseBytes.subarray(0, 15).toString(), 'SQLite format 3');
});

test('retries are idempotent, including after restart; conflicting payloads are rejected', async (t) => {
  const fixture = await createFixture(t);
  const submission = artwork();
  const first = await (await fixture.post(submission)).json();
  await fixture.restart();
  const retry = await fixture.post(submission);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), first);
  const conflicting = await fixture.post({ ...submission, name: 'Someone different' });
  assert.equal(conflicting.status, 409);
  assert.equal((await conflicting.json()).code, 'SUBMISSION_CONFLICT');
  assert.equal((await (await fixture.list()).json()).total, 1);
});

test('simultaneous requests with one reference store exactly one submission', async (t) => {
  const fixture = await createFixture(t);
  const submission = artwork();
  const responses = await Promise.all(Array.from({ length: 6 }, () => fixture.post(submission)));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 200).length, 5);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal((await (await fixture.list()).json()).total, 1);
});

test('keeps names, IDs, and grids private without the organizer key', async (t) => {
  const fixture = await createFixture(t);
  await fixture.post(artwork());
  for (const headers of [{}, { 'X-Admin-Key': 'incorrect-key' }]) {
    const response = await fixture.get('/api/submissions', headers);
    assert.equal(response.status, 401);
    const content = await response.text();
    assert.ok(!content.includes('CLUB-42'));
    assert.ok(!content.includes('Pixel maker'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fixture.list()).status, 200);
});

test('accepts anonymous art and paginates newest submissions first', async (t) => {
  const fixture = await createFixture(t);
  const created = [];
  for (let index = 0; index < 3; index += 1) {
    created.push(await (await fixture.post(artwork({ name: undefined, studentId: undefined }))).json());
  }
  const firstPage = await (await fixture.list('?limit=2&offset=0')).json();
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(firstPage.submissions.map(({ id }) => id), [created[2].id, created[1].id]);
  assert.equal(firstPage.submissions[0].name, '');
  assert.equal(firstPage.submissions[0].studentId, '');
  const secondPage = await (await fixture.list('?limit=2&offset=2')).json();
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(secondPage.submissions.map(({ id }) => id), [created[0].id]);
  for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?limit=1.5', '?offset=nope']) {
    assert.equal((await fixture.list(query)).status, 400);
  }
});

test('rejects blank, malformed, oversized, and invalid submissions without storing any', async (t) => {
  const fixture = await createFixture(t);
  const blankGrid = Array.from({ length: 25 }, () => Array(25).fill('#ffffff'));
  const badColor = artwork();
  badColor.grid[1][1] = 'red';
  const badRow = artwork();
  badRow.grid[1].pop();
  const cases = [
    null, [], {}, artwork({ grid: blankGrid }), artwork({ grid: [[ '#000000' ]] }),
    badColor, badRow, artwork({ name: 'x'.repeat(61) }), artwork({ studentId: 'x'.repeat(81) }),
    artwork({ name: { value: 'Hello' } }), artwork({ name: 'Hello\u0001there' }),
    artwork({ clientSubmissionId: 'not-a-uuid' }),
  ];
  for (const payload of cases) assert.equal((await fixture.post(payload)).status, 422);
  const blank = await fixture.post(artwork({ grid: blankGrid }));
  assert.equal((await blank.json()).code, 'EMPTY_ARTWORK');
  assert.equal((await fixture.post(artwork({ name: 'x'.repeat(20_000) }))).status, 413);
  const malformed = await fetch(fixture.origin + '/api/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await fixture.post(artwork(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fixture.post(artwork(), { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await (await fixture.list()).json()).total, 0);
});

test('blocks cross-origin browser requests and permits its own origin', async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await fixture.post(artwork(), { Origin: 'https://another.example' })).status, 403);
  assert.equal((await fixture.post(artwork(), { Origin: 'null' })).status, 403);
  assert.equal((await fixture.post(artwork(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fixture.post(artwork(), { Origin: fixture.origin })).status, 201);
  assert.equal((await fixture.get('/api/submissions', {
    'X-Admin-Key': ADMIN_KEY, Origin: 'https://another.example',
  })).status, 403);
});

test('supports a configured public HTTPS origin behind a reverse proxy', async (t) => {
  const fixture = await createFixture(t, { publicOrigin: 'https://pixels.example' });
  assert.equal((await fixture.post(artwork(), { Origin: 'https://pixels.example' })).status, 201);
  assert.equal((await fixture.post(artwork(), { Origin: fixture.origin })).status, 403);
});

test('allows only explicitly configured Pages origins and restrictive preflights', async (t) => {
  const pagesOrigin = 'https://pixel-club.github.io';
  const fixture = await createFixture(t, {
    publicOrigin: 'https://pixels.example', allowedOrigins: [pagesOrigin],
  });
  const preflight = (origin, method = 'POST', headers = 'content-type', path = '/api/submissions') => fetch(fixture.origin + path, {
    method: 'OPTIONS', headers: {
      Origin: origin, 'Sec-Fetch-Site': 'cross-site',
      'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers,
    },
  });
  for (const [method, headers] of [['POST', 'content-type'], ['GET', 'x-admin-key'], ['GET', 'Content-Type, X-Admin-Key']]) {
    const response = await preflight(pagesOrigin, method, headers);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), pagesOrigin);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type, X-Admin-Key');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.match(response.headers.get('vary'), /Origin/);
  }
  const submitted = await fixture.post(artwork(), { Origin: pagesOrigin, 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.headers.get('access-control-allow-origin'), pagesOrigin);
  const listed = await fixture.get('/api/submissions', { Origin: pagesOrigin, 'X-Admin-Key': ADMIN_KEY });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).total, 1);
  const unauthorized = await fixture.get('/api/submissions', { Origin: pagesOrigin });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), pagesOrigin);
  for (const origin of ['null', 'https://untrusted.example', 'https://pixel-club.github.io.attacker.example', `${pagesOrigin}/path`, `https://user:pass@pixel-club.github.io`]) {
    const rejected = await preflight(origin);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    assert.equal((await fixture.post(artwork(), { Origin: origin })).status, 403);
  }
  assert.equal((await preflight(pagesOrigin, 'DELETE')).status, 403);
  assert.equal((await preflight(pagesOrigin, 'POST', 'authorization')).status, 403);
  assert.equal((await preflight(pagesOrigin, 'GET', '', '/api/health')).status, 403);
  assert.equal((await fetch(fixture.origin + '/api/submissions', { method: 'OPTIONS' })).status, 403);
});

test('rejects malformed origin configuration before opening storage', () => {
  const options = { adminKey: ADMIN_KEY, databasePath: ':memory:' };
  for (const origin of ['*', 'null', 'https://pixels.example/', 'https://pixels.example/path', 'https://pixels.example?query', 'https://pixels.example#hash', 'https://user:pass@pixels.example']) {
    assert.throws(() => createAppServer({ ...options, publicOrigin: origin }), /PUBLIC_ORIGIN/);
    assert.throws(() => createAppServer({ ...options, allowedOrigins: [origin] }), /ALLOWED_ORIGINS/);
  }
  assert.throws(() => createAppServer({ ...options, production: true, publicOrigin: 'http://pixels.example' }), /HTTPS/);
  assert.throws(() => createAppServer({ ...options, allowedOrigins: ['http://pixel-club.github.io'] }), /HTTPS/);
  assert.throws(() => createAppServer({ ...options, allowedOrigins: '*' }), /ALLOWED_ORIGINS/);
  assert.throws(() => createAppServer({ ...options, allowedOrigins: Array(21).fill('https://pixels.example') }), /ALLOWED_ORIGINS/);
});

test('sends HSTS only for production with a public HTTPS origin', async (t) => {
  const production = await createFixture(t, { production: true, publicOrigin: 'https://pixels.example' });
  assert.equal((await production.get('/')).headers.get('strict-transport-security'), 'max-age=31536000');
  const local = await createFixture(t);
  assert.equal((await local.get('/')).headers.get('strict-transport-security'), null);
});

test('serves only public files with security headers and correct method handling', async (t) => {
  const fixture = await createFixture(t);
  const home = await fixture.get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /^text\/html/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await home.text(), /Pixel Wall/);
  assert.match(await (await fixture.get('/admin')).text(), /Submissions/);
  assert.equal((await fixture.get('/admin/')).status, 200);
  assert.equal((await fixture.get('/missing')).status, 404);
  assert.equal((await fixture.get('/%2e%2e/private.txt')).status, 404);
  assert.equal((await fixture.get('/%2e%2e%2fprivate.txt')).status, 404);
  assert.equal((await fixture.get('/%00')).status, 400);
  assert.equal((await fixture.get('/%5c..%5cprivate.txt')).status, 400);
  const head = await fetch(fixture.origin, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(fixture.origin, { method: 'POST' })).status, 405);
  const wrongMethod = await fetch(fixture.origin + '/api/submissions', { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, POST, OPTIONS');
  const health = await fixture.get('/api/health');
  assert.deepEqual(await health.json(), { ok: true });
});

test('limits write bursts without trusting a forged forwarding address', async (t) => {
  const fixture = await createFixture(t, { rateLimitMax: 2, rateLimitWindowMs: 60_000 });
  assert.equal((await fixture.post(artwork())).status, 201);
  assert.equal((await fixture.post(artwork())).status, 201);
  const limited = await fixture.post(artwork(), { 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await fixture.list()).status, 200);
});

test('canonical organizer redirects keep relative assets valid and discard query strings', async (t) => {
  const fixture = await createFixture(t);
  for (const path of ['/admin', '/admin/', '/admin/?accessKey=legacy-value']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(fixture.origin + path, { method, redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/admin.html');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), '');
    }
  }
  const document = await fixture.get('/admin/');
  assert.equal(document.url, fixture.origin + '/admin.html');
  assert.equal(new URL('./admin.js', document.url).pathname, '/admin.js');
  assert.equal(new URL('./admin.css', document.url).pathname, '/admin.css');
  assert.equal(new URL('./', document.url).pathname, '/');
  assert.equal((await fetch(fixture.origin + '/admin/', { method: 'POST', redirect: 'manual' })).status, 405);
});

test('requires a strong organizer key in production', () => {
  assert.throws(() => createAppServer({ production: true, adminKey: '' }), /Set ADMIN_KEY/);
  assert.throws(() => createAppServer({ production: true, adminKey: 'too-short' }), /32 to 1024/);
  assert.throws(() => createAppServer({ production: true, adminKey: 'pixel-wall-local-preview-key' }), /32 to 1024/);
  for (const key of ['replace-this-with-a-randomly-generated-key', 'pixel-wall-local-preview-key-with-extra-padding', 'x'.repeat(32)]) {
    assert.throws(() => createAppServer({ production: true, adminKey: key }), /placeholder/);
  }
});

test('limits failed organizer key attempts separately without trusting forwarding headers', async (t) => {
  const fixture = await createFixture(t, { adminRateLimitMax: 2 });
  for (let index = 0; index < 3; index += 1) assert.equal((await fixture.list()).status, 200);
  assert.equal((await fixture.get('/api/submissions')).status, 401);
  assert.equal((await fixture.get('/api/submissions', { 'X-Admin-Key': 'wrong' })).status, 401);
  const limited = await fixture.get('/api/submissions', { 'X-Admin-Key': ADMIN_KEY, 'X-Forwarded-For': '203.0.113.99' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await fixture.post(artwork())).status, 201);
});

test('allows organizer authentication again after the failure window expires', async (t) => {
  const fixture = await createFixture(t, { adminRateLimitMax: 1, adminRateLimitWindowMs: 30 });
  assert.equal((await fixture.get('/api/submissions')).status, 401);
  assert.equal((await fixture.list()).status, 429);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal((await fixture.list()).status, 200);
});
