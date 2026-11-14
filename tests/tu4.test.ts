import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/core/parser';
import { createProgram } from '../src/core/program';
import { convertTextToTu4, toTu4 } from '../src/core/tu4';

const compile = (text: string, q0?: number | string) => createProgram(parseProgram(text), q0);

describe('toTu4', () => {
  it('renames states to two-digit hex numbers in order of appearance', () => {
    const program = compile('rep,0,1,mov  mov,0,<,rep  rep, ,>,fin  fin, ,#,fin');
    expect(toTu4(program)).toBe(['00,0,1,01', '01,0,<,00', '00, ,>,02', '02, ,#,02'].join('\n'));
  });

  it('keeps the initial state at 00 even when it is not the first command', () => {
    const program = compile('fin, ,#,fin  mov,0,<,rep  rep, ,>,fin', 'rep');
    // Numbering follows the order of appearance: `rep` (the initial state,
    // not the first command) → 00, `fin` → 01, `mov` → 02. The initial state
    // keeps 00, which is what the TU4 format requires.
    expect(toTu4(program)).toBe(['01, ,#,01', '02,0,<,00', '00, ,>,01'].join('\n'));
  });

  it('produces a program that is parsed back to an equivalent machine', () => {
    const source = 'rep,0,1,mov  mov,0,<,rep  rep, ,>,fin  fin, ,#,fin';
    const converted = convertTextToTu4(source);

    expect(converted).not.toBeNull();
    const machine = compile(converted as string);
    // Digit-only state names are parsed back as decimal numbers, so `00`
    // becomes `0` and `01` becomes `1`: the machine is equivalent.
    expect(machine.commands.map((c) => c.toString())).toEqual([
      '0,0,1,1',
      '1,0,<,0',
      '0, ,>,2',
      '2, ,#,2',
    ]);
    expect(machine.initialState).toBe(0);
  });

  it('returns null for programs that do not compile', () => {
    expect(convertTextToTu4('garbage')).toBeNull();
    expect(convertTextToTu4('')).toBeNull();
  });
});
