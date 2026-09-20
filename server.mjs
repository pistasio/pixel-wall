import { createServer as createHttpServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStorage } from './lib/storage.mjs';
import { ValidationError, validatePagination, validateSubmission } from './lib/validation.mjs';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function securityHeaders(response, enforceHttps) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (enforceHttps) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
}

function parseOrigin(value, httpsOnly = false) {
  const parsed = new URL(value);
  // Require a literal, canonical origin: no credentials, path, query, fragment, or wildcard.
  if (typeof value !== 'string' || parsed.origin !== value || parsed.username || parsed.password ||
      !(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(parsed.protocol)) throw new Error('Invalid origin');
  return parsed.origin;
}

function permittedOrigin(request, publicOrigin, allowedOrigins) {
  const origin = request.headers.origin;
  if (!origin) return request.headers['sec-fetch-site'] !== 'cross-site'; // Non-browser clients may omit Origin.
  try {
    parseOrigin(origin);
    if (allowedOrigins.has(origin)) return true;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    return publicOrigin ? origin === publicOrigin : new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function keyMatches(candidate, expectedDigest) {
  if (typeof candidate !== 'string' || candidate.length > 1024) return false;
  return timingSafeEqual(createHash('sha256').update(candidate).digest(), expectedDigest);
}

function readJson(request, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    let bytes = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!rejected) rejectBody(new ValidationError('This artwork is too large.', 'BODY_TOO_LARGE', 413));
        rejected = true;
        chunks.length = 0;
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectBody(new ValidationError('Please send valid JSON.', 'INVALID_JSON', 400)); }
    });
    request.on('error', rejectBody);
    request.on('aborted', () => rejectBody(new ValidationError('Submission was interrupted.', 'INTERRUPTED', 400)));
  });
}

// A generous ceiling accommodates an entire event sharing a university Wi-Fi address.
function createRateLimiter(maximum, windowMs, maximumAddresses = 10_000) {
  const windows = new Map();
  let lastSweep = Date.now();
  return (address, consume = true) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [key, entry] of windows) if (entry.reset <= now) windows.delete(key);
      lastSweep = now;
    }
    let entry = windows.get(address);
    if (!entry || entry.reset <= now) {
      if (!consume) return 0;
      if (!entry && windows.size >= maximumAddresses) {
        // Fail closed for new addresses instead of allowing unbounded memory growth.
        for (const [key, value] of windows) if (value.reset <= now) windows.delete(key);
        if (windows.size >= maximumAddresses) return Math.max(1, Math.ceil(windowMs / 1000));
      }
      entry = { count: 0, reset: now + windowMs };
      windows.set(address, entry);
    }
    if (consume) entry.count += 1;
    const allowed = consume ? entry.count <= maximum : entry.count < maximum;
    return allowed ? 0 : Math.max(1, Math.ceil((entry.reset - now) / 1000));
  };
}

export function createAppServer(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  let adminKey = options.adminKey ?? process.env.ADMIN_KEY;
  if (!adminKey) {
    if (production) throw new Error('Set ADMIN_KEY to a randomly generated secret of at least 32 characters before starting in production.');
    adminKey = randomBytes(24).toString('hex');
    console.log(`Local organizer key: ${adminKey}`);
  }
  const minimumKeyLength = production ? 32 : 16;
  if (typeof adminKey !== 'string' || adminKey.length < minimumKeyLength || adminKey.length > 1024) {
    throw new Error(`ADMIN_KEY must contain ${minimumKeyLength} to 1024 characters.`);
  }
  if (production && (/(?:example|replace|change[-_ ]?me|local[-_ ]preview|password|your[-_ ](?:secret|admin|key))/i.test(adminKey) ||
      /^(.)\1+$/.test(adminKey))) {
    throw new Error('ADMIN_KEY must be a randomly generated secret, not a preview key or placeholder.');
  }
  const adminDigest = createHash('sha256').update(adminKey).digest();
  const publicDirectory = resolve(options.publicDir ?? resolve(appDirectory, 'public'));
  const dataDirectory = resolve(options.dataDir ?? process.env.DATA_DIR ?? resolve(appDirectory, 'data'));
  const originSetting = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  let publicOrigin;
  if (originSetting) {
    try {
      publicOrigin = parseOrigin(originSetting, production);
    } catch {
      throw new Error(`PUBLIC_ORIGIN must be an exact ${production ? 'HTTPS' : 'HTTP or HTTPS'} origin without a path or credentials.`);
    }
  }
  let allowedOrigins;
  try {
    const configured = options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()) : []);
    if (!Array.isArray(configured) || configured.length > 20) throw new Error();
    allowedOrigins = new Set(configured.map((origin) => parseOrigin(origin, true)));
  } catch {
    throw new Error('ALLOWED_ORIGINS must contain at most 20 exact HTTPS origins without paths, wildcards, or credentials.');
  }
  const storage = openStorage(options.databasePath ?? resolve(dataDirectory, 'pixel-wall.sqlite'));
  const maxBodyBytes = options.maxBodyBytes ?? 16_384;
  const rateLimit = createRateLimiter(options.rateLimitMax ?? 600, options.rateLimitWindowMs ?? 60_000);
  const adminRateLimit = createRateLimiter(options.adminRateLimitMax ?? 20, options.adminRateLimitWindowMs ?? 60_000);

  const server = createHttpServer(async (request, response) => {
    securityHeaders(response, production && publicOrigin?.startsWith('https://'));
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        // Cross-origin access is deliberately limited to the submissions endpoint.
        const crossOrigins = url.pathname === '/api/submissions' ? allowedOrigins : new Set();
        response.setHeader('Vary', 'Origin');
        if (!permittedOrigin(request, publicOrigin, crossOrigins)) {
          return json(response, 403, { error: 'Requests must come from this website.', code: 'ORIGIN_REJECTED' });
        }
        if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
        if (url.pathname === '/api/health' && request.method === 'GET') {
          return json(response, 200, { ok: true });
        }
        if (url.pathname === '/api/submissions') {
          if (request.method === 'OPTIONS') {
            const method = request.headers['access-control-request-method'];
            const headers = (request.headers['access-control-request-headers'] ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
            if (!request.headers.origin || !['GET', 'POST'].includes(method) ||
                headers.some((header) => !['content-type', 'x-admin-key'].includes(header))) {
              return json(response, 403, { error: 'This cross-origin request is not permitted.', code: 'PREFLIGHT_REJECTED' });
            }
            response.writeHead(204, {
              'Access-Control-Allow-Methods': 'GET, POST',
              'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
              'Access-Control-Max-Age': '600',
              'Cache-Control': 'no-store',
              Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
            });
            return response.end();
          }
          if (request.method === 'GET') {
            const address = request.socket.remoteAddress ?? 'unknown';
            const retryAfter = adminRateLimit(address, false);
            if (retryAfter) {
              return json(response, 429, { error: 'Too many organizer key attempts. Wait a minute and try again.', code: 'RATE_LIMITED' }, { 'Retry-After': retryAfter });
            }
            if (!keyMatches(request.headers['x-admin-key'], adminDigest)) {
              const retryAfter = adminRateLimit(address);
              if (retryAfter) {
                return json(response, 429, { error: 'Too many organizer key attempts. Wait a minute and try again.', code: 'RATE_LIMITED' }, { 'Retry-After': retryAfter });
              }
              return json(response, 401, { error: 'Enter a valid organizer key to view submissions.', code: 'UNAUTHORIZED' });
            }
            return json(response, 200, storage.list(validatePagination(url.searchParams)));
          }
          if (request.method === 'POST') {
            const retryAfter = rateLimit(request.socket.remoteAddress ?? 'unknown');
            if (retryAfter) {
              request.resume();
              return json(response, 429, { error: 'The wall is busy. Please wait a moment and try again.', code: 'RATE_LIMITED' }, { 'Retry-After': retryAfter });
            }
            if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') ||
                (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
              request.resume();
              return json(response, 415, { error: 'Send artwork as JSON.', code: 'UNSUPPORTED_MEDIA_TYPE' });
            }
            if (Number(request.headers['content-length'] ?? 0) > maxBodyBytes) {
              request.resume();
              return json(response, 413, { error: 'This artwork is too large.', code: 'BODY_TOO_LARGE' });
            }
            const submission = validateSubmission(await readJson(request, maxBodyBytes));
            const result = storage.create(submission);
            return json(response, result.isNew ? 201 : 200, { id: result.id, createdAt: result.createdAt });
          }
          return json(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET, POST, OPTIONS' });
        }
        return json(response, 404, { error: 'Page not found.', code: 'NOT_FOUND' });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        return json(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET, HEAD' });
      }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { return json(response, 400, { error: 'Invalid URL.', code: 'INVALID_URL' }); }
      if (pathname.includes('\0') || pathname.includes('\\')) {
        return json(response, 400, { error: 'Invalid URL.', code: 'INVALID_URL' });
      }
      if (pathname === '/') pathname = '/index.html';
      if (pathname === '/admin' || pathname === '/admin/') {
        // A canonical file URL keeps relative assets and the home link correct.
        response.writeHead(302, { Location: '/admin.html', 'Cache-Control': 'no-store' });
        return response.end();
      }
      const filePath = resolve(publicDirectory, `.${pathname}`);
      if (!filePath.startsWith(publicDirectory + sep)) {
        return json(response, 404, { error: 'Page not found.', code: 'NOT_FOUND' });
      }
      try {
        const realFilePath = await realpath(filePath);
        const realPublicDirectory = await realpath(publicDirectory);
        if (!realFilePath.startsWith(realPublicDirectory + sep) || !(await stat(realFilePath)).isFile()) throw new Error('Not a public file');
        const data = await readFile(realFilePath);
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'no-cache',
        });
        response.end(request.method === 'HEAD' ? undefined : data);
      } catch {
        json(response, 404, { error: 'Page not found.', code: 'NOT_FOUND' });
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const expected = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      if (!expected) console.error('Request failed:', error.message);
      json(response, expected ? error.status : 500, {
        error: expected ? error.message : 'Something went wrong. Your artwork is still here; please try again.',
        code: expected ? error.code : 'INTERNAL_ERROR',
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => storage.close());
  return server;
}

export async function startServer(options = {}) {
  const server = createAppServer(options);
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  await new Promise((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(port, host, () => {
      server.off('error', rejectListening);
      resolveListening();
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startServer();
  const address = server.address();
  console.log(`Pixel Wall is ready at http://${address.address}:${address.port}`);
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
