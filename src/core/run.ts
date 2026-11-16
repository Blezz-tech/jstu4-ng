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

/** A tape symbol read at a position; an empty cell reads as a space. */
export function symbolAt(tape: readonly string[], index: number): string {
  return tape[index] ?? ' ';
}

function isBlankCell(symbol: string): boolean {
  return symbol === ' ' || symbol === '\t' || symbol === '\n' || symbol === '\r';
}

/**
 * Strip trailing whitespace (not part of the machine input, matching v2.3) and
 * split the remaining text into Unicode code-point cells.
 */
export function normaliseInitialTape(tapeText: string): {
  readonly text: string;
  readonly cells: readonly string[];
} {
  const text = tapeText.replace(/\s+$/, '');
  return { text, cells: Array.from(text) };
}

/**
 * Evaluate whether a finished tape satisfies the "normal" jstu4 convention:
 * source cells and the blank separator cell right after them are untouched,
 * and the head stops immediately after the last non-blank symbol.
 */
export function checkTapeNormality(
  tape: readonly string[],
  initialCells: readonly string[],
  headPosition: number,
): NormalityStatus {
  for (let i = 0; i < initialCells.length; i += 1) {
    if ((tape[i] ?? ' ') !== initialCells[i]) return 'sourceAltered';
  }
  if (!isBlankCell(tape[initialCells.length] ?? ' ')) return 'sourceAltered';

  let trimmedEnd = tape.length;
  while (trimmedEnd > 0 && isBlankCell(tape[trimmedEnd - 1] ?? ' ')) {
    trimmedEnd -= 1;
  }
  if (trimmedEnd !== headPosition) return 'misplaced';
  return 'normal';
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
  private readonly initialTapeText: string;
  private readonly history: UndoHistory;
  private dirtyCells: number[] = [];
  private dirtySnapshot: number[] = [];
  private dirtyAll = false;
  private state: StateId;
  private stateTransitions: ReadonlyMap<string, Command> | undefined;
  private position: number;
  private running = true;
  private next: Command | undefined;
  private steps = 0;

  constructor(
    private readonly program: Program,
    tapeText: string,
    options: MachineRunOptions = {},
  ) {
    this.history = new UndoHistory(options.maxHistory);

    // Trailing whitespace is not a part of the data: the machine starts
    // immediately after the last visible symbol (original behaviour).
    const { text: normalised, cells } = normaliseInitialTape(tapeText);
    this.initialTapeCells = cells;
    this.tape = [...cells, ' '];
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

  /** Number of initial non-trailing-space cells (exact for non-BMP Unicode symbols). */
  get initialLength(): number {
    return this.initialTapeCells.length;
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
   * @returns `ok(true)` when a command executed, `ok(false)` when the machine
   *   was already halted, or `err(RuntimeError)` on undefined transition / left
   *   tape boundary violation.
   */
  step(): Result<boolean, RuntimeError> {
    if (!this.running) return STEP_HALTED;

    const command = this.next;
    if (command === undefined) {
      this.running = false;
      return err({ kind: 'noSuchCommand', state: this.state, symbol: this.currentSymbol });
    }

    if (command.kind === 'left' && this.position === 0) {
      this.running = false;
      return err({ kind: 'outOfTape', command });
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
      case 'halt':
        break;
    }

    this.history.push(command, prevPosition, prevTapeLength, prevSymbol);
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

    return STEP_OK;
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
    const popped = this.history.pop();
    if (popped === null) return null;

    const { command, prevPosition, prevTapeLength, prevSymbol } = popped;
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
    this.history.clear();
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
  checkNormality(): NormalityStatus {
    return checkTapeNormality(this.tape, this.initialTapeCells, this.position);
  }
}
