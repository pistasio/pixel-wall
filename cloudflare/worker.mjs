import { ValidationError, validatePagination, validateSubmission } from '../lib/validation.mjs';

const MAX_BODY_BYTES = 16_384;
const WINDOW_SECONDS = 60;
const SUBMISSIONS_PER_MINUTE = 600;
const FAILED_KEYS_PER_MINUTE = 20;
const encoder = new TextEncoder();
const configurations = new WeakMap();

const securityHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  Vary: 'Origin',
};

function reply(status, payload, origin, extraHeaders = {}) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: {
      ...securityHeaders,
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...extraHeaders,
    },
  });
}

function reject(message, code, status) {
  return new ValidationError(message, code, status);
}

async function hmacKey(value) {
  return crypto.subtle.importKey('raw', encoder.encode(value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function configuration(env) {
  // Secrets live only in the Worker environment. Configuration mistakes fail closed.
  if (!env || !env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function') throw new Error('Missing database binding');
  if (configurations.has(env)) return configurations.get(env);
  const key = env.ADMIN_KEY;
  if (typeof key !== 'string' || key.length < 32 || key.length > 1024 ||
      /(?:example|replace|change[-_ ]?me|local[-_ ]preview|password|your[-_ ](?:secret|admin|key))/i.test(key) || /^(.)\1+$/.test(key)) {
    throw new Error('Invalid organizer secret');
  }
  if (typeof env.ALLOWED_ORIGINS !== 'string') throw new Error('Missing origins');
  const origins = env.ALLOWED_ORIGINS.split(',').map((value) => value.trim());
  if (!origins.length || origins.length > 20 || origins.some((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password || value.includes('*');
    } catch { return true; }
  })) throw new Error('Invalid allowed origins');
  const secretKey = await hmacKey(key);
  const checkMessage = encoder.encode('pixel-wall-organizer-access-v1');
  const signature = await crypto.subtle.sign('HMAC', secretKey, checkMessage);
  const result = { origins: new Set(origins), secretKey, checkMessage, signature };
  configurations.set(env, result);
  return result;
}

async function keyMatches(candidate, config) {
  if (typeof candidate !== 'string' || !candidate.length || candidate.length > 1024) return false;
  // WebCrypto verifies the fixed-size MAC in native code; no secret string comparison.
  const candidateKey = await hmacKey(candidate);
  return crypto.subtle.verify('HMAC', candidateKey, config.signature, config.checkMessage);
}

async function rateKey(request, config, kind) {
  // Cloudflare supplies this trusted header. Do not trust user-supplied forwarding headers.
  const address = request.headers.get('CF-Connecting-IP');
  if (!address || address.length > 64) throw new Error('Missing client address');
  return hex(await crypto.subtle.sign('HMAC', config.secretKey, encoder.encode(`pixel-wall-rate-v1:${kind}:${address}`)));
}

function currentWindow() {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
}

function limited(kind) {
  return reject(kind === 'admin' ? 'Too many organizer key attempts. Wait a minute and try again.' :
    'The wall is busy. Please wait a moment and try again.', 'RATE_LIMITED', 429);
}

async function consumeRate(db, key, maximum, kind) {
  const windowStart = currentWindow();
  // Atomic across Worker instances and locations; one bounded row per hashed IP and kind.
  const row = await db.prepare(`
    INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < excluded.window_start THEN 1 ELSE rate_limits.count + 1 END,
      window_start = MAX(rate_limits.window_start, excluded.window_start)
    WHERE rate_limits.window_start < excluded.window_start OR rate_limits.count <= ?
    RETURNING count
  `).bind(key, windowStart, maximum).first();
  // Once blocked, further requests read the existing row without rewriting it.
  // A delayed request from an older minute cannot reset or rewind the current bucket.
  if (!row) throw limited(kind);
  if (!Number.isInteger(row.count)) throw new Error('Rate limit unavailable');
  if (row.count > maximum) throw limited(kind);
}

async function checkAdminRate(db, key) {
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start >= ?')
    .bind(key, currentWindow()).first();
  if (row && row.count >= FAILED_KEYS_PER_MINUTE) throw limited('admin');
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') ||
      !['', 'identity'].includes(request.headers.get('content-encoding') ?? '')) {
    throw reject('Send artwork as JSON.', 'UNSUPPORTED_MEDIA_TYPE', 415);
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    throw reject('This artwork is too large.', 'BODY_TOO_LARGE', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw reject('Please send valid JSON.', 'INVALID_JSON', 400);
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw reject('This artwork is too large.', 'BODY_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw reject('Please send valid JSON.', 'INVALID_JSON', 400); }
}

function fullWall() {
  return reject('The wall is full. Your artwork is still on this device. Please save a copy and ask a club organizer for help.', 'WALL_FULL', 507);
}

function checkFingerprint(stored, fingerprint) {
  if (stored.fingerprint !== fingerprint) throw reject(
    'This submission reference has already been used for different artwork. Please try again.', 'SUBMISSION_CONFLICT', 409);
}

async function createSubmission(db, submission, fingerprint) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // A D1 batch is transactional. Concurrent retries cannot overwrite the original artwork.
  let inserted;
  let selected;
  try {
    [inserted, selected] = await db.batch([
      db.prepare(`INSERT INTO submissions (id, client_submission_id, created_at, name, student_id, grid_json, fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_submission_id) DO NOTHING`)
        .bind(id, submission.clientSubmissionId, createdAt, submission.name, submission.studentId, JSON.stringify(submission.grid), fingerprint),
      db.prepare('SELECT id, created_at, fingerprint FROM submissions WHERE client_submission_id = ?').bind(submission.clientSubmissionId),
    ]);
  } catch (error) {
    // The database trigger enforces capacity inside the same transaction, including concurrent submissions.
    if (String(error?.message).includes('PIXEL_WALL_FULL')) throw fullWall();
    if (String(error?.message).includes('PIXEL_WALL_EMAIL_REFERENCE')) throw reject('Email reference already exists.', 'EMAIL_REFERENCE', 503);
    throw error;
  }
  const stored = selected.results?.[0];
  if (!stored || !inserted.success || !selected.success) throw new Error('Submission unavailable');
  checkFingerprint(stored, fingerprint);
  return { isNew: inserted.meta.changes > 0, id: stored.id, createdAt: stored.created_at };
}

function overflowConfiguration(env) {
  // The binding's default restrictions allow verified destination addresses only.
  // The recipient and routing-domain sender are private Worker secrets, never request inputs.
  const validAddress = (value) => typeof value === 'string' && value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
  if (typeof env.OVERFLOW_EMAIL?.send !== 'function' || !validAddress(env.OVERFLOW_TO) || !validAddress(env.OVERFLOW_FROM)) return null;
  return { to: env.OVERFLOW_TO, from: env.OVERFLOW_FROM };
}

function emailUncertain() {
  return reject("We couldn't confirm the email submission. Your artwork is still on this device. Please save a copy and ask a club organizer for help.", 'EMAIL_UNCERTAIN', 503);
}

function emailFailed() {
  return reject('The email submission failed. Your artwork is still on this device. Please save a copy and ask a club organizer for help.', 'EMAIL_FAILED', 503);
}

function emailReceipt(stored, fingerprint, isNew = false) {
  if (!stored) throw new Error('Missing email receipt');
  checkFingerprint(stored, fingerprint);
  if (stored.status === 'failed') throw emailFailed();
  if (stored.status !== 'sent') throw emailUncertain();
  return { delivery: 'email', isNew, id: stored.id, createdAt: stored.created_at };
}

const DEFINITE_EMAIL_REJECTIONS = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED',
  'E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY',
]);

async function deliverOverflow(env, submission, fingerprint, addresses) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let claimed;
  let selected;
  let primary;
  try {
    // This claim is durable before a send is attempted. No lease expiry or automatic
    // resend: a crash between acceptance and recording success has an uncertain outcome.
    [claimed, selected, primary] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO overflow_deliveries (client_submission_id, id, created_at, fingerprint, status)
        SELECT ?, ?, ?, ?, 'pending' WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE client_submission_id = ?)
        ON CONFLICT(client_submission_id) DO NOTHING`)
        .bind(submission.clientSubmissionId, id, createdAt, fingerprint, submission.clientSubmissionId),
      env.DB.prepare('SELECT id, created_at, fingerprint, status FROM overflow_deliveries WHERE client_submission_id = ?')
        .bind(submission.clientSubmissionId),
      env.DB.prepare('SELECT id, created_at, fingerprint FROM submissions WHERE client_submission_id = ?')
        .bind(submission.clientSubmissionId),
    ]);
  } catch (error) {
    if (String(error?.message).includes('PIXEL_WALL_OVERFLOW_FULL')) throw fullWall();
    throw error; // A D1 quota outage must never bypass the durable claim.
  }
  if (!claimed.success || !selected.success || !primary.success) throw new Error('Email claim unavailable');
  const stored = selected.results?.[0];
  if (!stored) {
    const existing = primary.results?.[0];
    if (!existing) throw new Error('Submission unavailable');
    checkFingerprint(existing, fingerprint);
    return { isNew: false, id: existing.id, createdAt: existing.created_at };
  }
  checkFingerprint(stored, fingerprint);
  if (!claimed.meta.changes) return emailReceipt(stored, fingerprint);

  // Explicit allowlist: studentId is deliberately absent from the email and attachment.
  const attachment = {
    grid: submission.grid, name: submission.name, createdAt: stored.created_at,
    clientSubmissionId: submission.clientSubmissionId,
  };
  const content = btoa(String.fromCharCode(...encoder.encode(JSON.stringify(attachment))));
  let accepted;
  try {
    accepted = await env.OVERFLOW_EMAIL.send({
      to: addresses.to, from: addresses.from, subject: 'Pixel Wall artwork',
      text: `A new artwork arrived after the Pixel Wall reached its storage limit.\n\nNickname: ${submission.name || 'Anonymous'}\nSubmitted: ${stored.created_at}\nReference: ${submission.clientSubmissionId}\n\nThe complete 25-by-25 color grid is attached as JSON.`,
      attachments: [{ filename: `pixel-wall-${stored.id}.json`, type: 'application/json', disposition: 'attachment', content }],
    });
  } catch (error) {
    if (DEFINITE_EMAIL_REJECTIONS.has(error?.code)) {
      try {
        const failed = await env.DB.prepare("UPDATE overflow_deliveries SET status = 'failed' WHERE client_submission_id = ? AND status = 'pending'")
          .bind(submission.clientSubmissionId).run();
        if (!failed.success || failed.meta.changes !== 1) throw new Error('Email status unavailable');
      } catch { throw emailUncertain(); }
      throw emailFailed();
    }
    throw emailUncertain();
  }
  if (typeof accepted?.messageId !== 'string' || !accepted.messageId.length) throw emailUncertain();
  try {
    const saved = await env.DB.prepare("UPDATE overflow_deliveries SET status = 'sent' WHERE client_submission_id = ? AND status = 'pending'")
      .bind(submission.clientSubmissionId).run();
    if (!saved.success || saved.meta.changes !== 1) throw new Error('Email status unavailable');
  } catch { throw emailUncertain(); }
  return emailReceipt({ ...stored, status: 'sent' }, fingerprint, true);
}

async function saveSubmission(env, submission) {
  const fingerprint = hex(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify({
    grid: submission.grid, name: submission.name, studentId: submission.studentId,
  }))));
  try { return await createSubmission(env.DB, submission, fingerprint); }
  catch (error) {
    if (error.code === 'EMAIL_REFERENCE') {
      const stored = await env.DB.prepare('SELECT id, created_at, fingerprint, status FROM overflow_deliveries WHERE client_submission_id = ?')
        .bind(submission.clientSubmissionId).first();
      return emailReceipt(stored, fingerprint);
    }
    if (error.code !== 'WALL_FULL') throw error;
    const addresses = overflowConfiguration(env);
    if (!addresses) throw error;
    return deliverOverflow(env, submission, fingerprint, addresses);
  }
}

async function listSubmissions(db, { limit, offset }) {
  const [count, page] = await db.batch([
    db.prepare('SELECT submission_count AS total FROM wall_state WHERE id = 1'),
    db.prepare(`SELECT id, created_at, name, student_id, grid_json FROM submissions
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(limit, offset),
  ]);
  if (!count.success || !page.success || !count.results?.[0]) throw new Error('Submissions unavailable');
  const total = count.results[0].total;
  const submissions = page.results.map((row) => ({
    id: row.id, createdAt: row.created_at, name: row.name, studentId: row.student_id, grid: JSON.parse(row.grid_json),
  }));
  return { submissions, total, hasMore: offset + submissions.length < total };
}

export default {
  async fetch(request, env) {
    let allowedOrigin;
    try {
      const config = await configuration(env);
      const url = new URL(request.url);
      if (url.protocol !== 'https:') throw reject('HTTPS is required.', 'HTTPS_REQUIRED', 400);
      const origin = request.headers.get('Origin');
      if (origin && !config.origins.has(origin)) throw reject('Requests must come from this website.', 'ORIGIN_REJECTED', 403);
      allowedOrigin = origin || undefined;
      if (url.pathname === '/api/health' && request.method === 'GET') return reply(200, { ok: true }, allowedOrigin);
      if (url.pathname !== '/api/submissions') return reply(404, { error: 'Page not found.', code: 'NOT_FOUND' }, allowedOrigin);
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('Access-Control-Request-Method');
        const headers = (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
        const permitted = method === 'POST' ? ['content-type'] : ['x-admin-key', 'content-type'];
        if (!origin || !['GET', 'POST'].includes(method) || headers.some((header) => !permitted.includes(header))) {
          throw reject('This cross-origin request is not permitted.', 'PREFLIGHT_REJECTED', 403);
        }
        return reply(204, null, allowedOrigin, {
          'Access-Control-Allow-Methods': method,
          'Access-Control-Allow-Headers': permitted.join(', '),
          'Access-Control-Max-Age': '600',
          Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        });
      }
      if (request.method === 'POST') {
        if (!origin) throw reject('Requests must come from this website.', 'ORIGIN_REJECTED', 403);
        await consumeRate(env.DB, await rateKey(request, config, 'submit'), SUBMISSIONS_PER_MINUTE, 'submit');
        const result = await saveSubmission(env, validateSubmission(await readJson(request)));
        return reply(result.isNew ? 201 : 200, {
          id: result.id, createdAt: result.createdAt, ...(result.delivery ? { delivery: result.delivery } : {}),
        }, allowedOrigin);
      }
      if (request.method === 'GET') {
        const key = await rateKey(request, config, 'admin');
        await checkAdminRate(env.DB, key);
        if (!await keyMatches(request.headers.get('X-Admin-Key'), config)) {
          await consumeRate(env.DB, key, FAILED_KEYS_PER_MINUTE, 'admin');
          throw reject('Enter a valid organizer key to view submissions.', 'UNAUTHORIZED', 401);
        }
        return reply(200, await listSubmissions(env.DB, validatePagination(url.searchParams)), allowedOrigin);
      }
      return reply(405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, allowedOrigin, { Allow: 'GET, POST, OPTIONS' });
    } catch (error) {
      if (error instanceof ValidationError) return reply(error.status, { error: error.message, code: error.code }, allowedOrigin,
        error.status === 429 ? { 'Retry-After': String(WINDOW_SECONDS - Math.floor(Date.now() / 1000) % WINDOW_SECONDS) } : {});
      // Never expose configuration, SQL, personal information, or credentials in responses/logs.
      return reply(503, { error: 'The wall is temporarily unavailable. Your artwork is still here; please try again.', code: 'SERVICE_UNAVAILABLE' }, allowedOrigin);
    }
  },

  async scheduled(_controller, env) {
    await configuration(env);
    // Keep hashed-address retention short. This uses the indexed window_start column.
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(currentWindow() - 86_400).run();
  },
};
