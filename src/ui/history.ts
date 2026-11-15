import type { I18n } from '../i18n';

export {
  AUTOSAVE_INTERVAL_MS,
  createAutosaveTracker,
  formatSaveClock,
  isDraftDirty,
  type AutosaveTracker,
  type AutosaveTrackerOptions,
  type DraftState,
} from './autosave';

export const SNAPSHOTS_STORAGE_KEY = 'jstu4:snapshots';
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

// ——— pure snapshot collection operations ——————————————————————————

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

/** Validate, deduplicate by `id`, and sort an untrusted decoded JSON snapshot array newest-first. */
export function parseSnapshotsList(parsed: unknown): ProgramSnapshot[] {
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
}

/** Return visible snapshots under the `namedOnly` filter (newest-first). */
export function filterSnapshots(
  snapshots: readonly ProgramSnapshot[],
  namedOnly: boolean,
): readonly ProgramSnapshot[] {
  return namedOnly ? snapshots.filter((s) => s.customName !== null) : snapshots;
}

/** Check whether the newest snapshot already has identical `program` and `tape`. */
export function matchesLatestSnapshot(
  snapshots: readonly ProgramSnapshot[],
  program: string,
  tape: string,
): boolean {
  const latest = snapshots[0];
  return latest !== undefined && latest.program === program && latest.tape === tape;
}

/** Enforce the `MAX_AUTOSAVES` cap on unnamed autosaves while keeping named and manual saves intact. */
export function trimUnnamedAutosaves(
  snapshots: readonly ProgramSnapshot[],
  maxAutosaves = MAX_AUTOSAVES,
): ProgramSnapshot[] {
  let autosaveCount = 0;
  return snapshots.filter((s) => {
    if (s.kind === 'autosave' && s.customName === null) {
      autosaveCount += 1;
      return autosaveCount <= maxAutosaves;
    }
    return true;
  });
}

/** Insert a snapshot newest-first (fast prepend when monotonic) and trim unnamed autosaves. */
export function insertSnapshotIntoList(
  snapshots: readonly ProgramSnapshot[],
  snapshot: ProgramSnapshot,
  maxAutosaves = MAX_AUTOSAVES,
): ProgramSnapshot[] {
  const prevTop = snapshots[0]?.createdAt ?? Number.NEGATIVE_INFINITY;
  const next = [snapshot, ...snapshots];
  if (snapshot.createdAt < prevTop) next.sort((a, b) => b.createdAt - a.createdAt);
  return snapshot.kind === 'autosave' ? trimUnnamedAutosaves(next, maxAutosaves) : next;
}

/** Purely rename a snapshot by `id`, preserving `createdAt`; returns `null` if blank or missing. */
export function renameSnapshotInList(
  snapshots: readonly ProgramSnapshot[],
  id: string,
  rawName: string,
): { readonly snapshots: ProgramSnapshot[]; readonly updated: ProgramSnapshot } | null {
  const trimmed = rawName.trim();
  if (trimmed === '') return null;
  const idx = snapshots.findIndex((s) => s.id === id);
  const current = idx !== -1 ? snapshots[idx] : undefined;
  if (current === undefined) return null;
  const updated: ProgramSnapshot = { ...current, customName: trimmed };
  const next = [...snapshots];
  next[idx] = updated;
  return { snapshots: next, updated };
}

/** Purely remove a snapshot by `id`; returns `null` when no entry matches. */
export function removeSnapshotFromList(
  snapshots: readonly ProgramSnapshot[],
  id: string,
): ProgramSnapshot[] | null {
  const idx = snapshots.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  return [...snapshots.slice(0, idx), ...snapshots.slice(idx + 1)];
}

/** Drop the oldest unnamed autosave (skipping `protectedId`) to recover storage quota; `null` if none. */
export function pruneOldestAutosave(
  snapshots: readonly ProgramSnapshot[],
  protectedId?: string,
): ProgramSnapshot[] | null {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const entry = snapshots[i];
    if (
      entry !== undefined &&
      entry.id !== protectedId &&
      entry.kind === 'autosave' &&
      entry.customName === null
    ) {
      return [...snapshots.slice(0, i), ...snapshots.slice(i + 1)];
    }
  }
  return null;
}

// ——— storage shell ————————————————————————————————————————————————

function loadRawSnapshots(): ProgramSnapshot[] {
  try {
    const raw = window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY);
    if (raw === null) return [];
    return parseSnapshotsList(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

interface PersistResult {
  readonly ok: boolean;
  readonly saved: ProgramSnapshot[];
}

function persistSnapshots(
  snapshots: readonly ProgramSnapshot[],
  protectedId?: string,
): PersistResult {
  let payload: ProgramSnapshot[] = [...snapshots];
  while (true) {
    try {
      window.localStorage.setItem(SNAPSHOTS_STORAGE_KEY, JSON.stringify(payload));
      return { ok: true, saved: payload };
    } catch {
      const pruned = pruneOldestAutosave(payload, protectedId);
      if (pruned === null) return { ok: false, saved: [...snapshots] };
      payload = pruned;
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

export interface SnapshotStore {
  /** Whether the most recent persistence write to `localStorage` succeeded. */
  readonly lastPersistOk: boolean;
  /** Subscribe to snapshot changes (including cross-tab `storage` updates). */
  subscribe(listener: (source: SnapshotChangeSource) => void): () => void;
  /** Reload snapshots from `localStorage` and notify subscribers. */
  reload(): void;
  /** Detach the `storage` event listener and clear subscribers. */
  dispose(): void;
  /** All snapshots ordered newest-first. */
  list(): readonly ProgramSnapshot[];
  /**
   * Snapshots visible under the current filter, ordered newest-first:
   * - `namedOnly === true` → only user-named snapshots (`customName !== null`).
   * - `namedOnly === false` → all snapshots (named, unnamed manual saves, and autosaves).
   */
  getVisible(namedOnly: boolean): readonly ProgramSnapshot[];
  getById(id: string): ProgramSnapshot | null;
  /** Create and persist a new snapshot (`manual` or `autosave`). */
  create(kind: SnapshotKind, program: string, tape: string, now?: number): ProgramSnapshot;
  /**
   * Create a timed autosave only if `program` is non-empty and differs from
   * the most recent snapshot (avoids cluttering history with identical duplicates).
   * Returns `null` if skipped or if persistence failed due to storage quota.
   */
  maybeAutosave(program: string, tape: string, now?: number): ProgramSnapshot | null;
  /**
   * Rename any snapshot without changing its original `createdAt` timestamp.
   * Passing an empty/whitespace-only name is rejected and returns `null`.
   */
  rename(id: string, rawName: string): ProgramSnapshot | null;
  /** Permanently remove a snapshot by id. */
  remove(id: string): boolean;
}

/**
 * Persistent `localStorage`-backed store for program version snapshots.
 * Synchronizes across browser tabs via the `storage` event and merges fresh
 * storage state before each mutation so concurrent tabs never overwrite each other.
 */
export function createSnapshotStore(options: SnapshotStoreOptions = {}): SnapshotStore {
  const storageBacked = options.initial === undefined;
  const onPersistError = options.onPersistError;
  const listeners = new Set<(source: SnapshotChangeSource) => void>();
  let snapshots: ProgramSnapshot[] =
    options.initial !== undefined
      ? [...options.initial].sort((a, b) => b.createdAt - a.createdAt)
      : loadRawSnapshots();
  let persistOk = true;

  const notify = (source: SnapshotChangeSource): void => {
    for (const listener of listeners) listener(source);
  };

  const syncFromStorage = (): void => {
    if (storageBacked) snapshots = loadRawSnapshots();
  };

  const commit = (next: ProgramSnapshot[], previous: ProgramSnapshot[], protectedId?: string) => {
    if (!storageBacked) {
      snapshots = next;
      persistOk = true;
      notify('local');
      return;
    }
    const result = persistSnapshots(next, protectedId);
    persistOk = result.ok;
    if (result.ok) {
      snapshots = result.saved;
    } else {
      // Roll back in-memory state so UI never displays phantom unsaved entries.
      snapshots = previous;
      onPersistError?.();
    }
    notify('local');
  };

  const insertSnapshot = (
    kind: SnapshotKind,
    program: string,
    tape: string,
    now: number,
  ): ProgramSnapshot => {
    const previous = snapshots;
    const snapshot: ProgramSnapshot = {
      id: nextSnapshotId(now),
      kind,
      createdAt: now,
      customName: null,
      program,
      tape,
    };
    commit(insertSnapshotIntoList(snapshots, snapshot), previous, snapshot.id);
    return snapshot;
  };

  const reload = (): void => {
    if (!storageBacked) return;
    snapshots = loadRawSnapshots();
    notify('storage');
  };

  const storageHandler: ((event: StorageEvent) => void) | null =
    storageBacked && typeof window !== 'undefined'
      ? (event) => {
          if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
          if (event.key === SNAPSHOTS_STORAGE_KEY || event.key === null) reload();
        }
      : null;

  if (storageHandler !== null && typeof window !== 'undefined') {
    window.addEventListener('storage', storageHandler);
  }

  return {
    get lastPersistOk(): boolean {
      return persistOk;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload,
    dispose() {
      if (storageHandler !== null && typeof window !== 'undefined') {
        window.removeEventListener('storage', storageHandler);
      }
      listeners.clear();
    },
    list: () => snapshots,
    getVisible: (namedOnly) => filterSnapshots(snapshots, namedOnly),
    getById: (id) => snapshots.find((s) => s.id === id) ?? null,
    create(kind, program, tape, now = Date.now()) {
      syncFromStorage();
      return insertSnapshot(kind, program, tape, now);
    },
    maybeAutosave(program, tape, now = Date.now()) {
      if (program.trim() === '') {
        persistOk = true;
        return null;
      }
      syncFromStorage();
      if (matchesLatestSnapshot(snapshots, program, tape)) {
        persistOk = true;
        return null;
      }
      const created = insertSnapshot('autosave', program, tape, now);
      return persistOk ? created : null;
    },
    rename(id, rawName) {
      if (rawName.trim() === '') return null;
      syncFromStorage();
      const result = renameSnapshotInList(snapshots, id, rawName);
      if (result === null) return null;
      commit(result.snapshots, snapshots);
      return persistOk ? result.updated : null;
    },
    remove(id) {
      syncFromStorage();
      const next = removeSnapshotFromList(snapshots, id);
      if (next === null) return false;
      commit(next, snapshots);
      return persistOk;
    },
  };
}
