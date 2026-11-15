import { describe, expect, it } from 'vitest';
import { NoSuchCommandError, OutOfTapeError } from '../src/core/errors';
import { parseProgram } from '../src/core/parser';
import { createProgram } from '../src/core/program';
import { DEFAULT_MAX_HISTORY, MachineRun } from '../src/core/run';

const start = (program: string, tape: string): MachineRun =>
  new MachineRun(createProgram(parseProgram(program)), tape);

/**
 * The program from the built-in help. It starts by moving left, so the tape
 * needs at least one cell to the left of the data (leading space) — the tape
 * is limited at the left edge and is not padded automatically.
 */
const SWAP = `
  00, ,<,rep
  rep,0,1,mov  rep,1,0,mov  rep, ,>,fin  // rewrite the cell
  mov,0,<,rep  mov,1,<,rep               // step left
  fin,0,>,fin  fin,1,>,fin  fin, ,#,fin   // move after the word
`;

describe('MachineRun', () => {
  it('starts with the head after the last symbol', () => {
    const run = start('0, ,#,0', '101');
    expect(run.headPosition).toBe(3);
    expect(run.currentSymbol).toBe(' ');
    expect(run.isRunning).toBe(true);
  });

  it('swaps 0 and 1 following the help example', () => {
    const run = start(SWAP, ' 0110');
    while (run.isRunning) run.step();
    expect(run.tapeText.replace(/\s+$/, '')).toBe(' 1001');
  });

  it('halts on # and clears nextCommand', () => {
    const run = start('0, ,#,0', '');
    expect(run.step()).toBe(true);
    expect(run.isRunning).toBe(false);
    expect(run.nextCommand).toBeUndefined();
    expect(run.step()).toBe(false);
  });

  it('writes symbols, moves the head, and tracks cellsUsed even when only moving right', () => {
    const run = start('0, ,>,1  1, ,a,2  2,a,>,3  3, ,>,4  4, ,<,1', '');
    expect(run.cellsUsed).toBe(1);
    run.step(); // move right to pos 1
    expect(run.cellsUsed).toBe(2);
    run.step(); // write 'a' at pos 1
    expect(run.currentSymbol).toBe('a');
    expect(run.tapeText).toBe(' a');
    expect(run.cellsUsed).toBe(2);
    run.step(); // move right to pos 2
    run.step(); // move right to pos 3 (without writing)
    expect(run.headPosition).toBe(3);
    expect(run.cellsUsed).toBe(4);
    expect(run.tapeText).toBe(' a  ');
    run.step(); // move left to pos 2
    expect(run.headPosition).toBe(2);
    expect(run.cellsUsed).toBe(4);
    // Visited blank cells stay materialised so the tape display does not shrink.
    expect(run.tapeText).toBe(' a  ');
  });

  it('keeps the initial head cell when stepping left immediately (matches v2.3)', () => {
    const run = start(SWAP, ' 0110');
    expect(run.tapeText).toBe(' 0110 ');
    run.step(); // moves left from pos 5 to pos 4
    expect(run.headPosition).toBe(4);
    expect(run.tapeText).toBe(' 0110 ');
    expect(run.cellsUsed).toBe(6);
  });

  it('moves and halts when a === v === < and q === w (matches v2.3)', () => {
    const run = start('0, ,<,0  0,<,<,0', '<');
    run.step(); // pos 1 -> pos 0, reads '<'
    expect(run.isRunning).toBe(true);
    expect(run.currentSymbol).toBe('<');
    // At pos 0, moving left throws OutOfTapeError even though a === v && q === w.
    expect(() => run.step()).toThrow(OutOfTapeError);

    const run2 = start('0, ,<,0  0,<,<,0', ' <');
    run2.step(); // pos 2 -> pos 1, reads '<'
    run2.step(); // moves left to pos 0 AND halts
    expect(run2.headPosition).toBe(0);
    expect(run2.isRunning).toBe(false);
  });

  it('throws OutOfTapeError when moving left from the first cell', () => {
    const run = start('0, ,<,0', '');
    expect(() => run.step()).toThrow(OutOfTapeError);
  });

  it('throws NoSuchCommandError for an undefined transition', () => {
    const run = start('0,1,>,0', '');
    expect(() => run.step()).toThrow(NoSuchCommandError);
  });

  it('treats a no-op write as a stay', () => {
    const run = start('0, , ,1  1, ,#,1', '');
    run.step();
    expect(run.currentState).toBe(1);
    expect(run.headPosition).toBe(0);
  });

  it('reports sourceAltered for the in-place SWAP example', () => {
    // The help example replaces 0 and 1 *in place* ("ненормированная замена"):
    // source ' 0110' is overwritten with ' 1001', so normality reports sourceAltered.
    const run = start(SWAP, ' 0110');
    while (run.isRunning) run.step();
    expect(run.tapeText.replace(/\s+$/, '')).toBe(' 1001');
    expect(run.checkNormality()).toBe('sourceAltered');
  });

  it('reports normal finish when source data is retained with a separating space', () => {
    // Input '101', skip the separating blank cell, write '0', move right and halt.
    const run = start('0, ,>,1  1, ,0,2  2,0,>,3  3, ,#,3', '101');
    while (run.isRunning) run.step();
    expect(run.tapeText.replace(/\s+$/, '')).toBe('101 0');
    expect(run.headPosition).toBe(5);
    expect(run.checkNormality()).toBe('normal');
  });

  it('reports sourceAltered when output overwrites the separating space after source', () => {
    // Input '101', write '0' directly at pos 3 (producing '1010' with no space):
    // matches original jstu4 v2.3 where initialTape() includes the trailing space.
    const run = start('0, ,0,1  1,0,>,2  2, ,#,2', '101');
    while (run.isRunning) run.step();
    expect(run.tapeText.replace(/\s+$/, '')).toBe('1010');
    expect(run.checkNormality()).toBe('sourceAltered');
  });

  it('reports normal finish for an immediate halt on empty input', () => {
    const run = start('0, ,#,0', '');
    run.step();
    expect(run.checkNormality()).toBe('normal');
  });

  it('detects altered source data', () => {
    // Write 'x' over the first non-space cell, then stop after the word.
    const run = start('0, ,<,a  a,1,x,a  a,x,>,a  a, ,>,b  b,0,>,b  b, ,#,b', '101');
    while (run.isRunning) run.step();
    expect(run.checkNormality()).toBe('sourceAltered');
  });

  it('detects a misplaced head at the end of the run', () => {
    // Leave source intact but halt before the end of the word.
    const run = start('0, ,<,a  a,1,1,a  a, ,<,b  b,0,>,c  c,0,>,c  c, ,#,c', '101');
    while (run.isRunning) run.step();
    expect(run.checkNormality()).toBe('misplaced');
  });

  it('counts performed steps, including the halting one', () => {
    const run = start('0, ,#,0', '');
    run.step();
    expect(run.stepsCount).toBe(1);
  });

  it('reverses every step losslessly with stepBack() from halt all the way back to step 0', () => {
    const run = start('0, ,>,1  1, ,0,2  2,0,>,3  3, ,1,4  4,1,<,5  5,0,=,6  6,0,#,6', 'ab');

    type Snapshot = {
      readonly tapeText: string;
      readonly headPosition: number;
      readonly currentState: string | number;
      readonly cellsUsed: number;
      readonly stepsCount: number;
      readonly isRunning: boolean;
      readonly nextOffset: number | undefined;
    };

    const snap = (): Snapshot => ({
      tapeText: run.tapeText,
      headPosition: run.headPosition,
      currentState: run.currentState,
      cellsUsed: run.cellsUsed,
      stepsCount: run.stepsCount,
      isRunning: run.isRunning,
      nextOffset: run.nextCommand?.source.offset,
    });

    const snapshots: Snapshot[] = [snap()];
    while (run.isRunning) {
      run.step();
      snapshots.push(snap());
    }

    expect(run.isRunning).toBe(false);
    expect(run.canStepBack).toBe(true);
    expect(run.stepsCount).toBe(snapshots.length - 1);

    for (let i = snapshots.length - 2; i >= 0; i -= 1) {
      expect(run.stepBack()).not.toBeNull();
      expect(snap()).toEqual(snapshots[i]);
    }

    expect(run.isAtStart).toBe(true);
    expect(run.canStepBack).toBe(false);
    expect(run.stepBack()).toBeNull();
  });

  it('recovers cleanly via stepBack() after a runtime OutOfTapeError or NoSuchCommandError', () => {
    const run = start('0, ,<,0  0,a,<,0', 'a');
    run.step(); // pos 1 -> 0 (symbol 'a')
    expect(() => run.step()).toThrow(OutOfTapeError);
    expect(run.isRunning).toBe(false);
    expect(run.stepsCount).toBe(1);
    expect(run.canStepBack).toBe(true);

    expect(run.stepBack()).not.toBeNull();
    expect(run.isRunning).toBe(true);
    expect(run.headPosition).toBe(1);
    expect(run.stepsCount).toBe(0);

    const run2 = start('0, ,>,1  1,a,#,1', 'x');
    run2.step(); // state 0 -> 1, symbol ' ' has no transition
    expect(() => run2.step()).toThrow(NoSuchCommandError);
    expect(run2.isRunning).toBe(false);
    expect(run2.stepBack()).not.toBeNull();
    expect(run2.isRunning).toBe(true);
    expect(run2.currentState).toBe(0);
    expect(run2.stepsCount).toBe(0);
  });

  it('resets completely to initial state and tape with reset()', () => {
    const run = start('0, ,>,1  1, ,X,2  2,X,#,2', 'hi');
    while (run.isRunning) run.step();
    expect(run.isRunning).toBe(false);
    expect(run.stepsCount).toBe(3);

    run.reset();
    expect(run.isRunning).toBe(true);
    expect(run.isAtStart).toBe(true);
    expect(run.canStepBack).toBe(false);
    expect(run.stepsCount).toBe(0);
    expect(run.currentState).toBe(0);
    expect(run.headPosition).toBe(2);
    expect(run.tapeText).toBe('hi ');
    expect(run.cellsUsed).toBe(3);
  });

  it('bounds undo history with an O(1) ring buffer across wrap-around, stepBack, and reset', () => {
    const program = createProgram(parseProgram('0, ,>,1  1, ,a,2  2,a,>,0'));
    const run = new MachineRun(program, '', { maxHistory: 5 });

    expect(run.historyLimit).toBe(5);
    expect(run.historyLength).toBe(0);
    expect(run.isHistoryTruncated).toBe(false);

    type StateSnap = {
      readonly tapeText: string;
      readonly headPosition: number;
      readonly currentState: string | number;
      readonly cellsUsed: number;
      readonly stepsCount: number;
    };
    const snap = (): StateSnap => ({
      tapeText: run.tapeText,
      headPosition: run.headPosition,
      currentState: run.currentState,
      cellsUsed: run.cellsUsed,
      stepsCount: run.stepsCount,
    });

    const states: StateSnap[] = [snap()];
    for (let i = 0; i < 12; i += 1) {
      run.step();
      states.push(snap());
    }

    expect(run.stepsCount).toBe(12);
    expect(run.historyLength).toBe(5);
    expect(run.isHistoryTruncated).toBe(true);
    expect(run.canStepBack).toBe(true);

    // Undo the most recent 3 steps, then advance 2 more to exercise ring wrap-around after pop
    for (let s = 11; s >= 9; s -= 1) {
      expect(run.stepBack()).not.toBeNull();
      expect(snap()).toEqual(states[s]);
    }
    expect(run.historyLength).toBe(2);

    run.step();
    run.step();
    expect(run.stepsCount).toBe(11);
    expect(run.historyLength).toBe(4);

    // Undo all 4 retained steps down to the ring boundary (step 7)
    for (let s = 10; s >= 7; s -= 1) {
      expect(run.stepBack()).not.toBeNull();
      expect(snap()).toEqual(states[s]);
    }

    expect(run.stepsCount).toBe(7);
    expect(run.historyLength).toBe(0);
    expect(run.canStepBack).toBe(false);
    expect(run.isAtStart).toBe(false);
    expect(run.isHistoryTruncated).toBe(true);
    expect(run.stepBack()).toBeNull();

    // Reset clears truncation and restores step 0
    run.reset();
    expect(run.stepsCount).toBe(0);
    expect(run.historyLength).toBe(0);
    expect(run.isAtStart).toBe(true);
    expect(run.isHistoryTruncated).toBe(false);
  });

  it('supports maxHistory: 0 and exposes DEFAULT_MAX_HISTORY', () => {
    expect(DEFAULT_MAX_HISTORY).toBe(100_000);
    const program = createProgram(parseProgram('0, ,>,0'));
    const run = new MachineRun(program, '', { maxHistory: 0 });
    run.step();
    expect(run.stepsCount).toBe(1);
    expect(run.historyLength).toBe(0);
    expect(run.canStepBack).toBe(false);
    expect(run.isHistoryTruncated).toBe(true);
    expect(run.stepBack()).toBeNull();
  });

  it('exposes zero-copy tapeCells and tracks dirty indices across write, stepBack, overflow, and reset', () => {
    const program = createProgram(
      parseProgram(
        [
          '0, ,<,1',
          '1,a,a,2', // no-op write (same symbol)
          '2,a,b,3', // actual write at index 0
          '3,b,>,4',
          '4, ,c,5', // actual write at index 1
          '5,c,>,6',
          '6, ,d,5', // loop writing to the right
        ].join('\n'),
      ),
    );
    const run = new MachineRun(program, 'a');

    expect(run.tapeCells).toEqual(['a', ' ']);
    expect(run.consumeDirtyCells()).toEqual([]);

    // Step 1: move left -> no cell content changed
    run.step();
    expect(run.consumeDirtyCells()).toEqual([]);

    // Step 2: write 'a' over 'a' -> no-op, not dirty
    run.step();
    expect(run.consumeDirtyCells()).toEqual([]);

    // Step 3: write 'b' over 'a' at index 0 -> dirty [0]
    run.step();
    expect(run.tapeCells).toEqual(['b', ' ']);
    expect(run.consumeDirtyCells()).toEqual([0]);
    // Second drain with no changes returns empty
    expect(run.consumeDirtyCells()).toEqual([]);

    // Step 4 (move right) + Step 5 (write 'c' at index 1) batched
    run.step();
    run.step();
    expect(run.tapeCells).toEqual(['b', 'c']);
    expect(run.consumeDirtyCells()).toEqual([1]);

    // Step back undoes write 'c' -> dirty [1]
    run.stepBack();
    expect(run.tapeCells).toEqual(['b', ' ']);
    expect(run.consumeDirtyCells()).toEqual([1]);

    // Reset forces a full sync (`null`) and restores initial cells
    run.reset();
    expect(run.tapeCells).toEqual(['a', ' ']);
    expect(run.consumeDirtyCells()).toBeNull();
    expect(run.consumeDirtyCells()).toEqual([]);

    // More than 256 writes without consuming coalesces to `null` (bounded memory)
    const writer = createProgram(parseProgram('0, ,1,1  1,1,0,2  2,0,1,1'));
    const busy = new MachineRun(writer, '');
    for (let i = 0; i < 300; i += 1) busy.step();
    expect(busy.consumeDirtyCells()).toBeNull();
    expect(busy.consumeDirtyCells()).toEqual([]);
  });

  it('grows the SoA undo buffer past its initial 256 capacity and rewinds every step accurately', () => {
    const program = createProgram(parseProgram('0, ,a,1  1,a,>,2  2, ,b,3  3,b,>,0'));
    const run = new MachineRun(program, '', { maxHistory: 1000 });
    const totalSteps = 600;

    for (let i = 0; i < totalSteps; i += 1) {
      expect(run.step()).toBe(true);
    }
    expect(run.stepsCount).toBe(totalSteps);
    expect(run.historyLength).toBe(totalSteps);
    expect(run.isHistoryTruncated).toBe(false);
    expect(run.cellsUsed).toBe(301);

    for (let i = totalSteps; i > 0; i -= 1) {
      expect(run.stepBack()).not.toBeNull();
    }
    expect(run.stepsCount).toBe(0);
    expect(run.historyLength).toBe(0);
    expect(run.isAtStart).toBe(true);
    expect(run.tapeText).toBe(' ');
    expect(run.headPosition).toBe(0);
    expect(run.currentState).toBe(0);
  });

  it('evaluates checkNormality() accurately with non-BMP Unicode symbols on the tape', () => {
    // '🚀' is 2 UTF-16 code units but 1 tape cell; head starts on the trailing blank at cell 2
    const normalRun = start('0, ,>,1  1, ,🎯,2  2,🎯,>,3  3, ,#,3', '🚀a');
    expect(normalRun.initialLength).toBe(2);
    while (normalRun.isRunning) normalRun.step();
    expect(normalRun.headPosition).toBe(4);
    expect(normalRun.checkNormality()).toBe('normal');

    // Head finishes on the written non-BMP symbol instead of the blank right after it
    const misplacedRun = start('0, ,>,1  1, ,🎯,2  2,🎯,#,2', '🚀a');
    while (misplacedRun.isRunning) misplacedRun.step();
    expect(misplacedRun.checkNormality()).toBe('misplaced');

    // Initial non-BMP prefix altered
    const alteredRun = start('0, ,<,1  1,a,b,2  2,b,>,3  3, ,#,3', '🚀a');
    while (alteredRun.isRunning) alteredRun.step();
    expect(alteredRun.checkNormality()).toBe('sourceAltered');
  });
});
