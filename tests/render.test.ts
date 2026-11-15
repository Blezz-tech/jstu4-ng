// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { parseProgram } from '../src/core/parser';
import { createProgram } from '../src/core/program';
import { MachineRun } from '../src/core/run';
import { TAPE_VIRTUALIZE_THRESHOLD, TapeRenderer } from '../src/ui/render';

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

describe('TapeRenderer (dual-mode windowed virtualization > 500 cells)', () => {
  it('stays in direct mode up to TAPE_VIRTUALIZE_THRESHOLD (500) cells', () => {
    expect(TAPE_VIRTUALIZE_THRESHOLD).toBe(500);
    const host = document.createElement('div');
    const renderer = new TapeRenderer();
    const cells = Array.from({ length: TAPE_VIRTUALIZE_THRESHOLD }, (_, i) => String(i % 10));

    renderer.mount(host, cells, TAPE_VIRTUALIZE_THRESHOLD - 1, 'Tape');

    expect(renderer.isVirtualized).toBe(false);
    expect(renderer.renderedRange).toEqual([0, TAPE_VIRTUALIZE_THRESHOLD]);
    expect(host.querySelector('.tape-view')?.classList.contains('tape-view--virtual')).toBe(false);
    expect(host.querySelectorAll('.tape-view__spacer')).toHaveLength(0);
    expect(host.querySelectorAll('.cell')).toHaveLength(TAPE_VIRTUALIZE_THRESHOLD);
    expect(renderer.currentCell?.textContent).toBe('9');
  });

  it('bounds DOM nodes on a 10,000-cell tape and follows head jumps across start, middle, and end', () => {
    const host = document.createElement('div');
    const renderer = new TapeRenderer();
    const total = 10_000;
    const cells = Array.from({ length: total }, (_, i) =>
      i === 0 ? 'S' : i === 5_000 ? 'M' : i === total - 1 ? 'E' : String(i % 10),
    );

    renderer.mount(host, cells, total - 1, 'Tape');

    expect(renderer.isVirtualized).toBe(true);
    expect(host.querySelector('.tape-view')?.classList.contains('tape-view--virtual')).toBe(true);
    expect(host.querySelectorAll('.tape-view__spacer')).toHaveLength(2);

    const endCount = host.querySelectorAll('.cell').length;
    expect(endCount).toBeGreaterThan(0);
    expect(endCount).toBeLessThanOrEqual(200);
    expect(renderer.currentCell?.textContent).toBe('E');
    expect(renderer.currentCell?.classList.contains('current')).toBe(true);
    expect(renderer.currentCell?.getAttribute('aria-current')).toBe('true');

    // Jump head to middle (5,000)
    renderer.update(cells, 5_000, 'Tape', []);
    renderer.scrollToHead();
    const [midStart, midEnd] = renderer.renderedRange;
    expect(midStart).toBeLessThanOrEqual(5_000);
    expect(midEnd).toBeGreaterThan(5_000);
    expect(host.querySelectorAll('.cell').length).toBeLessThanOrEqual(200);
    expect(renderer.currentCell?.textContent).toBe('M');

    // Jump head to start (0)
    renderer.update(cells, 0, 'Tape', []);
    renderer.scrollToHead();
    expect(renderer.renderedRange[0]).toBe(0);
    expect(renderer.currentCell?.textContent).toBe('S');

    renderer.clear();
  });

  it('updates dirty cells in place inside the window and renders off-window writes when scrolled', () => {
    const host = document.createElement('div');
    const renderer = new TapeRenderer();
    const cells = Array.from({ length: 2_000 }, () => '0');

    renderer.mount(host, cells, 0, 'Tape');
    expect(renderer.isVirtualized).toBe(true);
    const poolBefore = Array.from(host.querySelectorAll<HTMLSpanElement>('.cell'));

    // Mutate visible cell 5 and off-window cell 1,000
    cells[5] = 'A';
    cells[1_000] = 'Z';
    renderer.update(cells, 5, 'Tape', [5, 1_000]);

    // Pool DOM nodes are reused in place
    expect(Array.from(host.querySelectorAll<HTMLSpanElement>('.cell'))).toEqual(poolBefore);
    expect(renderer.currentCell?.textContent).toBe('A');

    // Manually scroll host to cell ~1,000 (default fallback cell width 14px)
    host.scrollLeft = 1_000 * 14;
    host.dispatchEvent(new Event('scroll'));

    const [start, end] = renderer.renderedRange;
    expect(start).toBeLessThanOrEqual(1_000);
    expect(end).toBeGreaterThan(1_000);
    const cellNodes = host.querySelectorAll<HTMLSpanElement>('.cell');
    expect(cellNodes[1_000 - start]?.textContent).toBe('Z');
    // Head at 5 is off-window so no `.current` is highlighted while scrolled away
    expect(renderer.currentCell).toBeNull();
    expect(host.querySelector('.cell.current')).toBeNull();

    // scrollToHead() brings head cell 5 back into the rendered window
    renderer.scrollToHead();
    expect(renderer.currentCell?.textContent).toBe('A');

    renderer.clear();
  });

  it('transitions smoothly between direct and virtual modes across MachineRun growth, stepBack, and reset', () => {
    // Program writes 'a' and moves right forever
    const program = createProgram(parseProgram('0, ,a,1  1,a,>,0'));
    const run = new MachineRun(program, '');
    const host = document.createElement('div');
    const renderer = new TapeRenderer();

    const sync = (): void => {
      renderer.update(run.tapeCells, run.headPosition, 'Tape', run.consumeDirtyCells());
      renderer.scrollToHead();
    };

    run.consumeDirtyCells();
    renderer.mount(host, run.tapeCells, run.headPosition, 'Tape');
    expect(renderer.isVirtualized).toBe(false);

    // Advance to 500 cells (499 write+right pairs = 998 steps -> length 500): still direct
    for (let i = 0; i < 998; i += 1) run.step();
    sync();
    expect(run.cellsUsed).toBe(500);
    expect(renderer.isVirtualized).toBe(false);
    expect(host.querySelectorAll('.cell')).toHaveLength(500);

    // One more write+right crosses threshold (501 cells) -> enters virtual mode
    run.step();
    run.step();
    sync();
    expect(run.cellsUsed).toBe(501);
    expect(renderer.isVirtualized).toBe(true);
    expect(host.querySelectorAll('.cell').length).toBeLessThanOrEqual(200);
    expect(renderer.currentCell?.textContent).toBe('\u00a0');

    // Stepping back shrinks tape back to 500 cells -> exits virtual mode seamlessly
    run.stepBack();
    sync();
    expect(run.cellsUsed).toBe(500);
    expect(renderer.isVirtualized).toBe(false);
    expect(host.querySelectorAll('.cell')).toHaveLength(500);
    expect(renderer.currentCell?.textContent).toBe('a');

    // Re-enter virtual mode and grow further to 1,200 cells -> DOM node count stays bounded
    run.step();
    for (let i = 0; i < 1_398; i += 1) run.step();
    sync();
    expect(run.cellsUsed).toBe(1_200);
    expect(renderer.isVirtualized).toBe(true);
    expect(host.querySelectorAll('.cell').length).toBeLessThanOrEqual(200);

    // Reset back to 1 cell -> cleanly exits virtual mode
    run.reset();
    sync();
    expect(run.cellsUsed).toBe(1);
    expect(renderer.isVirtualized).toBe(false);
    expect(host.querySelector('.tape-view')?.classList.contains('tape-view--virtual')).toBe(false);
    expect(host.querySelectorAll('.tape-view__spacer')).toHaveLength(0);
    expect(readCells(host)).toEqual(['\u00a0']);
    expect(renderer.currentCell).toBe(host.querySelectorAll('.cell')[0]);

    renderer.clear();
  });

  it('detaches scroll listeners and ResizeObserver on clear() and when exiting virtual mode', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    };

    try {
      const host = document.createElement('div');
      const addSpy = vi.spyOn(host, 'addEventListener');
      const removeSpy = vi.spyOn(host, 'removeEventListener');
      const renderer = new TapeRenderer();

      const big = Array.from({ length: 600 }, () => '1');
      renderer.mount(host, big, 599, 'Tape');
      expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
      expect(observe).toHaveBeenCalledWith(host);

      // Exiting back below threshold disconnects observer & removes scroll listener
      renderer.update(['1', ' '], 1, 'Tape', null);
      expect(renderer.isVirtualized).toBe(false);
      expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(disconnect).toHaveBeenCalledTimes(1);

      // Re-entering virtual mode and calling clear() cleans up again
      renderer.update(big, 599, 'Tape', null);
      expect(renderer.isVirtualized).toBe(true);
      renderer.clear();
      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(removeSpy).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });
});
