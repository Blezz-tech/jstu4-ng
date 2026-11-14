import type { Command, StateId } from './machine';
import type { Program } from './program';
import { findTransition } from './program';
import { NoSuchCommandError, OutOfTapeError } from './errors';

/** A tape symbol read at a position; an empty cell reads as a space. */
export function symbolAt(tape: readonly string[], index: number): string {
  return tape[index] ?? ' ';
}

/**
 * One machine run. The tape is a plain array of single-character cells,
 * mutable — but all mutations go through {@link step}, so the run is a
 * deterministic state machine that is trivial to unit-test.
 */
export class MachineRun {
  private readonly tape: string[];
  private state: StateId;
  private position: number;
  private running = true;
  private next: Command | undefined;
  private steps = 0;
  private readonly initialTapeText: string;
  private cellsHighWaterMark: number;

  constructor(
    private readonly program: Program,
    tapeText: string,
  ) {
    // Trailing whitespace is not a part of the data: the machine starts
    // immediately after the last visible symbol (original behaviour).
    const normalised = tapeText.replace(/\s+$/, '');
    this.tape = Array.from(normalised);
    this.initialTapeText = normalised;
    this.state = program.initialState;
    // The head starts *after* the last symbol, on an empty (space) cell.
    this.position = this.tape.length;
    // Include the initial blank cell under the head, matching `tapeText.length`
    // and original jstu4 v2.3's `tmRun.tape().length`.
    this.cellsHighWaterMark = this.position + 1;
    this.next = this.lookup();
  }

  private lookup(): Command | undefined {
    return findTransition(this.program, this.state, symbolAt(this.tape, this.position));
  }

  get isRunning(): boolean {
    return this.running;
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

  /** Current tape as a string; the cell under the head is always present. */
  get tapeText(): string {
    const cells = [...this.tape];
    while (cells.length <= this.position) cells.push(' ');
    return cells.join('');
  }

  /** Highest number of cells the run has ever occupied. */
  get cellsUsed(): number {
    return this.cellsHighWaterMark;
  }

  /**
   * Execute one command.
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

    switch (command.kind) {
      case 'left':
        if (this.position === 0) {
          this.running = false;
          throw new OutOfTapeError({ command });
        }
        this.position -= 1;
        break;
      case 'right':
        this.position += 1;
        this.cellsHighWaterMark = Math.max(this.cellsHighWaterMark, this.position + 1);
        break;
      case 'write':
        while (this.tape.length <= this.position) this.tape.push(' ');
        this.tape[this.position] = command.v;
        this.cellsHighWaterMark = Math.max(this.cellsHighWaterMark, this.tape.length);
        break;
      case 'stay':
        break;
      case 'halt':
        break;
    }

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
