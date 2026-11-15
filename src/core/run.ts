import type { Command, StateId } from './machine';
import type { Program } from './program';
import { NoSuchCommandError, OutOfTapeError } from './errors';

/** Default maximum number of reversible steps kept in memory per run. */
export const DEFAULT_MAX_HISTORY = 100_000;

/** Initial backing capacity for the growable SoA undo ring buffer. */
const INITIAL_HISTORY_CAPACITY = 256;

const EMPTY_INT32 = new Int32Array(0);

/**
 * Cap on individually tracked dirty cell indices between renders. Exceeding it
 * (e.g. headless runs or huge frame batches) coalesces into a full sync (`null`)
 * so memory stays O(1) even if nobody consumes dirty cells.
 */
const MAX_DIRTY_CELLS = 256;

const EMPTY_DIRTY: readonly number[] = [];

export interface MachineRunOptions {
  /**
   * Maximum number of steps retained in the undo ring buffer (default:
   * {@link DEFAULT_MAX_HISTORY}). Bounds memory usage during infinite loops
   * while preserving O(1) `step()` and `stepBack()`.
   */
  readonly maxHistory?: number;
}

/** A tape symbol read at a position; an empty cell reads as a space. */
export function symbolAt(tape: readonly string[], index: number): string {
  return tape[index] ?? ' ';
}

/**
 * One machine run. The tape is a plain array of single-character cells,
 * mutable — all mutations go through {@link step}, {@link stepBack}, and
 * {@link reset}, so the run is a deterministic, reversible state machine
 * with bounded O(1) undo history that is trivial to unit-test.
 */
export class MachineRun {
  private readonly tape: string[];
  private readonly initialTapeCells: readonly string[];
  private readonly maxHistory: number;
  // Growable Structure-of-Arrays ring buffer for O(1) reversible history:
  // avoids allocating a StepRecord object per step and cuts 100k-step memory ~4×.
  // `prevState` is omitted because it always equals `command.q`.
  private historyCmd: (Command | undefined)[] = [];
  private historyPos: Int32Array = EMPTY_INT32;
  private historyLen: Int32Array = EMPTY_INT32;
  private historySym: (string | undefined)[] = [];
  private historyCap = 0;
  private historyHead = 0;
  private historySize = 0;
  private dirtyCells: number[] = [];
  private dirtySnapshot: number[] = [];
  private dirtyAll = false;
  private state: StateId;
  private stateTransitions: ReadonlyMap<string, Command> | undefined;
  private position: number;
  private running = true;
  private next: Command | undefined;
  private steps = 0;
  private readonly initialTapeText: string;

  constructor(
    private readonly program: Program,
    tapeText: string,
    options: MachineRunOptions = {},
  ) {
    const limit = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.maxHistory = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : limit === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : DEFAULT_MAX_HISTORY;

    // Trailing whitespace is not a part of the data: the machine starts
    // immediately after the last visible symbol (original behaviour).
    const normalised = tapeText.replace(/\s+$/, '');
    this.initialTapeCells = Array.from(normalised);
    this.tape = [...this.initialTapeCells, ' '];
    this.initialTapeText = normalised;
    this.state = program.initialState;
    this.stateTransitions = program.transitions.get(this.state);
    // The head starts *after* the last symbol, on an empty (space) cell.
    this.position = this.initialTapeCells.length;
    this.next = this.lookup();
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

  private lookup(): Command | undefined {
    return this.stateTransitions?.get(symbolAt(this.tape, this.position));
  }

  private clearHistory(): void {
    this.historyCmd = [];
    this.historyPos = EMPTY_INT32;
    this.historyLen = EMPTY_INT32;
    this.historySym = [];
    this.historyCap = 0;
    this.historyHead = 0;
    this.historySize = 0;
  }

  private growHistory(): void {
    const oldCap = this.historyCap;
    const rawNext = oldCap === 0 ? INITIAL_HISTORY_CAPACITY : oldCap * 2;
    const nextCap = Math.min(this.maxHistory, rawNext);

    const nextCmd = new Array<Command | undefined>(nextCap);
    const nextPos = new Int32Array(nextCap);
    const nextLen = new Int32Array(nextCap);
    const nextSym = new Array<string | undefined>(nextCap);

    if (this.historySize > 0) {
      if (this.historyHead === 0) {
        for (let i = 0; i < this.historySize; i += 1) {
          nextCmd[i] = this.historyCmd[i];
          nextSym[i] = this.historySym[i];
        }
        nextPos.set(this.historyPos.subarray(0, this.historySize));
        nextLen.set(this.historyLen.subarray(0, this.historySize));
      } else {
        for (let i = 0; i < this.historySize; i += 1) {
          const src = (this.historyHead + i) % oldCap;
          nextCmd[i] = this.historyCmd[src];
          nextPos[i] = this.historyPos[src] ?? 0;
          nextLen[i] = this.historyLen[src] ?? 0;
          nextSym[i] = this.historySym[src];
        }
        this.historyHead = 0;
      }
    }

    this.historyCmd = nextCmd;
    this.historyPos = nextPos;
    this.historyLen = nextLen;
    this.historySym = nextSym;
    this.historyCap = nextCap;
  }

  private pushHistory(
    command: Command,
    prevPosition: number,
    prevTapeLength: number,
    prevSymbol: string | undefined,
  ): void {
    if (this.maxHistory === 0) return;

    if (this.historySize === this.historyCap && this.historyCap < this.maxHistory) {
      this.growHistory();
    }

    let writeIdx: number;
    if (this.historySize < this.historyCap) {
      writeIdx = (this.historyHead + this.historySize) % this.historyCap;
      this.historySize += 1;
    } else {
      // Buffer is full: overwrite the oldest record in O(1).
      writeIdx = this.historyHead;
      this.historyHead = (this.historyHead + 1) % this.historyCap;
    }

    this.historyCmd[writeIdx] = command;
    this.historyPos[writeIdx] = prevPosition;
    this.historyLen[writeIdx] = prevTapeLength;
    this.historySym[writeIdx] = prevSymbol;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isAtStart(): boolean {
    return this.steps === 0;
  }

  get canStepBack(): boolean {
    return this.historySize > 0;
  }

  /** Number of steps currently retained in the undo buffer. */
  get historyLength(): number {
    return this.historySize;
  }

  /** Configured maximum undo history capacity. */
  get historyLimit(): number {
    return this.maxHistory;
  }

  /** True when earlier steps were evicted because total steps exceeded {@link historyLimit}. */
  get isHistoryTruncated(): boolean {
    return this.steps > this.historySize;
  }

  get currentState(): StateId {
    return this.state;
  }

  get headPosition(): number {
    return this.position;
  }

  get stepsCount(): number {
    return this.steps;
  }

  get currentSymbol(): string {
    return symbolAt(this.tape, this.position);
  }

  /** The command that will be executed by the next {@link step}. */
  get nextCommand(): Command | undefined {
    return this.next;
  }

  get initialTape(): string {
    return this.initialTapeText;
  }

  /** Current tape as a read-only cell array (zero-copy view for incremental rendering). */
  get tapeCells(): readonly string[] {
    return this.tape;
  }

  /** Current tape as a string; every cell visited by the head is kept. */
  get tapeText(): string {
    return this.tape.join('');
  }

  /** Highest number of cells the run has ever occupied up to the current step. */
  get cellsUsed(): number {
    return this.tape.length;
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
   * Execute one command forward.
   *
   * @returns `false` when the machine has already halted
   * @throws {NoSuchCommandError} when the transition is undefined
   * @throws {OutOfTapeError} when the head is moved left of the tape start
   */
  step(): boolean {
    if (!this.running) return false;

    const command = this.next;
    if (command === undefined) {
      this.running = false;
      throw new NoSuchCommandError({ state: this.state, symbol: this.currentSymbol });
    }

    if (command.kind === 'left' && this.position === 0) {
      this.running = false;
      throw new OutOfTapeError({ command });
    }

    const prevPosition = this.position;
    const prevTapeLength = this.tape.length;
    let prevSymbol: string | undefined;

    switch (command.kind) {
      case 'left':
        this.position -= 1;
        break;
      case 'right':
        this.position += 1;
        while (this.tape.length <= this.position) this.tape.push(' ');
        break;
      case 'write':
        while (this.tape.length <= this.position) this.tape.push(' ');
        prevSymbol = this.tape[this.position] ?? ' ';
        if (prevSymbol !== command.v) {
          this.tape[this.position] = command.v;
          this.markCellDirty(this.position);
        }
        break;
      case 'stay':
        break;
      case 'halt':
        break;
    }

    this.pushHistory(command, prevPosition, prevTapeLength, prevSymbol);
    this.steps += 1;

    if (command.isHalt) {
      this.running = false;
      this.next = undefined;
    } else {
      if (command.w !== this.state) {
        this.state = command.w;
        this.stateTransitions = this.program.transitions.get(command.w);
      }
      this.next = this.lookup();
    }

    return true;
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
    if (this.historySize === 0) return null;

    this.historySize -= 1;
    const readIdx = (this.historyHead + this.historySize) % this.historyCap;
    const command = this.historyCmd[readIdx];
    const prevPosition = this.historyPos[readIdx] ?? 0;
    const prevTapeLength = this.historyLen[readIdx] ?? 0;
    const prevSymbol = this.historySym[readIdx];

    this.historyCmd[readIdx] = undefined;
    this.historySym[readIdx] = undefined;
    if (this.historySize === 0) this.clearHistory();

    if (command === undefined) return null;

    this.tape.length = prevTapeLength;
    if (command.kind === 'write') {
      const restored = prevSymbol ?? ' ';
      if (this.tape[prevPosition] !== restored) {
        this.tape[prevPosition] = restored;
        this.markCellDirty(prevPosition);
      }
    }

    this.position = prevPosition;
    if (command.q !== this.state) {
      this.state = command.q;
      this.stateTransitions = this.program.transitions.get(command.q);
    }
    this.steps -= 1;
    this.running = true;
    this.next = command;

    return command;
  }

  /** Reset the run back to step 0 with the original tape and initial state. */
  reset(): void {
    const initial = this.initialTapeCells;
    this.tape.length = initial.length + 1;
    for (let i = 0; i < initial.length; i += 1) {
      this.tape[i] = initial[i] ?? ' ';
    }
    this.tape[initial.length] = ' ';
    this.dirtyAll = true;
    this.dirtyCells.length = 0;
    this.clearHistory();
    this.state = this.program.initialState;
    this.stateTransitions = this.program.transitions.get(this.state);
    this.position = initial.length;
    this.running = true;
    this.steps = 0;
    this.next = this.lookup();
  }

  /**
   * Why the finished run deviates from the "normal" convention, if it does.
   * A normal run keeps the source data intact (including the blank separator
   * cell after it, where the head starts) and stops right after the result;
   * matches original jstu4 v2.3 exactly.
   */
  checkNormality(): 'normal' | 'sourceAltered' | 'misplaced' {
    // Original v2.3's `initialTape()` is `initialTapeText + ' '` (length + 1),
    // so overwriting that separating blank cell (appending output with no
    // space) is also flagged as altering the source data.
    const sourceWithSeparatorLength = this.initialTapeText.length + 1;
    const current = this.tapeText;
    const sourcePrefix = current.slice(0, sourceWithSeparatorLength).replace(/\s+$/, '');

    if (sourcePrefix !== this.initialTapeText) return 'sourceAltered';
    if (current.replace(/\s+$/, '').length !== this.position) return 'misplaced';
    return 'normal';
  }
}
