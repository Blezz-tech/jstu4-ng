import { describe, expect, it } from 'vitest';
import {
  AmbiguousCommandError,
  EmptyProgramError,
  NonexistentInitialStateError,
  NonexistentTargetStateError,
} from '../src/core/errors';
import { parseProgram } from '../src/core/parser';
import { createProgram, findTransition } from '../src/core/program';

const compile = (text: string, q0?: number | string) => createProgram(parseProgram(text), q0);

describe('createProgram', () => {
  it('uses the state of the first command as the initial state by default', () => {
    expect(compile('5,0,>,6  6,0,>,5').initialState).toBe(5);
  });

  it('accepts an explicit initial state', () => {
    expect(compile('0,0,>,1  1,0,>,0', 1).initialState).toBe(1);
  });

  it('treats 01 and 1 as the same state', () => {
    const program = compile('01,0,>,1  1,1,<,1');
    // Both commands belong to state "1", so a single map entry per symbol.
    expect(program.commands[0]?.q).toBe(1);
    expect(program.transitions.size).toBe(2);
  });

  it('rejects an empty program', () => {
    expect(() => compile('  # only a comment\n')).toThrow(EmptyProgramError);
  });

  it('rejects ambiguous transitions', () => {
    expect(() => compile('0,1,>,1  0,1,<,1  1,0,>,1')).toThrow(AmbiguousCommandError);
  });

  it('rejects a nonexistent initial state', () => {
    expect(() => compile('0,1,>,1  1,0,>,1', 7)).toThrow(NonexistentInitialStateError);
  });

  it('rejects nonexistent target states', () => {
    expect(() => compile('0,1,>,nope')).toThrow(NonexistentTargetStateError);
  });

  it('indexes transitions by state and symbol without key collisions', () => {
    const program = compile('1,0,>,1  01,1,<,1');
    expect(findTransition(program, 1, '0')?.v).toBe('>');
    expect(findTransition(program, 1, '1')?.v).toBe('<');
    expect(findTransition(program, 2, '0')).toBeUndefined();
  });

  it('does not confuse named states with numeric ones', () => {
    // Numeric states are keyed "0", named ones "#0" — no collision.
    const program = compile('0,0,>,0  a,0,>,a');
    expect(findTransition(program, 'a', '0')?.q).toBe('a');
    expect(findTransition(program, 1, '0')).toBeUndefined();
  });
});
