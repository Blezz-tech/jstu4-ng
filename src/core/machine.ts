/**
 * Core data model of the Turing machine.
 *
 * A program is a set of 4-tuple commands `q,a,v,q'`:
 *  - `q` — current state;
 *  - `a` — symbol read from the tape;
 *  - `v` — what to do: `<` move left, `>` move right, `=` stay, `#` halt,
 *           or any other symbol to write into the current cell;
 *  - `w` — next state.
 *
 * State names made of digits only are numeric states (so `01` and `1` are the
 * same state, exactly as in the original jstu4 v2.3).
 */

/** A parsed command together with its position in the source text. */
export interface CommandSource {
  /** Full source slice of the command, e.g. `rep,0,1,mov`. */
  readonly text: string;
  /** Offset of the command in the program text (UTF-16 code units). */
  readonly offset: number;
}

/** Numeric states are stored as numbers, named states as strings. */
export type StateId = number | string;

type MoveKind = 'left' | 'right' | 'stay' | 'halt';
export type CommandKind = MoveKind | 'write';

/** Immutable representation of a single Turing machine transition `q,a,v,w`. */
export interface Command {
  readonly q: StateId;
  readonly a: string;
  readonly v: string;
  readonly w: StateId;
  readonly source: CommandSource;
  /**
   * What this command does. Note that `rep,0,0,rep` is a halt and `rep,0,0,nxt`
   * is a stay rather than a write (same as original jstu4 v2.3).
   */
  readonly kind: CommandKind;
  /**
   * `true` when the machine stops after this command. Matches original v2.3
   * `isStop()`: `#` always halts, and `a === v && q === w` also halts even
   * when `v` is `<` or `>` (after performing the move).
   */
  readonly isHalt: boolean;
}

function classifyCommand(q: StateId, a: string, v: string, w: StateId): CommandKind {
  if (v === '<') return 'left';
  if (v === '>') return 'right';
  if (v === '#') return 'halt';
  if (a === v) return q === w ? 'halt' : 'stay';
  if (v === '=') return 'stay';
  return 'write';
}

/** Create an immutable {@link Command} value from its parsed components. */
export function createCommand(
  q: StateId,
  a: string,
  v: string,
  w: StateId,
  source: CommandSource,
): Command {
  return {
    q,
    a,
    v,
    w,
    source,
    kind: classifyCommand(q, a, v, w),
    isHalt: v === '#' || (a === v && q === w),
  };
}

/** Parse a state name: safe-integer digit-only names become numbers. */
export function parseStateName(name: string): StateId {
  if (!/^\d+$/.test(name)) return name;
  const parsed = Number.parseInt(name, 10);
  return Number.isSafeInteger(parsed) ? parsed : name;
}
