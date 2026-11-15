import type { ProgramSnapshot, SnapshotStore } from './history';

/** Periodic autosave interval while the user is actively editing (5 minutes). */
export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

export interface DraftState {
  readonly program: string;
  readonly tape: string;
}

/** Formats a Unix timestamp (ms) in local time as `HH:mm`. */
export function formatSaveClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Pure dirty predicate: a draft has unsaved changes iff the program is non-blank
 * and differs from both the clean baseline and the latest persisted snapshot.
 */
export function isDraftDirty(
  draft: DraftState,
  baseline: DraftState,
  latest: Pick<ProgramSnapshot, 'program' | 'tape'> | undefined,
): boolean {
  if (draft.program.trim() === '') return false;
  if (draft.program === baseline.program && draft.tape === baseline.tape) return false;
  if (latest !== undefined && latest.program === draft.program && latest.tape === draft.tape) {
    return false;
  }
  return true;
}

export interface AutosaveTrackerOptions {
  readonly store: SnapshotStore;
  readonly readState: () => DraftState;
  readonly intervalMs?: number;
  readonly onAutosave?: (snapshot: ProgramSnapshot) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

export interface AutosaveTracker {
  readonly isDirty: boolean;
  /** Set a clean baseline (initial load, manual save, or snapshot restore) and stop the timer. */
  reset(program: string, tape: string): void;
  /** Notify the tracker after a user edit in the program or tape input. */
  markEdited(program: string, tape: string): void;
  /**
   * Synchronously create an autosave if there are unsaved user edits.
   * Safe to call multiple times (e.g. from both `beforeunload` and `pagehide`):
   * once saved, `dirty` is cleared immediately; if persistence fails due to
   * storage quota, `dirty` stays `true` so the user keeps seeing "Unsaved".
   */
  flush(now?: number): ProgramSnapshot | null;
  dispose(): void;
}

/**
 * Dirty-driven autosave scheduler:
 * - Does nothing while the user has not edited the program or tape.
 * - Starts a single countdown (`AUTOSAVE_INTERVAL_MS`, default 5 minutes) upon
 *   the first unsaved edit; cancels it automatically if the user reverts back
 *   to the baseline or saves manually.
 * - Exposes `flush()` for synchronous autosaving on tab close (`pagehide` /
 *   `beforeunload`) and before restoring another snapshot.
 */
export function createAutosaveTracker({
  store,
  readState,
  intervalMs = AUTOSAVE_INTERVAL_MS,
  onAutosave,
  onDirtyChange,
}: AutosaveTrackerOptions): AutosaveTracker {
  let baseline: DraftState = { program: '', tape: '' };
  let dirty = false;
  let timerId: number | null = null;

  const clearTimer = (): void => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  const setDirty = (next: boolean): void => {
    if (dirty === next) return;
    dirty = next;
    onDirtyChange?.(next);
  };

  const flush = (now = Date.now()): ProgramSnapshot | null => {
    if (!dirty) return null;
    const { program, tape } = readState();
    clearTimer();
    const created = store.maybeAutosave(program, tape, now);
    if (!store.lastPersistOk) return null;
    baseline = { program, tape };
    setDirty(false);
    if (created !== null) onAutosave?.(created);
    return created;
  };

  return {
    get isDirty(): boolean {
      return dirty;
    },
    reset(program, tape) {
      baseline = { program, tape };
      clearTimer();
      setDirty(false);
    },
    markEdited(program, tape) {
      if (isDraftDirty({ program, tape }, baseline, store.list()[0])) {
        setDirty(true);
        if (timerId === null) {
          timerId = window.setTimeout(() => {
            timerId = null;
            flush();
          }, intervalMs);
        }
      } else {
        clearTimer();
        setDirty(false);
      }
    },
    flush,
    dispose: clearTimer,
  };
}
