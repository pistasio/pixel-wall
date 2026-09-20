export const GRID_SIZE = 25;
export const BLANK_COLOR = '#FFFFFF';
const HISTORY_LIMIT = 80;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const PALETTE = Object.freeze([
  { name: 'Black', hex: '#000000' },
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Red', hex: '#F25B67' },
  { name: 'Orange', hex: '#F99A55' },
  { name: 'Yellow', hex: '#F6D96B' },
  { name: 'Green', hex: '#63B887' },
  { name: 'Cyan', hex: '#60CED7' },
  { name: 'Blue', hex: '#6086DB' },
  { name: 'Purple', hex: '#9A7BCE' },
  { name: 'Pink', hex: '#EA92BE' },
  { name: 'Lavender', hex: '#D9CEF0' },
  { name: 'Mint', hex: '#C5E7D9' },
  { name: 'Peach', hex: '#F7C9AD' },
  { name: 'Sky', hex: '#C1DDF2' },
  { name: 'Sand', hex: '#E9DEC8' },
  { name: 'Teal', hex: '#3D9292' },
].map(Object.freeze));

export function createEmptyGrid() {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(BLANK_COLOR));
}

export function validateDraftGrid(grid) {
  return Array.isArray(grid) && grid.length === GRID_SIZE &&
    Array.from(grid).every(row => Array.isArray(row) && row.length === GRID_SIZE &&
      Array.from(row).every(color => typeof color === 'string' && HEX_COLOR.test(color)));
}

function copyGrid(grid) {
  return grid.map(row => row.slice());
}

function normalizeColor(color) {
  if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
    throw new TypeError('Colors must use six-digit hex notation.');
  }
  return color.toUpperCase();
}

function isCell(cell) {
  return cell && Number.isInteger(cell.row) && Number.isInteger(cell.col) &&
    cell.row >= 0 && cell.row < GRID_SIZE && cell.col >= 0 && cell.col < GRID_SIZE;
}

// Bresenham interpolation fills cells skipped by fast pointer movement.
export function rasterLine(start, end) {
  if (!isCell(start) || !isCell(end)) return [];
  let col = start.col;
  let row = start.row;
  const dx = Math.abs(end.col - col);
  const dy = -Math.abs(end.row - row);
  const sx = col < end.col ? 1 : -1;
  const sy = row < end.row ? 1 : -1;
  let error = dx + dy;
  const cells = [];
  while (true) {
    cells.push({ row, col });
    if (col === end.col && row === end.row) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      col += sx;
    }
    if (twice <= dx) {
      error += dx;
      row += sy;
    }
  }
  return cells;
}

/** Grid and bounded stroke history, independent of the browser. */
export class PixelDocument {
  constructor(grid = createEmptyGrid()) {
    this.load(grid);
  }

  load(grid) {
    if (!validateDraftGrid(grid)) throw new TypeError('Artwork must contain a 25 × 25 color grid.');
    this.grid = grid.map(row => row.map(color => color.toUpperCase()));
    this.past = [];
    this.future = [];
    this.beforeStroke = null;
  }

  beginStroke() {
    if (!this.beforeStroke) this.beforeStroke = copyGrid(this.grid);
  }

  paint(cell, color) {
    if (!isCell(cell)) return false;
    color = normalizeColor(color);
    if (this.grid[cell.row][cell.col] === color) return false;
    this.beginStroke();
    this.grid[cell.row][cell.col] = color;
    return true;
  }

  endStroke() {
    if (!this.beforeStroke) return false;
    const before = this.beforeStroke;
    this.beforeStroke = null;
    const changed = before.some((row, r) => row.some((color, c) => color !== this.grid[r][c]));
    if (!changed) return false;
    this.past.push(before);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    return true;
  }

  undo() {
    this.endStroke();
    if (!this.past.length) return false;
    this.future.push(this.grid);
    this.grid = this.past.pop();
    return true;
  }

  redo() {
    this.endStroke();
    if (!this.future.length) return false;
    this.past.push(this.grid);
    this.grid = this.future.pop();
    return true;
  }

  clear() {
    this.endStroke();
    this.beginStroke();
    this.grid = createEmptyGrid();
    return this.endStroke();
  }

  getGrid() {
    return copyGrid(this.grid);
  }

  getState() {
    return {
      grid: this.getGrid(),
      filled: this.grid.reduce((count, row) => count + row.filter(color => color !== BLANK_COLOR).length, 0),
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    };
  }
}

export class PixelEditor {
  constructor(canvasElement, { onChange = () => {} } = {}) {
    this.canvas = canvasElement;
    this.context = this.canvas.getContext('2d', { alpha: false });
    if (!this.context) throw new Error('Your browser does not support the pixel canvas.');
    this.document = new PixelDocument();
    this.onChange = onChange;
    this.color = PALETTE[0].hex;
    this.erasing = false;
    this.pointerId = null;
    this.lastCell = null;
    this.focusCell = { row: 0, col: 0 };
    this.keyboardFocus = false;
    this.disposed = false;
    this.listeners = [];
    this.canvas.style.touchAction = 'none';
    this.canvas.style.userSelect = 'none';
    this.canvas.style.webkitUserSelect = 'none';
    if (!this.canvas.hasAttribute('tabindex')) this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.updateLabel();
    this.listen(this.canvas, 'pointerdown', event => this.pointerDown(event));
    this.listen(this.canvas, 'pointermove', event => this.pointerMove(event));
    this.listen(this.canvas, 'pointerup', event => this.pointerEnd(event));
    this.listen(this.canvas, 'pointercancel', event => this.pointerEnd(event));
    this.listen(this.canvas, 'lostpointercapture', event => this.pointerEnd(event));
    this.listen(window, 'pointerup', event => this.pointerEnd(event));
    this.listen(window, 'pointercancel', event => this.pointerEnd(event));
    this.listen(window, 'blur', () => this.finishStroke());
    this.listen(this.canvas, 'contextmenu', event => event.preventDefault());
    this.listen(this.canvas, 'keydown', event => this.keyDown(event));
    this.listen(this.canvas, 'focus', () => {
      this.keyboardFocus = this.canvas.matches(':focus-visible');
      this.draw();
    });
    this.listen(this.canvas, 'blur', () => {
      this.keyboardFocus = false;
      this.finishStroke();
      this.draw();
    });
    this.listen(window, 'resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.resize();
  }

  listen(target, type, handler) {
    target.addEventListener(type, handler, { passive: false });
    this.listeners.push(() => target.removeEventListener(type, handler));
  }

  resize() {
    if (this.disposed) return;
    const width = this.canvas.getBoundingClientRect().width;
    if (!width) return;
    const size = Math.max(GRID_SIZE, Math.round(width * (window.devicePixelRatio || 1)));
    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    this.draw();
  }

  cellAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const col = Math.floor((event.clientX - rect.left) / rect.width * GRID_SIZE);
    const row = Math.floor((event.clientY - rect.top) / rect.height * GRID_SIZE);
    return isCell({ row, col }) ? { row, col } : null;
  }

  pointerDown(event) {
    if (event.cancelable) event.preventDefault();
    if (event.isPrimary === false || this.pointerId !== null || event.button !== 0) return;
    const cell = this.cellAt(event);
    if (!cell) return;
    this.pointerId = event.pointerId;
    this.keyboardFocus = false;
    this.canvas.focus({ preventScroll: true });
    this.keyboardFocus = false;
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Window listeners finish uncaptured pointers. */ }
    this.document.beginStroke();
    this.paintTo(cell);
  }

  pointerMove(event) {
    if (event.pointerId !== this.pointerId) return;
    if (event.cancelable) event.preventDefault();
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      this.finishStroke();
      return;
    }
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const sample of samples) this.paintTo(this.cellAt(sample), false);
    this.paintTo(this.cellAt(event), false);
    this.draw();
  }

  paintTo(cell, redraw = true) {
    if (!cell) {
      this.lastCell = null;
      return;
    }
    const color = this.erasing ? BLANK_COLOR : this.color;
    for (const point of rasterLine(this.lastCell || cell, cell)) this.document.paint(point, color);
    this.lastCell = cell;
    this.focusCell = cell;
    if (redraw) this.draw();
  }

  pointerEnd(event) {
    if (event.pointerId !== this.pointerId) return;
    if (event.type === 'pointerup') this.paintTo(this.cellAt(event));
    this.finishStroke();
  }

  finishStroke() {
    const pointerId = this.pointerId;
    this.pointerId = null;
    this.lastCell = null;
    if (pointerId !== null) {
      try {
        if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
      } catch { /* A cancelled pointer may already have released capture. */ }
    }
    const changed = this.document.endStroke();
    this.updateLabel();
    if (changed) this.emitChange();
    return changed;
  }

  setColor(hex) {
    const color = normalizeColor(hex);
    this.finishStroke();
    this.color = color;
    this.erasing = false;
    this.updateLabel();
  }

  setEraser(enabled) {
    this.finishStroke();
    this.erasing = Boolean(enabled);
    this.updateLabel();
  }

  undo() {
    this.finishStroke();
    if (!this.document.undo()) return false;
    this.draw();
    this.updateLabel();
    this.emitChange();
    return true;
  }

  redo() {
    this.finishStroke();
    if (!this.document.redo()) return false;
    this.draw();
    this.updateLabel();
    this.emitChange();
    return true;
  }

  clear() {
    this.finishStroke();
    if (!this.document.clear()) return false;
    this.draw();
    this.updateLabel();
    this.emitChange();
    return true;
  }

  getGrid() {
    return this.document.getGrid();
  }

  loadGrid(grid) {
    if (!validateDraftGrid(grid)) throw new TypeError('Artwork must contain a 25 × 25 color grid.');
    this.finishStroke();
    this.document.load(grid);
    this.draw();
    this.updateLabel();
    this.emitChange();
  }

  emitChange() {
    this.onChange(this.document.getState());
  }

  keyDown(event) {
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (event.key.toLowerCase() === 'y' || event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    const directions = {
      ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0],
    };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      this.finishStroke();
      this.keyboardFocus = true;
      this.focusCell = {
        row: Math.max(0, Math.min(GRID_SIZE - 1, this.focusCell.row + direction[0])),
        col: Math.max(0, Math.min(GRID_SIZE - 1, this.focusCell.col + direction[1])),
      };
      this.updateLabel();
      this.draw();
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.finishStroke();
      this.keyboardFocus = true;
      this.document.paint(this.focusCell, this.erasing ? BLANK_COLOR : this.color);
      const changed = this.document.endStroke();
      this.updateLabel();
      this.draw();
      if (changed) this.emitChange();
    }
  }

  updateLabel() {
    const { row, col } = this.focusCell;
    const selected = this.erasing ? 'eraser' :
      (PALETTE.find(color => color.hex === this.color)?.name || this.color);
    const color = this.document.grid[row][col];
    const current = PALETTE.find(entry => entry.hex === color)?.name || color;
    this.canvas.setAttribute('aria-label',
      `Pixel art canvas, 25 by 25. Row ${row + 1}, column ${col + 1}: ${current}. ` +
      `${selected} selected. Use arrow keys to move and Space or Enter to paint.`);
  }

  draw() {
    if (this.disposed) return;
    const ctx = this.context;
    const size = this.canvas.width;
    const edge = index => Math.round(index * size / GRID_SIZE);
    ctx.imageSmoothingEnabled = false;
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        ctx.fillStyle = this.document.grid[row][col];
        ctx.fillRect(edge(col), edge(row), edge(col + 1) - edge(col), edge(row + 1) - edge(row));
      }
    }
    ctx.beginPath();
    ctx.strokeStyle = '#E9E9EF';
    ctx.lineWidth = 1;
    for (let index = 1; index < GRID_SIZE; index++) {
      const line = edge(index) + 0.5;
      ctx.moveTo(line, 0);
      ctx.lineTo(line, size);
      ctx.moveTo(0, line);
      ctx.lineTo(size, line);
    }
    ctx.stroke();
    if (this.keyboardFocus) {
      const { row, col } = this.focusCell;
      const dpr = window.devicePixelRatio || 1;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(3, 3 * dpr);
      ctx.strokeRect(edge(col) + 2 * dpr, edge(row) + 2 * dpr,
        edge(col + 1) - edge(col) - 4 * dpr, edge(row + 1) - edge(row) - 4 * dpr);
      ctx.strokeStyle = '#514A69';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeRect(edge(col) + 2 * dpr, edge(row) + 2 * dpr,
        edge(col + 1) - edge(col) - 4 * dpr, edge(row + 1) - edge(row) - 4 * dpr);
    }
  }

  destroy() {
    this.finishStroke();
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.listeners.forEach(remove => remove());
    this.listeners = [];
  }
}
