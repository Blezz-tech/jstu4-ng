import {
  lookupTransitionIndex,
  OP_FLAG_HALT,
  OP_LEFT,
  OP_MASK,
  OP_RIGHT,
  OP_WRITE,
  type CompiledBytecode,
} from './bytecode';
import type { RuntimeError } from './errors';
import type { Command, StateId } from './machine';
import type { Program } from './program';
import { err, type Ok, type Result } from './result';
import { DEFAULT_MAX_HISTORY, UndoHistory } from './undo-history';

export { DEFAULT_MAX_HISTORY };

/**
 * Cap on individually tracked dirty cell indices between renders. Exceeding it
 * (e.g. headless runs or huge frame batches) coalesces into a full sync (`null`)
 * so memory stays O(1) even if nobody consumes dirty cells.
 */
const MAX_DIRTY_CELLS = 256;

/** Minimum backing length of the growable `Uint32Array` tape buffer. */
const INITIAL_TAPE_CAPACITY = 64;
/** Shrink overgrown tape buffers on `reset()` above this threshold to return memory. */
const RESET_SHRINK_THRESHOLD = 4096;

const EMPTY_DIRTY: readonly number[] = [];

/** Pre-allocated immutable results keep successful {@link MachineRun.step} calls zero-alloc. */
const STEP_OK: Ok<boolean> = Object.freeze({ ok: true, value: true });
const STEP_HALTED: Ok<boolean> = Object.freeze({ ok: true, value: false });

export interface MachineRunOptions {
  /**
   * Maximum number of steps retained in the undo ring buffer (default:
   * {@link DEFAULT_MAX_HISTORY}). Bounds memory usage during infinite loops
   * while preserving O(1) `step()` and `stepBack()`.
   */
  readonly maxHistory?: number;
}

export type NormalityStatus = 'normal' | 'sourceAltered' | 'misplaced';

/** Zero-copy read interface over the current numeric tape for incremental renderers. */
export interface TapeSource {
  readonly length: number;
  symbolAt(index: number): string;
}

function isBlankCell(symbol: string): boolean {
  return symbol === ' ' || symbol === '\t' || symbol === '\n' || symbol === '\r';
}

/**
 * Strip trailing whitespace (not part of the machine input, matching v2.3) and
 * split the remaining text into Unicode code-point cells.
 */
export function normaliseInitialTape(tapeText: string): readonly string[] {
  return Array.from(tapeText.replace(/\s+$/, ''));
}

/**
 * One machine run executing directly on flat linear-memory `TypedArray`s:
 *
 * - Commands & transitions come from `program.bytecode` (one contiguous `ArrayBuffer`).
 * - Tape cells are stored as interned `Uint32` symbol IDs (`0 === ' '`), zero GC scanning.
 * - Undo history is a bounded O(1) linear-memory `TypedArray` ring buffer (zero JS objects).
 *
 * All mutations go through {@link step}, {@link stepBack}, {@link stepBackIndex},
 * and {@link reset}, keeping the run deterministic, reversible, and fast.
 */
export class MachineRun {
  private readonly bc: CompiledBytecode;
  private readonly cmdFrom: Uint32Array;
  private readonly cmdNext: Uint32Array;
  private readonly cmdWrite: Uint32Array;
  private readonly cmdMeta: Uint8Array;

  private readonly idToSym: readonly string[];
  private readonly initialTapeIds: Uint32Array;
  private readonly history: UndoHistory;
  private readonly view: TapeSource;

  private tapeBuf: Uint32Array;
  private tapeLen: number;
  private dirtyCells: number[] = [];
  private dirtySnapshot: number[] = [];
  private dirtyAll = false;
  private stateIdx = 0;
  private position: number;
  private running = true;
  private nextIdx: number;
  private steps = 0;

  constructor(
    private readonly program: Program,
    tapeText: string,
    options: MachineRunOptions = {},
  ) {
    const bc = program.bytecode;
    this.bc = bc;
    this.cmdFrom = bc.cmdFrom;
    this.cmdNext = bc.cmdNext;
    this.cmdWrite = bc.cmdWrite;
    this.cmdMeta = bc.cmdMeta;
    this.history = new UndoHistory(options.maxHistory);

    // Trailing whitespace is not a part of the data: the machine starts
    // immediately after the last visible symbol (original behaviour).
    const cells = normaliseInitialTape(tapeText);

    // Intern initial tape cells: reuse program's table zero-copy unless the tape
    // contains symbols absent from the program (which always map to NoSuchCommand).
    let idToSym: readonly string[] = bc.idToSym;
    let mutableIdToSym: string[] | null = null;
    let extraSymToId: Map<string, number> | null = null;
    const initLen = cells.length;
    const initIds = new Uint32Array(initLen);

    for (let i = 0; i < initLen; i += 1) {
      const ch = cells[i]!;
      let symId = bc.symToId.get(ch);
      if (symId === undefined) {
        if (extraSymToId === null) {
          extraSymToId = new Map<string, number>();
          mutableIdToSym = [...bc.idToSym];
          idToSym = mutableIdToSym;
        }
        symId = extraSymToId.get(ch);
        if (symId === undefined) {
          symId = mutableIdToSym!.length;
          mutableIdToSym!.push(ch);
          extraSymToId.set(ch, symId);
        }
      }
      initIds[i] = symId;
    }

    this.idToSym = idToSym;
    this.initialTapeIds = initIds;

    // The head starts *after* the last symbol, on an empty (space = id 0) cell.
    const cap = Math.max(INITIAL_TAPE_CAPACITY, initLen + 1);
    this.tapeBuf = new Uint32Array(cap);
    this.tapeBuf.set(initIds);
    this.tapeLen = initLen + 1;
    this.position = initLen;
    this.nextIdx = this.lookup();

    const getLength = (): number => this.tapeLen;
    this.view = {
      get length(): number {
        return getLength();
      },
      symbolAt: (index) => this.symbolAtIndex(index),
    };
  }

  private markCellDirty(index: number): void {
    if (this.dirtyAll) return;
    if (this.dirtyCells.length >= MAX_DIRTY_CELLS) {
      this.dirtyAll = true;
      this.dirtyCells.length = 0;
      return;
    }
    this.dirtyCells.push(index);
  }

  private ensureTapeCapacity(minLength: number): void {
    if (minLength <= this.tapeBuf.length) return;
    let nextCap = this.tapeBuf.length;
    while (nextCap < minLength) nextCap *= 2;
    const next = new Uint32Array(nextCap);
    next.set(this.tapeBuf.subarray(0, this.tapeLen));
    this.tapeBuf = next;
  }

  private lookup(): number {
    const symId = this.position < this.tapeLen ? this.tapeBuf[this.position]! : 0;
    return lookupTransitionIndex(this.bc, this.stateIdx, symId);
  }

  /** Read the cell symbol string at `index` in O(1) without materializing an array. */
  symbolAtIndex(index: number): string {
    if (index < 0 || index >= this.tapeLen) return ' ';
    return this.idToSym[this.tapeBuf[index]!] ?? ' ';
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isAtStart(): boolean {
    return this.steps === 0;
  }

  get canStepBack(): boolean {
    return this.history.size > 0;
  }

  /** Number of steps currently retained in the undo buffer. */
  get historyLength(): number {
    return this.history.size;
  }

  /** Configured maximum undo history capacity. */
  get historyLimit(): number {
    return this.history.limit;
  }

  /** True when earlier steps were evicted because total steps exceeded {@link historyLimit}. */
  get isHistoryTruncated(): boolean {
    return this.steps > this.history.size;
  }

  get currentState(): StateId {
    return this.bc.idToState[this.stateIdx]!;
  }

  get headPosition(): number {
    return this.position;
  }

  get stepsCount(): number {
    return this.steps;
  }

  get currentSymbol(): string {
    return this.symbolAtIndex(this.position);
  }

  /** Integer index of the command that will be executed by the next {@link step}, or `-1`. */
  get nextCommandIndex(): number {
    return this.nextIdx;
  }

  /** The command that will be executed by the next {@link step}. */
  get nextCommand(): Command | undefined {
    return this.nextIdx >= 0 ? this.program.commands[this.nextIdx] : undefined;
  }

  /** Number of initial non-trailing-space cells (exact for non-BMP Unicode symbols). */
  get initialLength(): number {
    return this.initialTapeIds.length;
  }

  /** Zero-copy view over the numeric tape buffer for incremental DOM rendering. */
  get tapeView(): TapeSource {
    return this.view;
  }

  /** Current tape as a materialized string cell array (snapshot for inspection/tests). */
  get tapeCells(): readonly string[] {
    const len = this.tapeLen;
    const out = new Array<string>(len);
    const buf = this.tapeBuf;
    const syms = this.idToSym;
    for (let i = 0; i < len; i += 1) {
      out[i] = syms[buf[i]!] ?? ' ';
    }
    return out;
  }

  /** Current tape as a string; every cell visited by the head is kept. */
  get tapeText(): string {
    return this.tapeCells.join('');
  }

  /** Highest number of cells the run has ever occupied up to the current step. */
  get cellsUsed(): number {
    return this.tapeLen;
  }

  /**
   * Drain cell indices overwritten since the last call.
   *
   * - Returns an empty array when only head/tail length changed (zero allocations).
   * - Returns a swapped backing array of modified indices when `<= 256` writes occurred.
   * - Returns `null` when a full resync is needed (`reset()` or more than 256 writes).
   *
   * Note: the returned array is reused on the *next* call; iterate synchronously.
   */
  consumeDirtyCells(): readonly number[] | null {
    if (this.dirtyAll) {
      this.dirtyAll = false;
      this.dirtyCells.length = 0;
      return null;
    }
    if (this.dirtyCells.length === 0) return EMPTY_DIRTY;
    const out = this.dirtyCells;
    this.dirtySnapshot.length = 0;
    this.dirtyCells = this.dirtySnapshot;
    this.dirtySnapshot = out;
    return out;
  }

  /**
   * Execute one command forward on flat integer `TypedArray` tables
   * (zero allocations, zero `Map` lookups, zero string operations on the hot path).
   *
   * @returns `ok(true)` when a command executed, `ok(false)` when the machine
   *   was already halted, or `err(RuntimeError)` on undefined transition / left
   *   tape boundary violation.
   */
  step(): Result<boolean, RuntimeError> {
    if (!this.running) return STEP_HALTED;

    const cmdIdx = this.nextIdx;
    if (cmdIdx < 0) {
      this.running = false;
      return err({
        kind: 'noSuchCommand',
        state: this.bc.idToState[this.stateIdx]!,
        symbol: this.currentSymbol,
      });
    }

    const meta = this.cmdMeta[cmdIdx]!;
    const op = meta & OP_MASK;

    if (op === OP_LEFT && this.position === 0) {
      this.running = false;
      return err({ kind: 'outOfTape', command: this.program.commands[cmdIdx]! });
    }

    const prevPosition = this.position;
    const prevTapeLength = this.tapeLen;
    let prevSymId = 0;

    if (op === OP_LEFT) {
      this.position -= 1;
    } else if (op === OP_RIGHT) {
      this.position += 1;
      if (this.position >= this.tapeLen) {
        const needed = this.position + 1;
        this.ensureTapeCapacity(needed);
        this.tapeBuf.fill(0, this.tapeLen, needed);
        this.tapeLen = needed;
      }
    } else if (op === OP_WRITE) {
      if (this.position >= this.tapeLen) {
        const needed = this.position + 1;
        this.ensureTapeCapacity(needed);
        this.tapeBuf.fill(0, this.tapeLen, needed);
        this.tapeLen = needed;
      }
      prevSymId = this.tapeBuf[this.position]!;
      const writeSymId = this.cmdWrite[cmdIdx]!;
      if (prevSymId !== writeSymId) {
        this.tapeBuf[this.position] = writeSymId;
        this.markCellDirty(this.position);
      }
    }

    this.history.push(cmdIdx, prevPosition, prevTapeLength, prevSymId);
    this.steps += 1;

    if ((meta & OP_FLAG_HALT) !== 0) {
      this.running = false;
      this.nextIdx = -1;
    } else {
      this.stateIdx = this.cmdNext[cmdIdx]!;
      this.nextIdx = this.lookup();
    }

    return STEP_OK;
  }

  /**
   * Undo the most recently executed command without allocating, returning the
   * undone command's integer index (`-1` when no undo history remains).
   */
  stepBackIndex(): number {
    if (!this.history.pop()) return -1;

    const cmdIdx = this.history.lastCmdIdx;
    const prevPosition = this.history.lastPos;
    const prevTapeLength = this.history.lastLen;
    const prevSymId = this.history.lastSymId;

    this.tapeLen = prevTapeLength;
    if ((this.cmdMeta[cmdIdx]! & OP_MASK) === OP_WRITE) {
      if (this.tapeBuf[prevPosition] !== prevSymId) {
        this.tapeBuf[prevPosition] = prevSymId;
        this.markCellDirty(prevPosition);
      }
    }

    this.position = prevPosition;
    this.stateIdx = this.cmdFrom[cmdIdx]!;
    this.steps -= 1;
    this.running = true;
    this.nextIdx = cmdIdx;

    return cmdIdx;
  }

  /**
   * Undo the most recently executed command, restoring the exact tape, head,
   * state, cell count, and active running status (including recovering from a
   * normal halt or a runtime error after at least one step).
   *
   * @returns the undone command (now again {@link nextCommand}), or `null` when
   *   no undo history remains (at step 0 or at the history buffer boundary)
   */
  stepBack(): Command | null {
    const idx = this.stepBackIndex();
    return idx >= 0 ? (this.program.commands[idx] ?? null) : null;
  }

  /** Reset the run back to step 0 with the original tape and initial state. */
  reset(): void {
    const initIds = this.initialTapeIds;
    const initLen = initIds.length;
    const targetLen = initLen + 1;

    if (this.tapeBuf.length > RESET_SHRINK_THRESHOLD && targetLen <= RESET_SHRINK_THRESHOLD) {
      this.tapeBuf = new Uint32Array(Math.max(INITIAL_TAPE_CAPACITY, targetLen));
    }
    this.tapeBuf.set(initIds);
    this.tapeBuf[initLen] = 0;
    this.tapeLen = targetLen;

    this.dirtyAll = true;
    this.dirtyCells.length = 0;
    this.history.clear();
    this.stateIdx = 0;
    this.position = initLen;
    this.running = true;
    this.steps = 0;
    this.nextIdx = this.lookup();
  }

  /**
   * Why the finished run deviates from the "normal" convention, if it does.
   * A normal run keeps the source data intact (including the blank separator
   * cell after it, where the head starts) and stops right after the result;
   * matches original jstu4 v2.3 exactly.
   */
  checkNormality(): NormalityStatus {
    const init = this.initialTapeIds;
    const initLen = init.length;
    const buf = this.tapeBuf;
    const syms = this.idToSym;

    for (let i = 0; i < initLen; i += 1) {
      if (buf[i] !== init[i]) return 'sourceAltered';
    }
    const sepId = initLen < this.tapeLen ? buf[initLen]! : 0;
    if (sepId !== 0 && !isBlankCell(syms[sepId] ?? ' ')) return 'sourceAltered';

    let trimmedEnd = this.tapeLen;
    while (trimmedEnd > 0) {
      const symId = buf[trimmedEnd - 1]!;
      if (symId !== 0 && !isBlankCell(syms[symId] ?? ' ')) break;
      trimmedEnd -= 1;
    }
    if (trimmedEnd !== this.position) return 'misplaced';
    return 'normal';
  }
}
