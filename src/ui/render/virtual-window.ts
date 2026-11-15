/** Shared window math, padding-aware scroll targeting, and observer lifecycle
 *  for both `TapeRenderer` (horizontal) and `ProgramRenderer` (vertical). */

export function scrollNodeIntoView(node: HTMLElement | null): void {
  if (node !== null && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export interface HostPadding {
  readonly start: number;
  readonly end: number;
}

export const ZERO_PADDING: HostPadding = { start: 0, end: 0 };

/** Measure CSS padding along an axis (`x` = left/right, `y` = top/bottom). */
export function measureHostPadding(host: HTMLElement, axis: 'x' | 'y'): HostPadding {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return ZERO_PADDING;
  }
  const style = window.getComputedStyle(host);
  const start = Number.parseFloat(axis === 'x' ? style.paddingLeft : style.paddingTop);
  const end = Number.parseFloat(axis === 'x' ? style.paddingRight : style.paddingBottom);
  return {
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
  };
}

export interface WindowRangeInput {
  readonly scrollPos: number;
  readonly viewportSize: number;
  readonly itemSize: number;
  readonly total: number;
  readonly overscan: number;
  readonly paddingStart: number;
  readonly curStart: number;
  readonly curEnd: number;
  readonly renderedCount: number;
  readonly force: boolean;
}

/**
 * Compute the next `[start, end)` virtual window, or `null` when the current
 * window already covers the viewport plus half-overscan hysteresis buffer.
 */
export function computeWindowRange(
  input: WindowRangeInput,
): { readonly start: number; readonly end: number } | null {
  const {
    scrollPos,
    viewportSize,
    itemSize,
    total,
    overscan,
    paddingStart,
    curStart,
    curEnd,
    renderedCount,
    force,
  } = input;

  const contentScroll = Math.max(0, scrollPos - paddingStart);
  const visibleStart = Math.max(0, Math.floor(contentScroll / itemSize));
  const visibleCount = Math.max(1, Math.ceil(viewportSize / itemSize));
  const visibleEnd = Math.min(total, visibleStart + visibleCount);

  const maxWindowLen = visibleCount + overscan * 2;
  if (!force && renderedCount > 0 && curEnd <= total && renderedCount <= maxWindowLen) {
    const margin = Math.floor(overscan / 2);
    const safeStart = Math.max(0, visibleStart - margin);
    const safeEnd = Math.min(total, visibleEnd + margin);
    if (curStart <= safeStart && curEnd >= safeEnd) {
      return null;
    }
  }

  const start = Math.max(0, Math.min(total, visibleStart - overscan));
  const end = Math.min(total, Math.max(start, visibleEnd + overscan));
  return { start, end };
}

/**
 * Compute the nearest scroll offset that keeps `index` fully inside the visible
 * viewport (accounting for host start/end padding so boundary items never clip).
 */
export function computeScrollToIndex(
  index: number,
  itemSize: number,
  viewStart: number,
  viewportSize: number,
  padding: HostPadding,
): number {
  const itemStart = padding.start + index * itemSize;
  const itemEnd = itemStart + itemSize;
  const viewEnd = viewStart + viewportSize;

  if (itemStart < viewStart + padding.start) {
    return Math.max(0, itemStart - padding.start);
  }
  if (itemEnd + padding.end > viewEnd) {
    return Math.max(0, itemEnd + padding.end - viewportSize);
  }
  return viewStart;
}

/**
 * Manages passive `scroll` and `ResizeObserver` subscriptions on a virtualized
 * scroll host, guaranteeing clean detachment on mode exit or `clear()`.
 */
export class VirtualHostObserver {
  private host: HTMLElement | null = null;
  private scrollFn: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  attach(host: HTMLElement, onScroll: () => void, onResize: () => void): void {
    this.detach();
    this.host = host;
    this.scrollFn = onScroll;
    host.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(onResize);
      this.resizeObserver.observe(host);
    }
  }

  detach(): void {
    if (this.host !== null && this.scrollFn !== null) {
      this.host.removeEventListener('scroll', this.scrollFn);
    }
    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.host = null;
    this.scrollFn = null;
  }
}

/** Pair of leading/trailing spacers with string-cached inline sizes to skip redundant writes. */
export class SpacerPair {
  private lastStart = '';
  private lastEnd = '';

  constructor(
    readonly startEl: HTMLElement,
    readonly endEl: HTMLElement,
    private readonly prop: 'width' | 'height',
  ) {}

  sync(startPx: number, endPx: number): void {
    const startVal = `${startPx}px`;
    const endVal = `${endPx}px`;
    if (this.lastStart !== startVal) {
      this.startEl.style[this.prop] = startVal;
      this.lastStart = startVal;
    }
    if (this.lastEnd !== endVal) {
      this.endEl.style[this.prop] = endVal;
      this.lastEnd = endVal;
    }
  }
}
