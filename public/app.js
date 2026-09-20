import { PixelEditor, PALETTE, GRID_SIZE, createEmptyGrid, validateDraftGrid } from './drawing.js';
import { api } from './api-config.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'pixel-wall.draft.v1';
const ATTEMPT_KEY = 'pixel-wall.attempt.v1';
let selectedColor = PALETTE.find(color => color.name === 'Purple');
let erasing = false;
let filled = 0;
let submitting = false;
let previousAttempt = null;
let submissionFailed = false;

function updateDownloadState() {
  $('download-fallback').hidden = api.available && !submissionFailed;
  $('dialog-download-fallback').hidden = !submissionFailed;
  for (const id of ['download-artwork', 'download-artwork-dialog']) $(id).disabled = !filled || submitting;
}

function showMessage(message = '') {
  $('editor-message').textContent = message;
  $('editor-message').hidden = !message;
}

function safelyStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* Painting still works when browser storage is unavailable. */ }
}

const editor = new PixelEditor($('pixel-canvas'), {
  onChange(state) {
    filled = state.filled;
    $('pixel-count').textContent = `${filled} / 625`;
    $('undo').disabled = !state.canUndo;
    $('redo').disabled = !state.canRedo;
    $('clear').disabled = !filled;
    safelyStore(DRAFT_KEY, filled ? state.grid : null);
    showMessage();
    updateDownloadState();
  },
});
editor.setColor(selectedColor.hex);

function selectColor(color) {
  selectedColor = color;
  erasing = false;
  editor.setColor(color.hex);
  updateSelection();
}

function updateSelection() {
  for (const button of $('palette').children) {
    button.setAttribute('aria-pressed', String(!erasing && button.dataset.color === selectedColor.hex));
  }
  $('selected-dot').style.backgroundColor = erasing ? '#FFFFFF' : selectedColor.hex;
  $('selected-name').textContent = erasing ? 'Eraser' : selectedColor.name;
  $('eraser').setAttribute('aria-pressed', String(erasing));
  $('pixel-canvas').classList.toggle('eraser-cursor', erasing);
}

for (const color of PALETTE) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'color-swatch';
  button.dataset.color = color.hex;
  button.style.backgroundColor = color.hex;
  button.style.setProperty('--swatch-color', color.hex);
  button.setAttribute('aria-label', color.name);
  button.title = color.name;
  const rgb = color.hex.slice(1).match(/../g).map(value => parseInt(value, 16));
  if ((rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 180) button.classList.add('light-swatch');
  button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
  button.addEventListener('click', () => selectColor(color));
  $('palette').append(button);
}
updateSelection();

try {
  const draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
  if (validateDraftGrid(draft)) {
    editor.loadGrid(draft);
    if (filled) showMessage('Welcome back. Your canvas is right where you left it.');
  }
  const attempt = JSON.parse(localStorage.getItem(ATTEMPT_KEY));
  if (attempt && typeof attempt.id === 'string' && typeof attempt.fingerprint === 'string') previousAttempt = attempt;
} catch { /* Ignore an old or unavailable draft. */ }

if (!api.available) {
  showMessage(api.message);
  for (const id of ['artist-name', 'student-id', 'confirm-submit']) $(id).disabled = true;
}
updateDownloadState();

$('eraser').addEventListener('click', () => {
  erasing = !erasing;
  editor.setEraser(erasing);
  updateSelection();
});
$('undo').addEventListener('click', () => editor.undo());
$('redo').addEventListener('click', () => editor.redo());
$('clear').addEventListener('click', () => {
  editor.clear();
  showMessage('A fresh canvas. You can undo this if you change your mind.');
});
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || $('submit-dialog').open || $('create-screen').hidden || /INPUT|TEXTAREA/.test(event.target.tagName)) return;
  if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    if (event.key.toLowerCase() === 'y' || event.shiftKey) editor.redo();
    else editor.undo();
  }
});

function renderArtwork(canvas, grid) {
  const context = canvas.getContext('2d');
  const size = canvas.width / GRID_SIZE;
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      context.fillStyle = grid[row][col];
      context.fillRect(col * size, row * size, size, size);
    }
  }
}

$('open-submit').addEventListener('click', () => {
  editor.finishStroke();
  if (!api.available) {
    showMessage(api.message);
    return;
  }
  if (!filled) {
    showMessage('Add a little color before you submit. Your first pixel is a great start.');
    $('pixel-canvas').focus({ preventScroll: true });
    return;
  }
  $('submit-error').hidden = true;
  renderArtwork($('preview-art'), editor.getGrid());
  $('submit-dialog').showModal();
  $('artist-name').focus({ preventScroll: true });
});

function closeDialog() {
  if (submitting) return;
  $('submit-dialog').close();
}
$('close-dialog').addEventListener('click', closeDialog);
$('keep-creating').addEventListener('click', closeDialog);
$('submit-dialog').addEventListener('cancel', (event) => { if (submitting) event.preventDefault(); });
$('submit-dialog').addEventListener('close', () => { if (!$('create-screen').hidden) $('open-submit').focus({ preventScroll: true }); });

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function getAttemptId(payload) {
  // Only a digest is persisted: optional names and student IDs stay out of local storage.
  const raw = JSON.stringify(payload);
  let fingerprint;
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } else {
    // Non-HTTPS LAN previews can still retry safely during the current page session.
    fingerprint = raw;
  }
  if (previousAttempt?.fingerprint === fingerprint) return previousAttempt.id;
  previousAttempt = { id: newId(), fingerprint };
  if (crypto.subtle) safelyStore(ATTEMPT_KEY, previousAttempt);
  return previousAttempt.id;
}

function setSubmitting(value) {
  submitting = value;
  for (const id of ['confirm-submit', 'close-dialog', 'keep-creating', 'artist-name', 'student-id']) $(id).disabled = value;
  $('submit-form').setAttribute('aria-busy', String(value));
  $('confirm-submit').querySelector('span').textContent = value ? 'Sending your artwork…' : 'Send to the wall';
  updateDownloadState();
}

function downloadArtwork(messageId) {
  editor.finishStroke();
  if (!filled || submitting) return;
  const artwork = { format: 'pixel-wall', version: 1, size: GRID_SIZE, exportedAt: new Date().toISOString(), grid: editor.getGrid() };
  const name = $('artist-name').value.trim();
  if (name) artwork.name = name;
  // Build an allowlisted export rather than copying the submission's personal details.
  const file = new Blob([JSON.stringify(artwork, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pixel-wall-${artwork.exportedAt.slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  $(messageId).textContent = 'Download ready. Share the JSON file with the club to hand in your artwork.';
  $(messageId).hidden = false;
}
$('download-artwork').addEventListener('click', () => downloadArtwork('download-message'));
$('download-artwork-dialog').addEventListener('click', () => downloadArtwork('dialog-download-message'));

$('submit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  if (!api.available) {
    showMessage(api.message);
    return;
  }
  const payload = { grid: editor.getGrid(), name: $('artist-name').value.trim(), studentId: $('student-id').value.trim() };
  setSubmitting(true);
  $('submit-error').hidden = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const clientSubmissionId = await getAttemptId(payload);
    const response = await fetch(api.url('/api/submissions'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      body: JSON.stringify({ ...payload, clientSubmissionId }), signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'We couldn’t save your artwork. Please try again.');
    if (!result.id || !result.createdAt) throw new Error('We couldn’t confirm your submission. Please try again.');
    $('success-title').textContent = result.delivery === 'email'
      ? 'Your artwork was sent to the club by email.'
      : 'Your pixel art has been submitted! 🎨';
    renderArtwork($('success-art'), payload.grid);
    $('create-screen').hidden = true;
    $('success-screen').hidden = false;
    $('submit-dialog').close();
    $('submit-form').reset();
    safelyStore(DRAFT_KEY, null);
    safelyStore(ATTEMPT_KEY, null);
    previousAttempt = null;
    submissionFailed = false;
    updateDownloadState();
    $('success-title').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) {
    $('submit-error').textContent = error.name === 'AbortError' || error instanceof TypeError
      ? 'We couldn’t reach the wall. Check your connection and try again. Your artwork is safe here.'
      : error.message;
    $('submit-error').hidden = false;
    submissionFailed = true;
    updateDownloadState();
  } finally {
    clearTimeout(timeout);
    setSubmitting(false);
  }
});

$('create-another').addEventListener('click', () => {
  $('success-screen').hidden = true;
  $('create-screen').hidden = false;
  editor.loadGrid(createEmptyGrid());
  selectColor(PALETTE.find(color => color.name === 'Purple'));
  showMessage();
  $('pixel-canvas').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
});

// Optional personal details are enabled only after safe form submission is installed.
if (api.available) {
  for (const id of ['artist-name', 'student-id', 'confirm-submit']) $(id).disabled = false;
}

document.addEventListener('visibilitychange', () => { if (document.hidden && !$('create-screen').hidden) editor.finishStroke(); });
window.addEventListener('pagehide', () => { if (!$('create-screen').hidden) editor.finishStroke(); });
