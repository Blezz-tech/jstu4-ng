import type { Tu4Error } from './errors';
import type { StateId } from './machine';
import { parseProgram } from './parser';
import { createProgram, type Program } from './program';
import { err, ok, type Result } from './result';

/** Maximum number of states representable in the two-digit TU4 format (`00`..`ff`). */
export const TU4_MAX_STATES = 256;

/**
 * TU4 export: rename every state to a two-digit number in order of first
 * appearance, keeping the initial state as `00`.
 *
 * Matches original jstu4 v2.3: uses decimal `00`..`98` when there are fewer
 * than 100 states, and hexadecimal `00`..`ff` for 100..256 states.
 */
export function toTu4(program: Program): Result<string, Tu4Error> {
  // JS Map distinguishes numeric and string StateIds (`1 !== '1'`) natively.
  const names = new Map<StateId, number>();
  names.set(program.initialState, 0);

  for (const command of program.commands) {
    if (!names.has(command.q)) names.set(command.q, names.size);
  }

  if (names.size > TU4_MAX_STATES) {
    return err({ kind: 'tooManyStates', count: names.size, limit: TU4_MAX_STATES });
  }

  const radix = names.size >= 100 ? 16 : 10;

  const nameOf = (state: StateId): string => {
    const value = names.get(state);
    if (value === undefined) throw new Error(`Unknown state "${state}"`);
    return value.toString(radix).padStart(2, '0');
  };

  return ok(
    program.commands
      .map((command) => `${nameOf(command.q)},${command.a},${command.v},${nameOf(command.w)}`)
      .join('\n'),
  );
}

/**
 * Convenience helper: compile text and convert it to the TU4 format in one
 * call. Returns `null` when the program does not compile or exceeds the
 * 256-state TU4 limit.
 */
export function convertTextToTu4(text: string, initialState?: StateId | null): string | null {
  const parsed = parseProgram(text);
  if (!parsed.ok) return null;
  const program = createProgram(parsed.value, initialState);
  if (!program.ok) return null;
  const exported = toTu4(program.value);
  return exported.ok ? exported.value : null;
}
