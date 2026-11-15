import { describe, expect, it } from 'vitest';
import { createCommand, formatCommand, parseStateName } from '../src/core/machine';
import { parseProgram } from '../src/core/parser';
import { expectErr, expectOk } from './helpers/result';

describe('createCommand & formatCommand', () => {
  const src = { text: 'raw', offset: 0 };

  it('classifies move, write, stay, and halt commands identically to v2.3', () => {
    const left = createCommand(0, '1', '<', 1, src);
    expect(left.kind).toBe('left');
    expect(left.isHalt).toBe(false);

    const right = createCommand(0, '1', '>', 1, src);
    expect(right.kind).toBe('right');
    expect(right.isHalt).toBe(false);

    const halt = createCommand(0, ' ', '#', 1, src);
    expect(halt.kind).toBe('halt');
    expect(halt.isHalt).toBe(true);

    const write = createCommand('rep', '0', '1', 'mov', src);
    expect(write.kind).toBe('write');
    expect(write.isHalt).toBe(false);
    expect(formatCommand(write)).toBe('rep,0,1,mov');

    const stayExplicit = createCommand(0, '0', '=', 1, src);
    expect(stayExplicit.kind).toBe('stay');
    expect(stayExplicit.isHalt).toBe(false);

    const noopStay = createCommand('rep', '0', '0', 'nxt', src);
    expect(noopStay.kind).toBe('stay');
    expect(noopStay.isHalt).toBe(false);

    const noopHalt = createCommand('rep', '0', '0', 'rep', src);
    expect(noopHalt.kind).toBe('halt');
    expect(noopHalt.isHalt).toBe(true);

    // Special v2.3 rule: a === v && q === w halts even for '<' or '>' after moving.
    const moveAndHalt = createCommand(0, '<', '<', 0, src);
    expect(moveAndHalt.kind).toBe('left');
    expect(moveAndHalt.isHalt).toBe(true);
  });
});

describe('parseProgram', () => {
  it('parses a single command with source metadata', () => {
    const [command] = expectOk(parseProgram('0,1,>,1'));
    expect(command?.q).toBe(0);
    expect(command?.a).toBe('1');
    expect(command?.v).toBe('>');
    expect(command?.w).toBe(1);
    expect(command?.source).toEqual({ text: '0,1,>,1', offset: 0 });
  });

  it('parses several commands separated by any whitespace', () => {
    const commands = expectOk(parseProgram('0,1,>,1\n1,1,<,0\t\t0, ,#,0'));
    expect(commands.map(formatCommand)).toEqual(['0,1,>,1', '1,1,<,0', '0, ,#,0']);
  });

  it('reports offsets that point at the command start', () => {
    const commands = expectOk(parseProgram('  0,1,>,1\n  1,1,<,0'));
    expect(commands.map((c) => c.source.offset)).toEqual([2, 12]);
  });

  it('skips shell and C-style comments', () => {
    const text = '# header\n0,1,>,1 // move\n1,1,<,0\n// trailing';
    expect(expectOk(parseProgram(text)).map(formatCommand)).toEqual(['0,1,>,1', '1,1,<,0']);
  });

  it('treats digit-only state names as numbers (01 === 1)', () => {
    const [command] = expectOk(parseProgram('01, ,>,10'));
    expect(command?.q).toBe(1);
    expect(command?.w).toBe(10);
  });

  it('keeps named states as strings', () => {
    const [command] = expectOk(parseProgram('rep,0,1,mov'));
    expect(command?.q).toBe('rep');
    expect(command?.w).toBe('mov');
  });

  it('supports spaces as tape symbols', () => {
    const [command] = expectOk(parseProgram('0, ,#,0'));
    expect(command?.a).toBe(' ');
    expect(command?.kind).toBe('halt');
  });

  it('calls onCommand for every parsed command in order', () => {
    const seen: string[] = [];
    expectOk(parseProgram('0,1,>,1 1,1,<,0', { onCommand: (c) => seen.push(formatCommand(c)) }));
    expect(seen).toEqual(['0,1,>,1', '1,1,<,0']);
  });

  it('returns an empty list for empty or whitespace-only text', () => {
    expect(expectOk(parseProgram(''))).toEqual([]);
    expect(expectOk(parseProgram('   \n\t  '))).toEqual([]);
  });

  it('returns a typed ParseError result with the offending snippet', () => {
    const error = expectErr(parseProgram('0,1,>,1 ??'));
    expect(error).toEqual({ kind: 'parseError', text: '??', offset: 8 });
  });

  it('succeeds with empty array on an empty program', () => {
    expect(parseProgram('')).toEqual({ ok: true, value: [] });
  });

  it('parses large programs in O(N) with exact offsets and re-entrant onCommand callbacks', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(`s${i}, ,>,s${i + 1} // step ${i}`);
    }
    const source = lines.join('\n');

    const commands = expectOk(parseProgram(source));
    expect(commands).toHaveLength(5000);

    const last = commands.at(-1)!;
    expect(last.q).toBe('s4999');
    expect(last.w).toBe('s5000');
    expect(source.slice(last.source.offset, last.source.offset + last.source.text.length)).toBe(
      last.source.text,
    );

    // Nested parseProgram inside onCommand must not corrupt the outer regex cursor
    const nestedCounts: number[] = [];
    const outer = expectOk(
      parseProgram('0, ,>,1\n1, ,#,1', {
        onCommand: () => {
          nestedCounts.push(expectOk(parseProgram('a,0,1,b')).length);
        },
      }),
    );
    expect(outer.map(formatCommand)).toEqual(['0, ,>,1', '1, ,#,1']);
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
    const error = expectErr(parseProgram(broken));
    expect(error.kind).toBe('parseError');
    expect(error.text).toBe('123456789🚀');
  });
});
