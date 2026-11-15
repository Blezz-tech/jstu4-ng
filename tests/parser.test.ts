import { describe, expect, it } from 'vitest';
import { ParseError } from '../src/core/errors';
import { parseStateName } from '../src/core/machine';
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

  it('parses large programs in O(N) with exact offsets and re-entrant onCommand callbacks', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(`s${i}, ,>,s${i + 1} // step ${i}`);
    }
    const source = lines.join('\n');

    const commands = parseProgram(source);
    expect(commands).toHaveLength(5000);

    const last = commands.at(-1)!;
    expect(last.q).toBe('s4999');
    expect(last.w).toBe('s5000');
    expect(source.slice(last.source.offset, last.source.offset + last.source.text.length)).toBe(
      last.source.text,
    );

    // Nested parseProgram inside onCommand must not corrupt the outer regex cursor
    const nestedCounts: number[] = [];
    const outer = parseProgram('0, ,>,1\n1, ,#,1', {
      onCommand: () => {
        nestedCounts.push(parseProgram('a,0,1,b').length);
      },
    });
    expect(outer.map((c) => c.toString())).toEqual(['0, ,>,1', '1, ,#,1']);
    expect(nestedCounts).toEqual([1, 1]);
  });

  it('keeps huge numeric state names beyond MAX_SAFE_INTEGER as distinct strings and preserves surrogate pairs in ParseError snippets', () => {
    const big1 = '9007199254740993';
    const big2 = '9007199254740994';
    expect(parseStateName(big1)).toBe(big1);
    expect(parseStateName(big2)).toBe(big2);
    expect(parseStateName(big1)).not.toBe(parseStateName(big2));
    expect(parseStateName('007')).toBe(7);

    // 9 ASCII chars + non-BMP emoji + CRLF: slicing at 10 code points must not split the surrogate pair
    const broken = '123456789🚀\r\nmore';
    let caught: ParseError | null = null;
    try {
      parseProgram(broken);
    } catch (err) {
      if (err instanceof ParseError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught?.data.text).toBe('123456789🚀');
  });
});
