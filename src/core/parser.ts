import type { ParseError } from './errors';
import { createCommand, parseStateName, type Command, type StateId } from './machine';
import { err, ok, type Result } from './result';

export interface ParseOptions {
  /**
   * Called for every successfully parsed command, in source order. The UI uses
   * it to build the highlighted program listing without a second pass.
   */
  readonly onCommand?: (command: Command, index: number) => void;
}

/**
 * Whitespace / comment skipping regex (sticky `/y`, anchored at `lastIndex`)
 * that alternates between line comments (`#`, `//`) and plain whitespace.
 *
 * Note: a comment must be separated from a command by at least one space or
 * line break, otherwise `#` would be ambiguous with the halt symbol and `/`
 * with a tape symbol.
 */
const SKIP_PATTERN = '(?:(?:#|//)[^\\n]*(?:\\n|$))|(?:\\s+)';

/** `q,a,v,q'` — `a` and `v` are single characters, `q` and `q'` are words. */
const COMMAND_PATTERN = '([^\\s]+),(.),(.),([^\\s]+)';

/**
 * Parse program text into commands in O(N) time and memory using sticky
 * regular expressions and an integer cursor (no per-token string slicing).
 * An empty program returns `ok([])`: emptiness is detected later by
 * {@link createProgram}, so the UI can show a dedicated "program is empty" message.
 */
export function parseProgram(
  text: string,
  options: ParseOptions = {},
): Result<Command[], ParseError> {
  const commands: Command[] = [];
  // Local sticky Unicode RegExp instances keep `parseProgram` re-entrant and
  // match single code points (including non-BMP symbols) consistently with tape cells.
  const skipRe = new RegExp(SKIP_PATTERN, 'yu');
  const commandRe = new RegExp(COMMAND_PATTERN, 'yu');

  const length = text.length;
  let offset = 0;

  while (offset < length) {
    skipRe.lastIndex = offset;
    const skip = skipRe.exec(text);
    if (skip !== null) {
      offset = skipRe.lastIndex;
      continue;
    }

    commandRe.lastIndex = offset;
    const match = commandRe.exec(text);
    if (match === null) {
      const snippet = Array.from(text.slice(offset, offset + 20))
        .slice(0, 10)
        .join('')
        .replace(/[\r\n]/g, ' ')
        .trim();
      return err({ kind: 'parseError', offset, text: snippet });
    }

    const [source, q, a, v, w] = match as unknown as [string, string, string, string, string];
    const command = createCommand(parseStateName(q) satisfies StateId, a, v, parseStateName(w), {
      text: source,
      offset,
    });

    commands.push(command);
    options.onCommand?.(command, commands.length - 1);

    offset = commandRe.lastIndex;
  }

  return ok(commands);
}
