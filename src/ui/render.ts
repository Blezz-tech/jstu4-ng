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
 * plain text; every command gets `data-command-id` so the runner can mark the
 * current/visited/erroneous one without re-rendering the whole pane.
 */
export function renderProgram(compiled: ProgramListing): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  compiled.ranges.forEach((range, index) => {
    if (range.start > cursor) fragment.append(compiled.text.slice(cursor, range.start));
    const span = el('span', {
      class: 'cmd',
      'data-command-id': String(index),
    });
    span.textContent = compiled.text.slice(range.start, range.end);
    fragment.append(span);
    cursor = range.end;
  });

  if (cursor < compiled.text.length) fragment.append(compiled.text.slice(cursor));
  return fragment;
}

/** Render plain program text with one character highlighted as erroneous. */
export function renderProgramWithError(text: string, offset: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(text.slice(0, offset));
  const mark = el('mark', { class: 'error' });
  mark.textContent = text.charAt(offset) || ' ';
  fragment.append(mark, text.slice(offset + 1));
  return fragment;
}

/** Render a tape; `position` (if any) gets the `current` highlight. */
export function renderTape(tape: string, position: number | null, label: string): HTMLElement {
  const container = el('div', { class: 'tape-view', role: 'img', 'aria-label': label });

  const cells = Array.from(tape);
  // Always show the cell under the head, even when it is past the last symbol.
  if (position !== null && position >= cells.length) {
    while (cells.length <= position) cells.push(' ');
  }

  cells.forEach((symbol, index) => {
    const cell = el('span', {
      class: index === position ? 'cell current' : 'cell',
      ...(index === position ? { 'aria-current': 'true' } : {}),
    });
    // `&nbsp;`-style spaces keep the grid stable; the raw symbol is kept for
    // screen readers and copying via `aria-label` on the container.
    cell.textContent = symbol === ' ' ? '\u00a0' : symbol;
    container.append(cell);
  });

  return container;
}

function formatTapeCell(symbol: string): string {
  return symbol === ' ' ? '\u00a0' : symbol;
}

/**
 * Incremental DOM renderer for the tape pane during execution.
 * Mutates only cells whose symbol changed, appends/trims tail cells, and moves
 * the `.current` marker in O(1) without rebuilding the whole tape on every step.
 */
export class TapeRenderer {
  private host: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private cells: HTMLSpanElement[] = [];
  private symbols: string[] = [];
  private currentIndex: number | null = null;

  get currentCell(): HTMLSpanElement | null {
    return this.currentIndex !== null ? (this.cells[this.currentIndex] ?? null) : null;
  }

  mount(host: HTMLElement, tape: string, position: number | null, label: string): void {
    const container = el('div', { class: 'tape-view', role: 'img', 'aria-label': label });
    this.host = host;
    this.container = container;
    this.cells = [];
    this.symbols = [];
    this.currentIndex = null;
    this.update(tape, position, label);
    host.replaceChildren(container);
  }

  update(tape: string, position: number | null, label: string): void {
    const container = this.container;
    if (container === null) return;

    if (container.getAttribute('aria-label') !== label) {
      container.setAttribute('aria-label', label);
    }
    if (this.host !== null && this.host.getAttribute('aria-label') !== label) {
      this.host.setAttribute('aria-label', label);
    }

    const nextSymbols = Array.from(tape);
    if (position !== null && position >= nextSymbols.length) {
      while (nextSymbols.length <= position) nextSymbols.push(' ');
    }

    // Trim trailing cells if the tape shrank (e.g. after `stepBack` or `reset`).
    while (this.cells.length > nextSymbols.length) {
      const removed = this.cells.pop();
      this.symbols.pop();
      removed?.remove();
    }
    if (this.currentIndex !== null && this.currentIndex >= this.cells.length) {
      this.currentIndex = null;
    }

    // Update only existing cells whose symbol actually changed.
    const existingCount = this.cells.length;
    for (let i = 0; i < existingCount; i += 1) {
      const next = nextSymbols[i] ?? ' ';
      if (this.symbols[i] !== next) {
        this.symbols[i] = next;
        const cell = this.cells[i];
        if (cell !== undefined) cell.textContent = formatTapeCell(next);
      }
    }

    // Append newly visited cells on the right in one batch.
    if (nextSymbols.length > existingCount) {
      const fragment = document.createDocumentFragment();
      for (let i = existingCount; i < nextSymbols.length; i += 1) {
        const sym = nextSymbols[i] ?? ' ';
        const cell = el('span', { class: 'cell' }, formatTapeCell(sym));
        this.cells.push(cell);
        this.symbols.push(sym);
        fragment.append(cell);
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

  clear(): void {
    this.host = null;
    this.container = null;
    this.cells = [];
    this.symbols = [];
    this.currentIndex = null;
  }
}
