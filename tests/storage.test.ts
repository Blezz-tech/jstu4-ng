// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadState,
  saveProgram,
  saveSettings,
  saveTape,
} from '../src/ui/storage';

describe('storage', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns default settings when localStorage is empty', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists and loads settings as JSON in jstu4:settings', () => {
    saveSettings({ lang: 'en', theme: 'dark', sound: true });

    const raw = window.localStorage.getItem('jstu4:settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ lang: 'en', theme: 'dark', sound: true });
    expect(loadSettings()).toEqual({ lang: 'en', theme: 'dark', sound: true });
  });

  it('migrates legacy per-key preferences when jstu4:settings is absent', () => {
    window.localStorage.setItem('jstu4:lang', 'en');
    window.localStorage.setItem('jstu4:theme', 'light');
    window.localStorage.setItem('jstu4:sound', '1');

    expect(loadSettings()).toEqual({ lang: 'en', theme: 'light', sound: true });
  });

  it('sanitizes invalid or corrupted values in jstu4:settings', () => {
    window.localStorage.setItem(
      'jstu4:settings',
      JSON.stringify({ lang: 'de', theme: 'sepia', sound: 'yes' }),
    );
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

    window.localStorage.setItem('jstu4:settings', '{not-valid-json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('loads saved program, tape, and settings together via loadState()', () => {
    saveProgram('0, ,#,0');
    saveTape('101');
    saveSettings({ lang: 'ru', theme: 'light', sound: true });

    expect(loadState()).toEqual({
      program: '0, ,#,0',
      tape: '101',
      settings: { lang: 'ru', theme: 'light', sound: true },
    });

    // Clearing program/tape removes the keys instead of storing empty strings.
    saveProgram('');
    saveTape('');
    expect(loadState().program).toBeNull();
    expect(loadState().tape).toBeNull();
  });

  it('degrades gracefully when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(() => saveSettings({ lang: 'en', theme: 'dark', sound: true })).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
