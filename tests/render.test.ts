// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { computeScrollToIndex, computeWindowRange } from '../src/ui/render/virtual-window';
import { parseProgram } from '../src/core/parser';
import { createProgram } from '../src/core/program';
import { MachineRun } from '../src/core/run';
import {
  listProgram,
  PROGRAM_VIRTUALIZE_COMMAND_THRESHOLD,
  PROGRAM_VIRTUALIZE_LINE_THRESHOLD,
  ProgramRenderer,
  TAPE_VIRTUALIZE_THRESHOLD,
  TapeRenderer,
} from '../src/ui/render';

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

function makeLargeProgramText(linesCount: number, commandsPerLine = 1): string {
  const lines: string[] = [];
  let state = 0;
  for (let l = 0; l < linesCount; l += 1) {
    const parts: string[] = [];
    for (let c = 0; c < commandsPerLine; c += 1) {
      const next = state + 1;
      parts.push(`${state}, ,>,${next}`);
      state = next;
    }
    lines.push(`${parts.join('  ')} // line ${l}`);
  }
  return lines.join('\n');
}

describe('ProgramRenderer (dual-mode line-windowed virtualization)', () => {
  it('stays in direct mode up to line and command thresholds', () => {
    expect(PROGRAM_VIRTUALIZE_LINE_THRESHOLD).toBe(400);
    expect(PROGRAM_VIRTUALIZE_COMMAND_THRESHOLD).toBe(800);

    const text = makeLargeProgramText(PROGRAM_VIRTUALIZE_LINE_THRESHOLD, 1);
    const listing = listProgram(text);
    const host = document.createElement('div');
    const renderer = new ProgramRenderer();

    renderer.mount(host, listing);

    expect(renderer.isVirtualized).toBe(false);
    expect(renderer.totalLines).toBe(PROGRAM_VIRTUALIZE_LINE_THRESHOLD);
    expect(host.classList.contains('program--virtual')).toBe(false);
    expect(host.querySelectorAll('.program-virtual__spacer')).toHaveLength(0);
    expect(host.querySelectorAll('.cmd')).toHaveLength(PROGRAM_VIRTUALIZE_LINE_THRESHOLD);

    renderer.setVisited(0, true);
    renderer.setCurrent(1, false);
    renderer.setError(2, false);
    expect(host.querySelectorAll('.cmd.visited')).toHaveLength(1);
    expect(host.querySelector('.cmd.current')?.textContent).toBe('1, ,>,2');
    expect(host.querySelector('.cmd.error')?.textContent).toBe('2, ,>,3');

    renderer.clearVisited();
    expect(host.querySelectorAll('.cmd.visited')).toHaveLength(0);
    renderer.clear();
    expect(host.childNodes).toHaveLength(0);
  });

  it('virtualizes large programs (> 400 lines) with bounded DOM nodes and O(1) command jumps', () => {
    const totalLines = 5_000;
    const listing = listProgram(makeLargeProgramText(totalLines, 1));
    const host = document.createElement('div');
    const renderer = new ProgramRenderer();

    renderer.mount(host, listing);

    expect(renderer.isVirtualized).toBe(true);
    expect(renderer.totalLines).toBe(totalLines);
    expect(host.classList.contains('program--virtual')).toBe(true);
    expect(host.querySelectorAll('.program-virtual__spacer')).toHaveLength(2);
    expect(host.querySelectorAll('.program-line').length).toBeLessThanOrEqual(120);
    expect(host.querySelectorAll('.cmd').length).toBeLessThanOrEqual(120);

    // Jump to the last command (line 4,999)
    renderer.setCurrent(totalLines - 1, true);
    const [endStart, endStop] = renderer.renderedLineRange;
    expect(endStart).toBeLessThanOrEqual(totalLines - 1);
    expect(endStop).toBe(totalLines);
    expect(host.querySelectorAll('.program-line').length).toBeLessThanOrEqual(120);
    expect(renderer.currentCommandNode?.textContent).toBe(`${totalLines - 1}, ,>,${totalLines}`);
    expect(host.querySelectorAll('.cmd.current')).toHaveLength(1);

    // Jump to middle (line 2,500)
    renderer.setCurrent(2_500, true);
    expect(renderer.currentCommandNode?.textContent).toBe('2500, ,>,2501');
    expect(host.querySelectorAll('.cmd.current')).toHaveLength(1);

    // Jump back to line 0
    renderer.setCurrent(0, true);
    expect(renderer.renderedLineRange[0]).toBe(0);
    expect(renderer.currentCommandNode?.textContent).toBe('0, ,>,1');

    renderer.clear();
  });

  it('triggers virtualization by command threshold even when line count is below 400', () => {
    // 200 lines * 5 commands/line = 1,000 commands (> 800)
    const listing = listProgram(makeLargeProgramText(200, 5));
    const host = document.createElement('div');
    const renderer = new ProgramRenderer();

    renderer.mount(host, listing);

    expect(renderer.isVirtualized).toBe(true);
    expect(renderer.totalLines).toBe(200);
    // Line 0 renders all 5 commands cleanly
    const firstLine = host.querySelector('.program-line');
    expect(firstLine?.querySelectorAll('.cmd')).toHaveLength(5);
    expect(firstLine?.textContent).toContain('// line 0');

    // Jump to the last command on line 199 (command index 999)
    renderer.setCurrent(999, true);
    expect(renderer.currentCommandNode?.textContent).toBe('999, ,>,1000');

    renderer.clear();
  });

  it('preserves visited/error marks across manual vertical scroll and reuses overlapping line DOM nodes', () => {
    const listing = listProgram(makeLargeProgramText(1_500, 1));
    const host = document.createElement('div');
    const renderer = new ProgramRenderer();

    renderer.mount(host, listing, [10, 1_000]);
    renderer.setVisited(5, true);
    renderer.setVisited(1_000, true);
    renderer.setCurrent(5, false);

    // Incremental scroll by 25 lines (default fallback lineHeight = 24px -> 600px)
    const line30Before = Array.from(host.querySelectorAll('.program-line'))[30];
    host.scrollTop = 25 * 24;
    host.dispatchEvent(new Event('scroll'));
    const [afterStart] = renderer.renderedLineRange;
    const line30After = Array.from(host.querySelectorAll('.program-line'))[30 - afterStart];
    expect(line30After).toBe(line30Before);

    // Distant scroll to line 1,000 shows both .visited and .error on command 1,000
    host.scrollTop = 1_000 * 24;
    host.dispatchEvent(new Event('scroll'));
    const cmd1000 = host.querySelector<HTMLSpanElement>('.cmd.error');
    expect(cmd1000?.textContent).toBe('1000, ,>,1001');
    expect(cmd1000?.classList.contains('visited')).toBe(true);

    // clearVisited() removes .visited both in-window and off-window
    renderer.clearVisited();
    expect(cmd1000?.classList.contains('visited')).toBe(false);
    host.scrollTop = 0;
    host.dispatchEvent(new Event('scroll'));
    expect(host.querySelectorAll('.cmd.visited')).toHaveLength(0);
    // Error mark at 10 and current mark at 5 remain intact
    expect(host.querySelector('.cmd.error')?.textContent).toBe('10, ,>,11');
    expect(host.querySelector('.cmd.current')?.textContent).toBe('5, ,>,6');

    renderer.clear();
  });

  it('virtualizes ParseError on large files and scrolls directly to the offending mark', () => {
    const lines = Array.from({ length: 1_200 }, (_, i) => `${i}, ,>,${i + 1}`);
    lines[1_050] = 'BROKEN_LINE';
    const text = lines.join('\n');
    const errorOffset = text.indexOf('BROKEN_LINE');

    const host = document.createElement('div');
    const renderer = new ProgramRenderer();

    renderer.mountParseError(host, text, errorOffset);
    expect(renderer.isVirtualized).toBe(true);
    expect(host.querySelector('mark.error')).toBeNull(); // line 1,050 is off-window initially

    renderer.scrollToFirstError();
    const mark = host.querySelector('mark.error');
    expect(mark?.textContent).toBe('B');
    const [start, end] = renderer.renderedLineRange;
    expect(start).toBeLessThanOrEqual(1_050);
    expect(end).toBeGreaterThan(1_050);

    renderer.clear();
  });

  it('detaches scroll listener, ResizeObserver, and DOM state on clear()', () => {
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
      const listing = listProgram(makeLargeProgramText(600, 1));
      const renderer = new ProgramRenderer();

      renderer.mount(host, listing);
      expect(renderer.isVirtualized).toBe(true);
      expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
      expect(observe).toHaveBeenCalledWith(host);

      renderer.clear();
      expect(renderer.isVirtualized).toBe(false);
      expect(host.classList.contains('program--virtual')).toBe(false);
      expect(host.childNodes).toHaveLength(0);
      expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it('TapeRenderer.clear() empties host DOM in both direct and virtualized modes', () => {
    const directHost = document.createElement('div');
    const direct = new TapeRenderer();
    direct.mount(directHost, ['a', 'b', ' '], 2, 'tape');
    expect(directHost.childNodes.length).toBeGreaterThan(0);
    direct.clear();
    expect(directHost.childNodes).toHaveLength(0);

    const virtualHost = document.createElement('div');
    const virtual = new TapeRenderer();
    const cells = Array.from({ length: TAPE_VIRTUALIZE_THRESHOLD + 50 }, () => '1');
    virtual.mount(virtualHost, cells, 10, 'tape');
    expect(virtual.isVirtualized).toBe(true);
    expect(virtualHost.childNodes.length).toBeGreaterThan(0);
    virtual.clear();
    expect(virtualHost.childNodes).toHaveLength(0);
    expect(virtualHost.classList.contains('tape-view--virtual')).toBe(false);
  });

  it('accounts for host CSS padding when computing virtual scroll targets and window ranges', () => {
    const padding = { start: 10, end: 12 };
    // 100 items × 20px, viewport 100px, top/bottom padding 10px/12px -> total scroll height 2022px
    expect(computeScrollToIndex(99, 20, 0, 100, padding)).toBe(10 + 100 * 20 + 12 - 100);
    // Index 0 sits at offset 10..30; when scroll is at 25 it must scroll back up to 0
    expect(computeScrollToIndex(0, 20, 25, 100, padding)).toBe(0);
    // Already fully visible inside padded viewport -> keeps current scroll position unchanged
    expect(computeScrollToIndex(2, 20, 10, 100, padding)).toBe(10);
    // Window range clamps safely at both ends and respects start padding
    expect(
      computeWindowRange({
        scrollPos: 0,
        viewportSize: 100,
        itemSize: 20,
        total: 50,
        overscan: 5,
        paddingStart: 10,
        curStart: 0,
        curEnd: 0,
        renderedCount: 0,
        force: true,
      }),
    ).toEqual({ start: 0, end: 10 });
    expect(
      computeWindowRange({
        scrollPos: 950,
        viewportSize: 100,
        itemSize: 20,
        total: 50,
        overscan: 5,
        paddingStart: 10,
        curStart: 0,
        curEnd: 0,
        renderedCount: 0,
        force: true,
      }),
    ).toEqual({ start: 42, end: 50 });
  });
});
