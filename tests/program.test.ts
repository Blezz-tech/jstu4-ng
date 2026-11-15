import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/core/parser';
import { createProgram, findTransition } from '../src/core/program';
import { expectErr, expectOk } from './helpers/result';

const tryCompile = (text: string, q0?: number | string) =>
  createProgram(expectOk(parseProgram(text)), q0);

const compile = (text: string, q0?: number | string) => expectOk(tryCompile(text, q0));

describe('createProgram', () => {
  it('uses the state of the first command as the initial state by default', () => {
    expect(compile('5,0,>,6  6,0,>,5').initialState).toBe(5);
  });

  it('accepts an explicit initial state', () => {
    expect(compile('0,0,>,1  1,0,>,0', 1).initialState).toBe(1);
  });

  it('treats 01 and 1 as the same state', () => {
    const program = compile('01,0,>,1  1,1,<,1');
    // Both commands belong to state "1", so one state entry with two symbols.
    expect(program.commands[0]?.q).toBe(1);
    expect(program.transitions.size).toBe(1);
    expect(program.transitions.get(1)?.size).toBe(2);
  });

  it('rejects an empty program', () => {
    expect(expectErr(tryCompile('  # only a comment\n'))).toEqual({ kind: 'emptyProgram' });
  });

  it('rejects ambiguous transitions', () => {
    const error = expectErr(tryCompile('0,1,>,1  0,1,<,1  1,0,>,1'));
    expect(error.kind).toBe('ambiguousCommand');
    if (error.kind === 'ambiguousCommand') {
      expect(error.original.v).toBe('>');
      expect(error.command.v).toBe('<');
    }
  });

  it('rejects a nonexistent initial state', () => {
    expect(expectErr(tryCompile('0,1,>,1  1,0,>,1', 7))).toEqual({
      kind: 'nonexistentInitialState',
      state: 7,
    });
  });

  it('rejects nonexistent target states', () => {
    const error = expectErr(tryCompile('0,1,>,nope'));
    expect(error.kind).toBe('nonexistentTargetState');
    if (error.kind === 'nonexistentTargetState') {
      expect(error.command.w).toBe('nope');
    }
  });

  it('indexes transitions by state and symbol without key collisions', () => {
    const program = compile('1,0,>,1  01,1,<,1');
    expect(findTransition(program, 1, '0')?.v).toBe('>');
    expect(findTransition(program, 1, '1')?.v).toBe('<');
    expect(findTransition(program, 2, '0')).toBeUndefined();
  });

  it('does not confuse named states with numeric ones', () => {
    const program = compile('0,0,>,0  a,0,>,a');
    expect(findTransition(program, 'a', '0')?.q).toBe('a');
    expect(findTransition(program, 1, '0')).toBeUndefined();
  });

  it('allows Object.prototype property names as state names without colliding', () => {
    const program = compile('0, ,>,toString  toString, ,>,constructor  constructor, ,#,0', 0);
    expect(findTransition(program, 'toString', ' ')?.w).toBe('constructor');
    expect(findTransition(program, 'constructor', ' ')?.isHalt).toBe(true);
    expect(findTransition(program, 'valueOf', ' ')).toBeUndefined();
  });
});
