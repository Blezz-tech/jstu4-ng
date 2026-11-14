import type { I18n } from '../i18n';

export const SNAPSHOTS_STORAGE_KEY = 'jstu4:snapshots';
/** Periodic autosave interval while the user is actively editing (5 minutes). */
export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_AUTOSAVES = 100;

export type SnapshotKind = 'autosave' | 'manual';

export interface ProgramSnapshot {
  readonly id: string;
  readonly kind: SnapshotKind;
  /** Creation time in Unix ms; immutable across renames. */
  readonly createdAt: number;
  /** User-supplied name; `null` for unnamed manual saves and autosaves. */
  readonly customName: string | null;
  readonly program: string;
  readonly tape: string;
}

/**
 * Formats a Unix timestamp (ms) in local time as `YYYY-MM-DD-HH-mm-ss`.
 */
export function formatSnapshotTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('-');
}

/**
 * Display label for a snapshot:
 * - Named snapshot → its user-defined `customName`.
 * - Unnamed manual save → `"YYYY-MM-DD-HH-mm-ss Сохранено пользователем"` (RU) /
 *   `"YYYY-MM-DD-HH-mm-ss Saved by user"` (EN).
 * - Unnamed autosave → `"YYYY-MM-DD-HH-mm-ss автосохранение"` (RU) /
 *   `"YYYY-MM-DD-HH-mm-ss autosave"` (EN).
 */
export function getSnapshotDisplayName(snapshot: ProgramSnapshot, i18n: I18n): string {
  if (snapshot.customName !== null) return snapshot.customName;
  const ts = formatSnapshotTimestamp(snapshot.createdAt);
  const suffix = i18n.t(
    snapshot.kind === 'autosave' ? 'history.autosaveSuffix' : 'history.manualSuffix',
  );
  return `${ts} ${suffix}`;
}

function isSnapshotKind(value: unknown): value is SnapshotKind {
  return value === 'autosave' || value === 'manual';
}

function parseSnapshot(value: unknown): ProgramSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (
    typeof rec['id'] !== 'string' ||
    rec['id'] === '' ||
    !isSnapshotKind(rec['kind']) ||
    typeof rec['createdAt'] !== 'number' ||
    !Number.isFinite(rec['createdAt']) ||
    typeof rec['program'] !== 'string' ||
    typeof rec['tape'] !== 'string'
  ) {
    return null;
  }
  const rawName = rec['customName'];
  const customName = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : null;
  return {
    id: rec['id'],
    kind: rec['kind'],
    createdAt: rec['createdAt'],
    customName,
    program: rec['program'],
    tape: rec['tape'],
  };
}

function loadRawSnapshots(): ProgramSnapshot[] {
  try {
    const raw = window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: ProgramSnapshot[] = [];
    for (const item of parsed) {
      const snap = parseSnapshot(item);
      if (snap !== null && !seen.has(snap.id)) {
        seen.add(snap.id);
        result.push(snap);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

interface PersistResult {
  readonly ok: boolean;
  readonly saved: ProgramSnapshot[];
}

function persistSnapshots(snapshots: readonly ProgramSnapshot[]): PersistResult {
  const payload = [...snapshots];
  while (true) {
    try {
      window.localStorage.setItem(SNAPSHOTS_STORAGE_KEY, JSON.stringify(payload));
      return { ok: true, saved: payload };
    } catch {
      // If localStorage is full, prune the oldest unnamed autosave and retry.
      let oldestIdx = -1;
      for (let i = payload.length - 1; i >= 0; i -= 1) {
        const entry = payload[i];
        if (entry !== undefined && entry.kind === 'autosave' && entry.customName === null) {
          oldestIdx = i;
          break;
        }
      }
      if (oldestIdx === -1) return { ok: false, saved: [...snapshots] };
      payload.splice(oldestIdx, 1);
    }
  }
}

let idCounter = 0;

function nextSnapshotId(now: number): string {
  idCounter += 1;
  return `snap-${now.toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface SnapshotStoreOptions {
  /** Initial in-memory snapshots (disables automatic `localStorage` sync when provided). */
  readonly initial?: readonly ProgramSnapshot[];
  /** Invoked when writing to `localStorage` fails even after pruning old autosaves. */
  readonly onPersistError?: () => void;
}

export type SnapshotChangeSource = 'local' | 'storage';

/**
 * Persistent `localStorage`-backed store for program version snapshots.
 * Synchronizes across browser tabs via the `storage` event and merges fresh
 * storage state before each mutation so concurrent tabs never overwrite each other.
 */
export class SnapshotStore {
  private snapshots: ProgramSnapshot[];
  private readonly storageBacked: boolean;
  private readonly onPersistError: (() => void) | undefined;
  private readonly listeners = new Set<(source: SnapshotChangeSource) => void>();
  private readonly storageHandler: ((event: StorageEvent) => void) | null;
  private persistOk = true;

  constructor(options: SnapshotStoreOptions = {}) {
    this.onPersistError = options.onPersistError;
    if (options.initial !== undefined) {
      this.storageBacked = false;
      this.snapshots = [...options.initial].sort((a, b) => b.createdAt - a.createdAt);
    } else {
      this.storageBacked = true;
      this.snapshots = loadRawSnapshots();
    }

    if (this.storageBacked && typeof window !== 'undefined') {
      this.storageHandler = (event: StorageEvent): void => {
        if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
        if (event.key === SNAPSHOTS_STORAGE_KEY || event.key === null) {
          this.reload();
        }
      };
      window.addEventListener('storage', this.storageHandler);
    } else {
      this.storageHandler = null;
    }
  }

  /** Subscribe to snapshot changes (including cross-tab `storage` updates). */
  subscribe(listener: (source: SnapshotChangeSource) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reload snapshots from `localStorage` and notify subscribers. */
  reload(): void {
    if (!this.storageBacked) return;
    this.snapshots = loadRawSnapshots();
    this.notify('storage');
  }

  /** Detach the `storage` event listener and clear subscribers. */
  dispose(): void {
    if (this.storageHandler !== null && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageHandler);
    }
    this.listeners.clear();
  }

  /** Whether the most recent persistence write to `localStorage` succeeded. */
  get lastPersistOk(): boolean {
    return this.persistOk;
  }

  /** All snapshots ordered newest-first. */
  list(): readonly ProgramSnapshot[] {
    return this.snapshots;
  }

  /**
   * Snapshots visible under the current filter, ordered newest-first:
   * - `namedOnly === true` → only user-named snapshots (`customName !== null`).
   * - `namedOnly === false` → all snapshots (named, unnamed manual saves, and autosaves).
   */
  getVisible(namedOnly: boolean): readonly ProgramSnapshot[] {
    return namedOnly ? this.snapshots.filter((s) => s.customName !== null) : this.snapshots;
  }

  getById(id: string): ProgramSnapshot | null {
    return this.snapshots.find((s) => s.id === id) ?? null;
  }

  /** Create and persist a new snapshot (`manual` or `autosave`). */
  create(kind: SnapshotKind, program: string, tape: string, now = Date.now()): ProgramSnapshot {
    this.syncFromStorage();
    const previous = [...this.snapshots];
    const snapshot: ProgramSnapshot = {
      id: nextSnapshotId(now),
      kind,
      createdAt: now,
      customName: null,
      program,
      tape,
    };
    this.snapshots.unshift(snapshot);
    this.snapshots.sort((a, b) => b.createdAt - a.createdAt);
    if (kind === 'autosave') this.trimAutosaves();
    this.commit(previous);
    return snapshot;
  }

  /**
   * Create a timed autosave only if `program` is non-empty and differs from
   * the most recent snapshot (avoids cluttering history with identical duplicates).
   * Returns `null` if skipped or if persistence failed due to storage quota.
   */
  maybeAutosave(program: string, tape: string, now = Date.now()): ProgramSnapshot | null {
    if (program.trim() === '') return null;
    this.syncFromStorage();
    const latest = this.snapshots[0];
    if (latest !== undefined && latest.program === program && latest.tape === tape) {
      return null;
    }
    const created = this.create('autosave', program, tape, now);
    return this.persistOk ? created : null;
  }

  /**
   * Rename any snapshot without changing its original `createdAt` timestamp.
   * Passing an empty/whitespace-only name is rejected and returns `null`.
   */
  rename(id: string, rawName: string): ProgramSnapshot | null {
    const trimmed = rawName.trim();
    if (trimmed === '') return null;
    this.syncFromStorage();
    const idx = this.snapshots.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const current = this.snapshots[idx];
    if (current === undefined) return null;
    const previous = [...this.snapshots];
    const updated: ProgramSnapshot = {
      ...current,
      customName: trimmed,
    };
    this.snapshots[idx] = updated;
    this.commit(previous);
    return this.persistOk ? updated : null;
  }

  /** Permanently remove a snapshot by id. */
  remove(id: string): boolean {
    this.syncFromStorage();
    const idx = this.snapshots.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    const previous = [...this.snapshots];
    this.snapshots.splice(idx, 1);
    this.commit(previous);
    return this.persistOk;
  }

  private syncFromStorage(): void {
    if (this.storageBacked) {
      this.snapshots = loadRawSnapshots();
    }
  }

  private commit(previous: ProgramSnapshot[]): void {
    if (!this.storageBacked) {
      this.persistOk = true;
      this.notify('local');
      return;
    }
    const result = persistSnapshots(this.snapshots);
    this.persistOk = result.ok;
    if (result.ok) {
      this.snapshots = result.saved;
    } else {
      // Roll back in-memory state so UI never displays phantom unsaved entries.
      this.snapshots = previous;
      this.onPersistError?.();
    }
    this.notify('local');
  }

  private notify(source: SnapshotChangeSource): void {
    for (const listener of this.listeners) listener(source);
  }

  private trimAutosaves(): void {
    let autosaveCount = 0;
    this.snapshots = this.snapshots.filter((s) => {
      if (s.kind === 'autosave' && s.customName === null) {
        autosaveCount += 1;
        return autosaveCount <= MAX_AUTOSAVES;
      }
      return true;
    });
  }
}

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
   * the second call is a no-op because `dirty` is cleared immediately.
   */
  flush(now = Date.now()): ProgramSnapshot | null {
    if (!this.dirty) return null;
    const { program, tape } = this.readState();
    this.clearTimer();
    this.dirty = false;
    this.baseline = { program, tape };
    const created = this.store.maybeAutosave(program, tape, now);
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
