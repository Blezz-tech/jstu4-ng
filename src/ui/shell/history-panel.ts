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
  { readonly kind: 'idle' } | { readonly kind: 'saved' | 'autosaved'; readonly timestamp: number };

function countProgramLines(program: string): number {
  let count = 0;
  let hasContent = false;
  for (let i = 0; i < program.length; i += 1) {
    const code = program.charCodeAt(i);
    if (code === 10) {
      if (hasContent) count += 1;
      hasContent = false;
    } else if (code !== 13 && code !== 32 && code !== 9) {
      hasContent = true;
    }
  }
  if (hasContent) count += 1;
  return Math.max(count, 1);
}

function actionButton(
  className: string,
  label: string,
  iconPaths: readonly string[],
  type: 'button' | 'submit' = 'button',
): HTMLButtonElement {
  return el(
    'button',
    { class: className, type, title: label, 'aria-label': label },
    svgIcon(iconPaths),
  );
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
      onPersistError: () =>
        this.notifications.show('warning', (t) => t.t('log.snapshotQuotaExceeded')),
    });
    this.snapshots.subscribe((source) => {
      if (source !== 'storage') return;
      const missing = (id: string | null): boolean =>
        id !== null && this.snapshots.getById(id) === null;
      if (missing(this.activeSnapshotId)) this.activeSnapshotId = null;
      if (missing(this.deleteDialog.currentPendingId)) this.deleteDialog.close();
      if (missing(this.editingSnapshotId)) this.editingSnapshotId = null;
      if (this.editingSnapshotId === null) this.render();
    });

    this.autosave = new AutosaveTracker({
      store: this.snapshots,
      readState: () => ({ program: this.dom.programInput.value, tape: this.dom.tapeInput.value }),
      onAutosave: (created) => {
        this.activeSnapshotId = created.id;
        this.lastCleanSaveStatus = { kind: 'autosaved', timestamp: created.createdAt };
        this.syncSaveStatus();
        if (this.editingSnapshotId === null) this.render();
      },
      onDirtyChange: () => this.syncSaveStatus(),
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

    const bindInput = (
      field: HTMLInputElement | HTMLTextAreaElement,
      persist: DebouncedFn<[string]>,
    ): void => {
      listen(
        field,
        'input',
        () => {
          persist(field.value);
          this.autosave.markEdited(this.dom.programInput.value, this.dom.tapeInput.value);
        },
        signal,
      );
    };
    bindInput(this.dom.programInput, this.persistProgram);
    bindInput(this.dom.tapeInput, this.persistTape);

    // Delegate snapshot card interactions onto `#history-list` so re-rendering
    // never creates per-item event listeners.
    listen(this.dom.historyList, 'click', (event) => this.handleListClick(event), signal);
    listen(this.dom.historyList, 'submit', (event) => this.handleListSubmit(event), signal);
    listen(this.dom.historyList, 'keydown', (event) => this.handleListKeydown(event), signal);

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

  private handleListClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('.snapshot-action--cancel') !== null) {
      this.editingSnapshotId = null;
      this.render();
      return;
    }

    const id = target.closest<HTMLLIElement>('.snapshot-item')?.dataset.snapshotId;
    const snapshot = id ? this.snapshots.getById(id) : null;
    if (snapshot === null) return;

    if (target.closest('.snapshot-action--rename') !== null) {
      this.editingSnapshotId = snapshot.id;
      this.render();
      const input = this.dom.historyList.querySelector<HTMLInputElement>('.snapshot-item__input');
      input?.focus();
      input?.select();
    } else if (target.closest('.snapshot-action--delete') !== null) {
      this.requestDeleteSnapshot(snapshot);
    } else if (target.closest('.snapshot-item__load') !== null) {
      this.restoreSnapshot(snapshot);
    }
  }

  private handleListSubmit(event: SubmitEvent): void {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('snapshot-item__edit')) {
      return;
    }
    event.preventDefault();
    const id = form.closest<HTMLLIElement>('.snapshot-item')?.dataset.snapshotId;
    const trimmed =
      form.querySelector<HTMLInputElement>('.snapshot-item__input')?.value.trim() ?? '';
    if (id && trimmed !== '') this.snapshots.rename(id, trimmed);
    this.editingSnapshotId = null;
    this.render();
  }

  private handleListKeydown(event: KeyboardEvent): void {
    if (
      event.key === 'Escape' &&
      event.target instanceof HTMLInputElement &&
      event.target.classList.contains('snapshot-item__input')
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.editingSnapshotId = null;
      this.render();
    }
  }

  private syncNamedOnlyControl(): void {
    this.dom.namedOnlyButton.setAttribute('aria-checked', String(this.namedOnly));
  }

  private syncSaveStatus(): void {
    const status = this.dom.saveStatus;
    if (this.autosave.isDirty) {
      status.dataset.state = 'dirty';
      status.textContent = this.i18n.t('history.statusUnsaved');
      status.title = this.i18n.t('history.statusUnsavedHint');
      return;
    }
    status.title = '';
    if (this.lastCleanSaveStatus.kind === 'idle') {
      status.dataset.state = 'idle';
      status.textContent = '';
      return;
    }
    const key =
      this.lastCleanSaveStatus.kind === 'saved' ? 'history.statusSaved' : 'history.statusAutosaved';
    status.dataset.state = this.lastCleanSaveStatus.kind;
    status.textContent = this.i18n.t(key, {
      time: formatSaveClock(this.lastCleanSaveStatus.timestamp),
    });
  }

  private performDeleteSnapshot(id: string): void {
    if (!this.snapshots.remove(id)) return;
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
    const li = el('li', {
      class: 'snapshot-item',
      'data-snapshot-id': snapshot.id,
      'data-kind': snapshot.kind,
      'data-named': String(isNamed),
      'data-active': String(this.activeSnapshotId === snapshot.id),
    });
    const node = el('span', { class: 'snapshot-item__node', 'aria-hidden': 'true' });

    if (this.editingSnapshotId === snapshot.id) {
      const placeholder = this.i18n.t('history.renamePlaceholder');
      const input = el('input', {
        class: 'snapshot-item__input',
        type: 'text',
        placeholder,
        'aria-label': placeholder,
      });
      input.value = snapshot.customName ?? '';
      const form = el(
        'form',
        { class: 'snapshot-item__edit' },
        input,
        actionButton('snapshot-action', this.i18n.t('history.renameSave'), ICON_CHECK, 'submit'),
        actionButton(
          'snapshot-action snapshot-action--cancel',
          this.i18n.t('history.renameCancel'),
          ICON_CANCEL,
        ),
      );
      li.append(node, el('div', { class: 'snapshot-item__main' }, form));
      return li;
    }

    const lineText = this.i18n.t('history.linesCount', {
      count: countProgramLines(snapshot.program),
    });
    const meta = el(
      'span',
      { class: 'snapshot-item__meta' },
      ...(isNamed
        ? [el('span', {}, formatSnapshotTimestamp(snapshot.createdAt)), el('span', {}, '·')]
        : []),
      el('span', {}, lineText),
    );
    const loadBtn = el(
      'button',
      { class: 'snapshot-item__load', type: 'button', title: this.i18n.t('history.restore') },
      el('span', { class: 'snapshot-item__title' }, getSnapshotDisplayName(snapshot, this.i18n)),
      meta,
    );
    const actions = el(
      'div',
      { class: 'snapshot-item__actions' },
      actionButton(
        'snapshot-action snapshot-action--rename',
        this.i18n.t('history.rename'),
        ICON_RENAME,
      ),
      actionButton(
        'snapshot-action snapshot-action--delete',
        this.i18n.t('history.delete'),
        ICON_DELETE,
      ),
    );

    li.append(node, el('div', { class: 'snapshot-item__main' }, loadBtn), actions);
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
      if (target !== null) this.deleteDialog.syncName(getSnapshotDisplayName(target, this.i18n));
    }
  }
}
