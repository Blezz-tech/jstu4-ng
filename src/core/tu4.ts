import { stateKey, type StateId } from './machine';
import type { Program } from './program';
import { parseProgram } from './parser';
import { createProgram } from './program';

/**
 * TU4 export: rename every state to a two-digit number in order of first
 * appearance, keeping the initial state as `00`.
 *
 * Matches original jstu4 v2.3: uses decimal `00`..`98` when there are fewer
 * than 100 states, and hexadecimal `00`..`ff` for 100..256 states.
 *
 * @throws {RangeError} when the program has more than 256 states
 */
export function toTu4(program: Program): string {
  const names = new Map<string, number>();
  names.set(stateKey(program.initialState), 0);

  for (const command of program.commands) {
    const key = stateKey(command.q);
    if (!names.has(key)) names.set(key, names.size);
  }

  if (names.size > 256) {
    throw new RangeError('A TU4 program cannot have more than 256 states');
  }

  const radix = names.size >= 100 ? 16 : 10;

  const nameOf = (state: StateId): string => {
    const value = names.get(stateKey(state));
    if (value === undefined) throw new Error(`Unknown state "${state}"`);
    return value.toString(radix).padStart(2, '0');
  };

  return program.commands
    .map((command) => `${nameOf(command.q)},${command.a},${command.v},${nameOf(command.w)}`)
    .join('\n');
}

/**
 * Convenience helper: compile text and convert it to the TU4 format in one
 * call. Returns `null` instead of throwing when the program does not compile
 * or exceeds the 256-state TU4 limit.
 */
export function convertTextToTu4(text: string, initialState?: StateId | null): string | null {
  try {
    return toTu4(createProgram(parseProgram(text), initialState));
  } catch {
    return null;
  }
}
