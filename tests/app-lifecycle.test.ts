// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../src/app';
import { debounce } from '../src/ui/dom';
import { AUTOSAVE_INTERVAL_MS, SNAPSHOTS_STORAGE_KEY } from '../src/ui/history';
import { SettingsStore, ThemeController } from '../src/ui/shell/settings-store';
import { setupAppDom, teardownAppDom, type MockMql } from './helpers/dom-fixture';

describe('mountApp lifecycle & shell modules', () => {
  let mql: MockMql;

  beforeEach(() => {
    mql = setupAppDom(false);
  });

  afterEach(() => {
    teardownAppDom();
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

  it('renders #help-body lazily on open and clears its DOM on close', () => {
    const app = mountApp(document);

    const helpBtn = document.querySelector<HTMLButtonElement>('#btn-help')!;
    const helpClose = document.querySelector<HTMLButtonElement>('#btn-help-close')!;
    const helpDialog = document.querySelector<HTMLDialogElement>('#help-dialog')!;
    const helpBody = document.querySelector<HTMLElement>('#help-body')!;

    // Closed initially → #help-body has no DOM nodes
    expect(helpDialog.open).toBe(false);
    expect(helpBody.children).toHaveLength(0);

    // Opening builds the help DOM
    helpBtn.click();
    expect(helpDialog.open).toBe(true);
    expect(helpBody.children.length).toBeGreaterThan(0);

    // Closing releases #help-body DOM nodes
    helpClose.click();
    expect(helpDialog.open).toBe(false);
    expect(helpBody.children).toHaveLength(0);

    // Reopening rebuilds it cleanly
    helpBtn.click();
    expect(helpDialog.open).toBe(true);
    expect(helpBody.children.length).toBeGreaterThan(0);

    app.dispose();
  });

  it('closes the history drawer on wide-to-narrow resize when both drawers are open', () => {
    const originalInnerWidth = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', {
        value: 1400,
        configurable: true,
      });

      const app = mountApp(document);
      const appShell = document.querySelector<HTMLElement>('.app-shell')!;
      const sidepanel = document.querySelector<HTMLElement>('#sidepanel')!;
      const sidepanelBackdrop = document.querySelector<HTMLElement>('#sidepanel-backdrop')!;
      const historyPanel = document.querySelector<HTMLElement>('#history-panel')!;
      const historyBackdrop = document.querySelector<HTMLElement>('#history-backdrop')!;
      const btnHistory = document.querySelector<HTMLButtonElement>('#btn-history')!;

      // Desktop default: sidepanel open, history closed
      expect(sidepanel.hidden).toBe(false);
      expect(historyPanel.hidden).toBe(true);
      expect(appShell.dataset.sidepanel).toBe('open');
      expect(appShell.dataset.history).toBe('closed');

      // Open history on wide screen -> both panels are simultaneously open without backdrops
      btnHistory.click();
      expect(sidepanel.hidden).toBe(false);
      expect(historyPanel.hidden).toBe(false);
      expect(sidepanelBackdrop.hidden).toBe(true);
      expect(historyBackdrop.hidden).toBe(true);

      // Shrink viewport below single-drawer breakpoint -> history auto-closes & sidepanel backdrop shows
      Object.defineProperty(window, 'innerWidth', {
        value: 800,
        configurable: true,
      });
      window.dispatchEvent(new Event('resize'));
      expect(sidepanel.hidden).toBe(false);
      expect(historyPanel.hidden).toBe(true);
      expect(appShell.dataset.sidepanel).toBe('open');
      expect(appShell.dataset.history).toBe('closed');
      expect(sidepanelBackdrop.hidden).toBe(false);
      expect(historyBackdrop.hidden).toBe(true);

      app.dispose();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        value: originalInnerWidth,
        configurable: true,
      });
    }
  });
});
