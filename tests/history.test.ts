// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from '../src/i18n';
import {
  AUTOSAVE_INTERVAL_MS,
  createAutosaveTracker,
  createSnapshotStore,
  filterSnapshots,
  formatSaveClock,
  formatSnapshotTimestamp,
  getSnapshotDisplayName,
  insertSnapshotIntoList,
  isDraftDirty,
  matchesLatestSnapshot,
  parseSnapshotsList,
  pruneOldestAutosave,
  removeSnapshotFromList,
  renameSnapshotInList,
  SNAPSHOTS_STORAGE_KEY,
  trimUnnamedAutosaves,
  type ProgramSnapshot,
} from '../src/ui/history';

describe('history (pure snapshot operations & isDraftDirty)', () => {
  const makeSnap = (
    id: string,
    kind: 'autosave' | 'manual',
    createdAt: number,
    customName: string | null = null,
    program = `p-${id}`,
    tape = '',
  ): ProgramSnapshot => ({ id, kind, createdAt, customName, program, tape });

  it('inserts newest-first, enforces maxAutosaves without dropping named/manual snapshots, and supports pure rename/remove/prune', () => {
    const a1 = makeSnap('a1', 'autosave', 1000);
    const m1 = makeSnap('m1', 'manual', 2000);
    const a2 = makeSnap('a2', 'autosave', 3000, 'Pinned auto');
    const a3 = makeSnap('a3', 'autosave', 4000);
    const a4 = makeSnap('a4', 'autosave', 5000);

    let list: readonly ProgramSnapshot[] = [];
    // Out-of-order insert sorts chronologically
    list = insertSnapshotIntoList(list, a3, 2);
    list = insertSnapshotIntoList(list, a1, 2);
    list = insertSnapshotIntoList(list, m1, 2);
    list = insertSnapshotIntoList(list, a2, 2);
    list = insertSnapshotIntoList(list, a4, 2);

    // Only 2 unnamed autosaves remain (a4, a3); a1 is trimmed; m1 and named a2 survive
    expect(list.map((s) => s.id)).toEqual(['a4', 'a3', 'a2', 'm1']);
    expect(filterSnapshots(list, true).map((s) => s.id)).toEqual(['a2']);
    expect(matchesLatestSnapshot(list, 'p-a4', '')).toBe(true);
    expect(matchesLatestSnapshot(list, 'other', '')).toBe(false);

    // Pure rename keeps createdAt and returns null for blank/missing
    expect(renameSnapshotInList(list, 'm1', '   ')).toBeNull();
    expect(renameSnapshotInList(list, 'missing', 'Name')).toBeNull();
    const renamed = renameSnapshotInList(list, 'm1', '  Release 1  ');
    expect(renamed?.updated.customName).toBe('Release 1');
    expect(renamed?.updated.createdAt).toBe(2000);

    // Prune drops oldest unnamed autosave while skipping protectedId
    expect(pruneOldestAutosave(list, 'a3')?.map((s) => s.id)).toEqual(['a3', 'a2', 'm1']);
    expect(pruneOldestAutosave([a2, m1])).toBeNull();

    // Pure remove & trim
    expect(removeSnapshotFromList(list, 'missing')).toBeNull();
    expect(removeSnapshotFromList(list, 'a3')?.map((s) => s.id)).toEqual(['a4', 'a2', 'm1']);
    expect(trimUnnamedAutosaves(list, 1).map((s) => s.id)).toEqual(['a4', 'a2', 'm1']);

    // Deduplication and validation of untrusted JSON arrays
    expect(
      parseSnapshotsList([null, { id: '' }, a1, { ...a1, program: 'duplicate-ignored' }, m1]).map(
        (s) => s.id,
      ),
    ).toEqual(['m1', 'a1']);
  });

  it('evaluates isDraftDirty purely against blankness, baseline, and latest snapshot', () => {
    const baseline = { program: '0, ,#,0', tape: '1' };
    const latest = { program: '0,1,0,0', tape: '1' };

    expect(isDraftDirty({ program: '   ', tape: '1' }, baseline, latest)).toBe(false);
    expect(isDraftDirty({ program: '0, ,#,0', tape: '1' }, baseline, latest)).toBe(false);
    expect(isDraftDirty({ program: '0,1,0,0', tape: '1' }, baseline, latest)).toBe(false);
    expect(isDraftDirty({ program: '0, ,>,0', tape: '1' }, baseline, latest)).toBe(true);
    expect(isDraftDirty({ program: '0, ,#,0', tape: '10' }, baseline, undefined)).toBe(true);
  });
});

describe('history (SnapshotStore)', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('formats timestamps as YYYY-MM-DD-HH-mm-ss in local time', () => {
    const ts = new Date(2026, 10, 14, 9, 5, 3).getTime();
    expect(formatSnapshotTimestamp(ts)).toBe('2026-11-14-09-05-03');
  });

  it('formats default display names per locale for autosaves and manual saves', () => {
    const ts = new Date(2026, 10, 14, 15, 22, 8).getTime();
    const store = createSnapshotStore();
    const autoSnap = store.create('autosave', '0, ,#,0', '1', ts);
    const manualSnap = store.create('manual', '0, ,>,0', '10', ts + 1000);

    const ru = createI18n('ru');
    const en = createI18n('en');

    expect(getSnapshotDisplayName(autoSnap, ru)).toBe('2026-11-14-15-22-08 автосохранение');
    expect(getSnapshotDisplayName(autoSnap, en)).toBe('2026-11-14-15-22-08 autosave');
    expect(getSnapshotDisplayName(manualSnap, ru)).toBe(
      '2026-11-14-15-22-09 Сохранено пользователем',
    );
    expect(getSnapshotDisplayName(manualSnap, en)).toBe('2026-11-14-15-22-09 Saved by user');
  });

  it('filters named-only vs all snapshots in one chronological list and preserves createdAt on rename', () => {
    const t1 = new Date(2026, 10, 14, 10, 0, 0).getTime();
    const t2 = new Date(2026, 10, 14, 10, 1, 0).getTime();
    const t3 = new Date(2026, 10, 14, 10, 2, 0).getTime();

    const store = createSnapshotStore();
    const sAuto = store.create('autosave', '0, ,#,0', '1', t1);
    const sManual = store.create('manual', '0, ,>,1\n1, ,#,1', '10', t2);
    const sAuto2 = store.create('autosave', '0,1,0,0', '11', t3);

    expect(store.getVisible(true)).toHaveLength(0);
    expect(store.getVisible(false).map((s) => s.id)).toEqual([sAuto2.id, sManual.id, sAuto.id]);

    // Reject blank rename
    expect(store.rename(sAuto.id, '   ')).toBeNull();
    expect(store.getVisible(true)).toHaveLength(0);

    // Rename autosave — createdAt stays strictly unchanged and order stays chronological
    const renamed = store.rename(sAuto.id, '  Working baseline  ');
    expect(renamed).not.toBeNull();
    expect(renamed?.customName).toBe('Working baseline');
    expect(renamed?.createdAt).toBe(t1);

    expect(store.getVisible(true).map((s) => s.id)).toEqual([sAuto.id]);
    expect(store.getVisible(false).map((s) => s.id)).toEqual([sAuto2.id, sManual.id, sAuto.id]);

    // Rename again — createdAt still unchanged
    const renamedAgain = store.rename(sAuto.id, 'Final version');
    expect(renamedAgain?.createdAt).toBe(t1);
    expect(getSnapshotDisplayName(renamedAgain!, createI18n('ru'))).toBe('Final version');
  });

  it('maybeAutosave ignores empty programs and unchanged content', () => {
    const store = createSnapshotStore();
    expect(store.maybeAutosave('   \n  ', '101', 1000)).toBeNull();

    const first = store.maybeAutosave('0, ,#,0', '101', 2000);
    expect(first).not.toBeNull();
    expect(first?.kind).toBe('autosave');

    // Same content → skipped
    expect(store.maybeAutosave('0, ,#,0', '101', 3000)).toBeNull();
    // Tape changed → new autosave
    const second = store.maybeAutosave('0, ,#,0', '1010', 4000);
    expect(second).not.toBeNull();
    // Program changed → new autosave
    const third = store.maybeAutosave('0, ,>,0', '1010', 5000);
    expect(third).not.toBeNull();

    expect(store.list()).toHaveLength(3);
  });

  it('persists snapshots to localStorage and recovers from corrupted entries', () => {
    const store = createSnapshotStore();
    const s = store.create('manual', '0, ,#,0', '1', 1_700_000_000_000);
    store.rename(s.id, 'Saved v1');

    const raw = window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY);
    expect(raw).not.toBeNull();

    // Inject invalid entries alongside valid ones
    const parsed = JSON.parse(raw!) as unknown[];
    parsed.push(
      null,
      { id: 'bad' },
      { id: s.id, kind: 'manual', createdAt: 1, program: '', tape: '' },
    );
    window.localStorage.setItem(SNAPSHOTS_STORAGE_KEY, JSON.stringify(parsed));

    const reloaded = createSnapshotStore();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]?.customName).toBe('Saved v1');
    expect(reloaded.list()[0]?.createdAt).toBe(1_700_000_000_000);

    expect(reloaded.remove(s.id)).toBe(true);
    expect(reloaded.remove('missing')).toBe(false);
    expect(createSnapshotStore().list()).toHaveLength(0);
  });

  it('prunes oldest unnamed autosaves when localStorage throws QuotaExceededError', () => {
    const store = createSnapshotStore();
    store.create('autosave', 'p1', '', 1000);
    store.create('autosave', 'p2', '', 2000);

    let failCount = 1;
    const origDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === SNAPSHOTS_STORAGE_KEY && failCount > 0) {
        failCount -= 1;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      Reflect.apply(origDescriptor?.value as (...args: unknown[]) => unknown, this, [key, value]);
    });

    store.create('manual', 'p3', '', 3000);
    const saved = JSON.parse(window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY) ?? '[]') as {
      program: string;
    }[];
    // Oldest unnamed autosave ('p1') was pruned to fit
    expect(saved.map((entry) => entry.program)).toEqual(['p3', 'p2']);
  });

  it('AutosaveTracker autosaves every 5 minutes only during active edits, cancels on revert, and flushes once on tab close', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 9, 5, 0));

    expect(formatSaveClock(new Date(2026, 10, 14, 9, 5, 0).getTime())).toBe('09:05');

    const store = createSnapshotStore();
    let current = { program: '0, ,#,0', tape: '1' };
    const onAutosave = vi.fn();
    const onDirtyChange = vi.fn();
    const tracker = createAutosaveTracker({
      store,
      readState: () => current,
      onAutosave,
      onDirtyChange,
    });
    tracker.reset(current.program, current.tape);

    // Idle for 15 minutes → zero autosaves
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 3);
    expect(store.list()).toHaveLength(0);
    expect(tracker.isDirty).toBe(false);
    expect(tracker.flush()).toBeNull();

    // Edit and revert before 5 min → timer cancelled, zero autosaves
    current = { program: '0, ,>,0', tape: '1' };
    tracker.markEdited(current.program, current.tape);
    expect(tracker.isDirty).toBe(true);
    current = { program: '0, ,#,0', tape: '1' };
    tracker.markEdited(current.program, current.tape);
    expect(tracker.isDirty).toBe(false);
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2);
    expect(store.list()).toHaveLength(0);

    // Real edit → autosaves exactly once after 5 minutes, then sleeps
    current = { program: '0,1,0,0', tape: '10' };
    tracker.markEdited(current.program, current.tape);
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS - 1);
    expect(store.list()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(store.list()).toHaveLength(1);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(tracker.isDirty).toBe(false);

    // Idle for another 15 minutes → still only 1 autosave
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 3);
    expect(store.list()).toHaveLength(1);

    // Edit and close tab (flush called twice for beforeunload + pagehide) → strictly 1 autosave
    current = { program: '0,0,1,0', tape: '10' };
    tracker.markEdited(current.program, current.tape);
    const flushedFirst = tracker.flush();
    const flushedSecond = tracker.flush();
    expect(flushedFirst).not.toBeNull();
    expect(flushedSecond).toBeNull();
    expect(store.list()).toHaveLength(2);

    tracker.dispose();
    vi.useRealTimers();
  });

  it('synchronizes across tabs via storage events and merges before mutations without overwriting', () => {
    const tabA = createSnapshotStore();
    const tabB = createSnapshotStore();
    const onTabAChange = vi.fn();
    tabA.subscribe(onTabAChange);

    // Tab B creates a snapshot; Tab A receives storage event and updates automatically
    const fromB = tabB.create('manual', '0, ,#,0', 'fromB', 1000);
    window.dispatchEvent(new StorageEvent('storage', { key: SNAPSHOTS_STORAGE_KEY }));
    expect(onTabAChange).toHaveBeenCalledWith('storage');
    expect(tabA.list().map((s) => s.id)).toEqual([fromB.id]);

    // Even WITHOUT a storage event arriving first, Tab A mutating preserves Tab B's newer write
    const secondFromB = tabB.create('manual', '0,1,0,0', 'fromB2', 2000);
    const fromA = tabA.create('manual', '0,0,1,0', 'fromA', 3000);

    expect(tabA.list().map((s) => s.id)).toEqual([fromA.id, secondFromB.id, fromB.id]);
    expect(
      createSnapshotStore()
        .list()
        .map((s) => s.id),
    ).toEqual([fromA.id, secondFromB.id, fromB.id]);

    tabA.dispose();
    tabB.dispose();
  });

  it('reports unrecoverable QuotaExceededError via onPersistError, rolls back phantom writes, and ignores sessionStorage events', () => {
    const onPersistError = vi.fn();
    const store = createSnapshotStore({ onPersistError });
    const onChange = vi.fn();
    store.subscribe(onChange);

    // Events from sessionStorage must be ignored
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: SNAPSHOTS_STORAGE_KEY,
        storageArea: window.sessionStorage,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();

    const existing = store.create('manual', '0, ,>,0', '0', 500);
    expect(store.list()).toHaveLength(1);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    // Failed manual save rolls back in-memory list (no phantom entry)
    store.create('manual', '0, ,#,0', '1', 1000);
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(store.lastPersistOk).toBe(false);
    expect(store.list().map((s) => s.id)).toEqual([existing.id]);

    // Failed autosave returns null and rolls back
    expect(store.maybeAutosave('0,1,0,0', '1', 1500)).toBeNull();
    expect(store.list().map((s) => s.id)).toEqual([existing.id]);

    // Failed rename and remove roll back and return null / false
    expect(store.rename(existing.id, 'Cannot persist')).toBeNull();
    expect(store.getById(existing.id)?.customName).toBeNull();
    expect(store.remove(existing.id)).toBe(false);
    expect(store.list().map((s) => s.id)).toEqual([existing.id]);

    store.dispose();
  });

  it('keeps AutosaveTracker dirty when persistence fails so a later flush can succeed', () => {
    const store = createSnapshotStore();
    let current = { program: '0, ,#,0', tape: '1' };
    const tracker = createAutosaveTracker({
      store,
      readState: () => current,
    });
    tracker.reset(current.program, current.tape);

    current = { program: '0,1,0,0', tape: '1' };
    tracker.markEdited(current.program, current.tape);
    expect(tracker.isDirty).toBe(true);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    // Persistence fails -> flush returns null and keeps dirty=true without advancing baseline
    expect(tracker.flush()).toBeNull();
    expect(store.lastPersistOk).toBe(false);
    expect(tracker.isDirty).toBe(true);

    // Once storage recovers, a retry flush persists the snapshot cleanly
    setItemSpy.mockRestore();
    const saved = tracker.flush();
    expect(saved).not.toBeNull();
    expect(saved?.program).toBe('0,1,0,0');
    expect(tracker.isDirty).toBe(false);

    tracker.dispose();
    store.dispose();
  });

  it('never silently drops a newly created autosave when localStorage quota is exceeded', () => {
    const onPersistError = vi.fn();
    const store = createSnapshotStore({ onPersistError });
    const existingManual = store.create('manual', '0, ,#,0', '1', 1000);

    // Reject only payloads larger than the existing manual snapshot (simulates quota full for the new autosave)
    const maxBytes = window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY)!.length;
    const origSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key: string, value: string) => {
        if (key === SNAPSHOTS_STORAGE_KEY && value.length > maxBytes) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        origSetItem(key, value);
      });

    try {
      const created = store.maybeAutosave('0,1,0,0\n'.repeat(20), '111', 2000);
      expect(created).toBeNull();
      expect(store.lastPersistOk).toBe(false);
      expect(onPersistError).toHaveBeenCalledTimes(1);
      expect(store.list().map((s) => s.id)).toEqual([existingManual.id]);
    } finally {
      spy.mockRestore();
      store.dispose();
    }
  });
});
