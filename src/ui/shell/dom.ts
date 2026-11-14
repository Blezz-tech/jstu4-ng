import { mustFind } from '../dom';

/** Strongly typed collection of all DOM nodes wired by the application shell. */
export interface AppDom {
  readonly appShell: HTMLElement;
  readonly skipLink: HTMLAnchorElement;
  readonly version: HTMLElement;
  readonly programInput: HTMLTextAreaElement;
  readonly tapeInput: HTMLInputElement;
  readonly programView: HTMLElement;
  readonly programStack: HTMLElement;
  readonly tapeView: HTMLElement;
  readonly log: HTMLElement;
  readonly stats: HTMLElement;
  readonly controls: HTMLElement;
  readonly hint: HTMLElement;
  readonly startButton: HTMLButtonElement;
  readonly stepBackButton: HTMLButtonElement;
  readonly stepButton: HTMLButtonElement;
  readonly runToggleButton: HTMLButtonElement;
  readonly restartButton: HTMLButtonElement;
  readonly unmarkButton: HTMLButtonElement;
  readonly editButton: HTMLButtonElement;
  readonly editErrButton: HTMLButtonElement;
  readonly copyButton: HTMLButtonElement;
  readonly toTu4Button: HTMLButtonElement;
  readonly helpButton: HTMLButtonElement;
  readonly speedControl: HTMLElement;
  readonly speedInput: HTMLInputElement;
  readonly speedValue: HTMLElement;
  readonly sidepanelButton: HTMLButtonElement;
  readonly sidepanelClose: HTMLButtonElement;
  readonly sidepanelBadge: HTMLElement;
  readonly sidepanel: HTMLElement;
  readonly sidepanelBackdrop: HTMLElement;
  readonly settingsAnchor: HTMLElement;
  readonly settingsButton: HTMLButtonElement;
  readonly settingsMenu: HTMLElement;
  readonly settingsClose: HTMLButtonElement;
  readonly langButton: HTMLButtonElement;
  readonly themeButtons: readonly HTMLButtonElement[];
  readonly soundButton: HTMLButtonElement;
  readonly confirmDeleteSettingButton: HTMLButtonElement;
  readonly minSpeedInput: HTMLInputElement;
  readonly minSpeedDec: HTMLButtonElement;
  readonly minSpeedInc: HTMLButtonElement;
  readonly maxSpeedInput: HTMLInputElement;
  readonly maxSpeedDec: HTMLButtonElement;
  readonly maxSpeedInc: HTMLButtonElement;
  readonly historyPanel: HTMLElement;
  readonly historyBackdrop: HTMLElement;
  readonly historyButton: HTMLButtonElement;
  readonly historyClose: HTMLButtonElement;
  readonly namedOnlyButton: HTMLButtonElement;
  readonly historyList: HTMLUListElement;
  readonly historyCount: HTMLElement;
  readonly historyEmpty: HTMLElement;
  readonly saveButton: HTMLButtonElement;
  readonly saveStatus: HTMLElement;
  readonly helpDialog: HTMLDialogElement;
  readonly helpTitle: HTMLElement;
  readonly helpBody: HTMLElement;
  readonly helpClose: HTMLButtonElement;
  readonly helpBack: HTMLButtonElement;
  readonly tu4Dialog: HTMLDialogElement;
  readonly tu4Output: HTMLTextAreaElement;
  readonly tu4Status: HTMLElement;
  readonly tu4Close: HTMLButtonElement;
  readonly tu4Copy: HTMLButtonElement;
  readonly tu4Done: HTMLButtonElement;
  readonly deleteDialog: HTMLDialogElement;
  readonly deleteSnapshotName: HTMLElement;
  readonly skipDeleteConfirm: HTMLInputElement;
  readonly deleteDialogClose: HTMLButtonElement;
  readonly deleteDialogCancel: HTMLButtonElement;
  readonly deleteDialogConfirm: HTMLButtonElement;
}

export function queryAppDom(root: ParentNode): AppDom {
  return {
    appShell: mustFind(root, '#app-shell'),
    skipLink: mustFind<HTMLAnchorElement>(root, '.skip-link'),
    version: mustFind(root, '#app-version'),
    programInput: mustFind<HTMLTextAreaElement>(root, '#input-program'),
    tapeInput: mustFind<HTMLInputElement>(root, '#input-tape'),
    programView: mustFind(root, '#display-program'),
    programStack: mustFind(root, '.pane__stack'),
    tapeView: mustFind(root, '#display-tape'),
    log: mustFind(root, '#log'),
    stats: mustFind(root, '#stats'),
    controls: mustFind(root, '#controls'),
    hint: mustFind(root, '#hint'),
    startButton: mustFind<HTMLButtonElement>(root, '#btn-start'),
    stepBackButton: mustFind<HTMLButtonElement>(root, '#btn-step-back'),
    stepButton: mustFind<HTMLButtonElement>(root, '#btn-step'),
    runToggleButton: mustFind<HTMLButtonElement>(root, '#btn-run-toggle'),
    restartButton: mustFind<HTMLButtonElement>(root, '#btn-restart'),
    unmarkButton: mustFind<HTMLButtonElement>(root, '#btn-unmark'),
    editButton: mustFind<HTMLButtonElement>(root, '#btn-edit'),
    editErrButton: mustFind<HTMLButtonElement>(root, '#btn-edit-err'),
    copyButton: mustFind<HTMLButtonElement>(root, '#btn-copy'),
    toTu4Button: mustFind<HTMLButtonElement>(root, '#btn-totu4'),
    helpButton: mustFind<HTMLButtonElement>(root, '#btn-help'),
    speedControl: mustFind(root, '#speed-control'),
    speedInput: mustFind<HTMLInputElement>(root, '#input-speed'),
    speedValue: mustFind(root, '#speed-value'),
    sidepanelButton: mustFind<HTMLButtonElement>(root, '#btn-sidepanel'),
    sidepanelClose: mustFind<HTMLButtonElement>(root, '#btn-sidepanel-close'),
    sidepanelBadge: mustFind(root, '#sidepanel-badge'),
    sidepanel: mustFind(root, '#sidepanel'),
    sidepanelBackdrop: mustFind(root, '#sidepanel-backdrop'),
    settingsAnchor: mustFind(root, '#settings-anchor'),
    settingsButton: mustFind<HTMLButtonElement>(root, '#btn-settings'),
    settingsMenu: mustFind(root, '#settings-menu'),
    settingsClose: mustFind<HTMLButtonElement>(root, '#btn-settings-close'),
    langButton: mustFind<HTMLButtonElement>(root, '#btn-lang'),
    themeButtons: Array.from(
      root.querySelectorAll<HTMLButtonElement>('#theme-group [data-theme-option]'),
    ),
    soundButton: mustFind<HTMLButtonElement>(root, '#btn-sound'),
    confirmDeleteSettingButton: mustFind<HTMLButtonElement>(root, '#btn-setting-confirm-delete'),
    minSpeedInput: mustFind<HTMLInputElement>(root, '#input-min-speed'),
    minSpeedDec: mustFind<HTMLButtonElement>(root, '#btn-min-speed-dec'),
    minSpeedInc: mustFind<HTMLButtonElement>(root, '#btn-min-speed-inc'),
    maxSpeedInput: mustFind<HTMLInputElement>(root, '#input-max-speed'),
    maxSpeedDec: mustFind<HTMLButtonElement>(root, '#btn-max-speed-dec'),
    maxSpeedInc: mustFind<HTMLButtonElement>(root, '#btn-max-speed-inc'),
    historyPanel: mustFind<HTMLElement>(root, '#history-panel'),
    historyBackdrop: mustFind<HTMLElement>(root, '#history-backdrop'),
    historyButton: mustFind<HTMLButtonElement>(root, '#btn-history'),
    historyClose: mustFind<HTMLButtonElement>(root, '#btn-history-close'),
    namedOnlyButton: mustFind<HTMLButtonElement>(root, '#btn-named-only'),
    historyList: mustFind<HTMLUListElement>(root, '#history-list'),
    historyCount: mustFind<HTMLElement>(root, '#history-count'),
    historyEmpty: mustFind<HTMLElement>(root, '#history-empty'),
    saveButton: mustFind<HTMLButtonElement>(root, '#btn-save'),
    saveStatus: mustFind<HTMLElement>(root, '#save-status'),
    helpDialog: mustFind<HTMLDialogElement>(root, '#help-dialog'),
    helpTitle: mustFind(root, '#help-title'),
    helpBody: mustFind(root, '#help-body'),
    helpClose: mustFind<HTMLButtonElement>(root, '#btn-help-close'),
    helpBack: mustFind<HTMLButtonElement>(root, '#btn-help-back'),
    tu4Dialog: mustFind<HTMLDialogElement>(root, '#tu4-dialog'),
    tu4Output: mustFind<HTMLTextAreaElement>(root, '#tu4-output'),
    tu4Status: mustFind(root, '#tu4-status'),
    tu4Close: mustFind<HTMLButtonElement>(root, '#btn-tu4-close'),
    tu4Copy: mustFind<HTMLButtonElement>(root, '#btn-tu4-copy'),
    tu4Done: mustFind<HTMLButtonElement>(root, '#btn-tu4-done'),
    deleteDialog: mustFind<HTMLDialogElement>(root, '#delete-snapshot-dialog'),
    deleteSnapshotName: mustFind<HTMLElement>(root, '#delete-snapshot-name'),
    skipDeleteConfirm: mustFind<HTMLInputElement>(root, '#chk-skip-delete-confirm'),
    deleteDialogClose: mustFind<HTMLButtonElement>(root, '#btn-delete-dialog-close'),
    deleteDialogCancel: mustFind<HTMLButtonElement>(root, '#btn-cancel-delete'),
    deleteDialogConfirm: mustFind<HTMLButtonElement>(root, '#btn-confirm-delete-snapshot'),
  };
}

export function setButtonDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.disabled = disabled;
  button.setAttribute('aria-disabled', String(disabled));
}

export function safeReplaceState(url: string): void {
  try {
    history.replaceState(null, '', url);
  } catch {
    /* browsers may restrict history.replaceState on file:// origins */
  }
}

/** Attach an event listener bound to an `AbortSignal` for automatic cleanup on `dispose()`. */
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  signal: AbortSignal,
): void;
export function listen<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  signal: AbortSignal,
): void;
export function listen(
  target: EventTarget,
  type: string,
  handler: (event: never) => void,
  signal: AbortSignal,
): void {
  target.addEventListener(type, handler as EventListener, { signal });
}
