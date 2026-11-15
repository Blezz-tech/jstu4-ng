import type { Command } from './machine';

/** Default maximum number of reversible steps kept in memory per run. */
export const DEFAULT_MAX_HISTORY = 100_000;

/** Initial backing capacity for the growable SoA undo ring buffer. */
const INITIAL_HISTORY_CAPACITY = 256;

const EMPTY_INT32 = new Int32Array(0);

export interface PoppedStep {
  readonly command: Command;
  readonly prevPosition: number;
  readonly prevTapeLength: number;
  readonly prevSymbol: string | undefined;
}

/**
 * Bounded O(1) growable Structure-of-Arrays (SoA) ring buffer for reversible
 * Turing machine execution history. Avoids per-step object allocations and
 * cuts 100k-step memory usage ~4× (`prevState` always equals `command.q`).
 */
export class UndoHistory {
  readonly limit: number;
  private cmd: (Command | undefined)[] = [];
  private pos: Int32Array = EMPTY_INT32;
  private len: Int32Array = EMPTY_INT32;
  private sym: (string | undefined)[] = [];
  private cap = 0;
  private head = 0;
  private count = 0;

  constructor(maxHistory?: number) {
    const raw = maxHistory ?? DEFAULT_MAX_HISTORY;
    this.limit = Number.isFinite(raw)
      ? Math.max(0, Math.floor(raw))
      : raw === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : DEFAULT_MAX_HISTORY;
  }

  get size(): number {
    return this.count;
  }

  push(
    command: Command,
    prevPosition: number,
    prevTapeLength: number,
    prevSymbol: string | undefined,
  ): void {
    if (this.limit === 0) return;

    if (this.count === this.cap && this.cap < this.limit) {
      this.grow();
    }

    let writeIdx: number;
    if (this.count < this.cap) {
      writeIdx = (this.head + this.count) % this.cap;
      this.count += 1;
    } else {
      // Buffer is at limit: overwrite the oldest record in O(1).
      writeIdx = this.head;
      this.head = (this.head + 1) % this.cap;
    }

    this.cmd[writeIdx] = command;
    this.pos[writeIdx] = prevPosition;
    this.len[writeIdx] = prevTapeLength;
    this.sym[writeIdx] = prevSymbol;
  }

  pop(): PoppedStep | null {
    if (this.count === 0) return null;

    this.count -= 1;
    const readIdx = (this.head + this.count) % this.cap;
    const command = this.cmd[readIdx];
    const prevPosition = this.pos[readIdx] ?? 0;
    const prevTapeLength = this.len[readIdx] ?? 0;
    const prevSymbol = this.sym[readIdx];

    this.cmd[readIdx] = undefined;
    this.sym[readIdx] = undefined;
    if (this.count === 0) this.clear();

    if (command === undefined) return null;
    return { command, prevPosition, prevTapeLength, prevSymbol };
  }

  clear(): void {
    this.cmd = [];
    this.pos = EMPTY_INT32;
    this.len = EMPTY_INT32;
    this.sym = [];
    this.cap = 0;
    this.head = 0;
    this.count = 0;
  }

  private grow(): void {
    // `grow()` is only ever called while `cap < limit`, before any wrap-around
    // can advance `head`, so active entries are always contiguous at `[0, count)`.
    const nextCap = Math.min(this.limit, this.cap === 0 ? INITIAL_HISTORY_CAPACITY : this.cap * 2);
    const nextCmd = new Array<Command | undefined>(nextCap);
    const nextPos = new Int32Array(nextCap);
    const nextLen = new Int32Array(nextCap);
    const nextSym = new Array<string | undefined>(nextCap);

    if (this.count > 0) {
      for (let i = 0; i < this.count; i += 1) {
        nextCmd[i] = this.cmd[i];
        nextSym[i] = this.sym[i];
      }
      nextPos.set(this.pos.subarray(0, this.count));
      nextLen.set(this.len.subarray(0, this.count));
    }

    this.cmd = nextCmd;
    this.pos = nextPos;
    this.len = nextLen;
    this.sym = nextSym;
    this.cap = nextCap;
  }
}
