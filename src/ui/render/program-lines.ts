/** Matches `tab-size: 4` on `.program`. */
const PROGRAM_TAB_SIZE = 4;

export interface ProgramLine {
  readonly start: number;
  readonly end: number;
  readonly firstCommand: number;
  readonly commandCount: number;
}

export interface LineIndexResult {
  readonly lines: ProgramLine[];
  readonly commandLine: Int32Array;
  readonly maxLineChars: number;
  readonly parseErrorLine: number | null;
}

/** Return the UTF-16 code-unit length (1 or 2) of the Unicode code point at `offset`. */
export function codePointLengthAt(text: string, offset: number): number {
  const cp = text.codePointAt(offset);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

/**
 * Append `text.slice(start, end)` into `parent` with the code point at
 * `errorOffset` wrapped in `<mark class="error">` (safe for surrogate pairs).
 */
export function appendParseErrorSlice(
  parent: Node,
  text: string,
  start: number,
  end: number,
  errorOffset: number,
): void {
  const mark = document.createElement('mark');
  mark.className = 'error';

  if (errorOffset >= end) {
    if (end > start) parent.appendChild(document.createTextNode(text.slice(start, end)));
    mark.textContent = ' ';
    parent.appendChild(mark);
    return;
  }

  if (errorOffset > start) {
    parent.appendChild(document.createTextNode(text.slice(start, errorOffset)));
  }
  const charLen = Math.min(codePointLengthAt(text, errorOffset), end - errorOffset);
  mark.textContent = text.slice(errorOffset, errorOffset + charLen) || ' ';
  parent.appendChild(mark);
  if (errorOffset + charLen < end) {
    parent.appendChild(document.createTextNode(text.slice(errorOffset + charLen, end)));
  }
}

export function countTextLines(text: string): number {
  let lines = 1;
  let pos = -1;
  while ((pos = text.indexOf('\n', pos + 1)) !== -1) lines += 1;
  return lines;
}

export function exceedsLineThreshold(text: string, threshold: number): boolean {
  let lines = 1;
  let pos = -1;
  while ((pos = text.indexOf('\n', pos + 1)) !== -1) {
    lines += 1;
    if (lines > threshold) return true;
  }
  return false;
}

export function indexProgramLines(
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
      visualCols +=
        text.charCodeAt(i) === 9 ? PROGRAM_TAB_SIZE - (visualCols % PROGRAM_TAB_SIZE) : 1;
    }
    if (visualCols > maxLineChars) maxLineChars = visualCols;

    lines.push({ start: lineStart, end, firstCommand, commandCount: cmdCursor - firstCommand });

    if (nl === -1) break;
    lineStart = nl + 1;
  }

  return { lines, commandLine, maxLineChars, parseErrorLine };
}
