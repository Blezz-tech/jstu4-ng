import { describe, expect, it } from 'vitest';
import { ParseError } from '../src/core/errors';
import { parseProgram } from '../src/core/parser';

describe('parseProgram', () => {
  it('parses a single command with source metadata', () => {
    const [command] = parseProgram('0,1,>,1');
    expect(command?.q).toBe(0);
    expect(command?.a).toBe('1');
    expect(command?.v).toBe('>');
    expect(command?.w).toBe(1);
    expect(command?.source).toEqual({ text: '0,1,>,1', offset: 0 });
  });

  it('parses several commands separated by any whitespace', () => {
    const commands = parseProgram('0,1,>,1\n1,1,<,0\t\t0, ,#,0');
    expect(commands.map((c) => c.toString())).toEqual(['0,1,>,1', '1,1,<,0', '0, ,#,0']);
  });

  it('reports offsets that point at the command start', () => {
    const commands = parseProgram('  0,1,>,1\n  1,1,<,0');
    expect(commands.map((c) => c.source.offset)).toEqual([2, 12]);
  });

  it('skips shell and C-style comments', () => {
    const text = '# header\n0,1,>,1 // move\n1,1,<,0\n// trailing';
    expect(parseProgram(text).map((c) => c.toString())).toEqual(['0,1,>,1', '1,1,<,0']);
  });

  it('treats digit-only state names as numbers (01 === 1)', () => {
    const [command] = parseProgram('01, ,>,10');
    expect(command?.q).toBe(1);
    expect(command?.w).toBe(10);
  });

  it('keeps named states as strings', () => {
    const [command] = parseProgram('rep,0,1,mov');
    expect(command?.q).toBe('rep');
    expect(command?.w).toBe('mov');
  });

  it('supports spaces as tape symbols', () => {
    const [command] = parseProgram('0, ,#,0');
    expect(command?.a).toBe(' ');
    expect(command?.kind).toBe('halt');
  });

  it('calls onCommand for every parsed command in order', () => {
    const seen: string[] = [];
    parseProgram('0,1,>,1 1,1,<,0', { onCommand: (c) => seen.push(c.toString()) });
    expect(seen).toEqual(['0,1,>,1', '1,1,<,0']);
  });

  it('returns an empty list for empty or whitespace-only text', () => {
    expect(parseProgram('')).toEqual([]);
    expect(parseProgram('   \n\t  ')).toEqual([]);
  });

  it('throws ParseError with the offending snippet', () => {
    expect(() => parseProgram('0,1,>,1 ??')).toThrow(ParseError);
    try {
      parseProgram('0,1,>,1 ??');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).data.text).toBe('??');
      expect((error as ParseError).data.offset).toBe(8);
    }
  });

  it('never throws on an empty program', () => {
    expect(() => parseProgram('')).not.toThrow();
  });
});
