import { el } from '../dom';
import { buildProgramFragment, renderProgramWithError, type ProgramListing } from './listing';
import {
  appendParseErrorSlice,
  countTextLines,
  exceedsLineThreshold,
  indexProgramLines,
  type ProgramLine,
} from './program-lines';
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

/** Switch program view to line-windowed virtualization above this many lines. */
export const PROGRAM_VIRTUALIZE_LINE_THRESHOLD = 400;
/** Switch program view to line-windowed virtualization above this many commands. */
export const PROGRAM_VIRTUALIZE_COMMAND_THRESHOLD = 800;
/** Extra lines rendered above and below the visible viewport for smooth vertical scrolling. */
const PROGRAM_VIRTUAL_OVERSCAN = 30;
/** Fallback monospace line height (px) when layout geometry is unavailable (hidden host / jsdom). */
const DEFAULT_LINE_HEIGHT_PX = 24;
/** Fallback program viewport height (px) when `host.clientHeight` is 0. */
const DEFAULT_PROGRAM_VIEWPORT_HEIGHT_PX = 480;

export interface ProgramRendererOptions {
  readonly lineThreshold?: number;
  readonly commandThreshold?: number;
  readonly overscan?: number;
}

/**
 * Dual-mode renderer for the read-only `#display-program` pane.
 *
 * - Direct mode (`<= 400` lines and `<= 800` commands): builds the exact flat
 *   text + `.cmd` DOM tree once and toggles `.current` / `.visited` / `.error`
 *   in `O(1)` by command index.
 * - Virtualized line-windowed mode (`> 400` lines or `> 800` commands): indexes
 *   lines once in `O(N)` and materializes only the visible vertical viewport
 *   plus overscan flanked by height spacers so huge programs (5k–50k+ commands)
 *   start instantly and scroll/step smoothly at 60 FPS.
 */
export class ProgramRenderer {
  private readonly lineThreshold: number;
  private readonly commandThreshold: number;
  private readonly overscan: number;
  private readonly observer = createVirtualHostObserver();

  private host: HTMLElement | null = null;
  private virtualized = false;
  private directNodes: HTMLSpanElement[] = [];

  private currentIndex: number | null = null;
  private readonly visitedIndices = new Set<number>();
  private readonly errorIndices = new Set<number>();

  private text = '';
  private ranges: readonly { readonly start: number; readonly end: number }[] = [];
  private lines: ProgramLine[] = [];
  private commandLine: Int32Array = new Int32Array(0);
  private parseErrorOffset: number | null = null;
  private parseErrorLine: number | null = null;
  private wrapper: HTMLDivElement | null = null;
  private spacers: SpacerPair | null = null;
  private windowStart = 0;
  private windowEnd = 0;
  private readonly renderedLines = new Map<number, HTMLDivElement>();
  private readonly visibleCommandNodes = new Map<number, HTMLSpanElement>();
  private lineHeightPx = DEFAULT_LINE_HEIGHT_PX;
  private padding: HostPadding = ZERO_PADDING;
  private horizontalPadding: HostPadding = ZERO_PADDING;
  private geometryMeasured = false;
  private lastScrollTop = 0;

  constructor(options: ProgramRendererOptions = {}) {
    this.lineThreshold = Math.max(1, options.lineThreshold ?? PROGRAM_VIRTUALIZE_LINE_THRESHOLD);
    this.commandThreshold = Math.max(
      1,
      options.commandThreshold ?? PROGRAM_VIRTUALIZE_COMMAND_THRESHOLD,
    );
    this.overscan = Math.max(1, options.overscan ?? PROGRAM_VIRTUAL_OVERSCAN);
  }

  get isVirtualized(): boolean {
    return this.virtualized;
  }

  get renderedLineRange(): readonly [number, number] {
    return this.virtualized ? [this.windowStart, this.windowEnd] : [0, this.totalLines];
  }

  get totalLines(): number {
    if (this.host === null) return 0;
    return this.virtualized ? this.lines.length : this.countDirectLines();
  }

  get currentCommandNode(): HTMLSpanElement | null {
    return this.currentIndex !== null ? (this.getCommandNode(this.currentIndex) ?? null) : null;
  }

  mount(host: HTMLElement, listing: ProgramListing, errorIndices: readonly number[] = []): void {
    this.clear();
    this.host = host;
    this.text = listing.text;
    this.ranges = listing.ranges;
    for (let i = 0; i < errorIndices.length; i += 1) {
      const idx = errorIndices[i];
      if (idx !== undefined) this.errorIndices.add(idx);
    }

    if (
      listing.commands.length > this.commandThreshold ||
      exceedsLineThreshold(listing.text, this.lineThreshold)
    ) {
      this.mountVirtual(host, listing.text, listing.ranges, null);
      return;
    }

    this.mountDirect(host, listing);
  }

  mountParseError(host: HTMLElement, text: string, offset: number): void {
    this.clear();
    this.host = host;
    this.text = text;
    this.parseErrorOffset = offset;

    if (exceedsLineThreshold(text, this.lineThreshold)) {
      this.mountVirtual(host, text, [], offset);
      return;
    }

    host.replaceChildren(renderProgramWithError(text, offset));
  }

  setCurrent(index: number | null, scroll = true): void {
    if (this.currentIndex !== index) {
      if (this.currentIndex !== null) {
        this.getCommandNode(this.currentIndex)?.classList.remove('current');
      }
      this.currentIndex = index;
      if (index !== null) this.getCommandNode(index)?.classList.add('current');
    }

    if (scroll && index !== null) this.scrollToCommand(index);
  }

  setError(index: number | null, scroll = true): void {
    for (const prev of this.errorIndices) {
      if (prev !== index) this.getCommandNode(prev)?.classList.remove('error');
    }
    this.errorIndices.clear();

    if (index !== null) {
      this.errorIndices.add(index);
      this.getCommandNode(index)?.classList.add('error');
      if (scroll) this.scrollToCommand(index);
    }
  }

  setVisited(index: number, visited: boolean): void {
    if (visited) {
      if (this.visitedIndices.has(index)) return;
      this.visitedIndices.add(index);
      this.getCommandNode(index)?.classList.add('visited');
    } else {
      if (!this.visitedIndices.delete(index)) return;
      this.getCommandNode(index)?.classList.remove('visited');
    }
  }

  clearVisited(): void {
    for (const index of this.visitedIndices) {
      this.getCommandNode(index)?.classList.remove('visited');
    }
    this.visitedIndices.clear();
  }

  syncScroll(scrollTop: number): void {
    const host = this.host;
    if (host === null) return;
    host.scrollTop = scrollTop;
    if (!this.virtualized) return;

    this.lastScrollTop = scrollTop;
    this.measureGeometry();
    this.syncVirtualWindow(true, scrollTop);
  }

  scrollToCurrent(): void {
    if (this.currentIndex !== null) this.scrollToCommand(this.currentIndex);
  }

  scrollToFirstError(): void {
    const host = this.host;
    if (host === null) return;

    if (!this.virtualized) {
      scrollNodeIntoView(host.querySelector<HTMLElement>('mark.error, .cmd.error'));
      return;
    }

    if (this.parseErrorLine !== null) {
      this.scrollToLine(this.parseErrorLine);
      return;
    }

    let firstIndex: number | null = null;
    for (const idx of this.errorIndices) {
      if (firstIndex === null || idx < firstIndex) firstIndex = idx;
    }
    if (firstIndex !== null) this.scrollToCommand(firstIndex);
  }

  scrollToCommand(index: number): void {
    if (!this.virtualized) {
      scrollNodeIntoView(this.directNodes[index] ?? null);
      return;
    }
    const lineIdx = this.commandLine[index];
    if (lineIdx === undefined) return;
    this.scrollToLine(lineIdx);
    this.scrollCommandHorizontally(this.visibleCommandNodes.get(index) ?? null);
  }

  clear(): void {
    this.observer.detach();
    if (this.host !== null) {
      this.host.classList.remove('program--virtual');
      this.host.replaceChildren();
    }
    this.host = null;
    this.virtualized = false;
    this.directNodes = [];
    this.currentIndex = null;
    this.visitedIndices.clear();
    this.errorIndices.clear();
    this.text = '';
    this.ranges = [];
    this.lines = [];
    this.commandLine = new Int32Array(0);
    this.parseErrorOffset = null;
    this.parseErrorLine = null;
    this.wrapper = null;
    this.spacers = null;
    this.windowStart = 0;
    this.windowEnd = 0;
    this.renderedLines.clear();
    this.visibleCommandNodes.clear();
    this.lineHeightPx = DEFAULT_LINE_HEIGHT_PX;
    this.padding = ZERO_PADDING;
    this.horizontalPadding = ZERO_PADDING;
    this.geometryMeasured = false;
    this.lastScrollTop = 0;
  }

  private getCommandNode(index: number): HTMLSpanElement | undefined {
    return this.virtualized ? this.visibleCommandNodes.get(index) : this.directNodes[index];
  }

  private countDirectLines(): number {
    return countTextLines(this.text);
  }

  private mountDirect(host: HTMLElement, listing: ProgramListing): void {
    const nodes: HTMLSpanElement[] = [];
    const fragment = buildProgramFragment(listing, this.errorIndices, nodes);
    this.directNodes = nodes;
    host.replaceChildren(fragment);
  }

  private mountVirtual(
    host: HTMLElement,
    text: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    parseErrorOffset: number | null,
  ): void {
    const indexed = indexProgramLines(text, ranges, parseErrorOffset);
    this.virtualized = true;
    this.lines = indexed.lines;
    this.commandLine = indexed.commandLine;
    this.parseErrorLine = indexed.parseErrorLine;

    const wrapper = el('div', { class: 'program-virtual' });
    if (indexed.maxLineChars > 0) wrapper.style.minWidth = `${indexed.maxLineChars}ch`;
    const topSpacer = el('div', { class: 'program-virtual__spacer', 'aria-hidden': 'true' });
    const bottomSpacer = el('div', { class: 'program-virtual__spacer', 'aria-hidden': 'true' });
    wrapper.append(topSpacer, bottomSpacer);

    this.wrapper = wrapper;
    this.spacers = createSpacerPair(topSpacer, bottomSpacer, 'height');

    host.classList.add('program--virtual');
    host.replaceChildren(wrapper);

    this.lastScrollTop = host.clientHeight > 0 ? host.scrollTop : 0;
    this.syncVirtualWindow(true, this.lastScrollTop);
    this.measureGeometry();
    this.observer.attach(host, this.handleScroll, this.handleResize);
  }

  private readScrollTop(): number {
    return this.host !== null && this.host.clientHeight > 0
      ? this.host.scrollTop
      : this.lastScrollTop;
  }

  private measureGeometry(): boolean {
    if (this.geometryMeasured || !this.virtualized || this.host === null) return false;
    const sample = this.renderedLines.values().next().value;
    if (sample === undefined || typeof sample.getBoundingClientRect !== 'function') return false;
    const height = sample.getBoundingClientRect().height;
    if (height > 0) {
      this.geometryMeasured = true;
      this.padding = measureHostPadding(this.host, 'y');
      this.horizontalPadding = measureHostPadding(this.host, 'x');
      if (Math.abs(height - this.lineHeightPx) > 0.25) {
        this.lineHeightPx = height;
        this.syncVirtualWindow(true, this.readScrollTop());
        return true;
      }
    }
    return false;
  }

  private scrollToLine(lineIdx: number): void {
    const host = this.host;
    if (host === null || !this.virtualized) return;

    this.measureGeometry();
    const viewportH =
      host.clientHeight > 0 ? host.clientHeight : DEFAULT_PROGRAM_VIEWPORT_HEIGHT_PX;
    const viewTop = host.clientHeight > 0 ? host.scrollTop : this.lastScrollTop;
    const nextScrollTop = computeScrollToIndex(
      lineIdx,
      this.lineHeightPx,
      viewTop,
      viewportH,
      this.padding,
    );

    if (nextScrollTop !== viewTop) {
      this.lastScrollTop = nextScrollTop;
      host.scrollTop = nextScrollTop;
    } else {
      this.lastScrollTop = viewTop;
    }

    const lineOutsideWindow = lineIdx < this.windowStart || lineIdx >= this.windowEnd;
    if (lineOutsideWindow || nextScrollTop !== viewTop) {
      this.syncVirtualWindow(lineOutsideWindow, nextScrollTop);
    }
  }

  private scrollCommandHorizontally(node: HTMLSpanElement | null): void {
    const host = this.host;
    if (host === null || node === null || host.clientWidth <= 0) return;
    if (typeof host.getBoundingClientRect !== 'function') return;

    const hostRect = host.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    if (nodeRect.width <= 0) return;

    const visibleLeft = hostRect.left + this.horizontalPadding.start;
    const visibleRight = hostRect.left + host.clientWidth - this.horizontalPadding.end;

    if (nodeRect.left < visibleLeft) {
      host.scrollLeft = Math.max(0, host.scrollLeft - (visibleLeft - nodeRect.left));
    } else if (nodeRect.right > visibleRight) {
      host.scrollLeft += nodeRect.right - visibleRight;
    }
  }

  private syncVirtualWindow(force: boolean, scrollTop: number): void {
    const wrapper = this.wrapper;
    const spacers = this.spacers;
    if (!this.virtualized || wrapper === null || spacers === null) return;

    const total = this.lines.length;
    const host = this.host;
    const viewportH =
      host !== null && host.clientHeight > 0
        ? host.clientHeight
        : DEFAULT_PROGRAM_VIEWPORT_HEIGHT_PX;

    const range = computeWindowRange({
      scrollPos: scrollTop,
      viewportSize: viewportH,
      itemSize: this.lineHeightPx,
      total,
      overscan: this.overscan,
      paddingStart: this.padding.start,
      curStart: this.windowStart,
      curEnd: this.windowEnd,
      renderedCount: this.renderedLines.size,
      force,
    });
    if (range === null) return;

    const { start: nextStart, end: nextEnd } = range;
    const oldStart = this.windowStart;
    const oldEnd = this.windowEnd;
    const overlapStart = Math.max(oldStart, nextStart);
    const overlapEnd = Math.min(oldEnd, nextEnd);

    if (this.renderedLines.size === 0 || overlapStart >= overlapEnd) {
      this.renderedLines.clear();
      this.visibleCommandNodes.clear();
      wrapper.replaceChildren(
        spacers.startEl,
        this.buildLinesFragment(nextStart, nextEnd),
        spacers.endEl,
      );
    } else {
      for (let i = oldStart; i < overlapStart; i += 1) this.removeLineNode(i);
      for (let i = overlapEnd; i < oldEnd; i += 1) this.removeLineNode(i);
      if (nextStart < overlapStart) {
        spacers.startEl.after(this.buildLinesFragment(nextStart, overlapStart));
      }
      if (overlapEnd < nextEnd) {
        spacers.endEl.before(this.buildLinesFragment(overlapEnd, nextEnd));
      }
    }

    this.windowStart = nextStart;
    this.windowEnd = nextEnd;
    spacers.sync(nextStart * this.lineHeightPx, Math.max(0, total - nextEnd) * this.lineHeightPx);
  }

  private removeLineNode(lineIdx: number): void {
    const line = this.lines[lineIdx];
    if (line !== undefined) {
      const endCmd = line.firstCommand + line.commandCount;
      for (let c = line.firstCommand; c < endCmd; c += 1) this.visibleCommandNodes.delete(c);
    }
    this.renderedLines.get(lineIdx)?.remove();
    this.renderedLines.delete(lineIdx);
  }

  private buildLinesFragment(startLine: number, endLine: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    for (let i = startLine; i < endLine; i += 1) fragment.appendChild(this.buildLineElement(i));
    return fragment;
  }

  private buildLineElement(lineIdx: number): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'program-line';
    const line = this.lines[lineIdx];
    if (line === undefined) return div;

    if (this.parseErrorOffset !== null && this.parseErrorLine === lineIdx) {
      appendParseErrorSlice(div, this.text, line.start, line.end, this.parseErrorOffset);
    } else if (line.commandCount === 0) {
      if (line.end > line.start) div.textContent = this.text.slice(line.start, line.end);
    } else {
      let cursor = line.start;
      const endCmd = line.firstCommand + line.commandCount;
      for (let c = line.firstCommand; c < endCmd; c += 1) {
        const range = this.ranges[c];
        if (range === undefined) continue;
        const cmdStart = Math.max(line.start, range.start);
        const cmdEnd = Math.min(line.end, range.end);
        if (cmdStart > cursor) {
          div.appendChild(document.createTextNode(this.text.slice(cursor, cmdStart)));
        }
        const span = document.createElement('span');
        let cls = 'cmd';
        if (this.visitedIndices.has(c)) cls += ' visited';
        if (this.currentIndex === c) cls += ' current';
        if (this.errorIndices.has(c)) cls += ' error';
        span.className = cls;
        span.textContent = this.text.slice(cmdStart, cmdEnd);
        this.visibleCommandNodes.set(c, span);
        div.appendChild(span);
        cursor = cmdEnd;
      }
      if (cursor < line.end) {
        div.appendChild(document.createTextNode(this.text.slice(cursor, line.end)));
      }
    }

    this.renderedLines.set(lineIdx, div);
    return div;
  }

  private readonly handleScroll = (): void => {
    if (!this.virtualized || this.host === null) return;
    const scrollTop = this.host.scrollTop;
    this.lastScrollTop = scrollTop;
    this.syncVirtualWindow(false, scrollTop);
  };

  private readonly handleResize = (): void => {
    if (!this.virtualized) return;
    this.geometryMeasured = false;
    if (!this.measureGeometry()) {
      this.syncVirtualWindow(true, this.readScrollTop());
    }
  };
}
