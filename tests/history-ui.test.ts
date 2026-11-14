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

  it('places SVG save button right after Copy and places SVG history button right before Settings', async () => {
    await import('../src/main');

    const copyBtn = document.querySelector<HTMLButtonElement>('#btn-copy')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const settingsAnchor = document.querySelector<HTMLElement>('#settings-anchor')!;
    const historyPanel = document.querySelector<HTMLElement>('#history-panel')!;
    const shell = document.querySelector<HTMLElement>('#app-shell')!;

    expect(copyBtn.nextElementSibling).toBe(saveBtn);
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

  it('creates manual saves and timed autosaves in one unified list, filters named-only, and switches locale dynamically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 12, 30, 0));

    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const tapeInput = document.querySelector<HTMLInputElement>('#input-tape')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const namedOnlySwitch = document.querySelector<HTMLButtonElement>('#btn-named-only')!;
    const historyList = document.querySelector<HTMLUListElement>('#history-list')!;
    const historyEmpty = document.querySelector<HTMLElement>('#history-empty')!;
    const langBtn = document.querySelector<HTMLButtonElement>('#btn-lang')!;

    historyBtn.click();

    // Manual save in RU
    programInput.value = '0, ,#,0';
    tapeInput.value = '101';
    saveBtn.click();

    expect(historyList.children).toHaveLength(1);
    expect(historyList.textContent).toContain('2026-11-14-12-30-00 Сохранено пользователем');

    // Every action button inside snapshot item uses SVG
    for (const btn of historyList.querySelectorAll('.snapshot-action')) {
      expect(btn.querySelector('svg')).not.toBeNull();
    }

    // Edit program and advance timer → timed autosave created in the same list
    programInput.value = '0, ,>,1\n1, ,#,1';
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);

    expect(historyList.children).toHaveLength(2);
    expect(historyList.textContent).toContain('2026-11-14-12-30-30 автосохранение');

    // Advancing timer again with no changes → no duplicate autosave
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(historyList.children).toHaveLength(2);

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
    expect(historyList.children).toHaveLength(2);
    expect(historyList.textContent).toContain('2026-11-14-12-30-30 autosave');
    expect(historyList.textContent).toContain('2026-11-14-12-30-00 Saved by user');
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

    programInput.value = '0, ,#,0';
    tapeInput.value = 'first';
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

    // Modify editor, then restore the named snapshot (current edits are safety-autosaved)
    programInput.value = '0,1,0,0';
    tapeInput.value = 'modified';
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
    programInput.value = '0, ,#,0';
    saveBtn.click();
    vi.advanceTimersByTime(1000);
    programInput.value = '0,1,0,0';
    saveBtn.click();
    vi.advanceTimersByTime(1000);
    programInput.value = '0,0,1,0';
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
});
