import { Command, parseStateName, type StateId } from './machine';
import { ParseError } from './errors';

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
 * The function never throws on an empty program: that is detected later by
 * {@link createProgram}, so the UI can show a dedicated "program is empty" message.
 *
 * @throws {ParseError} when a non-space, non-comment chunk cannot be parsed
 */
export function parseProgram(text: string, options: ParseOptions = {}): Command[] {
  const commands: Command[] = [];
  // Local sticky RegExp instances keep `parseProgram` re-entrant even if
  // `options.onCommand` invokes `parseProgram` nestedly.
  const skipRe = new RegExp(SKIP_PATTERN, 'y');
  const commandRe = new RegExp(COMMAND_PATTERN, 'y');

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
      throw new ParseError({
        offset,
        text: text
          .slice(offset, offset + 10)
          .replace(/\n/g, ' ')
          .trim(),
      });
    }

    const [source, q, a, v, w] = match as unknown as [string, string, string, string, string];
    const command = new Command(parseStateName(q) satisfies StateId, a, v, parseStateName(w), {
      text: source,
      offset,
    });

    commands.push(command);
    options.onCommand?.(command, commands.length - 1);

    offset = commandRe.lastIndex;
  }

  return commands;
}
