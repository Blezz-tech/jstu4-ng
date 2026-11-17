import type { ProgramValidationError } from './errors';
import type { Command, CommandKind, StateId } from './machine';
import { err, ok, type Result } from './result';

/** Packed command operation codes stored in the low 3 bits of `cmdMeta`. */
export const OP_LEFT = 0;
export const OP_RIGHT = 1;
export const OP_WRITE = 2;
export const OP_STAY = 3;
export const OP_HALT = 4;
export const OP_MASK = 0x07;
/** Bit flag in `cmdMeta` indicating that the machine halts after this command. */
export const OP_FLAG_HALT = 0x08;

/**
 * Maximum number of `Int32` slots (`stateCount * alphabetSize`) allowed for
 * the O(1) dense 2D transition matrix (~1 MiB). Larger state×alphabet products
 * automatically switch to Compressed Sparse Row (CSR) layout in O(C) memory.
 */
const DENSE_TRANSITION_CELL_LIMIT = 262_144;

const EMPTY_UINT32 = new Uint32Array(0);
const EMPTY_INT32 = new Int32Array(0);

export interface BytecodeCompileOptions {
  /** Override the dense matrix cell threshold (primarily for testing sparse CSR mode). */
  readonly denseLimit?: number;
}

/**
 * Flat linear-memory representation of a validated Turing machine program.
 *
 * Every runtime table (commands + transition index) lives inside a single
 * contiguous `ArrayBuffer` with zero JS heap references, eliminating nested
 * `Map` allocations and enabling cache-friendly integer-indexed execution.
 */
export interface CompiledBytecode {
  /** Single contiguous linear-memory buffer holding all command and transition views. */
  readonly buffer: ArrayBuffer;
  readonly commandCount: number;
  readonly stateCount: number;
  readonly alphabetSize: number;
  readonly transitionMode: 'dense' | 'sparse';

  /** Source state index (`0..stateCount-1`) for each command (`stepBack`). */
  readonly cmdFrom: Uint32Array;
  /** Target state index (`0..stateCount-1`) for each command. */
  readonly cmdNext: Uint32Array;
  /** Written symbol id (`0..alphabetSize-1`) for `OP_WRITE` commands (`0` otherwise). */
  readonly cmdWrite: Uint32Array;
  /** Packed `(opCode & 0x07) | (isHalt ? 0x08 : 0)` for each command (1 byte/command). */
  readonly cmdMeta: Uint8Array;

  /** Dense `stateIdx * alphabetSize + symId -> cmdIdx | -1` table, or `null` in sparse mode. */
  readonly denseTransitions: Int32Array | null;
  /** CSR row offsets (`length = stateCount + 1`) in sparse mode, empty in dense mode. */
  readonly csrRowOffset: Uint32Array;
  /** CSR sorted column symbol ids (`length = commandCount`) in sparse mode. */
  readonly csrColSym: Uint32Array;
  /** CSR command indices (`length = commandCount`) in sparse mode. */
  readonly csrCmdIdx: Int32Array;

  /** Boundary lookup tables (used outside the hot loop for errors and tape symbol interning). */
  readonly idToState: readonly StateId[];
  readonly idToSym: readonly string[];
  readonly symToId: ReadonlyMap<string, number>;
}

interface CompiledBytecodeProgram {
  readonly initialState: StateId;
  readonly bytecode: CompiledBytecode;
}

function encodeOpMeta(kind: CommandKind, isHalt: boolean): number {
  let code: number;
  switch (kind) {
    case 'left':
      code = OP_LEFT;
      break;
    case 'right':
      code = OP_RIGHT;
      break;
    case 'write':
      code = OP_WRITE;
      break;
    case 'stay':
      code = OP_STAY;
      break;
    case 'halt':
      code = OP_HALT;
      break;
  }
  return isHalt ? code | OP_FLAG_HALT : code;
}

/**
 * In-place zero-allocation sort of CSR slice `[start, end)` by `(colSym, cmdIdx)`
 * ascending: insertion sort for tiny rows, heapsort for large rows (O(k log k) worst-case).
 */
function sortCsrRow(cols: Uint32Array, cmds: Int32Array, start: number, end: number): void {
  const len = end - start;
  if (len <= 1) return;

  if (len <= 32) {
    for (let i = start + 1; i < end; i += 1) {
      const col = cols[i]!;
      const cmd = cmds[i]!;
      let j = i - 1;
      while (j >= start && (cols[j]! > col || (cols[j]! === col && cmds[j]! > cmd))) {
        cols[j + 1] = cols[j]!;
        cmds[j + 1] = cmds[j]!;
        j -= 1;
      }
      cols[j + 1] = col;
      cmds[j + 1] = cmd;
    }
    return;
  }

  const siftDown = (root: number, heapEnd: number): void => {
    let i = root;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= heapEnd) return;
      let largest = left;
      const right = left + 1;
      if (right < heapEnd) {
        const lc = cols[start + left]!;
        const rc = cols[start + right]!;
        if (rc > lc || (rc === lc && cmds[start + right]! > cmds[start + left]!)) {
          largest = right;
        }
      }
      const ic = cols[start + i]!;
      const bc = cols[start + largest]!;
      if (ic > bc || (ic === bc && cmds[start + i]! >= cmds[start + largest]!)) return;

      cols[start + i] = bc;
      cols[start + largest] = ic;
      const tmpCmd = cmds[start + i]!;
      cmds[start + i] = cmds[start + largest]!;
      cmds[start + largest] = tmpCmd;
      i = largest;
    }
  };

  for (let i = (len >> 1) - 1; i >= 0; i -= 1) siftDown(i, len);
  for (let heapEnd = len - 1; heapEnd > 0; heapEnd -= 1) {
    const tmpCol = cols[start]!;
    cols[start] = cols[start + heapEnd]!;
    cols[start + heapEnd] = tmpCol;
    const tmpCmd = cmds[start]!;
    cmds[start] = cmds[start + heapEnd]!;
    cmds[start + heapEnd] = tmpCmd;
    siftDown(0, heapEnd);
  }
}

/**
 * Validate commands and compile them into a single contiguous `ArrayBuffer`
 * containing both the command SoA arrays and the transition lookup table.
 *
 * Validation preserves exact error priority:
 * 1. `emptyProgram`
 * 2. `ambiguousCommand` (earliest duplicate in source order)
 * 3. `nonexistentInitialState`
 * 4. `nonexistentTargetState` (earliest invalid target in source order)
 */
export function compileProgramBytecode(
  commands: readonly Command[],
  initialState?: StateId | null,
  options: BytecodeCompileOptions = {},
): Result<CompiledBytecodeProgram, ProgramValidationError> {
  const count = commands.length;
  const first = commands[0];
  if (first === undefined) return err({ kind: 'emptyProgram' });

  const q0 = initialState ?? first.q;
  const denseLimit = options.denseLimit ?? DENSE_TRANSITION_CELL_LIMIT;

  // Intern states with `q0` pinned at index 0, and symbols with `' '` pinned at index 0.
  const stateToId = new Map<StateId, number>();
  const idToState: StateId[] = [];
  stateToId.set(q0, 0);
  idToState.push(q0);
  let hasInitialState = false;

  const symToId = new Map<string, number>();
  const idToSym: string[] = [];
  symToId.set(' ', 0);
  idToSym.push(' ');

  const internSymbol = (symbol: string): number => {
    let id = symToId.get(symbol);
    if (id === undefined) {
      id = idToSym.length;
      symToId.set(symbol, id);
      idToSym.push(symbol);
    }
    return id;
  };

  // Pass 1: intern every source state and alphabet symbol while recording per-command ids.
  const tempFrom = new Uint32Array(count);
  const tempRead = new Uint32Array(count);
  const tempWrite = new Uint32Array(count);

  for (let i = 0; i < count; i += 1) {
    const command = commands[i]!;
    let qIdx = stateToId.get(command.q);
    if (qIdx === undefined) {
      qIdx = idToState.length;
      stateToId.set(command.q, qIdx);
      idToState.push(command.q);
    }
    if (qIdx === 0) hasInitialState = true;

    tempFrom[i] = qIdx;
    tempRead[i] = internSymbol(command.a);
    tempWrite[i] = command.kind === 'write' ? internSymbol(command.v) : 0;
  }

  const stateCount = idToState.length;
  const alphabetSize = idToSym.length;
  const denseCells = stateCount * alphabetSize;
  const useDense = denseCells <= denseLimit;

  // Allocate one single contiguous ArrayBuffer: all 4-byte aligned 32-bit views first, then 1-byte cmdMeta.
  const cmd32Bytes = count * 4;
  const transBytes = useDense ? denseCells * 4 : (stateCount + 1) * 4 + count * 4 + count * 4;
  const totalBytes = cmd32Bytes * 3 + transBytes + count;
  const buffer = new ArrayBuffer(totalBytes);

  let byteOffset = 0;
  const cmdFrom = new Uint32Array(buffer, byteOffset, count);
  byteOffset += cmd32Bytes;
  const cmdNext = new Uint32Array(buffer, byteOffset, count);
  byteOffset += cmd32Bytes;
  const cmdWrite = new Uint32Array(buffer, byteOffset, count);
  byteOffset += cmd32Bytes;

  cmdFrom.set(tempFrom);
  cmdWrite.set(tempWrite);

  let denseTransitions: Int32Array | null = null;
  let csrRowOffset: Uint32Array = EMPTY_UINT32;
  let csrColSym: Uint32Array = EMPTY_UINT32;
  let csrCmdIdx: Int32Array = EMPTY_INT32;

  if (useDense) {
    denseTransitions = new Int32Array(buffer, byteOffset, denseCells);
    byteOffset += denseCells * 4;
    denseTransitions.fill(-1);

    for (let i = 0; i < count; i += 1) {
      const slot = cmdFrom[i]! * alphabetSize + tempRead[i]!;
      const prev = denseTransitions[slot]!;
      if (prev !== -1) {
        return err({
          kind: 'ambiguousCommand',
          command: commands[i]!,
          original: commands[prev]!,
        });
      }
      denseTransitions[slot] = i;
    }
  } else {
    csrRowOffset = new Uint32Array(buffer, byteOffset, stateCount + 1);
    byteOffset += (stateCount + 1) * 4;
    csrColSym = new Uint32Array(buffer, byteOffset, count);
    byteOffset += count * 4;
    csrCmdIdx = new Int32Array(buffer, byteOffset, count);
    byteOffset += count * 4;

    // Count commands per state, prefix-sum offsets, then scatter into CSR rows.
    for (let i = 0; i < count; i += 1) {
      csrRowOffset[cmdFrom[i]! + 1] = csrRowOffset[cmdFrom[i]! + 1]! + 1;
    }
    for (let s = 0; s < stateCount; s += 1) {
      csrRowOffset[s + 1] = csrRowOffset[s + 1]! + csrRowOffset[s]!;
    }

    const writeCursor = new Uint32Array(stateCount);
    writeCursor.set(csrRowOffset.subarray(0, stateCount));
    for (let i = 0; i < count; i += 1) {
      const qIdx = cmdFrom[i]!;
      const dst = writeCursor[qIdx]!;
      writeCursor[qIdx] = dst + 1;
      csrColSym[dst] = tempRead[i]!;
      csrCmdIdx[dst] = i;
    }

    // Sort each row and detect the earliest duplicate in source order.
    let earliestDupCmd = count;
    let earliestOrigCmd = -1;
    for (let s = 0; s < stateCount; s += 1) {
      const start = csrRowOffset[s]!;
      const end = csrRowOffset[s + 1]!;
      sortCsrRow(csrColSym, csrCmdIdx, start, end);
      for (let k = start + 1; k < end; k += 1) {
        if (csrColSym[k] === csrColSym[k - 1]) {
          const dupIdx = csrCmdIdx[k]!;
          if (dupIdx < earliestDupCmd) {
            earliestDupCmd = dupIdx;
            earliestOrigCmd = csrCmdIdx[k - 1]!;
          }
        }
      }
    }
    if (earliestOrigCmd !== -1) {
      return err({
        kind: 'ambiguousCommand',
        command: commands[earliestDupCmd]!,
        original: commands[earliestOrigCmd]!,
      });
    }
  }

  if (!hasInitialState) {
    return err({ kind: 'nonexistentInitialState', state: q0 });
  }

  const cmdMeta = new Uint8Array(buffer, byteOffset, count);
  for (let i = 0; i < count; i += 1) {
    const command = commands[i]!;
    const wIdx = stateToId.get(command.w);
    if (wIdx === undefined) {
      return err({ kind: 'nonexistentTargetState', command });
    }
    cmdNext[i] = wIdx;
    cmdMeta[i] = encodeOpMeta(command.kind, command.isHalt);
  }

  return ok({
    initialState: q0,
    bytecode: {
      buffer,
      commandCount: count,
      stateCount,
      alphabetSize,
      transitionMode: useDense ? 'dense' : 'sparse',
      cmdFrom,
      cmdNext,
      cmdWrite,
      cmdMeta,
      denseTransitions,
      csrRowOffset,
      csrColSym,
      csrCmdIdx,
      idToState,
      idToSym,
      symToId,
    },
  });
}

/** O(1) dense / O(log deg) sparse CSR lookup returning command index or `-1`. */
export function lookupTransitionIndex(
  bc: CompiledBytecode,
  stateIdx: number,
  symId: number,
): number {
  if (symId >= bc.alphabetSize) return -1;
  const dense = bc.denseTransitions;
  if (dense !== null) {
    return dense[stateIdx * bc.alphabetSize + symId] ?? -1;
  }

  let lo = bc.csrRowOffset[stateIdx] ?? 0;
  let hi = (bc.csrRowOffset[stateIdx + 1] ?? 0) - 1;
  const cols = bc.csrColSym;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const col = cols[mid]!;
    if (col === symId) return bc.csrCmdIdx[mid] ?? -1;
    if (col < symId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
