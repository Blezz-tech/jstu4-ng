/** Default maximum number of reversible steps kept in memory per run. */
export const DEFAULT_MAX_HISTORY = 100_000;

/** Initial backing capacity for the growable SoA undo ring buffer. */
const INITIAL_HISTORY_CAPACITY = 256;

const EMPTY_INT32 = new Int32Array(0);
const EMPTY_UINT32 = new Uint32Array(0);

/**
 * Bounded O(1) growable linear-memory Structure-of-Arrays (SoA) ring buffer
 * for reversible Turing machine execution history.
 *
 * All four fields (`cmdIdx`, `pos`, `len`, `symId`) live inside a single
 * contiguous `ArrayBuffer` (16 bytes/step, zero JS heap references), so V8's GC
 * never scans the history buffer and neither `push()` nor `pop()` allocates.
 */
export class UndoHistory {
  readonly limit: number;
  private cmdIdx: Int32Array = EMPTY_INT32;
  private pos: Int32Array = EMPTY_INT32;
  private len: Int32Array = EMPTY_INT32;
  private symId: Uint32Array = EMPTY_UINT32;
  private cap = 0;
  private head = 0;
  private count = 0;

  /** Scalar outputs populated by {@link pop} without per-step object allocations. */
  lastCmdIdx = -1;
  lastPos = 0;
  lastLen = 0;
  lastSymId = 0;

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

  push(cmdIdx: number, prevPosition: number, prevTapeLength: number, prevSymId: number): void {
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

    this.cmdIdx[writeIdx] = cmdIdx;
    this.pos[writeIdx] = prevPosition;
    this.len[writeIdx] = prevTapeLength;
    this.symId[writeIdx] = prevSymId;
  }

  /**
   * Pop the most recent step into `lastCmdIdx` / `lastPos` / `lastLen` / `lastSymId`.
   * Returns `false` when the buffer is empty.
   */
  pop(): boolean {
    if (this.count === 0) return false;

    this.count -= 1;
    const readIdx = (this.head + this.count) % this.cap;
    this.lastCmdIdx = this.cmdIdx[readIdx]!;
    this.lastPos = this.pos[readIdx]!;
    this.lastLen = this.len[readIdx]!;
    this.lastSymId = this.symId[readIdx]!;

    if (this.count === 0) this.clear();
    return true;
  }

  clear(): void {
    this.cmdIdx = EMPTY_INT32;
    this.pos = EMPTY_INT32;
    this.len = EMPTY_INT32;
    this.symId = EMPTY_UINT32;
    this.cap = 0;
    this.head = 0;
    this.count = 0;
  }

  private grow(): void {
    // `grow()` is only ever called while `cap < limit`, before any wrap-around
    // can advance `head`, so active entries are always contiguous at `[0, count)`.
    const nextCap = Math.min(this.limit, this.cap === 0 ? INITIAL_HISTORY_CAPACITY : this.cap * 2);
    const strideBytes = nextCap * 4;
    const buffer = new ArrayBuffer(strideBytes * 4);
    const nextCmdIdx = new Int32Array(buffer, 0, nextCap);
    const nextPos = new Int32Array(buffer, strideBytes, nextCap);
    const nextLen = new Int32Array(buffer, strideBytes * 2, nextCap);
    const nextSymId = new Uint32Array(buffer, strideBytes * 3, nextCap);

    if (this.count > 0) {
      nextCmdIdx.set(this.cmdIdx.subarray(0, this.count));
      nextPos.set(this.pos.subarray(0, this.count));
      nextLen.set(this.len.subarray(0, this.count));
      nextSymId.set(this.symId.subarray(0, this.count));
    }

    this.cmdIdx = nextCmdIdx;
    this.pos = nextPos;
    this.len = nextLen;
    this.symId = nextSymId;
    this.cap = nextCap;
  }
}
