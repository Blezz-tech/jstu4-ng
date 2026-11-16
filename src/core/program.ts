import {
  compileProgramBytecode,
  type BytecodeCompileOptions,
  type CompiledBytecode,
} from './bytecode';
import type { ProgramValidationError } from './errors';
import type { Command, StateId } from './machine';
import { ok, type Result } from './result';

/** Immutable, validated machine program backed by flat linear-memory bytecode. */
export interface Program {
  /** The state the machine starts in. */
  readonly initialState: StateId;
  /** Transitions in program order. */
  readonly commands: readonly Command[];
  /** Compiled flat TypedArray bytecode & transition table inside one `ArrayBuffer`. */
  readonly bytecode: CompiledBytecode;
}

/**
 * Build a validated program from parsed commands, compiling transitions and
 * command records directly into contiguous linear-memory `TypedArray`s.
 *
 * @param commands parsed commands in source order
 * @param initialState requested initial state; when omitted, the state of the
 *   first command is used (same heuristic as the original emulator)
 */
export function createProgram(
  commands: readonly Command[],
  initialState?: StateId | null,
  options?: BytecodeCompileOptions,
): Result<Program, ProgramValidationError> {
  const compiled = compileProgramBytecode(commands, initialState, options);
  if (!compiled.ok) return compiled;
  return ok({
    initialState: compiled.value.initialState,
    commands: Object.freeze([...commands]),
    bytecode: compiled.value.bytecode,
  });
}
