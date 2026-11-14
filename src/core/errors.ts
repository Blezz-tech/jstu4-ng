import type { Command, StateId } from './machine';

/** Symbols or states involved in an error, used by the message templates. */
export interface ParseErrorData {
  readonly offset: number;
  readonly text: string;
}

export interface AmbiguousCommandData {
  readonly command: Command;
  readonly original: Command;
}

export interface InitialStateErrorData {
  readonly state: StateId;
}

export interface NoSuchCommandData {
  readonly state: StateId;
  readonly symbol: string;
}

/** Base class for all errors produced by the emulator core. */
export abstract class MachineError extends Error {
  // `name` gives readable class names in stack traces and logs without the
  // `Object.setPrototypeOf` dance old ES5 error subclasses needed.
  name = 'MachineError';
}

/** The program text could not be parsed as a command. */
export class ParseError extends MachineError {
  name = 'ParseError';

  constructor(readonly data: ParseErrorData) {
    super(`Could not parse "${data.text}" at offset ${data.offset}`);
  }
}

/** The program contains no commands at all (so the initial state is unknown). */
export class EmptyProgramError extends MachineError {
  name = 'EmptyProgramError';

  constructor() {
    super('Program is empty');
  }
}

/** Two or more commands share the same `q` and `a`. */
export class AmbiguousCommandError extends MachineError {
  name = 'AmbiguousCommandError';

  constructor(readonly data: AmbiguousCommandData) {
    super(`Ambiguous transition for state "${data.command.q}" and symbol "${data.command.a}"`);
  }
}

/** A state referenced as a target state has no outgoing transitions. */
export class NonexistentTargetStateError extends MachineError {
  name = 'NonexistentTargetStateError';

  constructor(readonly data: { readonly command: Command }) {
    super(`Target state "${data.command.w}" does not exist`);
  }
}

/** The initial state has no outgoing transitions. */
export class NonexistentInitialStateError extends MachineError {
  name = 'NonexistentInitialStateError';

  constructor(readonly data: InitialStateErrorData) {
    super(`Initial state "${data.state}" does not exist`);
  }
}

/** Runtime: the head moved to the left of the tape. */
export class OutOfTapeError extends MachineError {
  name = 'OutOfTapeError';

  constructor(readonly data: { readonly command: Command | null } = { command: null }) {
    super('Head is out of tape');
  }
}

/** Runtime: the transition for the current state and symbol is undefined. */
export class NoSuchCommandError extends MachineError {
  name = 'NoSuchCommandError';

  constructor(readonly data: NoSuchCommandData) {
    super(`Transition is undefined for state "${data.state}" and symbol "${data.symbol}"`);
  }
}
