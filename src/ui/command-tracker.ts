import type { Command } from '../core/machine';
import type { CompiledProgram, ProgramRenderer } from './render';

export interface CommandTracker {
  readonly returnCursorOffset: number | null;
  setReturnCursorOffset(offset: number | null): void;
  index(compiled: CompiledProgram): void;
  /** Maintain O(1) execution counts per command so stepping backward restores `.visited` exactly. */
  recordVisited(command: Command, delta: 1 | -1): void;
  clearVisited(): void;
  mark(kind: 'current' | 'error', command: Command | null | undefined, scroll?: boolean): void;
  reset(): void;
}

/**
 * Bridges compiled `Command` objects to their `ProgramRenderer` indices,
 * maintaining O(1) visit reference counts for exact undo highlights and
 * tracking the source offset to restore editor cursor position on edit return.
 */
export function createCommandTracker(programRenderer: ProgramRenderer): CommandTracker {
  const commandIndex = new Map<Command, number>();
  const visitCounts = new Map<number, number>();
  let returnCursorOffset: number | null = null;

  return {
    get returnCursorOffset(): number | null {
      return returnCursorOffset;
    },
    setReturnCursorOffset(offset) {
      returnCursorOffset = offset;
    },
    index(compiled) {
      commandIndex.clear();
      compiled.commands.forEach((command, idx) => commandIndex.set(command, idx));
    },
    recordVisited(command, delta) {
      const idx = commandIndex.get(command);
      if (idx === undefined) return;

      const prev = visitCounts.get(idx) ?? 0;
      const next = Math.max(0, prev + delta);

      if (next === 0) {
        visitCounts.delete(idx);
        if (prev > 0) programRenderer.setVisited(idx, false);
      } else {
        visitCounts.set(idx, next);
        if (prev === 0) programRenderer.setVisited(idx, true);
      }
    },
    clearVisited() {
      programRenderer.clearVisited();
      visitCounts.clear();
    },
    mark(kind, command, scroll = true) {
      let idx: number | null = null;
      if (command !== null && command !== undefined) {
        idx = commandIndex.get(command) ?? null;
        returnCursorOffset = command.source.offset;
      }

      if (kind === 'current') {
        programRenderer.setCurrent(idx, scroll);
      } else {
        programRenderer.setError(idx, scroll);
      }
    },
    reset() {
      commandIndex.clear();
      visitCounts.clear();
      returnCursorOffset = null;
    },
  };
}
