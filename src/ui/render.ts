import type { Command } from '../core/machine';
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
  return { ...listing, program: createProgram(listing.commands, initialState) };
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
