// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from '../src/i18n';
import {
  formatSnapshotTimestamp,
  getSnapshotDisplayName,
  SNAPSHOTS_STORAGE_KEY,
  SnapshotStore,
} from '../src/ui/history';

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
    const store = new SnapshotStore();
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

    const store = new SnapshotStore();
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
    const store = new SnapshotStore();
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
    const store = new SnapshotStore();
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

    const reloaded = new SnapshotStore();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]?.customName).toBe('Saved v1');
    expect(reloaded.list()[0]?.createdAt).toBe(1_700_000_000_000);

    expect(reloaded.remove(s.id)).toBe(true);
    expect(reloaded.remove('missing')).toBe(false);
    expect(new SnapshotStore().list()).toHaveLength(0);
  });

  it('prunes oldest unnamed autosaves when localStorage throws QuotaExceededError', () => {
    const store = new SnapshotStore();
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
});
