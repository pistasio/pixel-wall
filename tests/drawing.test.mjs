import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_SIZE, PALETTE, createEmptyGrid, validateDraftGrid, rasterLine, PixelDocument, PixelEditor } from '../public/drawing.js';

test('blank grids have independent rows and calls, and exactly 625 cells', () => {
  const first = createEmptyGrid();
  const second = createEmptyGrid();
  assert.equal(GRID_SIZE, 25);
  assert.equal(first.flat().length, 625);
  first[0][0] = '#000000';
  assert.equal(first[1][0], '#FFFFFF');
  assert.equal(second[0][0], '#FFFFFF');
  assert.equal(PALETTE.length, 16);
  assert.equal(new Set(PALETTE.map(color => color.hex)).size, 16);
});

test('draft validation rejects malformed and sparse grids', () => {
  const grid = createEmptyGrid();
  assert.ok(validateDraftGrid(grid));
  grid[2][3] = '#abcdef';
  assert.ok(validateDraftGrid(grid));
  for (const invalid of [null, {}, [], Array(25), grid.slice(1)]) assert.equal(validateDraftGrid(invalid), false);
  for (const color of ['', '#fff', 'red', '#1234567', 0, null, {}]) {
    grid[2][3] = color;
    assert.equal(validateDraftGrid(grid), false);
  }
  grid[2] = Array(25);
  assert.equal(validateDraftGrid(grid), false);
});

test('fast strokes include both endpoints and have no missing cells in every direction', () => {
  const cases = [
    [{ row: 0, col: 0 }, { row: 24, col: 24 }],
    [{ row: 24, col: 24 }, { row: 0, col: 0 }],
    [{ row: 2, col: 1 }, { row: 5, col: 24 }],
    [{ row: 1, col: 5 }, { row: 24, col: 2 }],
    [{ row: 12, col: 24 }, { row: 12, col: 0 }],
    [{ row: 24, col: 10 }, { row: 0, col: 10 }],
  ];
  for (const [start, end] of cases) {
    const points = rasterLine(start, end);
    assert.deepEqual(points[0], start);
    assert.deepEqual(points.at(-1), end);
    assert.equal(points.length, Math.max(Math.abs(start.row - end.row), Math.abs(start.col - end.col)) + 1);
    for (let i = 1; i < points.length; i++) {
      assert.ok(Math.abs(points[i].row - points[i - 1].row) <= 1);
      assert.ok(Math.abs(points[i].col - points[i - 1].col) <= 1);
    }
  }
  assert.deepEqual(rasterLine({ row: -1, col: 2 }, { row: 0, col: 0 }), []);
  assert.deepEqual(rasterLine({ row: 0.5, col: 2 }, { row: 0, col: 0 }), []);
});

test('a complete drag is one undoable change, redo restores actual grid data', () => {
  const art = new PixelDocument();
  art.beginStroke();
  for (const cell of rasterLine({ row: 0, col: 0 }, { row: 24, col: 24 })) art.paint(cell, '#123456');
  assert.equal(art.endStroke(), true);
  assert.equal(art.getState().filled, 25);
  assert.equal(art.undo(), true);
  assert.deepEqual(art.getGrid(), createEmptyGrid());
  assert.equal(art.undo(), false);
  assert.equal(art.redo(), true);
  assert.equal(art.getState().filled, 25);
  assert.equal(art.getGrid()[24][24], '#123456');
});

test('no-op strokes preserve redo; fresh changes replace redo; erasing and clearing are undoable', () => {
  const art = new PixelDocument();
  art.paint({ row: 0, col: 0 }, '#000000');
  art.endStroke();
  art.undo();
  art.beginStroke();
  art.paint({ row: 0, col: 0 }, '#FFFFFF');
  assert.equal(art.endStroke(), false);
  assert.equal(art.getState().canRedo, true);
  art.paint({ row: 1, col: 1 }, '#ff0000');
  art.endStroke();
  assert.equal(art.getState().canRedo, false);
  assert.equal(art.getGrid()[1][1], '#FF0000');
  art.paint({ row: 1, col: 1 }, '#FFFFFF');
  art.endStroke();
  assert.equal(art.getState().filled, 0);
  art.undo();
  assert.equal(art.getState().filled, 1);
  assert.equal(art.clear(), true);
  assert.equal(art.getState().filled, 0);
  art.undo();
  assert.equal(art.getState().filled, 1);
});

test('snapshots and loaded drafts cannot mutate editor state; loading resets history', () => {
  const source = createEmptyGrid();
  source[0][0] = '#abcdef';
  const art = new PixelDocument(source);
  source[0][0] = '#000000';
  const snapshot = art.getGrid();
  snapshot[0][0] = '#FF0000';
  assert.equal(art.getGrid()[0][0], '#ABCDEF');
  art.paint({ row: 1, col: 1 }, '#000000');
  art.endStroke();
  art.load(createEmptyGrid());
  assert.equal(art.getState().filled, 0);
  assert.equal(art.getState().canUndo, false);
  assert.equal(art.getState().canRedo, false);
  assert.throws(() => art.load([]), TypeError);
  assert.throws(() => art.paint({ row: 0, col: 0 }, 'red'), TypeError);
  assert.equal(art.paint({ row: 99, col: 0 }, '#000000'), false);
});

test('history retains the most recent 80 strokes', () => {
  const art = new PixelDocument();
  for (let n = 0; n < 100; n++) {
    art.paint({ row: Math.floor(n / 25), col: n % 25 }, '#000000');
    art.endStroke();
  }
  let undos = 0;
  while (art.undo()) undos++;
  assert.equal(undos, 80);
  assert.equal(art.getState().filled, 20);
  let redos = 0;
  while (art.redo()) redos++;
  assert.equal(redos, 80);
  assert.equal(art.getState().filled, 100);
});

class CanvasStub extends EventTarget {
  constructor() {
    super();
    this.style = {};
    this.attributes = new Map();
    this.captured = new Set();
    this.width = 250;
    this.height = 250;
    this.context = {
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {},
    };
  }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 250, height: 250 }; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  matches() { return false; }
  focus() { this.dispatchEvent(new Event('focus')); }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}

function browserFixture(t) {
  const originalWindow = globalThis.window;
  const windowStub = new EventTarget();
  windowStub.devicePixelRatio = 2;
  globalThis.window = windowStub;
  const canvas = new CanvasStub();
  const changes = [];
  const editor = new PixelEditor(canvas, { onChange: state => changes.push(state) });
  t.after(() => {
    editor.destroy();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { canvas, editor, changes, windowStub };
}

function dispatch(target, type, properties = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, properties);
  target.dispatchEvent(event);
  return event;
}

test('pointer strokes interpolate, ignore other touches, and commit once when released outside', t => {
  const { canvas, editor, changes, windowStub } = browserFixture(t);
  const pointer = { pointerId: 10, isPrimary: true, button: 0, buttons: 1, pointerType: 'touch' };
  editor.setColor('#123456');
  const down = dispatch(canvas, 'pointerdown', { ...pointer, clientX: 5, clientY: 5 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(canvas.style.touchAction, 'none');
  assert.equal(canvas.width, 500);
  assert.equal(canvas.height, 500);
  assert.equal(canvas.hasPointerCapture(10), true);
  dispatch(canvas, 'pointerdown', { ...pointer, pointerId: 11, isPrimary: false, clientX: 5, clientY: 245 });
  dispatch(canvas, 'pointermove', { ...pointer, clientX: 245, clientY: 245 });
  assert.equal(editor.getGrid()[24][0], '#FFFFFF');
  assert.equal(editor.getGrid()[24][24], '#123456');
  assert.equal(changes.length, 0);
  dispatch(windowStub, 'pointerup', { ...pointer, clientX: 280, clientY: 280 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].filled, 25);
  assert.equal(canvas.hasPointerCapture(10), false);
  editor.undo();
  assert.deepEqual(editor.getGrid(), createEmptyGrid());
  editor.redo();
  assert.equal(editor.getGrid()[24][24], '#123456');
});

test('pointer release paints the final position and cancellation flushes each stroke', t => {
  const { canvas, editor, changes } = browserFixture(t);
  const pointer = { pointerId: 1, isPrimary: true, button: 0, buttons: 1, pointerType: 'touch' };
  dispatch(canvas, 'pointerdown', { ...pointer, clientX: 5, clientY: 5 });
  dispatch(canvas, 'pointerup', { ...pointer, clientX: 45, clientY: 5 });
  assert.equal(changes[0].filled, 5);
  dispatch(canvas, 'pointerdown', { ...pointer, clientX: 5, clientY: 15 });
  dispatch(canvas, 'pointercancel', pointer);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].filled, 6);
  editor.undo();
  assert.equal(editor.getGrid()[1][0], '#FFFFFF');
  assert.equal(editor.getGrid()[0][4], '#000000');
});

test('keyboard movement, painting, erasing, and undo update accessible canvas state', t => {
  const { canvas, editor, changes } = browserFixture(t);
  editor.setColor('#123456');
  dispatch(canvas, 'keydown', { key: 'ArrowRight' });
  dispatch(canvas, 'keydown', { key: 'ArrowDown' });
  const paint = dispatch(canvas, 'keydown', { key: ' ' });
  assert.equal(paint.defaultPrevented, true);
  assert.equal(editor.getGrid()[1][1], '#123456');
  assert.match(canvas.attributes.get('aria-label'), /Row 2, column 2: #123456/);
  assert.equal(changes.length, 1);
  editor.setEraser(true);
  dispatch(canvas, 'keydown', { key: 'Enter' });
  assert.equal(editor.getGrid()[1][1], '#FFFFFF');
  dispatch(canvas, 'keydown', { key: 'z', ctrlKey: true });
  assert.equal(editor.getGrid()[1][1], '#123456');
  dispatch(canvas, 'keydown', { key: 'z', ctrlKey: true, shiftKey: true });
  assert.equal(editor.getGrid()[1][1], '#FFFFFF');
});
