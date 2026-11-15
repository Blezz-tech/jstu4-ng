import type { ProgramSnapshot, SnapshotStore } from './history';

/** Periodic autosave interval while the user is actively editing (5 minutes). */
export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

/** Formats a Unix timestamp (ms) in local time as `HH:mm`. */
export function formatSaveClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface AutosaveTrackerOptions {
  readonly store: SnapshotStore;
  readonly readState: () => { readonly program: string; readonly tape: string };
  readonly intervalMs?: number;
  readonly onAutosave?: (snapshot: ProgramSnapshot) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
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
export class AutosaveTracker {
  private readonly store: SnapshotStore;
  private readonly readState: () => { readonly program: string; readonly tape: string };
  private readonly intervalMs: number;
  private readonly onAutosave: ((snapshot: ProgramSnapshot) => void) | undefined;
  private readonly onDirtyChange: ((dirty: boolean) => void) | undefined;

  private baseline = { program: '', tape: '' };
  private dirty = false;
  private timerId: number | null = null;

  constructor(options: AutosaveTrackerOptions) {
    this.store = options.store;
    this.readState = options.readState;
    this.intervalMs = options.intervalMs ?? AUTOSAVE_INTERVAL_MS;
    this.onAutosave = options.onAutosave;
    this.onDirtyChange = options.onDirtyChange;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Set a clean baseline (initial load, manual save, or snapshot restore) and stop the timer. */
  reset(program: string, tape: string): void {
    this.baseline = { program, tape };
    this.clearTimer();
    if (this.dirty) {
      this.dirty = false;
      this.onDirtyChange?.(false);
    }
  }

  /** Notify the tracker after a user edit in the program or tape input. */
  markEdited(program: string, tape: string): void {
    const matchesBaseline = program === this.baseline.program && tape === this.baseline.tape;
    const latest = this.store.list()[0];
    const matchesLatest =
      latest !== undefined && latest.program === program && latest.tape === tape;
    const nextDirty = program.trim() !== '' && !matchesBaseline && !matchesLatest;

    if (nextDirty) {
      if (!this.dirty) {
        this.dirty = true;
        this.onDirtyChange?.(true);
      }
      if (this.timerId === null) {
        this.timerId = window.setTimeout(() => {
          this.timerId = null;
          this.flush();
        }, this.intervalMs);
      }
    } else {
      this.clearTimer();
      if (this.dirty) {
        this.dirty = false;
        this.onDirtyChange?.(false);
      }
    }
  }

  /**
   * Synchronously create an autosave if there are unsaved user edits.
   * Safe to call multiple times (e.g. from both `beforeunload` and `pagehide`):
   * once saved, `dirty` is cleared immediately; if persistence fails due to
   * storage quota, `dirty` stays `true` so the user keeps seeing "Unsaved".
   */
  flush(now = Date.now()): ProgramSnapshot | null {
    if (!this.dirty) return null;
    const { program, tape } = this.readState();
    this.clearTimer();
    const created = this.store.maybeAutosave(program, tape, now);
    if (!this.store.lastPersistOk) return null;
    this.dirty = false;
    this.baseline = { program, tape };
    this.onDirtyChange?.(false);
    if (created !== null) this.onAutosave?.(created);
    return created;
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
