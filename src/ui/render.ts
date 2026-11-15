import { parseStateName, type Command } from '../core/machine';
import { parseProgram } from '../core/parser';
import { createProgram, type Program } from '../core/program';
import { el } from './dom';

/**
 * Rendering helpers for the two read-only "program" and "tape" panes.
 *
 * They return DOM fragments instead of HTML strings: symbols like `<`, `>`
 * and `&` are valid tape symbols, and building markup by concatenation (as
 * the original did) both needs manual escaping and invites XSS.
 */

/** Program text split into command spans: enough to draw a listing. */
export interface ProgramListing {
  readonly text: string;
  /** Commands in source order; the array index doubles as the DOM id. */
  readonly commands: readonly Command[];
  /** `[start, end)` ranges of command source texts inside `text`. */
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
}

/** A listing plus the validated program itself. */
export interface CompiledProgram extends ProgramListing {
  readonly program: Program;
}

/**
 * Parse + validate program text and remember command offsets so the running
 * program can be rendered with per-command anchors.
 *
 * @throws MachineError subclasses when the program does not compile
 */
export function compileProgram(text: string, initialState: number | string = 0): CompiledProgram {
  const listing = listProgram(text);
  const normalisedInitial =
    typeof initialState === 'string' ? parseStateName(initialState) : initialState;
  return { ...listing, program: createProgram(listing.commands, normalisedInitial) };
}

/**
 * Parse the text into command spans without validating the program. Used to
 * draw listings of programs that do not compile (error reports).
 */
export function listProgram(text: string): ProgramListing {
  const commands = parseProgram(text);
  // Offsets are recorded by the parser itself, so they are exact; no second
  // scan of the source text is needed.
  const ranges = commands.map((command) => ({
    start: command.source.offset,
    end: command.source.offset + command.source.text.length,
  }));
  return { text, commands, ranges };
}

/**
 * Render program text with command spans. Whitespace and comments stay as
 * plain text; every command gets `.cmd` so the runner can highlight the
 * current/visited/erroneous one in O(1) without re-rendering the whole pane.
 */
export function renderProgram(compiled: ProgramListing): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (const range of compiled.ranges) {
    if (range.start > cursor) fragment.append(compiled.text.slice(cursor, range.start));
    const span = el('span', { class: 'cmd' }, compiled.text.slice(range.start, range.end));
    fragment.append(span);
    cursor = range.end;
  }

  if (cursor < compiled.text.length) fragment.append(compiled.text.slice(cursor));
  return fragment;
}

/** Render plain program text with one character highlighted as erroneous. */
export function renderProgramWithError(text: string, offset: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(text.slice(0, offset));
  fragment.append(
    el('mark', { class: 'error' }, text.charAt(offset) || ' '),
    text.slice(offset + 1),
  );
  return fragment;
}

function formatTapeCell(symbol: string): string {
  return symbol === ' ' ? '\u00a0' : symbol;
}

/** Switch from direct DOM rendering to windowed virtualization above this many tape cells. */
export const TAPE_VIRTUALIZE_THRESHOLD = 500;
/** Extra cells rendered on each side of the visible viewport to keep scrolling smooth. */
const VIRTUAL_OVERSCAN = 40;
/** Fallback cell slot width (px) when layout geometry is unavailable (e.g. hidden host / jsdom). */
const DEFAULT_CELL_WIDTH_PX = 14;
/** Fallback viewport width (px) when `host.clientWidth` is 0 (e.g. hidden host / jsdom). */
const DEFAULT_VIEWPORT_WIDTH_PX = 800;

export interface TapeRendererOptions {
  readonly virtualizeThreshold?: number;
  readonly overscan?: number;
}

/**
 * Dual-mode incremental DOM renderer for the tape pane during execution.
 *
 * - Direct mode (`<= 500` cells): keeps one `<span>` per cell, mutates only
 *   dirty indices in `O(k)`, appends/trims tail cells, and moves `.current` in `O(1)`.
 * - Virtualized windowed mode (`> 500` cells): reuses a fixed pool of `<span>`
 *   cells covering the visible horizontal viewport plus overscan, flanked by
 *   left/right width spacers so huge tapes (10k–100k+ cells) stay at 60 FPS.
 */
export class TapeRenderer {
  private readonly threshold: number;
  private readonly overscan: number;

  private host: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private cells: HTMLSpanElement[] = [];
  private symbols: string[] = [];
  private currentIndex: number | null = null;

  private virtualized = false;
  private leftSpacer: HTMLSpanElement | null = null;
  private rightSpacer: HTMLSpanElement | null = null;
  private lastLeftWidth = '';
  private lastRightWidth = '';
  private windowStart = 0;
  private windowEnd = 0;
  private currentSlot: number | null = null;
  private cellWidthPx = DEFAULT_CELL_WIDTH_PX;
  private cellWidthMeasured = false;
  private lastCells: readonly string[] = [];
  private lastLength = 0;
  private lastScrollLeft = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: TapeRendererOptions = {}) {
    this.threshold = Math.max(1, options.virtualizeThreshold ?? TAPE_VIRTUALIZE_THRESHOLD);
    this.overscan = Math.max(1, options.overscan ?? VIRTUAL_OVERSCAN);
  }

  /** Whether the renderer is currently using windowed virtualization (`length > threshold`). */
  get isVirtualized(): boolean {
    return this.virtualized;
  }

  /** Logical `[start, end)` cell range currently materialized in the DOM. */
  get renderedRange(): readonly [number, number] {
    return this.virtualized ? [this.windowStart, this.windowEnd] : [0, this.cells.length];
  }

  get currentCell(): HTMLSpanElement | null {
    if (this.virtualized) {
      return this.currentSlot !== null ? (this.cells[this.currentSlot] ?? null) : null;
    }
    return this.currentIndex !== null ? (this.cells[this.currentIndex] ?? null) : null;
  }

  mount(host: HTMLElement, cells: readonly string[], position: number | null, label: string): void {
    this.clear();
    const container = el('div', { class: 'tape-view', role: 'img', 'aria-label': label });
    this.host = host;
    this.container = container;
    this.update(cells, position, label, null);
    host.replaceChildren(container);
    if (this.virtualized) {
      this.measureCellWidth();
      this.scrollToHead();
    }
  }

  update(
    cells: readonly string[],
    position: number | null,
    label: string,
    dirtyIndices: readonly number[] | null = null,
  ): void {
    const container = this.container;
    if (container === null) return;

    if (container.getAttribute('aria-label') !== label) {
      container.setAttribute('aria-label', label);
    }
    if (this.host !== null && this.host.getAttribute('aria-label') !== label) {
      this.host.setAttribute('aria-label', label);
    }

    const targetLength = position !== null ? Math.max(cells.length, position + 1) : cells.length;
    this.lastCells = cells;
    this.lastLength = targetLength;

    if (targetLength > this.threshold) {
      this.updateVirtual(cells, targetLength, position, dirtyIndices);
      return;
    }

    if (this.virtualized) {
      this.exitVirtualMode();
      // Full rebuild into direct mode (`<= threshold` cells).
      this.updateDirect(cells, targetLength, position, null);
      return;
    }

    this.updateDirect(cells, targetLength, position, dirtyIndices);
  }

  /** Scroll the tape pane so the active head cell is visible (handles both direct and virtual modes). */
  scrollToHead(): void {
    const host = this.host;
    if (host === null) return;

    if (!this.virtualized) {
      const cell = this.currentCell;
      if (cell !== null && typeof cell.scrollIntoView === 'function') {
        cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }

    const pos = this.currentIndex;
    if (pos === null) return;

    this.measureCellWidth();
    const viewportW = host.clientWidth > 0 ? host.clientWidth : DEFAULT_VIEWPORT_WIDTH_PX;
    const cellLeft = pos * this.cellWidthPx;
    const cellRight = cellLeft + this.cellWidthPx;
    const viewLeft = host.clientWidth > 0 ? host.scrollLeft : this.lastScrollLeft;
    const viewRight = viewLeft + viewportW;

    let nextScrollLeft = viewLeft;
    if (cellLeft < viewLeft) {
      nextScrollLeft = cellLeft;
    } else if (cellRight > viewRight) {
      nextScrollLeft = Math.max(0, cellRight - viewportW);
    }

    if (nextScrollLeft !== viewLeft) {
      this.lastScrollLeft = nextScrollLeft;
      host.scrollLeft = nextScrollLeft;
    } else {
      this.lastScrollLeft = viewLeft;
    }

    const headOutsideWindow = pos < this.windowStart || pos >= this.windowEnd;
    if (headOutsideWindow || nextScrollLeft !== viewLeft) {
      this.syncVirtualWindow(headOutsideWindow, nextScrollLeft);
    }
  }

  clear(): void {
    this.detachVirtualObservers();
    this.host = null;
    this.container = null;
    this.cells = [];
    this.symbols = [];
    this.currentIndex = null;
    this.virtualized = false;
    this.leftSpacer = null;
    this.rightSpacer = null;
    this.lastLeftWidth = '';
    this.lastRightWidth = '';
    this.windowStart = 0;
    this.windowEnd = 0;
    this.currentSlot = null;
    this.cellWidthPx = DEFAULT_CELL_WIDTH_PX;
    this.cellWidthMeasured = false;
    this.lastCells = [];
    this.lastLength = 0;
    this.lastScrollLeft = 0;
  }

  private updateDirect(
    cells: readonly string[],
    targetLength: number,
    position: number | null,
    dirtyIndices: readonly number[] | null,
  ): void {
    const container = this.container;
    if (container === null) return;

    // Trim trailing cells if the tape shrank (e.g. after `stepBack` or `reset`).
    while (this.cells.length > targetLength) {
      const removed = this.cells.pop();
      this.symbols.pop();
      removed?.remove();
    }
    if (this.currentIndex !== null && this.currentIndex >= this.cells.length) {
      this.currentIndex = null;
    }

    // Update existing cells: O(k) via dirty indices, or O(N) full diff after reset / overflow.
    const existingCount = this.cells.length;
    if (dirtyIndices === null) {
      for (let i = 0; i < existingCount; i += 1) {
        this.syncCell(i, cells[i] ?? ' ');
      }
    } else {
      for (let k = 0; k < dirtyIndices.length; k += 1) {
        const i = dirtyIndices[k];
        if (i !== undefined && i >= 0 && i < existingCount) {
          this.syncCell(i, cells[i] ?? ' ');
        }
      }
    }

    // Append newly visited cells on the right.
    const addedCount = targetLength - existingCount;
    if (addedCount === 1) {
      container.append(this.createCell(cells[existingCount] ?? ' '));
    } else if (addedCount > 1) {
      const fragment = document.createDocumentFragment();
      for (let i = existingCount; i < targetLength; i += 1) {
        fragment.append(this.createCell(cells[i] ?? ' '));
      }
      container.append(fragment);
    }

    // Move `.current` highlight in O(1).
    if (this.currentIndex !== position) {
      if (this.currentIndex !== null) {
        const prevCell = this.cells[this.currentIndex];
        if (prevCell !== undefined) {
          prevCell.classList.remove('current');
          prevCell.removeAttribute('aria-current');
        }
      }
      this.currentIndex = position;
      if (position !== null) {
        const nextCell = this.cells[position];
        if (nextCell !== undefined) {
          nextCell.classList.add('current');
          nextCell.setAttribute('aria-current', 'true');
        }
      }
    }
  }

  private enterVirtualMode(anchorPosition: number | null): void {
    const container = this.container;
    const host = this.host;
    if (container === null || host === null) return;

    this.virtualized = true;
    this.cells = [];
    this.symbols = [];
    this.currentSlot = null;
    this.windowStart = 0;
    this.windowEnd = 0;
    this.lastLeftWidth = '';
    this.lastRightWidth = '';

    const leftSpacer = el('span', { class: 'tape-view__spacer', 'aria-hidden': 'true' });
    const rightSpacer = el('span', { class: 'tape-view__spacer', 'aria-hidden': 'true' });
    this.leftSpacer = leftSpacer;
    this.rightSpacer = rightSpacer;

    container.classList.add('tape-view--virtual');
    container.replaceChildren(leftSpacer, rightSpacer);

    const viewportW = host.clientWidth > 0 ? host.clientWidth : DEFAULT_VIEWPORT_WIDTH_PX;
    if (host.clientWidth > 0) {
      this.lastScrollLeft = host.scrollLeft;
    } else if (anchorPosition !== null) {
      this.lastScrollLeft = Math.max(0, (anchorPosition + 1) * this.cellWidthPx - viewportW);
    } else {
      this.lastScrollLeft = 0;
    }

    host.addEventListener('scroll', this.handleScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(host);
    }
  }

  private exitVirtualMode(): void {
    this.detachVirtualObservers();
    this.virtualized = false;
    this.leftSpacer = null;
    this.rightSpacer = null;
    this.lastLeftWidth = '';
    this.lastRightWidth = '';
    this.windowStart = 0;
    this.windowEnd = 0;
    this.currentSlot = null;
    this.currentIndex = null;
    this.cells = [];
    this.symbols = [];
    if (this.container !== null) {
      this.container.classList.remove('tape-view--virtual');
      this.container.replaceChildren();
    }
    if (this.host !== null) {
      this.host.scrollLeft = 0;
    }
    this.lastScrollLeft = 0;
  }

  private detachVirtualObservers(): void {
    if (this.host !== null) {
      this.host.removeEventListener('scroll', this.handleScroll);
    }
    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  private updateVirtual(
    cells: readonly string[],
    targetLength: number,
    position: number | null,
    dirtyIndices: readonly number[] | null,
  ): void {
    const entering = !this.virtualized;
    if (entering) this.enterVirtualMode(position);

    this.currentIndex = position;

    if (entering || this.windowEnd > targetLength) {
      this.syncVirtualWindow(true, this.readScrollLeft());
      this.measureCellWidth();
      return;
    }

    // Keep total scrollable width exact as the tape grows/shrinks.
    this.updateSpacers(this.windowStart, this.windowEnd, targetLength);

    // If the right edge of the window has room inside the newly grown tape, expand it.
    const host = this.host;
    const viewportW =
      host !== null && host.clientWidth > 0 ? host.clientWidth : DEFAULT_VIEWPORT_WIDTH_PX;
    const visibleEnd = Math.ceil((this.readScrollLeft() + viewportW) / this.cellWidthPx);
    const desiredEnd = Math.min(targetLength, visibleEnd + this.overscan);
    if (this.windowEnd < desiredEnd) {
      this.syncVirtualWindow(true, this.readScrollLeft());
      return;
    }

    // Fast path: window bounds unchanged — update only dirty slots in O(k).
    if (dirtyIndices === null) {
      for (let j = 0; j < this.cells.length; j += 1) {
        this.syncCell(j, cells[this.windowStart + j] ?? ' ');
      }
    } else {
      const start = this.windowStart;
      const end = this.windowEnd;
      for (let k = 0; k < dirtyIndices.length; k += 1) {
        const i = dirtyIndices[k];
        if (i !== undefined && i >= start && i < end) {
          this.syncCell(i - start, cells[i] ?? ' ');
        }
      }
    }

    this.syncVirtualCurrentHighlight();
  }

  private readScrollLeft(): number {
    if (this.host !== null && this.host.clientWidth > 0) {
      return this.host.scrollLeft;
    }
    return this.lastScrollLeft;
  }

  private measureCellWidth(): void {
    if (this.cellWidthMeasured || !this.virtualized) return;
    const sample = this.cells[0];
    if (sample === undefined || typeof sample.getBoundingClientRect !== 'function') return;
    const width = sample.getBoundingClientRect().width;
    if (width > 0) {
      this.cellWidthMeasured = true;
      if (Math.abs(width - this.cellWidthPx) > 0.25) {
        this.cellWidthPx = width;
        this.syncVirtualWindow(true, this.readScrollLeft());
      }
    }
  }

  private syncVirtualWindow(force: boolean, scrollLeft: number): void {
    const rightSpacer = this.rightSpacer;
    if (!this.virtualized || rightSpacer === null) return;

    const total = this.lastLength;
    const host = this.host;
    const viewportW =
      host !== null && host.clientWidth > 0 ? host.clientWidth : DEFAULT_VIEWPORT_WIDTH_PX;
    const visibleStart = Math.max(0, Math.floor(scrollLeft / this.cellWidthPx));
    const visibleCount = Math.max(1, Math.ceil(viewportW / this.cellWidthPx));
    const visibleEnd = Math.min(total, visibleStart + visibleCount);

    // Skip work while the visible range is still comfortably inside the overscan buffer
    // and the pooled DOM window has not grown beyond its target size.
    const maxWindowLen = visibleCount + this.overscan * 2;
    if (
      !force &&
      this.cells.length > 0 &&
      this.windowEnd <= total &&
      this.cells.length <= maxWindowLen
    ) {
      const margin = Math.floor(this.overscan / 2);
      const safeLeft = Math.max(0, visibleStart - margin);
      const safeRight = Math.min(total, visibleEnd + margin);
      if (this.windowStart <= safeLeft && this.windowEnd >= safeRight) {
        return;
      }
    }

    const nextStart = Math.max(0, Math.min(total, visibleStart - this.overscan));
    const nextEnd = Math.min(total, Math.max(nextStart, visibleEnd + this.overscan));
    const nextLen = nextEnd - nextStart;

    // Resize the pooled cell spans without recreating existing nodes.
    if (this.cells.length < nextLen) {
      const needed = nextLen - this.cells.length;
      if (needed === 1) {
        rightSpacer.before(this.createCell(this.lastCells[nextStart + this.cells.length] ?? ' '));
      } else {
        const fragment = document.createDocumentFragment();
        for (let j = this.cells.length; j < nextLen; j += 1) {
          fragment.append(this.createCell(this.lastCells[nextStart + j] ?? ' '));
        }
        rightSpacer.before(fragment);
      }
    } else if (this.cells.length > nextLen) {
      if (this.currentSlot !== null && this.currentSlot >= nextLen) {
        this.clearCurrentSlot();
      }
      while (this.cells.length > nextLen) {
        const removed = this.cells.pop();
        this.symbols.pop();
        removed?.remove();
      }
    }

    this.windowStart = nextStart;
    this.windowEnd = nextEnd;
    this.updateSpacers(nextStart, nextEnd, total);

    for (let j = 0; j < nextLen; j += 1) {
      this.syncCell(j, this.lastCells[nextStart + j] ?? ' ');
    }

    this.syncVirtualCurrentHighlight();
  }

  private updateSpacers(start: number, end: number, total: number): void {
    const leftW = `${start * this.cellWidthPx}px`;
    const rightW = `${Math.max(0, total - end) * this.cellWidthPx}px`;
    if (this.leftSpacer !== null && this.lastLeftWidth !== leftW) {
      this.leftSpacer.style.width = leftW;
      this.lastLeftWidth = leftW;
    }
    if (this.rightSpacer !== null && this.lastRightWidth !== rightW) {
      this.rightSpacer.style.width = rightW;
      this.lastRightWidth = rightW;
    }
  }

  private clearCurrentSlot(): void {
    if (this.currentSlot === null) return;
    const prevCell = this.cells[this.currentSlot];
    if (prevCell !== undefined) {
      prevCell.classList.remove('current');
      prevCell.removeAttribute('aria-current');
    }
    this.currentSlot = null;
  }

  private syncVirtualCurrentHighlight(): void {
    const pos = this.currentIndex;
    const nextSlot =
      pos !== null && pos >= this.windowStart && pos < this.windowEnd
        ? pos - this.windowStart
        : null;
    if (this.currentSlot === nextSlot) return;
    this.clearCurrentSlot();
    this.currentSlot = nextSlot;
    if (nextSlot !== null) {
      const nextCell = this.cells[nextSlot];
      if (nextCell !== undefined) {
        nextCell.classList.add('current');
        nextCell.setAttribute('aria-current', 'true');
      }
    }
  }

  private readonly handleScroll = (): void => {
    if (!this.virtualized || this.host === null) return;
    const scrollLeft = this.host.scrollLeft;
    this.lastScrollLeft = scrollLeft;
    this.syncVirtualWindow(false, scrollLeft);
  };

  private readonly handleResize = (): void => {
    if (!this.virtualized) return;
    this.cellWidthMeasured = false;
    this.measureCellWidth();
    this.syncVirtualWindow(true, this.readScrollLeft());
  };

  private syncCell(index: number, next: string): void {
    if (this.symbols[index] === next) return;
    this.symbols[index] = next;
    const cell = this.cells[index];
    if (cell !== undefined) cell.textContent = formatTapeCell(next);
  }

  private createCell(sym: string): HTMLSpanElement {
    const cell = el('span', { class: 'cell' }, formatTapeCell(sym));
    this.cells.push(cell);
    this.symbols.push(sym);
    return cell;
  }
}
