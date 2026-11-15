import type { CompileError, ParseError } from '../../core/errors';
import { parseStateName, type Command } from '../../core/machine';
import { parseProgram } from '../../core/parser';
import { createProgram, type Program } from '../../core/program';
import { ok, type Result } from '../../core/result';
import { appendParseErrorSlice } from './program-lines';

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
 */
export function compileProgram(
  text: string,
  initialState: number | string = 0,
): Result<CompiledProgram, CompileError> {
  const listed = listProgram(text);
  if (!listed.ok) return listed;
  const normalisedInitial =
    typeof initialState === 'string' ? parseStateName(initialState) : initialState;
  const created = createProgram(listed.value.commands, normalisedInitial);
  if (!created.ok) return created;
  return ok({ ...listed.value, program: created.value });
}

/**
 * Parse the text into command spans without validating the program. Used to
 * draw listings of programs that do not compile (error reports).
 */
export function listProgram(text: string): Result<ProgramListing, ParseError> {
  const parsed = parseProgram(text);
  if (!parsed.ok) return parsed;
  const commands = parsed.value;
  const ranges = commands.map((command) => ({
    start: command.source.offset,
    end: command.source.offset + command.source.text.length,
  }));
  return ok({ text, commands, ranges });
}

/**
 * Build a flat listing `DocumentFragment` with one `.cmd` span per command,
 * optionally marking `errorIndices` and collecting created spans into `outNodes`.
 */
export function buildProgramFragment(
  compiled: ProgramListing,
  errorIndices?: ReadonlySet<number>,
  outNodes?: HTMLSpanElement[],
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (let i = 0; i < compiled.ranges.length; i += 1) {
    const range = compiled.ranges[i];
    if (range === undefined) continue;
    if (range.start > cursor) {
      fragment.appendChild(document.createTextNode(compiled.text.slice(cursor, range.start)));
    }
    const span = document.createElement('span');
    span.className = errorIndices !== undefined && errorIndices.has(i) ? 'cmd error' : 'cmd';
    span.textContent = compiled.text.slice(range.start, range.end);
    outNodes?.push(span);
    fragment.appendChild(span);
    cursor = range.end;
  }

  if (cursor < compiled.text.length) {
    fragment.appendChild(document.createTextNode(compiled.text.slice(cursor)));
  }
  return fragment;
}

/**
 * Render program text with command spans. Whitespace and comments stay as
 * plain text; every command gets `.cmd` so the runner can highlight the
 * current/visited/erroneous one in O(1) without re-rendering the whole pane.
 */
export function renderProgram(compiled: ProgramListing): DocumentFragment {
  return buildProgramFragment(compiled);
}

/** Render plain program text with one Unicode code point highlighted as erroneous. */
export function renderProgramWithError(text: string, offset: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendParseErrorSlice(fragment, text, 0, text.length, offset);
  return fragment;
}
