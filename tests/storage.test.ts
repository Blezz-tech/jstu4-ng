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
    expect(DEFAULT_SETTINGS.minSpeed).toBe(-15);
    expect(DEFAULT_SETTINGS.maxSpeed).toBe(25);
  });

  it('persists and loads settings (including minSpeed, maxSpeed, and negative speed) as JSON', () => {
    saveSettings({
      lang: 'en',
      theme: 'dark',
      sound: true,
      speed: -2.5,
      minSpeed: -20,
      maxSpeed: 40,
    });

    const raw = window.localStorage.getItem('jstu4:settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      lang: 'en',
      theme: 'dark',
      sound: true,
      speed: -2.5,
      minSpeed: -20,
      maxSpeed: 40,
    });
    expect(loadSettings()).toEqual({
      lang: 'en',
      theme: 'dark',
      sound: true,
      speed: -2.5,
      minSpeed: -20,
      maxSpeed: 40,
    });

    // Optional UI boolean flags are persisted when explicitly toggled.
    saveSettings({
      ...DEFAULT_SETTINGS,
      sidepanelOpen: false,
      historyOpen: true,
      namedOnly: true,
      confirmSnapshotDelete: false,
    });
    const loadedFlags = loadSettings();
    expect(loadedFlags.sidepanelOpen).toBe(false);
    expect(loadedFlags.historyOpen).toBe(true);
    expect(loadedFlags.namedOnly).toBe(true);
    expect(loadedFlags.confirmSnapshotDelete).toBe(false);
  });

  it('clamps stored speed into [minSpeed, maxSpeed] and sanitizes out-of-range values', () => {
    window.localStorage.setItem(
      'jstu4:settings',
      JSON.stringify({
        lang: 'ru',
        theme: 'auto',
        sound: false,
        speed: 50,
        minSpeed: -10,
        maxSpeed: 8,
      }),
    );
    expect(loadSettings()).toEqual({
      lang: 'ru',
      theme: 'auto',
      sound: false,
      speed: 8,
      minSpeed: -10,
      maxSpeed: 8,
    });

    window.localStorage.setItem(
      'jstu4:settings',
      JSON.stringify({
        lang: 'ru',
        theme: 'auto',
        sound: false,
        speed: -50,
        minSpeed: -12,
        maxSpeed: 20,
      }),
    );
    expect(loadSettings().speed).toBe(-12);
  });

  it('migrates legacy per-key preferences when jstu4:settings is absent', () => {
    window.localStorage.setItem('jstu4:lang', 'en');
    window.localStorage.setItem('jstu4:theme', 'light');
    window.localStorage.setItem('jstu4:sound', '1');

    expect(loadSettings()).toEqual({
      lang: 'en',
      theme: 'light',
      sound: true,
      speed: 1,
      minSpeed: -15,
      maxSpeed: 25,
    });
  });

  it('sanitizes invalid or corrupted values in jstu4:settings', () => {
    window.localStorage.setItem(
      'jstu4:settings',
      JSON.stringify({
        lang: 'de',
        theme: 'sepia',
        sound: 'yes',
        speed: 'fast',
        minSpeed: 'slow',
        maxSpeed: 'lots',
      }),
    );
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

    window.localStorage.setItem('jstu4:settings', '{not-valid-json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('loads saved program, tape, and settings together via loadState()', () => {
    saveProgram('0, ,#,0');
    saveTape('101');
    saveSettings({
      lang: 'ru',
      theme: 'light',
      sound: true,
      speed: 3,
      minSpeed: -15,
      maxSpeed: 20,
    });

    expect(loadState()).toEqual({
      program: '0, ,#,0',
      tape: '101',
      settings: { lang: 'ru', theme: 'light', sound: true, speed: 3, minSpeed: -15, maxSpeed: 20 },
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

    expect(() =>
      saveSettings({
        lang: 'en',
        theme: 'dark',
        sound: true,
        speed: 2,
        minSpeed: -15,
        maxSpeed: 25,
      }),
    ).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back cleanly when jstu4:settings stores a JSON array instead of an object', () => {
    window.localStorage.setItem('jstu4:settings', '[]');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
