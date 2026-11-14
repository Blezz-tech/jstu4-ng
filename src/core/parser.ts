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
 * Whitespace / comment skipping is done by a single regular expression that
 * alternates between line comments (`#`, `//`) and plain whitespace.
 *
 * Note: a comment must be separated from a command by at least one space or
 * line break, otherwise `#` would be ambiguous with the halt symbol and `/`
 * with a tape symbol.
 */
const SKIP_RE = /^(?:(?:#|\/\/)[^\n]*(?:\n|$))|^(?:\s+)/;

/** `q,a,v,q'` — `a` and `v` are single characters, `q` and `q'` are words. */
const COMMAND_RE = /^([^\s]+),(.),(.),([^\s]+)/;

export interface ParsedCommand {
  readonly command: Command;
}

/**
 * Parse program text into commands. The function never throws on an empty
 * program: that is detected later by {@link createProgram}, so the UI can show
 * a dedicated "program is empty" message.
 *
 * @throws {ParseError} when a non-space, non-comment chunk cannot be parsed
 */
export function parseProgram(text: string, options: ParseOptions = {}): Command[] {
  const commands: Command[] = [];
  let rest = text;
  let offset = 0;

  while (rest.length > 0) {
    const skip = SKIP_RE.exec(rest);
    if (skip !== null) {
      offset += skip[0].length;
      rest = rest.slice(skip[0].length);
      continue;
    }

    const match = COMMAND_RE.exec(rest);
    if (match === null) {
      throw new ParseError({
        offset,
        text: rest.slice(0, 10).replace(/\n/g, ' ').trim(),
      });
    }

    const [source, q, a, v, w] = match as unknown as [string, string, string, string, string];
    const command = new Command(parseStateName(q) satisfies StateId, a, v, parseStateName(w), {
      text: source,
      offset,
    });

    commands.push(command);
    options.onCommand?.(command, commands.length - 1);

    offset += source.length;
    rest = rest.slice(source.length);
  }

  return commands;
}
