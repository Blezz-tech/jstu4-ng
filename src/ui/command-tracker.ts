import type { Command } from '../core/machine';
import type { CompiledProgram, ProgramRenderer } from './render';

const EMPTY_UINT32 = new Uint32Array(0);
const EMPTY_INT32 = new Int32Array(0);

export interface CommandTracker {
  readonly returnCursorOffset: number | null;
  setReturnCursorOffset(offset: number | null): void;
  index(compiled: CompiledProgram): void;
  /** Maintain O(1) execution counts per command index so stepping backward restores `.visited` exactly. */
  recordVisited(cmdIdx: number, delta: 1 | -1): void;
  /** Record the source offset of an executed command for edit-mode cursor restoration. */
  recordCursor(cmdIdx: number): void;
  clearVisited(): void;
  markCurrent(cmdIdx: number, scroll?: boolean): void;
  markError(command: Command | null | undefined, scroll?: boolean): void;
  reset(): void;
}

/**
 * Tracks per-command visit reference counts and source offsets in flat
 * `TypedArray`s (`Uint32Array` + `Int32Array`, zero `Map` allocations) for
 * O(1) `ProgramRenderer` highlights and edit-mode cursor restoration.
 */
export function createCommandTracker(programRenderer: ProgramRenderer): CommandTracker {
  let indexedCommands: readonly Command[] = [];
  let visitCounts: Uint32Array = EMPTY_UINT32;
  let commandOffsets: Int32Array = EMPTY_INT32;
  let returnCursorOffset: number | null = null;

  return {
    get returnCursorOffset(): number | null {
      return returnCursorOffset;
    },
    setReturnCursorOffset(offset) {
      returnCursorOffset = offset;
    },
    index(compiled) {
      const cmds = compiled.commands;
      const len = cmds.length;
      indexedCommands = cmds;
      visitCounts = new Uint32Array(len);
      commandOffsets = new Int32Array(len);
      for (let i = 0; i < len; i += 1) {
        commandOffsets[i] = cmds[i]!.source.offset;
      }
    },
    recordVisited(cmdIdx, delta) {
      if (cmdIdx < 0 || cmdIdx >= visitCounts.length) return;
      const prev = visitCounts[cmdIdx]!;
      const next = delta > 0 ? prev + 1 : prev > 0 ? prev - 1 : 0;
      visitCounts[cmdIdx] = next;

      if (prev === 0 && next > 0) {
        programRenderer.setVisited(cmdIdx, true);
      } else if (prev > 0 && next === 0) {
        programRenderer.setVisited(cmdIdx, false);
      }
    },
    recordCursor(cmdIdx) {
      if (cmdIdx >= 0 && cmdIdx < commandOffsets.length) {
        returnCursorOffset = commandOffsets[cmdIdx]!;
      }
    },
    clearVisited() {
      programRenderer.clearVisited();
      visitCounts.fill(0);
    },
    markCurrent(cmdIdx, scroll = true) {
      if (cmdIdx >= 0 && cmdIdx < commandOffsets.length) {
        returnCursorOffset = commandOffsets[cmdIdx]!;
        programRenderer.setCurrent(cmdIdx, scroll);
      } else {
        programRenderer.setCurrent(null, scroll);
      }
    },
    markError(command, scroll = true) {
      if (command === null || command === undefined) {
        programRenderer.setError(null, scroll);
        return;
      }
      const idx = indexedCommands.indexOf(command);
      returnCursorOffset = command.source.offset;
      programRenderer.setError(idx >= 0 ? idx : null, scroll);
    },
    reset() {
      indexedCommands = [];
      visitCounts = EMPTY_UINT32;
      commandOffsets = EMPTY_INT32;
      returnCursorOffset = null;
    },
  };
}
