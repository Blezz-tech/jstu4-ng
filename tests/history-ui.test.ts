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

  it('places SVG save button right after Copy and toggles the left history panel via SVG top button', async () => {
    await import('../src/main');

    const copyBtn = document.querySelector<HTMLButtonElement>('#btn-copy')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const historyPanel = document.querySelector<HTMLElement>('#history-panel')!;
    const shell = document.querySelector<HTMLElement>('#app-shell')!;

    expect(copyBtn.nextElementSibling).toBe(saveBtn);
    expect(saveBtn.dataset.mode).toBe('edit');
    expect(saveBtn.querySelector('svg')).not.toBeNull();
    expect(historyBtn.querySelector('svg')).not.toBeNull();

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

  it('creates manual saves, timed autosaves, toggles autosave visibility, and switches locale dynamically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 12, 30, 0));

    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const tapeInput = document.querySelector<HTMLInputElement>('#input-tape')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const autosavesSwitch = document.querySelector<HTMLButtonElement>('#btn-show-autosaves')!;
    const unnamedList = document.querySelector<HTMLUListElement>('#history-unnamed-list')!;
    const langBtn = document.querySelector<HTMLButtonElement>('#btn-lang')!;

    historyBtn.click();

    // Manual save in RU
    programInput.value = '0, ,#,0';
    tapeInput.value = '101';
    saveBtn.click();

    expect(unnamedList.children).toHaveLength(1);
    expect(unnamedList.textContent).toContain('2026-11-14-12-30-00 Сохранено пользователем');

    // Every action button inside snapshot item uses SVG
    for (const btn of unnamedList.querySelectorAll('.snapshot-action')) {
      expect(btn.querySelector('svg')).not.toBeNull();
    }

    // Edit program and advance timer → timed autosave created
    programInput.value = '0, ,>,1\n1, ,#,1';
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);

    expect(unnamedList.children).toHaveLength(2);
    expect(unnamedList.textContent).toContain('2026-11-14-12-30-30 автосохранение');

    // Advancing timer again with no changes → no duplicate autosave
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(unnamedList.children).toHaveLength(2);

    // Toggle autosaves switch OFF (no text inside switch, blue pill switch)
    expect(autosavesSwitch.getAttribute('aria-checked')).toBe('true');
    expect(autosavesSwitch.textContent?.trim()).toBe('');
    autosavesSwitch.click();
    expect(autosavesSwitch.getAttribute('aria-checked')).toBe('false');
    expect(unnamedList.children).toHaveLength(1);
    expect(unnamedList.textContent).toContain('Сохранено пользователем');
    expect(unnamedList.textContent).not.toContain('автосохранение');

    // Toggle back ON and switch UI language RU -> EN
    autosavesSwitch.click();
    langBtn.click();
    expect(unnamedList.textContent).toContain('2026-11-14-12-30-30 autosave');
    expect(unnamedList.textContent).toContain('2026-11-14-12-30-00 Saved by user');
  });

  it('renames a snapshot without changing its creation time, separates named from unnamed, and restores snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 14, 0, 5));

    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const tapeInput = document.querySelector<HTMLInputElement>('#input-tape')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const namedList = document.querySelector<HTMLUListElement>('#history-named-list')!;
    const unnamedList = document.querySelector<HTMLUListElement>('#history-unnamed-list')!;

    historyBtn.click();

    programInput.value = '0, ,#,0';
    tapeInput.value = 'first';
    saveBtn.click();

    // Advance time by 5 minutes before renaming
    vi.advanceTimersByTime(5 * 60 * 1000);

    // Trigger inline rename
    unnamedList.querySelector<HTMLButtonElement>('.snapshot-action--rename')!.click();
    const editInput = unnamedList.querySelector<HTMLInputElement>('.snapshot-item__input')!;
    editInput.value = 'Initial algorithm';
    editInput
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Moved into Named section with original timestamp preserved
    expect(namedList.children).toHaveLength(1);
    expect(unnamedList.children).toHaveLength(0);
    expect(namedList.textContent).toContain('Initial algorithm');
    expect(namedList.textContent).toContain('2026-11-14-14-00-05');

    const persisted = JSON.parse(window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY)!) as {
      createdAt: number;
      customName: string;
    }[];
    expect(persisted[0]?.customName).toBe('Initial algorithm');
    expect(persisted[0]?.createdAt).toBe(new Date(2026, 10, 14, 14, 0, 5).getTime());

    // Modify editor, then restore the named snapshot (current edits are safety-autosaved)
    programInput.value = '0,1,0,0';
    tapeInput.value = 'modified';
    namedList.querySelector<HTMLButtonElement>('.snapshot-item__load')!.click();

    expect(programInput.value).toBe('0, ,#,0');
    expect(tapeInput.value).toBe('first');
    // Unsaved modification was preserved as an autosave in unnamed list
    expect(unnamedList.children).toHaveLength(1);
  });

  it('confirms deletion with snapshot name, supports "do not show again", and re-enables via Settings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 16, 10, 0));

    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
    const historyBtn = document.querySelector<HTMLButtonElement>('#btn-history')!;
    const unnamedList = document.querySelector<HTMLUListElement>('#history-unnamed-list')!;
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

    expect(unnamedList.children).toHaveLength(3);

    // Click delete on newest snapshot → dialog opens with exact snapshot name
    unnamedList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(true);
    expect(deleteTargetName.textContent).toBe('2026-11-14-16-10-02 Сохранено пользователем');

    // Checking the box and cancelling does NOT disable future confirmations
    skipCheckbox.checked = true;
    cancelDeleteBtn.click();
    expect(deleteDialog.open).toBe(false);
    expect(unnamedList.children).toHaveLength(3);
    expect(confirmDeleteSettingSwitch.getAttribute('aria-checked')).toBe('true');

    // Delete again, check "do not show again", and confirm
    unnamedList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(true);
    expect(skipCheckbox.checked).toBe(false);
    skipCheckbox.checked = true;
    confirmDeleteBtn.click();

    expect(deleteDialog.open).toBe(false);
    expect(unnamedList.children).toHaveLength(2);
    expect(confirmDeleteSettingSwitch.getAttribute('aria-checked')).toBe('false');

    // Deleting the next snapshot skips the dialog immediately
    unnamedList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(false);
    expect(unnamedList.children).toHaveLength(1);

    // Re-enable delete confirmation in Settings
    settingsBtn.click();
    confirmDeleteSettingSwitch.click();
    expect(confirmDeleteSettingSwitch.getAttribute('aria-checked')).toBe('true');

    // Deleting the last snapshot opens the confirmation dialog again
    unnamedList.querySelector<HTMLButtonElement>('.snapshot-action--delete')!.click();
    expect(deleteDialog.open).toBe(true);
    confirmDeleteBtn.click();
    expect(unnamedList.children).toHaveLength(0);
  });
});
