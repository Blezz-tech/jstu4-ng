import type { Command, StateId } from './machine';

/** The program text could not be parsed as a command. */
export interface ParseError {
  readonly kind: 'parseError';
  readonly offset: number;
  readonly text: string;
}

/** The program contains no commands at all (so the initial state is unknown). */
export interface EmptyProgramError {
  readonly kind: 'emptyProgram';
}

/** Two or more commands share the same `q` and `a`. */
export interface AmbiguousCommandError {
  readonly kind: 'ambiguousCommand';
  readonly command: Command;
  readonly original: Command;
}

/** A state referenced as a target state has no outgoing transitions. */
export interface NonexistentTargetStateError {
  readonly kind: 'nonexistentTargetState';
  readonly command: Command;
}

/** The initial state has no outgoing transitions. */
export interface NonexistentInitialStateError {
  readonly kind: 'nonexistentInitialState';
  readonly state: StateId;
}

/** Runtime: the head moved to the left of the tape. */
export interface OutOfTapeError {
  readonly kind: 'outOfTape';
  readonly command: Command;
}

/** Runtime: the transition for the current state and symbol is undefined. */
export interface NoSuchCommandError {
  readonly kind: 'noSuchCommand';
  readonly state: StateId;
  readonly symbol: string;
}

/** Export: the program exceeds the 256-state TU4 format limit. */
export interface TooManyStatesError {
  readonly kind: 'tooManyStates';
  readonly count: number;
  readonly limit: number;
}

/** Validation errors returned by {@link createProgram}. */
export type ProgramValidationError =
  | EmptyProgramError
  | AmbiguousCommandError
  | NonexistentTargetStateError
  | NonexistentInitialStateError;

/** All errors that can occur while parsing or validating a program. */
export type CompileError = ParseError | ProgramValidationError;

/** All errors that can occur during machine execution. */
export type RuntimeError = OutOfTapeError | NoSuchCommandError;

/** All errors that can occur during TU4 export. */
export type Tu4Error = TooManyStatesError;

/** Discriminated union of all domain errors produced by the emulator core. */
export type MachineError = CompileError | RuntimeError | Tu4Error;
