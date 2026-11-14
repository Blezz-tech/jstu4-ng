import type { Command, StateId } from './machine';
import { stateKey } from './machine';
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
  /** `stateKey(q) + '\u0000' + symbol` → command. */
  readonly transitions: ReadonlyMap<string, Command>;
}

const transitionKey = (state: StateId, symbol: string): string =>
  `${stateKey(state)}\u0000${symbol}`;

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

  const transitions = new Map<string, Command>();
  const definedStates = new Set<string>();
  for (const command of commands) {
    const key = transitionKey(command.q, command.a);
    const original = transitions.get(key);
    if (original !== undefined) {
      throw new AmbiguousCommandError({ command, original });
    }
    transitions.set(key, command);
    definedStates.add(stateKey(command.q));
  }

  if (!definedStates.has(stateKey(q0))) {
    throw new NonexistentInitialStateError({ state: q0 });
  }

  for (const command of commands) {
    if (!definedStates.has(stateKey(command.w))) {
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
  return program.transitions.get(transitionKey(state, symbol));
}
