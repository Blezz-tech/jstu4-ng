import type { I18n } from '../../i18n';
import type { AppController } from '../controller';
import { debounce, el, svgIcon, type DebouncedFn } from '../dom';
import {
  AutosaveTracker,
  formatSaveClock,
  formatSnapshotTimestamp,
  getSnapshotDisplayName,
  SnapshotStore,
  type ProgramSnapshot,
} from '../history';
import type { NotificationLog } from '../notifications';
import { saveProgram, saveTape } from '../storage';
import { DeleteSnapshotDialog } from './dialogs';
import { listen, type AppDom } from './dom';
import type { SettingsStore } from './settings-store';
import { isNarrowViewport } from './sidepanels';

const ICON_RENAME = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z'];
const ICON_DELETE = [
  'M3 6h18',
  'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
  'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  'M10 11v6',
  'M14 11v6',
];
const ICON_CHECK = ['M20 6 9 17l-5-5'];
const ICON_CANCEL = ['M18 6 6 18', 'M6 6l12 12'];

type CleanSaveStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saved'; readonly timestamp: number }
  | { readonly kind: 'autosaved'; readonly timestamp: number };

function countProgramLines(program: string): number {
  const nonEmpty = program.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  return Math.max(nonEmpty, 1);
}

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

/**
 * Owns the version-control history panel: snapshot storage, timed/tab-close
 * autosaving, `#save-status`, inline renaming, deletion confirmation dialog,
 * and cross-tab synchronization.
 */
export class HistoryPanel {
  private readonly dom: AppDom;
  private readonly i18n: I18n;
  private readonly controller: AppController;
  private readonly notifications: NotificationLog;
  private readonly settings: SettingsStore;
  private readonly onCloseHistoryDrawer: () => void;
  private readonly onConfirmDeleteSettingChanged: () => void;
  private readonly signal: AbortSignal;

  private readonly snapshots: SnapshotStore;
  private readonly autosave: AutosaveTracker;
  private readonly deleteDialog: DeleteSnapshotDialog;
  private readonly persistProgram: DebouncedFn<[string]>;
  private readonly persistTape: DebouncedFn<[string]>;

  private namedOnly: boolean;
  private confirmSnapshotDelete: boolean;
  private activeSnapshotId: string | null = null;
  private editingSnapshotId: string | null = null;
  private lastCleanSaveStatus: CleanSaveStatus = { kind: 'idle' };

  constructor(options: HistoryPanelOptions) {
    this.dom = options.dom;
    this.i18n = options.i18n;
    this.controller = options.controller;
    this.notifications = options.notifications;
    this.settings = options.settings;
    this.onCloseHistoryDrawer = options.onCloseHistoryDrawer;
    this.onConfirmDeleteSettingChanged = options.onConfirmDeleteSettingChanged;
    this.signal = options.signal;

    const initial = this.settings.get();
    this.namedOnly = initial.namedOnly ?? false;
    this.confirmSnapshotDelete = initial.confirmSnapshotDelete ?? true;

    this.deleteDialog = new DeleteSnapshotDialog({
      dom: this.dom,
      onBeforeOpen: options.onCloseSettings,
      onConfirm: (id, skipFutureConfirm) => {
        if (skipFutureConfirm) {
          this.confirmSnapshotDelete = false;
          this.settings.update({ confirmSnapshotDelete: false });
          this.onConfirmDeleteSettingChanged();
        }
        this.performDeleteSnapshot(id);
      },
      signal: options.signal,
    });

    this.snapshots = new SnapshotStore({
      onPersistError: () => {
        this.notifications.show('warning', (t) => t.t('log.snapshotQuotaExceeded'));
      },
    });
    this.snapshots.subscribe((source) => {
      if (source !== 'storage') return;
      if (
        this.activeSnapshotId !== null &&
        this.snapshots.getById(this.activeSnapshotId) === null
      ) {
        this.activeSnapshotId = null;
      }
      const pendingId = this.deleteDialog.currentPendingId;
      if (pendingId !== null && this.snapshots.getById(pendingId) === null) {
        this.deleteDialog.close();
      }
      if (
        this.editingSnapshotId !== null &&
        this.snapshots.getById(this.editingSnapshotId) === null
      ) {
        this.editingSnapshotId = null;
      }
      if (this.editingSnapshotId === null) {
        this.render();
      }
    });

    this.autosave = new AutosaveTracker({
      store: this.snapshots,
      readState: () => ({
        program: this.dom.programInput.value,
        tape: this.dom.tapeInput.value,
      }),
      onAutosave: (created) => {
        this.activeSnapshotId = created.id;
        this.lastCleanSaveStatus = { kind: 'autosaved', timestamp: created.createdAt };
        this.syncSaveStatus();
        if (this.editingSnapshotId === null) this.render();
      },
      onDirtyChange: () => {
        this.syncSaveStatus();
      },
    });

    this.persistProgram = debounce((text: string) => saveProgram(text), 400);
    this.persistTape = debounce((text: string) => saveTape(text), 400);

    const { signal } = options;

    listen(this.dom.saveButton, 'click', () => this.createManualSnapshot(), signal);
    listen(
      this.dom.namedOnlyButton,
      'click',
      () => {
        this.namedOnly = !this.namedOnly;
        this.settings.update({ namedOnly: this.namedOnly });
        this.syncNamedOnlyControl();
        this.render();
      },
      signal,
    );

    listen(
      this.dom.programInput,
      'input',
      () => {
        this.persistProgram(this.dom.programInput.value);
        this.autosave.markEdited(this.dom.programInput.value, this.dom.tapeInput.value);
      },
      signal,
    );
    listen(
      this.dom.tapeInput,
      'input',
      () => {
        this.persistTape(this.dom.tapeInput.value);
        this.autosave.markEdited(this.dom.programInput.value, this.dom.tapeInput.value);
      },
      signal,
    );

    const handleTabClosing = (): void => {
      saveProgram(this.dom.programInput.value);
      saveTape(this.dom.tapeInput.value);
      this.autosave.flush();
    };
    listen(window, 'beforeunload', handleTabClosing, signal);
    listen(window, 'pagehide', handleTabClosing, signal);
  }

  get isDeleteDialogOpen(): boolean {
    return this.deleteDialog.isOpen;
  }

  get isConfirmDeleteEnabled(): boolean {
    return this.confirmSnapshotDelete;
  }

  toggleConfirmDelete(): void {
    this.confirmSnapshotDelete = !this.confirmSnapshotDelete;
    this.settings.update({ confirmSnapshotDelete: this.confirmSnapshotDelete });
    this.onConfirmDeleteSettingChanged();
  }

  resetBaseline(program: string, tape: string): void {
    this.autosave.reset(program, tape);
    this.syncSaveStatus();
  }

  syncLocalized(): void {
    this.syncNamedOnlyControl();
    this.syncSaveStatus();
    this.render();
  }

  createManualSnapshot(): void {
    const program = this.dom.programInput.value;
    const tape = this.dom.tapeInput.value;
    if (program.trim() === '') {
      this.notifications.show('warning', (t) => t.t('log.snapshotEmpty'));
      return;
    }
    const created = this.snapshots.create('manual', program, tape);
    if (!this.snapshots.lastPersistOk) {
      this.render();
      return;
    }
    this.activeSnapshotId = created.id;
    this.lastCleanSaveStatus = { kind: 'saved', timestamp: created.createdAt };
    this.autosave.reset(program, tape);
    this.syncSaveStatus();
    this.notifications.show('info', (t) => t.t('log.snapshotSaved'));
    this.render();
  }

  dispose(): void {
    this.persistProgram.cancel();
    this.persistTape.cancel();
    this.autosave.dispose();
    this.snapshots.dispose();
  }

  private syncNamedOnlyControl(): void {
    this.dom.namedOnlyButton.setAttribute('aria-checked', String(this.namedOnly));
  }

  private syncSaveStatus(): void {
    if (this.autosave.isDirty) {
      this.dom.saveStatus.dataset.state = 'dirty';
      this.dom.saveStatus.textContent = this.i18n.t('history.statusUnsaved');
      this.dom.saveStatus.title = this.i18n.t('history.statusUnsavedHint');
      return;
    }
    if (this.lastCleanSaveStatus.kind === 'saved') {
      this.dom.saveStatus.dataset.state = 'saved';
      this.dom.saveStatus.textContent = this.i18n.t('history.statusSaved', {
        time: formatSaveClock(this.lastCleanSaveStatus.timestamp),
      });
      this.dom.saveStatus.title = '';
      return;
    }
    if (this.lastCleanSaveStatus.kind === 'autosaved') {
      this.dom.saveStatus.dataset.state = 'autosaved';
      this.dom.saveStatus.textContent = this.i18n.t('history.statusAutosaved', {
        time: formatSaveClock(this.lastCleanSaveStatus.timestamp),
      });
      this.dom.saveStatus.title = '';
      return;
    }
    this.dom.saveStatus.dataset.state = 'idle';
    this.dom.saveStatus.textContent = '';
    this.dom.saveStatus.title = '';
  }

  private performDeleteSnapshot(id: string): void {
    const removed = this.snapshots.remove(id);
    if (!removed) return;
    if (this.activeSnapshotId === id) this.activeSnapshotId = null;
    if (this.editingSnapshotId === id) this.editingSnapshotId = null;
    this.notifications.show('info', (t) => t.t('log.snapshotDeleted'));
    this.render();
  }

  private requestDeleteSnapshot(snapshot: ProgramSnapshot): void {
    if (!this.confirmSnapshotDelete) {
      this.performDeleteSnapshot(snapshot.id);
      return;
    }
    this.deleteDialog.open(snapshot.id, getSnapshotDisplayName(snapshot, this.i18n));
  }

  private restoreSnapshot(snapshot: ProgramSnapshot): void {
    const currentProgram = this.dom.programInput.value;
    const currentTape = this.dom.tapeInput.value;
    if (
      this.autosave.isDirty &&
      currentProgram.trim() !== '' &&
      (currentProgram !== snapshot.program || currentTape !== snapshot.tape)
    ) {
      this.autosave.flush();
    }
    this.activeSnapshotId = snapshot.id;
    this.editingSnapshotId = null;
    this.controller.loadDraft(snapshot.program, snapshot.tape);
    this.notifications.show('info', (t) =>
      t.t('log.snapshotRestored', { name: getSnapshotDisplayName(snapshot, t) }),
    );
    this.autosave.reset(snapshot.program, snapshot.tape);
    this.lastCleanSaveStatus = { kind: 'idle' };
    this.syncSaveStatus();
    this.render();
    if (isNarrowViewport()) this.onCloseHistoryDrawer();
  }

  private renderSnapshotItem(snapshot: ProgramSnapshot): HTMLLIElement {
    const isNamed = snapshot.customName !== null;
    const isEditing = this.editingSnapshotId === snapshot.id;
    const displayName = getSnapshotDisplayName(snapshot, this.i18n);

    const li = el('li', {
      class: 'snapshot-item',
      'data-snapshot-id': snapshot.id,
      'data-kind': snapshot.kind,
      'data-named': String(isNamed),
      'data-active': String(this.activeSnapshotId === snapshot.id),
    });

    const node = el('span', { class: 'snapshot-item__node', 'aria-hidden': 'true' });
    const main = el('div', { class: 'snapshot-item__main' });

    if (isEditing) {
      const form = el('form', { class: 'snapshot-item__edit' });
      const input = el('input', {
        class: 'snapshot-item__input',
        type: 'text',
        placeholder: this.i18n.t('history.renamePlaceholder'),
        'aria-label': this.i18n.t('history.renamePlaceholder'),
      });
      input.value = snapshot.customName ?? '';

      const commitBtn = el(
        'button',
        {
          class: 'snapshot-action',
          type: 'submit',
          title: this.i18n.t('history.renameSave'),
          'aria-label': this.i18n.t('history.renameSave'),
        },
        svgIcon(ICON_CHECK),
      );

      const cancelBtn = el(
        'button',
        {
          class: 'snapshot-action',
          type: 'button',
          title: this.i18n.t('history.renameCancel'),
          'aria-label': this.i18n.t('history.renameCancel'),
        },
        svgIcon(ICON_CANCEL),
      );

      listen(
        form,
        'submit',
        (event) => {
          event.preventDefault();
          const trimmed = input.value.trim();
          if (trimmed !== '') this.snapshots.rename(snapshot.id, trimmed);
          this.editingSnapshotId = null;
          this.render();
        },
        this.signal,
      );
      listen(
        cancelBtn,
        'click',
        () => {
          this.editingSnapshotId = null;
          this.render();
        },
        this.signal,
      );
      listen(
        input,
        'keydown',
        (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.editingSnapshotId = null;
            this.render();
          }
        },
        this.signal,
      );

      form.append(input, commitBtn, cancelBtn);
      main.append(form);
      li.append(node, main);
      return li;
    }

    const loadBtn = el('button', {
      class: 'snapshot-item__load',
      type: 'button',
      title: this.i18n.t('history.restore'),
    });
    const titleSpan = el('span', { class: 'snapshot-item__title' }, displayName);
    const meta = el('span', { class: 'snapshot-item__meta' });
    const lineText = this.i18n.t('history.linesCount', {
      count: countProgramLines(snapshot.program),
    });
    if (isNamed) {
      meta.append(
        el('span', { class: 'snapshot-item__time' }, formatSnapshotTimestamp(snapshot.createdAt)),
        el('span', {}, '·'),
        el('span', {}, lineText),
      );
    } else {
      meta.append(el('span', {}, lineText));
    }
    loadBtn.append(titleSpan, meta);
    listen(loadBtn, 'click', () => this.restoreSnapshot(snapshot), this.signal);

    const actions = el('div', { class: 'snapshot-item__actions' });
    const renameBtn = el(
      'button',
      {
        class: 'snapshot-action snapshot-action--rename',
        type: 'button',
        title: this.i18n.t('history.rename'),
        'aria-label': this.i18n.t('history.rename'),
      },
      svgIcon(ICON_RENAME),
    );
    listen(
      renameBtn,
      'click',
      () => {
        this.editingSnapshotId = snapshot.id;
        this.render();
        const editInput =
          this.dom.historyPanel.querySelector<HTMLInputElement>('.snapshot-item__input');
        if (editInput !== null) {
          editInput.focus();
          editInput.select();
        }
      },
      this.signal,
    );

    const deleteBtn = el(
      'button',
      {
        class: 'snapshot-action snapshot-action--delete',
        type: 'button',
        title: this.i18n.t('history.delete'),
        'aria-label': this.i18n.t('history.delete'),
      },
      svgIcon(ICON_DELETE),
    );
    listen(deleteBtn, 'click', () => this.requestDeleteSnapshot(snapshot), this.signal);

    actions.append(renameBtn, deleteBtn);
    main.append(loadBtn);
    li.append(node, main, actions);
    return li;
  }

  private render(): void {
    const visible = this.snapshots.getVisible(this.namedOnly);

    this.dom.historyCount.textContent = String(visible.length);
    this.dom.historyEmpty.textContent = this.i18n.t(
      this.namedOnly ? 'history.emptyNamed' : 'history.emptyAll',
    );
    this.dom.historyList.replaceChildren(...visible.map((s) => this.renderSnapshotItem(s)));

    const pendingId = this.deleteDialog.currentPendingId;
    if (this.deleteDialog.isOpen && pendingId !== null) {
      const target = this.snapshots.getById(pendingId);
      if (target !== null) {
        this.deleteDialog.syncName(getSnapshotDisplayName(target, this.i18n));
      }
    }
  }
}
