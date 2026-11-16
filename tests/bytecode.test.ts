import { describe, expect, it } from 'vitest';
import {
  compileProgramBytecode,
  lookupTransitionByValue,
  lookupTransitionIndex,
  OP_FLAG_HALT,
  OP_HALT,
  OP_LEFT,
  OP_MASK,
  OP_RIGHT,
  OP_STAY,
  OP_WRITE,
} from '../src/core/bytecode';
import { parseProgram } from '../src/core/parser';
import { createProgram, findTransition } from '../src/core/program';
import { MachineRun } from '../src/core/run';
import { expectErr, expectOk } from './helpers/result';

const SWAP = [
  '00, ,<,rep',
  'rep,0,1,mov  rep,1,0,mov  rep, ,>,fin',
  'mov,0,<,rep  mov,1,<,rep',
  'fin,0,>,fin  fin,1,>,fin  fin, ,#,fin',
].join('\n');

describe('linear-memory bytecode & execution engine', () => {
  it('packs all command and dense transition views into one contiguous ArrayBuffer', () => {
    const cmds = expectOk(parseProgram(SWAP));
    const program = expectOk(createProgram(cmds, 0));
    const bc = program.bytecode;

    expect(bc.transitionMode).toBe('dense');
    expect(bc.commandCount).toBe(cmds.length);
    expect(bc.stateCount).toBe(4);
    expect(bc.idToState[0]).toBe(0);
    expect(bc.idToSym[0]).toBe(' ');

    // Every runtime TypedArray shares the exact same contiguous ArrayBuffer.
    expect(bc.cmdFrom.buffer).toBe(bc.buffer);
    expect(bc.cmdNext.buffer).toBe(bc.buffer);
    expect(bc.cmdWrite.buffer).toBe(bc.buffer);
    expect(bc.cmdMeta.buffer).toBe(bc.buffer);
    expect(bc.denseTransitions?.buffer).toBe(bc.buffer);

    // Packed operation codes and halt flag match command semantics.
    expect(bc.cmdMeta[0]! & OP_MASK).toBe(OP_LEFT);
    expect(bc.cmdMeta[0]! & OP_FLAG_HALT).toBe(0);
    expect(bc.cmdMeta[1]! & OP_MASK).toBe(OP_WRITE);
    expect(bc.cmdMeta[6]! & OP_MASK).toBe(OP_RIGHT);
    const haltMeta = bc.cmdMeta[cmds.length - 1]!;
    expect(haltMeta & OP_FLAG_HALT).toBe(OP_FLAG_HALT);
  });

  it('produces identical results in dense and sparse CSR modes across forward, stepBack, and reset', () => {
    const cmds = expectOk(parseProgram(SWAP));
    const denseProgram = expectOk(createProgram(cmds, 0));
    const sparseProgram = expectOk(createProgram(cmds, 0, { denseLimit: 0 }));

    expect(denseProgram.bytecode.transitionMode).toBe('dense');
    expect(sparseProgram.bytecode.transitionMode).toBe('sparse');
    expect(sparseProgram.bytecode.denseTransitions).toBeNull();
    expect(sparseProgram.bytecode.csrRowOffset.buffer).toBe(sparseProgram.bytecode.buffer);
    expect(sparseProgram.bytecode.csrColSym.buffer).toBe(sparseProgram.bytecode.buffer);
    expect(sparseProgram.bytecode.csrCmdIdx.buffer).toBe(sparseProgram.bytecode.buffer);

    const runDense = new MachineRun(denseProgram, ' 0110');
    const runSparse = new MachineRun(sparseProgram, ' 0110');

    while (runDense.isRunning) {
      expect(runSparse.nextCommandIndex).toBe(runDense.nextCommandIndex);
      expectOk(runDense.step());
      expectOk(runSparse.step());
      expect(runSparse.tapeText).toBe(runDense.tapeText);
      expect(runSparse.headPosition).toBe(runDense.headPosition);
      expect(runSparse.currentState).toBe(runDense.currentState);
    }

    expect(runSparse.isRunning).toBe(false);
    expect(runSparse.tapeText).toBe(' 1001 ');
    expect(runSparse.stepsCount).toBe(15);

    // Rewind completely via stepBackIndex() and confirm step-by-step parity.
    while (runDense.canStepBack) {
      expect(runSparse.stepBackIndex()).toBe(runDense.stepBackIndex());
      expect(runSparse.tapeText).toBe(runDense.tapeText);
      expect(runSparse.headPosition).toBe(runDense.headPosition);
      expect(runSparse.currentState).toBe(runDense.currentState);
    }
    expect(runSparse.isAtStart).toBe(true);
    expect(runSparse.tapeText).toBe(' 0110 ');
  });

  it('handles sparse CSR heapsort (> 32 symbols in one state) and binary search lookups', () => {
    // 50 distinct symbols in reversed order so the heapsort path (`len > 32`) is exercised.
    const symbols = Array.from({ length: 50 }, (_, i) => String.fromCharCode(65 + i)).reverse();
    const source = [...symbols.map((ch) => `0,${ch},${ch},1`), '1, ,#,1'].join('\n');
    const cmds = expectOk(parseProgram(source));
    const program = expectOk(createProgram(cmds, 0, { denseLimit: 0 }));

    expect(program.bytecode.transitionMode).toBe('sparse');
    for (let i = 0; i < symbols.length; i += 1) {
      const ch = symbols[i]!;
      const found = findTransition(program, 0, ch);
      expect(found?.a).toBe(ch);
      expect(program.bytecode.cmdMeta[i]! & OP_MASK).toBe(OP_STAY);
    }
    expect(program.bytecode.cmdMeta[symbols.length]! & OP_MASK).toBe(OP_HALT);
    expect(findTransition(program, 0, '!')).toBeUndefined();
    expect(lookupTransitionByValue(program.bytecode, 0, '!')).toBe(-1);
    expect(lookupTransitionIndex(program.bytecode, 0, 9999)).toBe(-1);
  });

  it('reports the earliest ambiguous command in source order in both dense and sparse modes', () => {
    // State `a` duplicates at indices (0, 3), while state `b` duplicates earlier at indices (1, 2).
    const source = [
      'a,0,>,b', // 0
      'b,1,>,a', // 1 (original for earliest duplicate)
      'b,1,<,a', // 2 (earliest duplicate!)
      'a,0,<,b', // 3
      'b,1,#,b', // 4 (third duplicate for b,1)
    ].join('\n');
    const cmds = expectOk(parseProgram(source));

    const denseErr = expectErr(compileProgramBytecode(cmds, 'a'));
    const sparseErr = expectErr(compileProgramBytecode(cmds, 'a', { denseLimit: 0 }));

    expect(denseErr.kind).toBe('ambiguousCommand');
    expect(sparseErr).toEqual(denseErr);
    if (sparseErr.kind === 'ambiguousCommand') {
      expect(sparseErr.original).toBe(cmds[1]);
      expect(sparseErr.command).toBe(cmds[2]);
    }
  });

  it('supports tape symbols absent from the program (including non-BMP emoji) and reports exact NoSuchCommandError', () => {
    const program = expectOk(createProgram(expectOk(parseProgram('0, ,<,0')), 0));
    const run = new MachineRun(program, '🚀x');

    // Initial tape contains '🚀' and 'x', neither in program alphabet (`[' ']`).
    expect(run.tapeView.length).toBe(3);
    expect(run.tapeView.symbolAt(0)).toBe('🚀');
    expect(run.tapeView.symbolAt(1)).toBe('x');
    expect(run.tapeView.symbolAt(2)).toBe(' ');

    // Step 1 moves left onto 'x' -> next step fails with NoSuchCommandError for 'x'.
    expectOk(run.step());
    expect(run.currentSymbol).toBe('x');
    const err = expectErr(run.step());
    expect(err).toEqual({ kind: 'noSuchCommand', state: 0, symbol: 'x' });
  });

  it('clears stale tape cells when stepping right after stepBack trims written tail cells', () => {
    const program = expectOk(
      createProgram(expectOk(parseProgram('0, ,>,1  1, ,X,2  2,X,<,3  3, ,>,4  4, ,#,4')), 0),
    );
    const run = new MachineRun(program, '');

    // Step 1: move right (len 1 -> 2), Step 2: write 'X' at index 1.
    expectOk(run.step());
    expectOk(run.step());
    expect(run.tapeText).toBe(' X');

    // Undo both steps back to len 1, then move right again via step 1: index 1 must be blank ' ', NOT stale 'X'.
    expect(run.stepBackIndex()).toBe(1);
    expect(run.stepBackIndex()).toBe(0);
    expect(run.tapeText).toBe(' ');

    expectOk(run.step());
    expect(run.tapeText).toBe('  ');
    expect(run.tapeView.symbolAt(1)).toBe(' ');
  });

  it('compiles a 5,000-state sparse program compactly and rewinds 5,000+ steps losslessly', () => {
    const lines: string[] = [];
    const n = 5_000;
    for (let i = 0; i < n - 1; i += 1) {
      lines.push(`${i}, ,>,${i + 1}`);
    }
    lines.push(`${n - 1}, ,#,${n - 1}`);

    const cmds = expectOk(parseProgram(lines.join('\n')));
    // Force sparse CSR mode to exercise large-state linear memory (5,000 states × 1 symbol = 5,000).
    const program = expectOk(createProgram(cmds, 0, { denseLimit: 100 }));
    expect(program.bytecode.transitionMode).toBe('sparse');
    // 5,000 commands + CSR row/col/cmd fit in ~125 KB of linear memory.
    expect(program.bytecode.buffer.byteLength).toBeLessThan(140_000);

    const run = new MachineRun(program, '');
    while (run.isRunning) expectOk(run.step());
    expect(run.stepsCount).toBe(n);
    expect(run.cellsUsed).toBe(n); // grew past RESET_SHRINK_THRESHOLD (4096)

    // Rewind all 5,000 steps via zero-GC TypedArray UndoHistory.
    let undone = 0;
    while (run.stepBackIndex() >= 0) undone += 1;
    expect(undone).toBe(n);
    expect(run.isAtStart).toBe(true);
    expect(run.tapeText).toBe(' ');

    // Grow again and reset() to exercise oversized tape shrink.
    while (run.isRunning) expectOk(run.step());
    run.reset();
    expect(run.cellsUsed).toBe(1);
    expect(run.tapeText).toBe(' ');
    expectOk(run.step());
    expect(run.headPosition).toBe(1);
  });
});
