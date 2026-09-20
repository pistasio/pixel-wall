import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPages, PAGE_FILES } from '../scripts/build-pages.mjs';
import { resolveApiConfig, validateApiOrigin, UNAVAILABLE_MESSAGE } from '../public/api-config.js';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('only an HTTPS origin without credentials or URL payloads is allowed', () => {
  assert.equal(validateApiOrigin('https://api.example.test'), 'https://api.example.test');
  assert.equal(validateApiOrigin('https://api.example.test/'), 'https://api.example.test');
  for (const value of [
    '', ' https://api.example.test', 'http://api.example.test', '//api.example.test',
    'https://user:password@api.example.test', 'https://api.example.test/path',
    'https://api.example.test?key=secret', 'https://api.example.test#key',
    'https://api.example.test?', 'https://api.example.test#',
    'https://api.example\t.test', "https://api';script-src.test", 'https://api\".test',
    'https://api.example.test\\other', 'javascript:alert(1)', 'data:text/plain,hello',
  ]) assert.throws(() => validateApiOrigin(value), /HTTPS origin/, value);
});

test('server uses same-origin API and Pages fails closed without valid API config', () => {
  const local = resolveApiConfig({ deployment: 'server', apiBaseUrl: '' });
  assert.equal(local.available, true);
  assert.equal(local.url('/api/submissions'), '/api/submissions');
  const external = resolveApiConfig({ deployment: 'pages', apiBaseUrl: 'https://api.example.test/' });
  assert.equal(external.url('/api/submissions?limit=24&offset=0'), 'https://api.example.test/api/submissions?limit=24&offset=0');
  for (const settings of [undefined, {}, { deployment: 'pages', apiBaseUrl: '' }, { deployment: 'pages', apiBaseUrl: 'http://insecure.test' }]) {
    const api = resolveApiConfig(settings);
    assert.equal(api.available, false);
    assert.equal(api.message, UNAVAILABLE_MESSAGE);
    assert.throws(() => api.url('/api/submissions'), /Submissions are not connected/);
  }
  for (const path of ['https://other.test/api/submissions', '//other.test', '/api/../private', '/api/submissions#fragment', '/api/submissions\\else']) {
    assert.throws(() => external.url(path), /Invalid API path/);
  }
});

test('Pages build publishes only allowlisted assets and exact-origin CSP at any base path', async (t) => {
  const destination = await mkdtemp(resolve(appDirectory, 'dist-pages-test-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  // A stale file must not survive rebuilding the deployment directory.
  await writeFile(resolve(destination, '.env'), 'ADMIN_KEY=DO_NOT_PUBLISH');
  const result = await buildPages({ apiBaseUrl: 'https://api.example.test', outputDirectory: destination });
  assert.equal(result.apiConfigured, true);
  const files = await readdir(destination);
  assert.deepEqual(files.sort(), [...PAGE_FILES, '.nojekyll'].sort());
  for (const file of files) {
    const content = await readFile(resolve(destination, file), 'utf8');
    assert.doesNotMatch(content, /DO_NOT_PUBLISH|pixel-wall-local-preview-key|BEGIN PRIVATE KEY/);
    if (!file.endsWith('.html')) continue;
    assert.match(content, /connect-src https:\/\/api\.example\.test;/);
    assert.match(content, /script-src 'self';/);
    assert.match(content, /object-src 'none'; base-uri 'none'; form-action 'none'/);
    assert.match(content, /name="referrer" content="no-referrer"/);
    assert.doesNotMatch(content, /(?:src|href)="\//);
    for (const [, link] of content.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
      assert.ok(link.startsWith('./'), `Expected relative frontend link: ${link}`);
      assert.equal(new URL(link, 'https://club.github.io/pixel-wall/').pathname.startsWith('/pixel-wall/'), true);
    }
  }
  const built = await import(`${pathToFileURL(resolve(destination, 'api-config.js')).href}?configured`);
  assert.equal(built.api.available, true);
  assert.equal(built.api.url('/api/submissions'), 'https://api.example.test/api/submissions');
});

test('missing backend build blocks network access without blocking the canvas', async (t) => {
  const destination = await mkdtemp(resolve(appDirectory, 'dist-pages-test-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const result = await buildPages({ apiBaseUrl: '', outputDirectory: destination });
  assert.equal(result.apiConfigured, false);
  const built = await import(`${pathToFileURL(resolve(destination, 'api-config.js')).href}?disabled`);
  assert.equal(built.api.available, false);
  assert.throws(() => built.api.url('/api/submissions'), /not connected/);
  const html = await readFile(resolve(destination, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'none';/);
  assert.match(html, /id="pixel-canvas"/);
  const editor = await readFile(resolve(destination, 'app.js'), 'utf8');
  const organizer = await readFile(resolve(destination, 'admin.js'), 'utf8');
  assert.match(editor, /if \(!api.available\)/);
  assert.match(organizer, /if \(!api.available\)/);
  assert.match(organizer, /elements\['access-key'\]\.disabled = true/);
});

test('invalid backend settings and unsafe build destinations are rejected', async () => {
  await assert.rejects(buildPages({ apiBaseUrl: 'http://api.example.test' }), /HTTPS origin/);
  await assert.rejects(buildPages({ apiBaseUrl: '', outputDirectory: appDirectory }), /dist-pages build directory/);
});

test('organizer credentials cannot enter a browser navigation when JavaScript fails', async () => {
  const html = await readFile(resolve(appDirectory, 'public/admin.html'), 'utf8');
  const form = html.match(/<form\b[^>]*\bid="access-form"[^>]*>/)?.[0];
  const input = html.match(/<input\b[^>]*\bid="access-key"[^>]*>/)?.[0];
  const button = html.match(/<button\b[^>]*\bid="connect-button"[^>]*>/)?.[0];
  assert.ok(form && input && button);
  assert.match(form, /\bmethod="post"/);
  assert.match(input, /\sdisabled(?:\s|>)/);
  assert.match(button, /\sdisabled(?:\s|>)/);
  // An unnamed secret input is excluded from native form data even if re-enabled.
  assert.doesNotMatch(input, /\sname\s*=/);
  const source = await readFile(resolve(appDirectory, 'public/admin.js'), 'utf8');
  const handlerPosition = source.indexOf('elements["access-form"].addEventListener("submit"');
  const enablePosition = source.indexOf('elements["access-key"].disabled = false');
  assert.ok(handlerPosition > 0 && enablePosition > handlerPosition);
});

async function editorHarness({ apiAvailable = true, response } = {}) {
  const nodes = new Map();
  const downloads = [];
  const files = new Map();
  const requests = [];
  function node(tag = 'div') {
    return {
      tagName: tag.toUpperCase(), value: '', textContent: '', hidden: false, disabled: true, children: [],
      listeners: new Map(), dataset: {}, style: { setProperty() {} }, classList: { add() {}, toggle() {} },
      addEventListener(event, handler) { this.listeners.set(event, handler); },
      setAttribute() {}, focus() {}, append(child) { this.children.push(child); }, remove() {},
      querySelector() { return this.span ??= { textContent: '' }; },
      getContext() { return { clearRect() {}, fillRect() {} }; },
      showModal() { this.open = true; }, close() { this.open = false; }, reset() {},
      click() { if (tag === 'a') downloads.push({ href: this.href, filename: this.download }); },
    };
  }
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement: node, addEventListener() {}, body: node('body'),
  };
  document.getElementById('success-screen').hidden = true;
  const grid = Array.from({ length: 25 }, () => Array(25).fill('#FFFFFF'));
  grid[0][0] = '#123456';
  class PixelEditor {
    constructor(canvas, { onChange }) { this.onChange = onChange; this.grid = grid; this.update(); }
    update() { this.onChange({ grid: this.grid, filled: this.grid.flat().filter(c => c !== '#FFFFFF').length, canUndo: true, canRedo: false }); }
    setColor() {} finishStroke() {} setEraser() {} undo() {} redo() {} clear() {}
    getGrid() { return this.grid.map(row => [...row]); }
    loadGrid(value) { this.grid = value; this.update(); }
  }
  const source = (await readFile(resolve(appDirectory, 'public/app.js'), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  runInNewContext(source, {
    document, window: { addEventListener() {}, scrollTo() {} }, PixelEditor,
    GRID_SIZE: 25, PALETTE: [{ name: 'Purple', hex: '#9876AB' }],
    createEmptyGrid: () => Array.from({ length: 25 }, () => Array(25).fill('#FFFFFF')),
    validateDraftGrid: () => false, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    api: { available: apiAvailable, message: UNAVAILABLE_MESSAGE, url: path => path },
    crypto: webcrypto, TextEncoder, AbortController, Blob,
    URL: { createObjectURL(file) { const id = `blob:artwork-${files.size}`; files.set(id, file); return id; }, revokeObjectURL() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (...args) => { requests.push(args); return response || { ok: false, json: async () => ({ error: 'Email is unavailable.' }) }; },
  });
  return { nodes, downloads, files, requests, grid, async dispatch(id, event = 'click') {
    return nodes.get(id).listeners.get(event)({ preventDefault() {} });
  } };
}

test('download fallback preserves all pixel data without student ID or a submission claim', async () => {
  const app = await editorHarness({ apiAvailable: false });
  app.nodes.get('artist-name').value = 'Ada';
  app.nodes.get('student-id').value = 'PRIVATE-STUDENT-ID';
  assert.equal(app.nodes.get('download-fallback').hidden, false);
  assert.equal(app.nodes.get('download-artwork').disabled, false);
  await app.dispatch('download-artwork');
  assert.equal(app.downloads.length, 1);
  const file = app.files.get(app.downloads[0].href);
  assert.equal(file.type, 'application/json');
  const text = await file.text();
  const data = JSON.parse(text);
  assert.deepEqual(data.grid, app.grid);
  assert.equal(data.size, 25);
  assert.equal(data.grid.flat().length, 625);
  assert.equal(data.name, 'Ada');
  assert.doesNotMatch(text, /studentId|PRIVATE-STUDENT-ID/);
  assert.equal(app.requests.length, 0);
  assert.equal(app.nodes.get('success-screen').hidden, true);
});

test('failed submission offers a download and emailed success is described truthfully', async () => {
  const failed = await editorHarness();
  await failed.dispatch('submit-form', 'submit');
  assert.equal(failed.nodes.get('dialog-download-fallback').hidden, false);
  assert.equal(failed.nodes.get('success-screen').hidden, true);
  assert.equal(failed.nodes.get('submit-error').hidden, false);
  await failed.dispatch('download-artwork-dialog');
  assert.equal(failed.downloads.length, 1);

  const emailed = await editorHarness({ response: { ok: true, json: async () => ({ id: 'artwork-id', createdAt: new Date().toISOString(), delivery: 'email' }) } });
  await emailed.dispatch('submit-form', 'submit');
  assert.equal(emailed.nodes.get('success-screen').hidden, false);
  assert.equal(emailed.nodes.get('success-title').textContent, 'Your artwork was sent to the club by email.');
});

test('optional personal details remain outside native form data if JavaScript fails', async () => {
  const html = await readFile(resolve(appDirectory, 'public/index.html'), 'utf8');
  assert.match(html, /<form id="submit-form" method="post">/);
  for (const id of ['artist-name', 'student-id']) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(input);
    assert.match(input, /\sdisabled(?:\s|>)/);
    assert.doesNotMatch(input, /\sname\s*=/);
  }
});
