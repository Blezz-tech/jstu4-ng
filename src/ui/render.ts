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

function scrollNodeIntoView(node: HTMLElement | null): void {
  if (node !== null && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

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
/** Matches `tab-size: 4` on `.program`. */
const PROGRAM_TAB_SIZE = 4;

export interface ProgramRendererOptions {
  readonly lineThreshold?: number;
  readonly commandThreshold?: number;
  readonly overscan?: number;
}

interface ProgramLine {
  readonly start: number;
  readonly end: number;
  readonly firstCommand: number;
  readonly commandCount: number;
}

interface LineIndexResult {
  readonly lines: ProgramLine[];
  readonly commandLine: Int32Array;
  readonly maxLineChars: number;
  readonly parseErrorLine: number | null;
}

function exceedsLineThreshold(text: string, threshold: number): boolean {
  let lines = 1;
  let pos = -1;
  while ((pos = text.indexOf('\n', pos + 1)) !== -1) {
    lines += 1;
    if (lines > threshold) return true;
  }
  return false;
}

function indexProgramLines(
  text: string,
  ranges: readonly { readonly start: number; readonly end: number }[],
  parseErrorOffset: number | null,
): LineIndexResult {
  const lines: ProgramLine[] = [];
  const commandLine = new Int32Array(ranges.length);
  const len = text.length;
  let cmdCursor = 0;
  let lineStart = 0;
  let maxLineChars = 0;
  let parseErrorLine: number | null = null;

  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const rawEnd = nl === -1 ? len : nl;
    const end = rawEnd > lineStart && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    const lineIdx = lines.length;

    const firstCommand = cmdCursor;
    while (cmdCursor < ranges.length) {
      const range = ranges[cmdCursor];
      if (range === undefined || range.start > rawEnd) break;
      commandLine[cmdCursor] = lineIdx;
      cmdCursor += 1;
    }

    if (
      parseErrorOffset !== null &&
      parseErrorLine === null &&
      (parseErrorOffset <= rawEnd || nl === -1)
    ) {
      parseErrorLine = lineIdx;
    }

    let visualCols = 0;
    for (let i = lineStart; i < end; i += 1) {
      if (text.charCodeAt(i) === 9) {
        visualCols += PROGRAM_TAB_SIZE - (visualCols % PROGRAM_TAB_SIZE);
      } else {
        visualCols += 1;
      }
    }
    if (visualCols > maxLineChars) maxLineChars = visualCols;

    lines.push({
      start: lineStart,
      end,
      firstCommand,
      commandCount: cmdCursor - firstCommand,
    });

    if (nl === -1) break;
    lineStart = nl + 1;
  }

  return { lines, commandLine, maxLineChars, parseErrorLine };
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

  private host: HTMLElement | null = null;
  private virtualized = false;

  // Direct mode state
  private directNodes: HTMLSpanElement[] = [];

  // Shared command highlight state
  private currentIndex: number | null = null;
  private readonly visitedIndices = new Set<number>();
  private readonly errorIndices = new Set<number>();

  // Virtual mode state
  private text = '';
  private ranges: readonly { readonly start: number; readonly end: number }[] = [];
  private lines: ProgramLine[] = [];
  private commandLine: Int32Array = new Int32Array(0);
  private parseErrorOffset: number | null = null;
  private parseErrorLine: number | null = null;
  private wrapper: HTMLDivElement | null = null;
  private topSpacer: HTMLDivElement | null = null;
  private bottomSpacer: HTMLDivElement | null = null;
  private lastTopHeight = '';
  private lastBottomHeight = '';
  private windowStart = 0;
  private windowEnd = 0;
  private readonly renderedLines = new Map<number, HTMLDivElement>();
  private readonly visibleCommandNodes = new Map<number, HTMLSpanElement>();
  private lineHeightPx = DEFAULT_LINE_HEIGHT_PX;
  private lineHeightMeasured = false;
  private lastScrollTop = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: ProgramRendererOptions = {}) {
    this.lineThreshold = Math.max(1, options.lineThreshold ?? PROGRAM_VIRTUALIZE_LINE_THRESHOLD);
    this.commandThreshold = Math.max(
      1,
      options.commandThreshold ?? PROGRAM_VIRTUALIZE_COMMAND_THRESHOLD,
    );
    this.overscan = Math.max(1, options.overscan ?? PROGRAM_VIRTUAL_OVERSCAN);
  }

  /** Whether the program listing is currently using line-windowed virtualization. */
  get isVirtualized(): boolean {
    return this.virtualized;
  }

  /** Logical `[startLine, endLine)` line range currently materialized in the DOM. */
  get renderedLineRange(): readonly [number, number] {
    return this.virtualized ? [this.windowStart, this.windowEnd] : [0, this.totalLines];
  }

  /** Total line count of the mounted listing (or 0 when cleared). */
  get totalLines(): number {
    if (this.host === null) return 0;
    return this.virtualized ? this.lines.length : this.countMountedDirectLines();
  }

  /** Currently highlighted `.cmd.current` DOM element (if rendered inside the active window). */
  get currentCommandNode(): HTMLSpanElement | null {
    return this.currentIndex !== null ? (this.getCommandNode(this.currentIndex) ?? null) : null;
  }

  /** Mount a parsed program listing with optional pre-marked error command indices. */
  mount(host: HTMLElement, listing: ProgramListing, errorIndices: readonly number[] = []): void {
    this.clear();
    this.host = host;
    this.text = listing.text;
    this.ranges = listing.ranges;
    for (let i = 0; i < errorIndices.length; i += 1) {
      const idx = errorIndices[i];
      if (idx !== undefined) this.errorIndices.add(idx);
    }

    const shouldVirtualize =
      listing.commands.length > this.commandThreshold ||
      exceedsLineThreshold(listing.text, this.lineThreshold);

    if (shouldVirtualize) {
      this.mountVirtual(host, listing.text, listing.ranges, null);
      return;
    }

    this.mountDirect(host, listing);
  }

  /** Mount plain program text with one character highlighted as a `ParseError`. */
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

  /** Highlight the currently executing command (or clear with `null`). */
  setCurrent(index: number | null, scroll = true): void {
    if (this.currentIndex !== index) {
      if (this.currentIndex !== null) {
        this.getCommandNode(this.currentIndex)?.classList.remove('current');
      }
      this.currentIndex = index;
      if (index !== null) {
        this.getCommandNode(index)?.classList.add('current');
      }
    }

    if (scroll && index !== null) {
      this.scrollToCommand(index);
    }
  }

  /** Highlight a single runtime-erroneous command (or clear all error highlights with `null`). */
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

  /** Set or clear the `.visited` state for one command index in `O(1)`. */
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

  /** Remove all `.visited` marks in `O(|visited|)`. */
  clearVisited(): void {
    for (const index of this.visitedIndices) {
      this.getCommandNode(index)?.classList.remove('visited');
    }
    this.visitedIndices.clear();
  }

  /** Apply an external `scrollTop` (e.g. preserving scroll position from `#input-program`). */
  syncScroll(scrollTop: number): void {
    const host = this.host;
    if (host === null) return;
    host.scrollTop = scrollTop;
    if (!this.virtualized) return;

    this.lastScrollTop = scrollTop;
    this.measureLineHeight();
    this.syncVirtualWindow(true, scrollTop);
  }

  /** Ensure the active `.cmd.current` command is scrolled into view. */
  scrollToCurrent(): void {
    if (this.currentIndex !== null) {
      this.scrollToCommand(this.currentIndex);
    }
  }

  /** Ensure the first highlighted error (`mark.error` or `.cmd.error`) is scrolled into view. */
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
    if (firstIndex !== null) {
      this.scrollToCommand(firstIndex);
    }
  }

  /** Scroll to a specific command index (handles both direct and virtualized modes). */
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

  /** Detach listeners/observers, remove DOM children, and release all references. */
  clear(): void {
    if (this.host !== null) {
      this.host.removeEventListener('scroll', this.handleScroll);
      this.host.classList.remove('program--virtual');
      this.host.replaceChildren();
    }
    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
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
    this.topSpacer = null;
    this.bottomSpacer = null;
    this.lastTopHeight = '';
    this.lastBottomHeight = '';
    this.windowStart = 0;
    this.windowEnd = 0;
    this.renderedLines.clear();
    this.visibleCommandNodes.clear();
    this.lineHeightPx = DEFAULT_LINE_HEIGHT_PX;
    this.lineHeightMeasured = false;
    this.lastScrollTop = 0;
  }

  private getCommandNode(index: number): HTMLSpanElement | undefined {
    return this.virtualized ? this.visibleCommandNodes.get(index) : this.directNodes[index];
  }

  private countMountedDirectLines(): number {
    let lines = 1;
    let pos = -1;
    while ((pos = this.text.indexOf('\n', pos + 1)) !== -1) {
      lines += 1;
    }
    return lines;
  }

  private mountDirect(host: HTMLElement, listing: ProgramListing): void {
    const fragment = document.createDocumentFragment();
    const nodes: HTMLSpanElement[] = [];
    let cursor = 0;

    for (let i = 0; i < listing.ranges.length; i += 1) {
      const range = listing.ranges[i];
      if (range === undefined) continue;
      if (range.start > cursor) fragment.append(listing.text.slice(cursor, range.start));
      const span = el('span', { class: 'cmd' }, listing.text.slice(range.start, range.end));
      if (this.errorIndices.has(i)) span.classList.add('error');
      nodes.push(span);
      fragment.append(span);
      cursor = range.end;
    }

    if (cursor < listing.text.length) fragment.append(listing.text.slice(cursor));
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
    if (indexed.maxLineChars > 0) {
      wrapper.style.minWidth = `${indexed.maxLineChars}ch`;
    }
    const topSpacer = el('div', { class: 'program-virtual__spacer', 'aria-hidden': 'true' });
    const bottomSpacer = el('div', { class: 'program-virtual__spacer', 'aria-hidden': 'true' });
    wrapper.append(topSpacer, bottomSpacer);

    this.wrapper = wrapper;
    this.topSpacer = topSpacer;
    this.bottomSpacer = bottomSpacer;

    host.classList.add('program--virtual');
    host.replaceChildren(wrapper);

    this.lastScrollTop = host.clientHeight > 0 ? host.scrollTop : 0;
    this.syncVirtualWindow(true, this.lastScrollTop);
    this.measureLineHeight();

    host.addEventListener('scroll', this.handleScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(host);
    }
  }

  private readScrollTop(): number {
    if (this.host !== null && this.host.clientHeight > 0) {
      return this.host.scrollTop;
    }
    return this.lastScrollTop;
  }

  private measureLineHeight(): void {
    if (this.lineHeightMeasured || !this.virtualized) return;
    const sample = this.renderedLines.values().next().value;
    if (sample === undefined || typeof sample.getBoundingClientRect !== 'function') return;
    const height = sample.getBoundingClientRect().height;
    if (height > 0) {
      this.lineHeightMeasured = true;
      if (Math.abs(height - this.lineHeightPx) > 0.25) {
        this.lineHeightPx = height;
        this.syncVirtualWindow(true, this.readScrollTop());
      }
    }
  }

  private scrollToLine(lineIdx: number): void {
    const host = this.host;
    if (host === null || !this.virtualized) return;

    this.measureLineHeight();
    const viewportH =
      host.clientHeight > 0 ? host.clientHeight : DEFAULT_PROGRAM_VIEWPORT_HEIGHT_PX;
    const lineTop = lineIdx * this.lineHeightPx;
    const lineBottom = lineTop + this.lineHeightPx;
    const viewTop = host.clientHeight > 0 ? host.scrollTop : this.lastScrollTop;
    const viewBottom = viewTop + viewportH;

    let nextScrollTop = viewTop;
    if (lineTop < viewTop) {
      nextScrollTop = lineTop;
    } else if (lineBottom > viewBottom) {
      nextScrollTop = Math.max(0, lineBottom - viewportH);
    }

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

    if (nodeRect.left < hostRect.left) {
      host.scrollLeft = Math.max(0, host.scrollLeft - (hostRect.left - nodeRect.left));
    } else if (nodeRect.right > hostRect.right) {
      host.scrollLeft += nodeRect.right - hostRect.right;
    }
  }

  private syncVirtualWindow(force: boolean, scrollTop: number): void {
    const wrapper = this.wrapper;
    const topSpacer = this.topSpacer;
    const bottomSpacer = this.bottomSpacer;
    if (!this.virtualized || wrapper === null || topSpacer === null || bottomSpacer === null) {
      return;
    }

    const total = this.lines.length;
    const host = this.host;
    const viewportH =
      host !== null && host.clientHeight > 0
        ? host.clientHeight
        : DEFAULT_PROGRAM_VIEWPORT_HEIGHT_PX;
    const visibleStart = Math.max(0, Math.floor(scrollTop / this.lineHeightPx));
    const visibleCount = Math.max(1, Math.ceil(viewportH / this.lineHeightPx));
    const visibleEnd = Math.min(total, visibleStart + visibleCount);

    const maxWindowLen = visibleCount + this.overscan * 2;
    if (
      !force &&
      this.renderedLines.size > 0 &&
      this.windowEnd <= total &&
      this.renderedLines.size <= maxWindowLen
    ) {
      const margin = Math.floor(this.overscan / 2);
      const safeTop = Math.max(0, visibleStart - margin);
      const safeBottom = Math.min(total, visibleEnd + margin);
      if (this.windowStart <= safeTop && this.windowEnd >= safeBottom) {
        return;
      }
    }

    const nextStart = Math.max(0, Math.min(total, visibleStart - this.overscan));
    const nextEnd = Math.min(total, Math.max(nextStart, visibleEnd + this.overscan));
    const oldStart = this.windowStart;
    const oldEnd = this.windowEnd;

    const overlapStart = Math.max(oldStart, nextStart);
    const overlapEnd = Math.min(oldEnd, nextEnd);

    if (this.renderedLines.size === 0 || overlapStart >= overlapEnd) {
      // Full window jump (initial mount or distant scroll): replace cleanly in one pass.
      this.renderedLines.clear();
      this.visibleCommandNodes.clear();
      const frag = this.buildLinesFragment(nextStart, nextEnd);
      wrapper.replaceChildren(topSpacer, frag, bottomSpacer);
    } else {
      // Incremental sliding window: keep DOM nodes in the overlapping middle untouched.
      for (let i = oldStart; i < overlapStart; i += 1) this.removeLineNode(i);
      for (let i = overlapEnd; i < oldEnd; i += 1) this.removeLineNode(i);

      if (nextStart < overlapStart) {
        topSpacer.after(this.buildLinesFragment(nextStart, overlapStart));
      }
      if (overlapEnd < nextEnd) {
        bottomSpacer.before(this.buildLinesFragment(overlapEnd, nextEnd));
      }
    }

    this.windowStart = nextStart;
    this.windowEnd = nextEnd;
    this.updateSpacers(nextStart, nextEnd, total);
  }

  private removeLineNode(lineIdx: number): void {
    const line = this.lines[lineIdx];
    if (line !== undefined) {
      const endCmd = line.firstCommand + line.commandCount;
      for (let c = line.firstCommand; c < endCmd; c += 1) {
        this.visibleCommandNodes.delete(c);
      }
    }
    this.renderedLines.get(lineIdx)?.remove();
    this.renderedLines.delete(lineIdx);
  }

  private buildLinesFragment(startLine: number, endLine: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    for (let i = startLine; i < endLine; i += 1) {
      fragment.appendChild(this.buildLineElement(i));
    }
    return fragment;
  }

  private buildLineElement(lineIdx: number): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'program-line';
    const line = this.lines[lineIdx];
    if (line === undefined) return div;

    if (this.parseErrorOffset !== null && this.parseErrorLine === lineIdx) {
      const offset = this.parseErrorOffset;
      if (offset >= line.end) {
        if (line.end > line.start) {
          div.appendChild(document.createTextNode(this.text.slice(line.start, line.end)));
        }
        const mark = document.createElement('mark');
        mark.className = 'error';
        mark.textContent = ' ';
        div.appendChild(mark);
      } else {
        if (offset > line.start) {
          div.appendChild(document.createTextNode(this.text.slice(line.start, offset)));
        }
        const mark = document.createElement('mark');
        mark.className = 'error';
        mark.textContent = this.text.charAt(offset) || ' ';
        div.appendChild(mark);
        if (offset + 1 < line.end) {
          div.appendChild(document.createTextNode(this.text.slice(offset + 1, line.end)));
        }
      }
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

  private updateSpacers(startLine: number, endLine: number, totalLines: number): void {
    const topH = `${startLine * this.lineHeightPx}px`;
    const bottomH = `${Math.max(0, totalLines - endLine) * this.lineHeightPx}px`;
    if (this.topSpacer !== null && this.lastTopHeight !== topH) {
      this.topSpacer.style.height = topH;
      this.lastTopHeight = topH;
    }
    if (this.bottomSpacer !== null && this.lastBottomHeight !== bottomH) {
      this.bottomSpacer.style.height = bottomH;
      this.lastBottomHeight = bottomH;
    }
  }

  private readonly handleScroll = (): void => {
    if (!this.virtualized || this.host === null) return;
    const scrollTop = this.host.scrollTop;
    this.lastScrollTop = scrollTop;
    this.syncVirtualWindow(false, scrollTop);
  };

  private readonly handleResize = (): void => {
    if (!this.virtualized) return;
    this.lineHeightMeasured = false;
    this.measureLineHeight();
    this.syncVirtualWindow(true, this.readScrollTop());
  };
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
      scrollNodeIntoView(this.currentCell);
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
