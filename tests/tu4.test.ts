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

  it('uses decimal 00..98 when there are fewer than 100 states (matches v2.3)', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `s${i}, ,>,s${(i + 1) % 12}`).join('\n');
    const converted = toTu4(compile(lines));
    const rows = converted.split('\n');
    expect(rows[9]).toBe('09, ,>,10');
    expect(rows[10]).toBe('10, ,>,11');
    expect(rows[11]).toBe('11, ,>,00');
  });

  it('switches to two-digit hex 00..ff when there are 100..256 states', () => {
    const lines = Array.from({ length: 105 }, (_, i) => `s${i}, ,>,s${(i + 1) % 105}`).join('\n');
    const converted = toTu4(compile(lines));
    const rows = converted.split('\n');
    expect(rows[10]).toBe('0a, ,>,0b');
    expect(rows[104]).toBe('68, ,>,00');
  });

  it('throws RangeError when the program has more than 256 states', () => {
    const lines = Array.from({ length: 257 }, (_, i) => `s${i}, ,>,s${(i + 1) % 257}`).join('\n');
    expect(() => toTu4(compile(lines))).toThrow(RangeError);
  });

  it('returns null for programs that do not compile or exceed 256 states', () => {
    expect(convertTextToTu4('garbage')).toBeNull();
    expect(convertTextToTu4('')).toBeNull();
    const tooBig = Array.from({ length: 257 }, (_, i) => `s${i}, ,>,s${(i + 1) % 257}`).join('\n');
    expect(convertTextToTu4(tooBig)).toBeNull();
  });
});
