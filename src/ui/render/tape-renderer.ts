import type { TapeSource } from '../../core/run';
import { el } from '../dom';
import {
  computeScrollToIndex,
  computeWindowRange,
  createSpacerPair,
  createVirtualHostObserver,
  measureHostPadding,
  scrollNodeIntoView,
  ZERO_PADDING,
  type HostPadding,
  type SpacerPair,
} from './virtual-window';

/** Either a plain string array or a zero-copy numeric {@link TapeSource}. */
export type TapeInput = readonly string[] | TapeSource;

function readTapeSymbol(cells: TapeInput, index: number): string {
  return 'symbolAt' in cells ? cells.symbolAt(index) : (cells[index] ?? ' ');
}

function formatTapeCell(symbol: string): string {
  return symbol === ' ' ? '\u00a0' : symbol;
}

/** Switch from direct DOM rendering to windowed virtualization above this many tape cells. */
export const TAPE_VIRTUALIZE_THRESHOLD = 500;
/** Extra cells rendered on each side of the visible viewport to keep scrolling smooth. */
const VIRTUAL_OVERSCAN = 40;
/** Fallback cell slot width (px) when layout geometry is unavailable (hidden host / jsdom). */
const DEFAULT_CELL_WIDTH_PX = 14;
/** Fallback viewport width (px) when `host.clientWidth` is 0 (hidden host / jsdom). */
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
  private readonly observer = createVirtualHostObserver();

  private host: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private cells: HTMLSpanElement[] = [];
  private symbols: string[] = [];
  private currentIndex: number | null = null;

  private virtualized = false;
  private spacers: SpacerPair | null = null;
  private windowStart = 0;
  private windowEnd = 0;
  private currentSlot: number | null = null;
  private cellWidthPx = DEFAULT_CELL_WIDTH_PX;
  private padding: HostPadding = ZERO_PADDING;
  private geometryMeasured = false;
  private lastCells: TapeInput = [];
  private lastLength = 0;
  private lastScrollLeft = 0;

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
    const idx = this.virtualized ? this.currentSlot : this.currentIndex;
    return idx !== null ? (this.cells[idx] ?? null) : null;
  }

  mount(host: HTMLElement, cells: TapeInput, position: number | null, label: string): void {
    this.clear();
    const container = el('div', { class: 'tape-view', role: 'img', 'aria-label': label });
    this.host = host;
    this.container = container;
    this.update(cells, position, label, null);
    host.replaceChildren(container);
    if (this.virtualized) {
      this.measureGeometry();
      this.scrollToHead();
    }
  }

  update(
    cells: TapeInput,
    position: number | null,
    label: string,
    dirtyIndices: readonly number[] | null = null,
  ): void {
    const container = this.container;
    if (container === null) return;

    if (container.getAttribute('aria-label') !== label) container.setAttribute('aria-label', label);
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
      scrollNodeIntoView(this.currentCell);
      return;
    }

    const pos = this.currentIndex;
    if (pos === null) return;

    this.measureGeometry();
    const viewportW = host.clientWidth > 0 ? host.clientWidth : DEFAULT_VIEWPORT_WIDTH_PX;
    const viewLeft = host.clientWidth > 0 ? host.scrollLeft : this.lastScrollLeft;
    const nextScrollLeft = computeScrollToIndex(
      pos,
      this.cellWidthPx,
      viewLeft,
      viewportW,
      this.padding,
    );

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
    this.observer.detach();
    if (this.host !== null) this.host.replaceChildren();
    this.host = null;
    this.container = null;
    this.cells = [];
    this.symbols = [];
    this.currentIndex = null;
    this.virtualized = false;
    this.spacers = null;
    this.windowStart = 0;
    this.windowEnd = 0;
    this.currentSlot = null;
    this.cellWidthPx = DEFAULT_CELL_WIDTH_PX;
    this.padding = ZERO_PADDING;
    this.geometryMeasured = false;
    this.lastCells = [];
    this.lastLength = 0;
    this.lastScrollLeft = 0;
  }

  private updateDirect(
    cells: TapeInput,
    targetLength: number,
    position: number | null,
    dirtyIndices: readonly number[] | null,
  ): void {
    const container = this.container;
    if (container === null) return;

    while (this.cells.length > targetLength) {
      const removed = this.cells.pop();
      this.symbols.pop();
      removed?.remove();
    }
    if (this.currentIndex !== null && this.currentIndex >= this.cells.length) {
      this.currentIndex = null;
    }

    const existingCount = this.cells.length;
    if (dirtyIndices === null) {
      for (let i = 0; i < existingCount; i += 1) this.syncCell(i, readTapeSymbol(cells, i));
    } else {
      for (let k = 0; k < dirtyIndices.length; k += 1) {
        const i = dirtyIndices[k];
        if (i !== undefined && i >= 0 && i < existingCount) {
          this.syncCell(i, readTapeSymbol(cells, i));
        }
      }
    }

    const addedCount = targetLength - existingCount;
    if (addedCount === 1) {
      container.appendChild(this.createCell(readTapeSymbol(cells, existingCount)));
    } else if (addedCount > 1) {
      const fragment = document.createDocumentFragment();
      for (let i = existingCount; i < targetLength; i += 1) {
        fragment.appendChild(this.createCell(readTapeSymbol(cells, i)));
      }
      container.appendChild(fragment);
    }

    if (this.currentIndex !== position) {
      if (this.currentIndex !== null) this.setCellCurrent(this.currentIndex, false);
      this.currentIndex = position;
      if (position !== null) this.setCellCurrent(position, true);
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

    const leftSpacer = el('span', { class: 'tape-view__spacer', 'aria-hidden': 'true' });
    const rightSpacer = el('span', { class: 'tape-view__spacer', 'aria-hidden': 'true' });
    this.spacers = createSpacerPair(leftSpacer, rightSpacer, 'width');

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

    this.observer.attach(host, this.handleScroll, this.handleResize);
  }

  private exitVirtualMode(): void {
    this.observer.detach();
    this.virtualized = false;
    this.spacers = null;
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
    if (this.host !== null) this.host.scrollLeft = 0;
    this.lastScrollLeft = 0;
  }

  private updateVirtual(
    cells: TapeInput,
    targetLength: number,
    position: number | null,
    dirtyIndices: readonly number[] | null,
  ): void {
    const entering = !this.virtualized;
    if (entering) this.enterVirtualMode(position);

    this.currentIndex = position;

    if (entering || this.windowEnd > targetLength) {
      this.syncVirtualWindow(true, this.readScrollLeft());
      this.measureGeometry();
      return;
    }

    this.spacers?.sync(
      this.windowStart * this.cellWidthPx,
      Math.max(0, targetLength - this.windowEnd) * this.cellWidthPx,
    );

    const host = this.host;
    const viewportW =
      host !== null && host.clientWidth > 0 ? host.clientWidth : DEFAULT_VIEWPORT_WIDTH_PX;
    const visibleEnd = Math.ceil(
      (Math.max(0, this.readScrollLeft() - this.padding.start) + viewportW) / this.cellWidthPx,
    );
    const desiredEnd = Math.min(targetLength, visibleEnd + this.overscan);
    if (this.windowEnd < desiredEnd) {
      this.syncVirtualWindow(true, this.readScrollLeft());
      return;
    }

    if (dirtyIndices === null) {
      for (let j = 0; j < this.cells.length; j += 1) {
        this.syncCell(j, readTapeSymbol(cells, this.windowStart + j));
      }
    } else {
      const start = this.windowStart;
      const end = this.windowEnd;
      for (let k = 0; k < dirtyIndices.length; k += 1) {
        const i = dirtyIndices[k];
        if (i !== undefined && i >= start && i < end) {
          this.syncCell(i - start, readTapeSymbol(cells, i));
        }
      }
    }

    this.syncVirtualCurrentHighlight();
  }

  private readScrollLeft(): number {
    return this.host !== null && this.host.clientWidth > 0
      ? this.host.scrollLeft
      : this.lastScrollLeft;
  }

  private measureGeometry(): boolean {
    if (this.geometryMeasured || !this.virtualized || this.host === null) return false;
    const sample = this.cells[0];
    if (sample === undefined || typeof sample.getBoundingClientRect !== 'function') return false;
    const width = sample.getBoundingClientRect().width;
    if (width > 0) {
      this.geometryMeasured = true;
      this.padding = measureHostPadding(this.host, 'x');
      if (Math.abs(width - this.cellWidthPx) > 0.25) {
        this.cellWidthPx = width;
        this.syncVirtualWindow(true, this.readScrollLeft());
        return true;
      }
    }
    return false;
  }

  private syncVirtualWindow(force: boolean, scrollLeft: number): void {
    const spacers = this.spacers;
    if (!this.virtualized || spacers === null) return;

    const total = this.lastLength;
    const host = this.host;
    const viewportW =
      host !== null && host.clientWidth > 0 ? host.clientWidth : DEFAULT_VIEWPORT_WIDTH_PX;

    const range = computeWindowRange({
      scrollPos: scrollLeft,
      viewportSize: viewportW,
      itemSize: this.cellWidthPx,
      total,
      overscan: this.overscan,
      paddingStart: this.padding.start,
      curStart: this.windowStart,
      curEnd: this.windowEnd,
      renderedCount: this.cells.length,
      force,
    });
    if (range === null) return;

    const { start: nextStart, end: nextEnd } = range;
    const nextLen = nextEnd - nextStart;

    if (this.cells.length < nextLen) {
      const needed = nextLen - this.cells.length;
      if (needed === 1) {
        spacers.endEl.before(
          this.createCell(readTapeSymbol(this.lastCells, nextStart + this.cells.length)),
        );
      } else {
        const fragment = document.createDocumentFragment();
        for (let j = this.cells.length; j < nextLen; j += 1) {
          fragment.appendChild(this.createCell(readTapeSymbol(this.lastCells, nextStart + j)));
        }
        spacers.endEl.before(fragment);
      }
    } else if (this.cells.length > nextLen) {
      if (this.currentSlot !== null && this.currentSlot >= nextLen) this.clearCurrentSlot();
      while (this.cells.length > nextLen) {
        const removed = this.cells.pop();
        this.symbols.pop();
        removed?.remove();
      }
    }

    this.windowStart = nextStart;
    this.windowEnd = nextEnd;
    spacers.sync(nextStart * this.cellWidthPx, Math.max(0, total - nextEnd) * this.cellWidthPx);

    for (let j = 0; j < nextLen; j += 1) {
      this.syncCell(j, readTapeSymbol(this.lastCells, nextStart + j));
    }

    this.syncVirtualCurrentHighlight();
  }

  private setCellCurrent(index: number, active: boolean): void {
    const cell = this.cells[index];
    if (cell === undefined) return;
    if (active) {
      cell.classList.add('current');
      cell.setAttribute('aria-current', 'true');
    } else {
      cell.classList.remove('current');
      cell.removeAttribute('aria-current');
    }
  }

  private clearCurrentSlot(): void {
    if (this.currentSlot === null) return;
    this.setCellCurrent(this.currentSlot, false);
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
    if (nextSlot !== null) this.setCellCurrent(nextSlot, true);
  }

  private readonly handleScroll = (): void => {
    if (!this.virtualized || this.host === null) return;
    const scrollLeft = this.host.scrollLeft;
    this.lastScrollLeft = scrollLeft;
    this.syncVirtualWindow(false, scrollLeft);
  };

  private readonly handleResize = (): void => {
    if (!this.virtualized) return;
    this.geometryMeasured = false;
    if (!this.measureGeometry()) {
      this.syncVirtualWindow(true, this.readScrollLeft());
    }
  };

  private syncCell(index: number, next: string): void {
    if (this.symbols[index] === next) return;
    this.symbols[index] = next;
    const cell = this.cells[index];
    if (cell !== undefined) cell.textContent = formatTapeCell(next);
  }

  private createCell(sym: string): HTMLSpanElement {
    const cell = document.createElement('span');
    cell.className = 'cell';
    cell.textContent = formatTapeCell(sym);
    this.cells.push(cell);
    this.symbols.push(sym);
    return cell;
  }
}
