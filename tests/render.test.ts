// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/core/parser';
import { createProgram } from '../src/core/program';
import { MachineRun } from '../src/core/run';
import { TapeRenderer } from '../src/ui/render';

function readCells(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.cell'), (node) => node.textContent ?? '');
}

describe('TapeRenderer (zero-copy incremental updates)', () => {
  it('mounts cells, renders spaces as NBSP, and highlights the current head position', () => {
    const host = document.createElement('div');
    const renderer = new TapeRenderer();

    renderer.mount(host, ['0', ' ', '1', ' '], 3, 'Tape');

    expect(host.getAttribute('aria-label')).toBe('Tape');
    expect(host.querySelector('.tape-view')?.getAttribute('aria-label')).toBe('Tape');
    expect(readCells(host)).toEqual(['0', '\u00a0', '1', '\u00a0']);

    const cells = Array.from(host.querySelectorAll<HTMLSpanElement>('.cell'));
    expect(renderer.currentCell).toBe(cells[3]);
    expect(cells[3]?.classList.contains('current')).toBe(true);
    expect(cells[3]?.getAttribute('aria-current')).toBe('true');
  });

  it('updates only dirty indices in O(k) while preserving untouched cell DOM nodes', () => {
    const host = document.createElement('div');
    const renderer = new TapeRenderer();
    const cells = ['a', 'b', 'c', ' '];

    renderer.mount(host, cells, 3, 'Tape');
    const originalNodes = Array.from(host.querySelectorAll<HTMLSpanElement>('.cell'));

    // Mutate cell 1 and pass dirtyIndices=[1]
    cells[1] = 'X';
    renderer.update(cells, 1, 'Tape', [1]);

    const afterNodes = Array.from(host.querySelectorAll<HTMLSpanElement>('.cell'));
    expect(afterNodes).toEqual(originalNodes);
    expect(readCells(host)).toEqual(['a', 'X', 'c', '\u00a0']);
    expect(originalNodes[3]?.classList.contains('current')).toBe(false);
    expect(originalNodes[1]?.classList.contains('current')).toBe(true);
    expect(renderer.currentCell).toBe(originalNodes[1]);

    // Empty dirtyIndices only moves `.current` / label without rescanning untouched cells
    renderer.update(cells, 0, 'Лента', []);
    expect(host.getAttribute('aria-label')).toBe('Лента');
    expect(renderer.currentCell).toBe(originalNodes[0]);
    expect(originalNodes[1]?.classList.contains('current')).toBe(false);
    expect(originalNodes[0]?.classList.contains('current')).toBe(true);
  });

  it('appends single cells and multi-cell batches, trims tail, and handles full resync (`null`)', () => {
    const host = document.createElement('div');
    const renderer = new TapeRenderer();

    renderer.mount(host, ['0', ' '], 1, 'Tape');
    const firstNode = host.querySelectorAll<HTMLSpanElement>('.cell')[0];

    // Grow by 1 cell
    renderer.update(['0', ' ', ' '], 2, 'Tape', []);
    expect(readCells(host)).toEqual(['0', '\u00a0', '\u00a0']);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[2]);

    // Grow by batch of 3 cells + dirty write to existing cell 0 and newly appended index 4
    renderer.update(['9', ' ', ' ', 'a', 'b', ' '], 4, 'Tape', [0, 4]);
    expect(readCells(host)).toEqual(['9', '\u00a0', '\u00a0', 'a', 'b', '\u00a0']);
    expect(host.querySelectorAll('.cell')[0]).toBe(firstNode);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[4]);

    // Trim tail and clear highlight when position is null
    renderer.update(['9', ' '], null, 'Tape', [5]);
    expect(readCells(host)).toEqual(['9', '\u00a0']);
    expect(renderer.currentCell).toBeNull();
    expect(host.querySelector('.cell.current')).toBeNull();

    // Full resync (`dirtyIndices = null`) reconciles all cells (e.g. after `reset()`)
    renderer.update(['0', ' '], 1, 'Tape', null);
    expect(readCells(host)).toEqual(['0', '\u00a0']);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[1]);
  });

  it('stays exact across MachineRun batched steps, stepBack, and reset', () => {
    const program = createProgram(
      parseProgram(
        [
          '0, ,<,1',
          '1,0,1,2',
          '2,1,>,3',
          '3, ,>,4',
          '4, ,X,5',
          '5,X,>,6',
          '6, ,Y,7',
          '7,Y,#,7',
        ].join('\n'),
      ),
    );
    const run = new MachineRun(program, '0');
    const host = document.createElement('div');
    const renderer = new TapeRenderer();

    const sync = (): void => {
      renderer.update(run.tapeCells, run.headPosition, 'Tape', run.consumeDirtyCells());
    };

    run.consumeDirtyCells();
    renderer.mount(host, run.tapeCells, run.headPosition, 'Tape');
    expect(readCells(host)).toEqual(['0', '\u00a0']);

    // Run 4 steps in a batch (move left, write 1, move right, move right past tail)
    for (let i = 0; i < 4; i += 1) run.step();
    sync();
    expect(readCells(host)).toEqual(['1', '\u00a0', '\u00a0']);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[2]);

    // Run remaining steps to halt
    while (run.isRunning) run.step();
    sync();
    expect(readCells(host)).toEqual(['1', '\u00a0', 'X', 'Y']);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[3]);

    // Undo 3 steps in a batch (undoes halt, write Y, move right -> shrinks tape back to 3 cells)
    run.stepBack();
    run.stepBack();
    run.stepBack();
    sync();
    expect(readCells(host)).toEqual(['1', '\u00a0', 'X']);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[2]);

    // Reset restores initial tape via `null` full sync
    run.reset();
    sync();
    expect(readCells(host)).toEqual(['0', '\u00a0']);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[1]);
  });
});
