// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../src/app';
import { debounce } from '../src/ui/dom';
import { AUTOSAVE_INTERVAL_MS, SNAPSHOTS_STORAGE_KEY } from '../src/ui/history';
import { SettingsStore, ThemeController } from '../src/ui/shell/settings-store';

const htmlPath = resolve(import.meta.dirname, '../public/index.html');
const rawHtml = readFileSync(htmlPath, 'utf8');
const bodyMatch = rawHtml.match(/<body>([\s\S]*)<\/body>/);
const bodyMarkup = bodyMatch?.[1] ?? '';

interface MockMql {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  fireChange(nextMatches: boolean): void;
}

function createMockMatchMedia(initialMatches = false): MockMql {
  const listeners = new Set<() => void>();
  const mql: MockMql = {
    matches: initialMatches,
    addEventListener: vi.fn((_type: string, cb: () => void) => {
      listeners.add(cb);
    }),
    removeEventListener: vi.fn((_type: string, cb: () => void) => {
      listeners.delete(cb);
    }),
    fireChange(nextMatches: boolean) {
      mql.matches = nextMatches;
      for (const cb of listeners) cb();
    },
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  );
  return mql;
}

describe('mountApp lifecycle & shell modules', () => {
  let mql: MockMql;

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, 'languages', {
      value: ['ru-RU'],
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'language', {
      value: 'ru-RU',
      configurable: true,
    });
    document.documentElement.lang = 'ru';
    document.body.innerHTML = bodyMarkup;
    mql = createMockMatchMedia(false);
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) {
      dialog.showModal = () => {
        dialog.setAttribute('open', '');
      };
      dialog.close = () => {
        dialog.removeAttribute('open');
        dialog.dispatchEvent(new Event('close'));
      };
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  it('detaches all listeners, timers, and observers on dispose() and allows clean remounting', () => {
    vi.useFakeTimers();
    const app1 = mountApp(document);

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const settingsBtn = document.querySelector<HTMLButtonElement>('#btn-settings')!;
    const settingsMenu = document.querySelector<HTMLElement>('#settings-menu')!;
    const helpDialog = document.querySelector<HTMLDialogElement>('#help-dialog')!;
    const historyList = document.querySelector<HTMLUListElement>('#history-list')!;

    // Verify mounted app responds to clicks and shortcuts
    settingsBtn.click();
    expect(settingsMenu.hidden).toBe(false);
    settingsBtn.click();
    expect(settingsMenu.hidden).toBe(true);

    // Trigger pending debounced save + autosave timer before disposing
    programInput.value = '0, ,#,0';
    programInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Dispose cleanly (and verify idempotency)
    app1.dispose();
    app1.dispose();

    // matchMedia listener was removed
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);

    // Debounced draft save & 5-minute autosave timer were cancelled
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS + 1000);
    expect(window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY)).toBeNull();

    // Global shortcuts, clicks, and cross-tab storage events no longer fire
    settingsBtn.click();
    expect(settingsMenu.hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true }));
    expect(helpDialog.open).toBe(false);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
    );
    expect(window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY)).toBeNull();

    window.dispatchEvent(new Event('beforeunload'));
    expect(window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(
      SNAPSHOTS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'ext-after-dispose',
          kind: 'manual',
          createdAt: 1000,
          customName: 'Ignored after dispose',
          program: '0, ,#,0',
          tape: '',
        },
      ]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: SNAPSHOTS_STORAGE_KEY }));
    expect(historyList.children).toHaveLength(0);

    // Remounting works cleanly without duplicated handlers (Ctrl+S creates exactly 1 snapshot)
    window.localStorage.clear();
    const app2 = mountApp(document);
    programInput.value = '0, ,>,0';
    programInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
    );
    expect(historyList.children).toHaveLength(1);

    // Even dynamically rendered snapshot item buttons stop responding after dispose()
    const deleteDialog = document.querySelector<HTMLDialogElement>('#delete-snapshot-dialog')!;
    const itemDeleteBtn = historyList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!;
    app2.dispose();
    itemDeleteBtn.click();
    expect(deleteDialog.open).toBe(false);
  });

  it('SettingsStore and ThemeController react to updates and OS color-scheme changes until disposed', () => {
    const store = new SettingsStore({
      lang: null,
      theme: 'auto',
      sound: false,
      speed: 1,
      minSpeed: -15,
      maxSpeed: 15,
    });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#theme-group [data-theme-option]'),
    );
    const theme = new ThemeController({
      root: document.documentElement,
      themeButtons: buttons,
      store,
    });

    expect(document.documentElement.dataset.theme).toBe('light');
    mql.fireChange(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    store.update({ theme: 'light' });
    theme.apply();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe('light');

    // Fixed theme ignores OS scheme changes
    mql.fireChange(false);
    mql.fireChange(true);
    expect(document.documentElement.dataset.theme).toBe('light');

    // Back to auto, then dispose stops listening to OS changes
    store.update({ theme: 'auto' });
    theme.apply();
    expect(document.documentElement.dataset.theme).toBe('dark');

    theme.dispose();
    unsubscribe();
    mql.fireChange(false);
    expect(document.documentElement.dataset.theme).toBe('dark');

    store.update({ sound: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('debounce().cancel() prevents pending execution', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 200);

    debounced('first');
    vi.advanceTimersByTime(100);
    debounced.cancel();
    vi.advanceTimersByTime(500);

    expect(fn).not.toHaveBeenCalled();

    debounced('second');
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('second');
  });
});
