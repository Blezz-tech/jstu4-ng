import type { Command, StateId } from './machine';
import type { Program } from './program';
import { findTransition } from './program';
import { NoSuchCommandError, OutOfTapeError } from './errors';

/** Default maximum number of reversible steps kept in memory per run. */
export const DEFAULT_MAX_HISTORY = 100_000;

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

/** O(1) diff captured for each executed command so `stepBack()` is exact. */
interface StepRecord {
  readonly command: Command;
  readonly prevState: StateId;
  readonly prevPosition: number;
  readonly prevTapeLength: number;
  readonly prevSymbol: string;
}

/**
 * One machine run. The tape is a plain array of single-character cells,
 * mutable — all mutations go through {@link step}, {@link stepBack}, and
 * {@link reset}, so the run is a deterministic, reversible state machine
 * with bounded O(1) undo history that is trivial to unit-test.
 */
export class MachineRun {
  private readonly tape: string[];
  private readonly maxHistory: number;
  private readonly history: (StepRecord | undefined)[] = [];
  private historyHead = 0;
  private historySize = 0;
  private state: StateId;
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
    this.tape = Array.from(normalised);
    this.initialTapeText = normalised;
    this.state = program.initialState;
    // The head starts *after* the last symbol, on an empty (space) cell.
    this.position = this.tape.length;
    // Materialise the initial cell under the head so `tapeText` and `cellsUsed`
    // stay monotonically non-shrinking when the head moves left (matches v2.3).
    this.tape.push(' ');
    this.next = this.lookup();
  }

  private lookup(): Command | undefined {
    return findTransition(this.program, this.state, symbolAt(this.tape, this.position));
  }

  private pushHistory(record: StepRecord): void {
    if (this.maxHistory === 0) return;
    if (!Number.isFinite(this.maxHistory)) {
      this.history.push(record);
      this.historySize += 1;
      return;
    }
    if (this.historySize < this.maxHistory) {
      const writeIdx = (this.historyHead + this.historySize) % this.maxHistory;
      this.history[writeIdx] = record;
      this.historySize += 1;
      return;
    }
    // Buffer is full: overwrite the oldest record in O(1).
    this.history[this.historyHead] = record;
    this.historyHead = (this.historyHead + 1) % this.maxHistory;
  }

  private popHistory(): StepRecord | undefined {
    if (this.historySize === 0) return undefined;
    if (!Number.isFinite(this.maxHistory)) {
      this.historySize -= 1;
      return this.history.pop();
    }
    this.historySize -= 1;
    const readIdx = (this.historyHead + this.historySize) % this.maxHistory;
    const record = this.history[readIdx];
    this.history[readIdx] = undefined;
    if (this.historySize === 0) {
      this.historyHead = 0;
      this.history.length = 0;
    }
    return record;
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

  /** Current tape as a string; every cell visited by the head is kept. */
  get tapeText(): string {
    return this.tape.join('');
  }

  /** Highest number of cells the run has ever occupied up to the current step. */
  get cellsUsed(): number {
    return this.tape.length;
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

    const prevState = this.state;
    const prevPosition = this.position;
    const prevTapeLength = this.tape.length;
    const prevSymbol = symbolAt(this.tape, prevPosition);

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
        this.tape[this.position] = command.v;
        break;
      case 'stay':
        break;
      case 'halt':
        break;
    }

    this.pushHistory({
      command,
      prevState,
      prevPosition,
      prevTapeLength,
      prevSymbol,
    });
    this.steps += 1;

    if (command.isHalt) {
      this.running = false;
      this.next = undefined;
    } else {
      this.state = command.w;
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
    const record = this.popHistory();
    if (record === undefined) return null;

    this.tape.length = record.prevTapeLength;
    if (record.command.kind === 'write') {
      this.tape[record.prevPosition] = record.prevSymbol;
    }

    this.position = record.prevPosition;
    this.state = record.prevState;
    this.steps -= 1;
    this.running = true;
    this.next = record.command;

    return record.command;
  }

  /** Reset the run back to step 0 with the original tape and initial state. */
  reset(): void {
    this.tape.length = 0;
    this.tape.push(...Array.from(this.initialTapeText), ' ');
    this.history.length = 0;
    this.historyHead = 0;
    this.historySize = 0;
    this.state = this.program.initialState;
    this.position = this.initialTapeText.length;
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
