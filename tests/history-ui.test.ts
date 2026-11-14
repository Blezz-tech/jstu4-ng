// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_INTERVAL_MS, SNAPSHOTS_STORAGE_KEY } from '../src/ui/history';

const htmlPath = resolve(import.meta.dirname, '../public/index.html');
const rawHtml = readFileSync(htmlPath, 'utf8');
const bodyMatch = rawHtml.match(/<body>([\s\S]*)<\/body>/);
const bodyMarkup = bodyMatch?.[1] ?? '';

function stubMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function editField(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('version control UI (public/index.html + src/main.ts)', () => {
  beforeEach(() => {
    vi.resetModules();
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
    stubMatchMedia();
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

  it('places SVG save button right after Copy, status indicator after Save, and SVG history button right before Settings', async () => {
    await import('../src/main');

    const copyBtn = document.querySelector<HTMLButtonElement>('#btn-copy')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const saveStatus = document.querySelector<HTMLElement>('#save-status')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const settingsAnchor = document.querySelector<HTMLElement>('#settings-anchor')!;
    const historyPanel = document.querySelector<HTMLElement>('#history-panel')!;
    const shell = document.querySelector<HTMLElement>('#app-shell')!;

    expect(copyBtn.nextElementSibling).toBe(saveBtn);
    expect(saveBtn.nextElementSibling).toBe(saveStatus);
    expect(saveStatus.dataset.state).toBe('idle');
    expect(saveBtn.dataset.mode).toBe('edit');
    expect(saveBtn.querySelector('svg')).not.toBeNull();
    expect(historyBtn.querySelector('svg')).not.toBeNull();
    expect(historyBtn.nextElementSibling).toBe(settingsAnchor);

    expect(historyPanel.hidden).toBe(true);
    expect(shell.dataset.history).toBe('closed');
    expect(historyBtn.getAttribute('aria-expanded')).toBe('false');

    historyBtn.click();
    expect(historyPanel.hidden).toBe(false);
    expect(shell.dataset.history).toBe('open');
    expect(historyBtn.getAttribute('aria-expanded')).toBe('true');

    // Close button inside history panel uses SVG and closes it
    const closeBtn = document.querySelector<HTMLButtonElement>('#btn-history-close')!;
    expect(closeBtn.querySelector('svg')).not.toBeNull();
    closeBtn.click();
    expect(historyPanel.hidden).toBe(true);
    expect(shell.dataset.history).toBe('closed');
  });

  it('creates manual saves, 5-minute edit-driven autosaves, tab-close autosaves, filters named-only, and switches locale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 12, 30, 0));

    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const tapeInput = document.querySelector<HTMLInputElement>('#input-tape')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const saveStatus = document.querySelector<HTMLElement>('#save-status')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const namedOnlySwitch = document.querySelector<HTMLButtonElement>('#btn-named-only')!;
    const historyList = document.querySelector<HTMLUListElement>('#history-list')!;
    const historyEmpty = document.querySelector<HTMLElement>('#history-empty')!;
    const langBtn = document.querySelector<HTMLButtonElement>('#btn-lang')!;

    historyBtn.click();

    // Without edits, waiting 10 minutes or closing tab creates zero autosaves
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2);
    window.dispatchEvent(new Event('pagehide'));
    expect(historyList.children).toHaveLength(0);
    expect(saveStatus.dataset.state).toBe('idle');

    // Edit & manual save in RU
    vi.setSystemTime(new Date(2026, 10, 14, 12, 30, 0));
    editField(programInput, '0, ,#,0');
    editField(tapeInput, '101');
    expect(saveStatus.dataset.state).toBe('dirty');
    expect(saveStatus.textContent).toBe('Не сохранено');

    saveBtn.click();
    expect(saveStatus.dataset.state).toBe('saved');
    expect(saveStatus.textContent).toBe('Сохранено в 12:30');
    expect(historyList.children).toHaveLength(1);
    expect(historyList.textContent).toContain('2026-11-14-12-30-00 Сохранено пользователем');

    // Every action button inside snapshot item uses SVG
    for (const btn of historyList.querySelectorAll('.snapshot-action')) {
      expect(btn.querySelector('svg')).not.toBeNull();
    }

    // Edit program → after 5 minutes an autosave is created
    editField(programInput, '0, ,>,1\n1, ,#,1');
    expect(saveStatus.dataset.state).toBe('dirty');
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);

    expect(historyList.children).toHaveLength(2);
    expect(historyList.textContent).toContain('2026-11-14-12-35-00 автосохранение');
    expect(saveStatus.dataset.state).toBe('autosaved');
    expect(saveStatus.textContent).toBe('Автосохранено в 12:35');

    // Advancing timer again with no further edits → no duplicate autosave
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 3);
    expect(historyList.children).toHaveLength(2);

    // Edit and close tab before 5 minutes elapse → synchronous autosave on unload (deduped across beforeunload + pagehide)
    editField(programInput, '0,1,0,0');
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('pagehide'));
    expect(historyList.children).toHaveLength(3);
    expect(saveStatus.dataset.state).toBe('autosaved');

    // Named-only switch starts OFF (shows all: named + unnamed)
    expect(namedOnlySwitch.getAttribute('aria-checked')).toBe('false');
    expect(namedOnlySwitch.textContent?.trim()).toBe('');

    // Toggle named-only ON → hides all unnamed saves (manual & autosave)
    namedOnlySwitch.click();
    expect(namedOnlySwitch.getAttribute('aria-checked')).toBe('true');
    expect(historyList.children).toHaveLength(0);
    expect(historyEmpty.textContent).toContain('Нет именованных сохранений');

    // Toggle back OFF and switch UI language RU -> EN
    namedOnlySwitch.click();
    langBtn.click();
    expect(historyList.children).toHaveLength(3);
    expect(historyList.textContent).toContain('2026-11-14-12-35-00 autosave');
    expect(historyList.textContent).toContain('2026-11-14-12-30-00 Saved by user');
    expect(saveStatus.textContent).toContain('Autosaved at');
  });

  it('renames a snapshot without changing its creation time, keeps it visible under named-only, and restores snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 14, 0, 5));

    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const tapeInput = document.querySelector<HTMLInputElement>('#input-tape')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const namedOnlySwitch = document.querySelector<HTMLButtonElement>('#btn-named-only')!;
    const historyList = document.querySelector<HTMLUListElement>('#history-list')!;

    historyBtn.click();

    editField(programInput, '0, ,#,0');
    editField(tapeInput, 'first');
    saveBtn.click();

    // Advance time by 5 minutes before renaming
    vi.advanceTimersByTime(5 * 60 * 1000);

    // Trigger inline rename
    historyList.querySelector<HTMLButtonElement>('.snapshot-action--rename')!.click();
    const editInput = historyList.querySelector<HTMLInputElement>('.snapshot-item__input')!;
    editInput.value = 'Initial algorithm';
    editInput
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Remains in the unified list with original timestamp preserved
    expect(historyList.children).toHaveLength(1);
    expect(historyList.textContent).toContain('Initial algorithm');
    expect(historyList.textContent).toContain('2026-11-14-14-00-05');

    const persisted = JSON.parse(window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY)!) as {
      createdAt: number;
      customName: string;
    }[];
    expect(persisted[0]?.customName).toBe('Initial algorithm');
    expect(persisted[0]?.createdAt).toBe(new Date(2026, 10, 14, 14, 0, 5).getTime());

    // Modify editor, then restore the named snapshot (unsaved edits are safety-autosaved)
    editField(programInput, '0,1,0,0');
    editField(tapeInput, 'modified');
    historyList.querySelector<HTMLButtonElement>('.snapshot-item__load')!.click();

    expect(programInput.value).toBe('0, ,#,0');
    expect(tapeInput.value).toBe('first');
    // Both the named snapshot and the safety autosave are shown together when named-only is OFF
    expect(historyList.children).toHaveLength(2);

    // Turning named-only ON shows strictly the named snapshot
    namedOnlySwitch.click();
    expect(historyList.children).toHaveLength(1);
    expect(historyList.textContent).toContain('Initial algorithm');
    expect(historyList.textContent).not.toContain('автосохранение');
  });

  it('confirms deletion with snapshot name, supports "do not show again", and re-enables via Settings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 16, 10, 0));

    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const historyList = document.querySelector<HTMLUListElement>('#history-list')!;
    const deleteDialog = document.querySelector<HTMLDialogElement>('#delete-snapshot-dialog')!;
    const deleteTargetName = document.querySelector<HTMLElement>('#delete-snapshot-name')!;
    const skipCheckbox = document.querySelector<HTMLInputElement>('#chk-skip-delete-confirm')!;
    const cancelDeleteBtn = document.querySelector<HTMLButtonElement>('#btn-cancel-delete')!;
    const confirmDeleteBtn = document.querySelector<HTMLButtonElement>(
      '#btn-confirm-delete-snapshot',
    )!;
    const settingsBtn = document.querySelector<HTMLButtonElement>('#btn-settings')!;
    const confirmDeleteSettingSwitch = document.querySelector<HTMLButtonElement>(
      '#btn-setting-confirm-delete',
    )!;

    historyBtn.click();

    // Create 3 snapshots
    editField(programInput, '0, ,#,0');
    saveBtn.click();
    vi.advanceTimersByTime(1000);
    editField(programInput, '0,1,0,0');
    saveBtn.click();
    vi.advanceTimersByTime(1000);
    editField(programInput, '0,0,1,0');
    saveBtn.click();

    expect(historyList.children).toHaveLength(3);

    // Click delete on newest snapshot → dialog opens with exact snapshot name
    historyList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(true);
    expect(deleteTargetName.textContent).toBe('2026-11-14-16-10-02 Сохранено пользователем');

    // Checking the box and cancelling does NOT disable future confirmations
    skipCheckbox.checked = true;
    cancelDeleteBtn.click();
    expect(deleteDialog.open).toBe(false);
    expect(historyList.children).toHaveLength(3);
    expect(confirmDeleteSettingSwitch.getAttribute('aria-checked')).toBe('true');

    // Delete again, check "do not show again", and confirm
    historyList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(true);
    expect(skipCheckbox.checked).toBe(false);
    skipCheckbox.checked = true;
    confirmDeleteBtn.click();

    expect(deleteDialog.open).toBe(false);
    expect(historyList.children).toHaveLength(2);
    expect(confirmDeleteSettingSwitch.getAttribute('aria-checked')).toBe('false');

    // Deleting the next snapshot skips the dialog immediately
    historyList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(false);
    expect(historyList.children).toHaveLength(1);

    // Re-enable delete confirmation in Settings
    settingsBtn.click();
    confirmDeleteSettingSwitch.click();
    expect(confirmDeleteSettingSwitch.getAttribute('aria-checked')).toBe('true');

    // Deleting the last snapshot opens the confirmation dialog again
    historyList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(true);
    confirmDeleteBtn.click();
    expect(historyList.children).toHaveLength(0);
  });

  it('updates history live on cross-tab storage events and warns on QuotaExceededError', async () => {
    await import('../src/main');

    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const historyList = document.querySelector<HTMLUListElement>('#history-list')!;
    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const saveStatus = document.querySelector<HTMLElement>('#save-status')!;
    const deleteDialog = document.querySelector<HTMLDialogElement>('#delete-snapshot-dialog')!;
    const log = document.querySelector<HTMLElement>('#log')!;

    historyBtn.click();
    expect(historyList.children).toHaveLength(0);

    // Simulate another tab writing a snapshot into localStorage
    window.localStorage.setItem(
      SNAPSHOTS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'ext-1',
          kind: 'manual',
          createdAt: new Date(2026, 10, 14, 18, 0, 0).getTime(),
          customName: 'From another tab',
          program: '0, ,#,0',
          tape: '1',
        },
      ]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: SNAPSHOTS_STORAGE_KEY }));

    expect(historyList.children).toHaveLength(1);
    expect(historyList.textContent).toContain('From another tab');

    // Open delete confirmation dialog for ext-1, then simulate another tab deleting it → dialog closes
    historyList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(true);
    window.localStorage.setItem(SNAPSHOTS_STORAGE_KEY, JSON.stringify([]));
    window.dispatchEvent(new StorageEvent('storage', { key: SNAPSHOTS_STORAGE_KEY }));
    expect(deleteDialog.open).toBe(false);
    expect(historyList.children).toHaveLength(0);

    // Simulate storage quota failure when saving manually → warning shown, no phantom entry, stays dirty
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key === SNAPSHOTS_STORAGE_KEY) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
    });
    editField(programInput, '0,1,0,0');
    expect(saveStatus.dataset.state).toBe('dirty');
    saveBtn.click();

    expect(log.dataset.kind).toBe('warning');
    expect(log.textContent).toContain('хранилище браузера переполнено');
    expect(historyList.children).toHaveLength(0);
    expect(saveStatus.dataset.state).toBe('dirty');
  });
});
