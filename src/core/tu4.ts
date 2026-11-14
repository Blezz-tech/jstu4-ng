import { Command, type StateId } from './machine';
import { stateKey } from './machine';
import type { Program } from './program';
import { parseProgram } from './parser';
import { createProgram } from './program';

/**
 * TU4 export: rename every state to a two-digit hexadecimal number
 * (`00`..`FF`) in the order of first appearance, keeping the initial state
 * as `00`. This is the on-disk format of the original `tu4` emulators, whose
 * programs may only use `00`..`FF` as state names.
 */
export function toTu4(program: Program): string {
  const names = new Map<string, number>();
  names.set(stateKey(program.initialState), 0);

  for (const command of program.commands) {
    if (!names.has(stateKey(command.q))) names.set(stateKey(command.q), names.size);
  }

  const nameOf = (state: StateId): string => {
    const value = names.get(stateKey(state));
    if (value === undefined) throw new Error(`Unknown state "${state}"`);
    if (value > 0xff) throw new RangeError('A TU4 program cannot have more than 256 states');
    return value.toString(16).toUpperCase().padStart(2, '0');
  };

  return program.commands
    .map((command) =>
      new Command(
        nameOf(command.q),
        command.a,
        command.v,
        nameOf(command.w),
        command.source,
      ).toString(),
    )
    .join('\n');
}

/**
 * Convenience helper: compile text and convert it to the TU4 format in one
 * call. Returns `null` instead of throwing when the program does not compile.
 */
export function convertTextToTu4(text: string): string | null {
  try {
    return toTu4(createProgram(parseProgram(text)));
  } catch {
    return null;
  }
}
