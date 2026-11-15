import type { I18n } from '../../i18n';
import type { AppController } from '../controller';
import { debounce, type DebouncedFn } from '../dom';
import {
  AutosaveTracker,
  formatSaveClock,
  getSnapshotDisplayName,
  SnapshotStore,
  type ProgramSnapshot,
} from '../history';
import type { NotificationLog } from '../notifications';
import { saveProgram, saveTape } from '../storage';
import { createDeleteSnapshotDialog } from './dialogs';
import { listen, type AppDom } from './dom';
import type { SettingsStore } from './settings-store';
import { isNarrowViewport } from './sidepanels';
import { renderSnapshotItem } from './snapshot-item';

type CleanSaveStatus =
  { readonly kind: 'idle' } | { readonly kind: 'saved' | 'autosaved'; readonly timestamp: number };

export interface HistoryPanelOptions {
  readonly dom: AppDom;
  readonly i18n: I18n;
  readonly controller: AppController;
  readonly notifications: NotificationLog;
  readonly settings: SettingsStore;
  readonly onCloseSettings: () => void;
  readonly onCloseHistoryDrawer: () => void;
  readonly onConfirmDeleteSettingChanged: () => void;
  readonly signal: AbortSignal;
}

export interface HistoryPanel {
  readonly isDeleteDialogOpen: boolean;
  readonly isConfirmDeleteEnabled: boolean;
  toggleConfirmDelete(): void;
  resetBaseline(program: string, tape: string): void;
  syncLocalized(): void;
  createManualSnapshot(): void;
  dispose(): void;
}

/**
 * Owns the version-control history panel: snapshot storage, timed/tab-close
 * autosaving, `#save-status`, inline renaming, deletion confirmation dialog,
 * and cross-tab synchronization.
 */
export function bindHistoryPanel({
  dom,
  i18n,
  controller,
  notifications,
  settings,
  onCloseSettings,
  onCloseHistoryDrawer,
  onConfirmDeleteSettingChanged,
  signal,
}: HistoryPanelOptions): HistoryPanel {
  const initial = settings.get();
  let namedOnly = initial.namedOnly ?? false;
  let confirmSnapshotDelete = initial.confirmSnapshotDelete ?? true;
  let activeSnapshotId: string | null = null;
  let editingSnapshotId: string | null = null;
  let lastCleanSaveStatus: CleanSaveStatus = { kind: 'idle' };

  const syncNamedOnlyControl = (): void => {
    dom.namedOnlyButton.setAttribute('aria-checked', String(namedOnly));
  };

  const syncSaveStatus = (): void => {
    const status = dom.saveStatus;
    if (autosave.isDirty) {
      status.dataset.state = 'dirty';
      status.textContent = i18n.t('history.statusUnsaved');
      status.title = i18n.t('history.statusUnsavedHint');
      return;
    }
    status.title = '';
    if (lastCleanSaveStatus.kind === 'idle') {
      status.dataset.state = 'idle';
      status.textContent = '';
      return;
    }
    const key =
      lastCleanSaveStatus.kind === 'saved' ? 'history.statusSaved' : 'history.statusAutosaved';
    status.dataset.state = lastCleanSaveStatus.kind;
    status.textContent = i18n.t(key, {
      time: formatSaveClock(lastCleanSaveStatus.timestamp),
    });
  };

  const render = (): void => {
    const visible = snapshots.getVisible(namedOnly);
    dom.historyCount.textContent = String(visible.length);
    dom.historyEmpty.textContent = i18n.t(namedOnly ? 'history.emptyNamed' : 'history.emptyAll');
    dom.historyList.replaceChildren(
      ...visible.map((s) =>
        renderSnapshotItem(s, i18n, {
          isActive: activeSnapshotId === s.id,
          isEditing: editingSnapshotId === s.id,
        }),
      ),
    );

    const pendingId = deleteDialog.currentPendingId;
    if (deleteDialog.isOpen && pendingId !== null) {
      const target = snapshots.getById(pendingId);
      if (target !== null) deleteDialog.syncName(getSnapshotDisplayName(target, i18n));
    }
  };

  const performDeleteSnapshot = (id: string): void => {
    if (!snapshots.remove(id)) return;
    if (activeSnapshotId === id) activeSnapshotId = null;
    if (editingSnapshotId === id) editingSnapshotId = null;
    notifications.show('info', (t) => t.t('log.snapshotDeleted'));
    render();
  };

  const requestDeleteSnapshot = (snapshot: ProgramSnapshot): void => {
    if (!confirmSnapshotDelete) {
      performDeleteSnapshot(snapshot.id);
      return;
    }
    deleteDialog.open(snapshot.id, getSnapshotDisplayName(snapshot, i18n));
  };

  const restoreSnapshot = (snapshot: ProgramSnapshot): void => {
    const currentProgram = dom.programInput.value;
    const currentTape = dom.tapeInput.value;
    if (
      autosave.isDirty &&
      currentProgram.trim() !== '' &&
      (currentProgram !== snapshot.program || currentTape !== snapshot.tape)
    ) {
      autosave.flush();
    }
    activeSnapshotId = snapshot.id;
    editingSnapshotId = null;
    controller.loadDraft(snapshot.program, snapshot.tape);
    notifications.show('info', (t) =>
      t.t('log.snapshotRestored', { name: getSnapshotDisplayName(snapshot, t) }),
    );
    autosave.reset(snapshot.program, snapshot.tape);
    lastCleanSaveStatus = { kind: 'idle' };
    syncSaveStatus();
    render();
    if (isNarrowViewport()) onCloseHistoryDrawer();
  };

  const createManualSnapshot = (): void => {
    const program = dom.programInput.value;
    const tape = dom.tapeInput.value;
    if (program.trim() === '') {
      notifications.show('warning', (t) => t.t('log.snapshotEmpty'));
      return;
    }
    const created = snapshots.create('manual', program, tape);
    if (!snapshots.lastPersistOk) {
      render();
      return;
    }
    activeSnapshotId = created.id;
    lastCleanSaveStatus = { kind: 'saved', timestamp: created.createdAt };
    autosave.reset(program, tape);
    syncSaveStatus();
    notifications.show('info', (t) => t.t('log.snapshotSaved'));
    render();
  };

  const deleteDialog = createDeleteSnapshotDialog({
    dom,
    onBeforeOpen: onCloseSettings,
    onConfirm: (id, skipFutureConfirm) => {
      if (skipFutureConfirm) {
        confirmSnapshotDelete = false;
        settings.update({ confirmSnapshotDelete: false });
        onConfirmDeleteSettingChanged();
      }
      performDeleteSnapshot(id);
    },
    signal,
  });

  const snapshots = new SnapshotStore({
    onPersistError: () => notifications.show('warning', (t) => t.t('log.snapshotQuotaExceeded')),
  });
  snapshots.subscribe((source) => {
    if (source !== 'storage') return;
    const missing = (id: string | null): boolean => id !== null && snapshots.getById(id) === null;
    if (missing(activeSnapshotId)) activeSnapshotId = null;
    if (missing(deleteDialog.currentPendingId)) deleteDialog.close();
    if (missing(editingSnapshotId)) editingSnapshotId = null;
    if (editingSnapshotId === null) render();
  });

  const autosave = new AutosaveTracker({
    store: snapshots,
    readState: () => ({ program: dom.programInput.value, tape: dom.tapeInput.value }),
    onAutosave: (created) => {
      activeSnapshotId = created.id;
      lastCleanSaveStatus = { kind: 'autosaved', timestamp: created.createdAt };
      syncSaveStatus();
      if (editingSnapshotId === null) render();
    },
    onDirtyChange: syncSaveStatus,
  });

  const persistProgram = debounce((text: string) => saveProgram(text), 400);
  const persistTape = debounce((text: string) => saveTape(text), 400);

  listen(dom.saveButton, 'click', createManualSnapshot, signal);
  listen(
    dom.namedOnlyButton,
    'click',
    () => {
      namedOnly = !namedOnly;
      settings.update({ namedOnly });
      syncNamedOnlyControl();
      render();
    },
    signal,
  );

  const bindInput = (
    field: HTMLInputElement | HTMLTextAreaElement,
    persist: DebouncedFn<[string]>,
  ): void => {
    listen(
      field,
      'input',
      () => {
        persist(field.value);
        autosave.markEdited(dom.programInput.value, dom.tapeInput.value);
      },
      signal,
    );
  };
  bindInput(dom.programInput, persistProgram);
  bindInput(dom.tapeInput, persistTape);

  // Delegate snapshot card interactions onto `#history-list` so re-rendering
  // never creates per-item event listeners.
  listen(
    dom.historyList,
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest('.snapshot-action--cancel') !== null) {
        editingSnapshotId = null;
        render();
        return;
      }

      const id = target.closest<HTMLLIElement>('.snapshot-item')?.dataset.snapshotId;
      const snapshot = id ? snapshots.getById(id) : null;
      if (snapshot === null) return;

      if (target.closest('.snapshot-action--rename') !== null) {
        editingSnapshotId = snapshot.id;
        render();
        const input = dom.historyList.querySelector<HTMLInputElement>('.snapshot-item__input');
        input?.focus();
        input?.select();
      } else if (target.closest('.snapshot-action--delete') !== null) {
        requestDeleteSnapshot(snapshot);
      } else if (target.closest('.snapshot-item__load') !== null) {
        restoreSnapshot(snapshot);
      }
    },
    signal,
  );

  listen(
    dom.historyList,
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.classList.contains('snapshot-item__edit')) {
        return;
      }
      event.preventDefault();
      const id = form.closest<HTMLLIElement>('.snapshot-item')?.dataset.snapshotId;
      const trimmed =
        form.querySelector<HTMLInputElement>('.snapshot-item__input')?.value.trim() ?? '';
      if (id && trimmed !== '') snapshots.rename(id, trimmed);
      editingSnapshotId = null;
      render();
    },
    signal,
  );

  listen(
    dom.historyList,
    'keydown',
    (event) => {
      if (
        event.key === 'Escape' &&
        event.target instanceof HTMLInputElement &&
        event.target.classList.contains('snapshot-item__input')
      ) {
        event.preventDefault();
        event.stopPropagation();
        editingSnapshotId = null;
        render();
      }
    },
    signal,
  );

  const handleTabClosing = (): void => {
    saveProgram(dom.programInput.value);
    saveTape(dom.tapeInput.value);
    autosave.flush();
  };
  listen(window, 'beforeunload', handleTabClosing, signal);
  listen(window, 'pagehide', handleTabClosing, signal);

  return {
    get isDeleteDialogOpen(): boolean {
      return deleteDialog.isOpen;
    },
    get isConfirmDeleteEnabled(): boolean {
      return confirmSnapshotDelete;
    },
    toggleConfirmDelete() {
      confirmSnapshotDelete = !confirmSnapshotDelete;
      settings.update({ confirmSnapshotDelete });
      onConfirmDeleteSettingChanged();
    },
    resetBaseline(program, tape) {
      autosave.reset(program, tape);
      syncSaveStatus();
    },
    syncLocalized() {
      syncNamedOnlyControl();
      syncSaveStatus();
      render();
    },
    createManualSnapshot,
    dispose() {
      persistProgram.cancel();
      persistTape.cancel();
      autosave.dispose();
      snapshots.dispose();
    },
  };
}
