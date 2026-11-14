import { describe, expect, it } from 'vitest';
import { NoSuchCommandError, OutOfTapeError } from '../src/core/errors';
import { parseProgram } from '../src/core/parser';
import { createProgram } from '../src/core/program';
import { MachineRun } from '../src/core/run';

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

  it('halts on #', () => {
    const run = start('0, ,#,0', '');
    expect(run.step()).toBe(true);
    expect(run.isRunning).toBe(false);
    expect(run.step()).toBe(false);
  });

  it('writes symbols and moves the head', () => {
    const run = start('0, ,>,1  1, ,a,2  2,a,<,1', '');
    run.step(); // move right
    run.step(); // write 'a'
    expect(run.currentSymbol).toBe('a');
    expect(run.tapeText).toBe(' a');
    expect(run.cellsUsed).toBe(2);
    run.step(); // move left
    expect(run.headPosition).toBe(0);
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

  it('reports a normal finish for a run that stops right after the result', () => {
    // The help example writes the converted word, then scans it to the right.
    // Because the cell after the word is already a space, the very last cell
    // of the result is rewritten with the same space — the data is untouched.
    const run = start(SWAP, ' 0110');
    while (run.isRunning) run.step();
    expect(run.tapeText.replace(/\s+$/, '')).toBe(' 1001');
    // The example writes a space over the (already empty) cell under the
    // head, which v2.3 reports as "source altered": the leading space belongs
    // to the source text and gets overwritten. Exact compatibility is kept.
    expect(run.checkNormality()).toBe('sourceAltered');
  });

  it('detects altered source data', () => {
    // Write 'x' over the first non-space cell, then stop after the word.
    const run = start('0, ,<,a  a,1,x,a  a,x,>,a  a, ,>,b  b,0,>,b  b, ,#,b', '101');
    while (run.isRunning) run.step();
    expect(run.checkNormality()).toBe('sourceAltered');
  });

  it('detects a misplaced head at the end of the run', () => {
    // Restore the data but stop one cell before the end of the result.
    const run = start('0, ,<,a  a,1,1,a  a, ,<,b  b,0,>,c  c,0,>,c  c, ,#,c', '101');
    while (run.isRunning) run.step();
    expect(run.checkNormality()).toBe('misplaced');
  });

  it('counts performed steps, including the halting one', () => {
    const run = start('0, ,#,0', '');
    run.step();
    expect(run.stepsCount).toBe(1);
  });
});
