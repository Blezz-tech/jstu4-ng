import type { Command, StateId } from './machine';
import {
  AmbiguousCommandError,
  EmptyProgramError,
  NonexistentInitialStateError,
  NonexistentTargetStateError,
} from './errors';

/** Immutable, validated machine program. */
export interface Program {
  /** The state the machine starts in. */
  readonly initialState: StateId;
  /** Transitions in program order. */
  readonly commands: readonly Command[];
  /** Two-level transition index: `state → (symbol → command)` (zero allocations per lookup). */
  readonly transitions: ReadonlyMap<StateId, ReadonlyMap<string, Command>>;
}

/**
 * Build a program from parsed commands.
 *
 * @param commands parsed commands in source order
 * @param initialState requested initial state; when omitted, the state of the
 *   first command is used (same heuristic as the original emulator)
 *
 * @throws {EmptyProgramError} when there are no commands
 * @throws {AmbiguousCommandError} when two commands share `q` and `a`
 * @throws {NonexistentInitialStateError} when the initial state is not used
 * @throws {NonexistentTargetStateError} when some target state is unreachable
 */
export function createProgram(
  commands: readonly Command[],
  initialState?: StateId | null,
): Program {
  const first = commands[0];
  if (first === undefined) throw new EmptyProgramError();

  const q0 = initialState ?? first.q;

  // JS Map keys distinguish numbers from strings (`1 !== '1'`), so numeric
  // and named StateIds never collide without allocating composite string keys.
  const transitions = new Map<StateId, Map<string, Command>>();
  for (const command of commands) {
    let bySymbol = transitions.get(command.q);
    if (bySymbol === undefined) {
      bySymbol = new Map<string, Command>();
      transitions.set(command.q, bySymbol);
    }
    const original = bySymbol.get(command.a);
    if (original !== undefined) {
      throw new AmbiguousCommandError({ command, original });
    }
    bySymbol.set(command.a, command);
  }

  if (!transitions.has(q0)) {
    throw new NonexistentInitialStateError({ state: q0 });
  }

  for (const command of commands) {
    if (!transitions.has(command.w)) {
      throw new NonexistentTargetStateError({ command });
    }
  }

  return { initialState: q0, commands: Object.freeze([...commands]), transitions };
}

/** Look up the transition for a state/symbol pair. */
export function findTransition(
  program: Program,
  state: StateId,
  symbol: string,
): Command | undefined {
  return program.transitions.get(state)?.get(symbol);
}
