import './styles/main.css';

import { TM_VERSION } from './core/version';
import { bindDomI18n, createI18n, detectLang, type HelpContent } from './i18n';
import { StepSound } from './ui/audio';
import { AppController, type LogKind, type RunControlState, type UIMode } from './ui/controller';
import { debounce, el, mustFind } from './ui/dom';
import {
  AUTOSAVE_INTERVAL_MS,
  formatSnapshotTimestamp,
  getSnapshotDisplayName,
  SnapshotStore,
  type ProgramSnapshot,
} from './ui/history';
import {
  clampMaxSpeed,
  clampMinSpeed,
  DEFAULT_MAX_SPEED,
  DEFAULT_MIN_SPEED,
  formatSpeed,
  MAX_MAX_SPEED,
  MAX_MIN_SPEED,
  MIN_MAX_SPEED,
  MIN_MIN_SPEED,
  SPEED_STEP,
  zeroRatio,
} from './ui/speed';
import {
  loadState,
  saveProgram,
  saveSettings,
  saveTape,
  type AppSettings,
  type Theme,
} from './ui/storage';

/* ——— settings, i18n & theme ———————————————————————————————————————— */

const html = document.documentElement;
const saved = loadState();
let settings: AppSettings = saved.settings;

const i18n = createI18n(
  detectLang(location.search, settings.lang, navigator.languages ?? [navigator.language]),
);

function updateSettings(patch: Partial<AppSettings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
}

function safeReplaceState(url: string): void {
  try {
    history.replaceState(null, '', url);
  } catch {
    /* browsers may restrict history.replaceState on file:// origins */
  }
}

/* ——— DOM references —————————————————————————————————————————————— */

const dom = {
  appShell: mustFind(document, '#app-shell'),
  skipLink: mustFind<HTMLAnchorElement>(document, '.skip-link'),
  version: mustFind(document, '#app-version'),
  programInput: mustFind<HTMLTextAreaElement>(document, '#input-program'),
  tapeInput: mustFind<HTMLInputElement>(document, '#input-tape'),
  programView: mustFind(document, '#display-program'),
  programStack: mustFind(document, '.pane__stack'),
  tapeView: mustFind(document, '#display-tape'),
  log: mustFind(document, '#log'),
  stats: mustFind(document, '#stats'),
  controls: mustFind(document, '#controls'),
  hint: mustFind(document, '#hint'),
  stepBackButton: mustFind<HTMLButtonElement>(document, '#btn-step-back'),
  stepButton: mustFind<HTMLButtonElement>(document, '#btn-step'),
  runToggleButton: mustFind<HTMLButtonElement>(document, '#btn-run-toggle'),
  restartButton: mustFind<HTMLButtonElement>(document, '#btn-restart'),
  speedControl: mustFind(document, '#speed-control'),
  speedInput: mustFind<HTMLInputElement>(document, '#input-speed'),
  speedValue: mustFind(document, '#speed-value'),
  sidepanelButton: mustFind<HTMLButtonElement>(document, '#btn-sidepanel'),
  sidepanelClose: mustFind<HTMLButtonElement>(document, '#btn-sidepanel-close'),
  sidepanelBadge: mustFind(document, '#sidepanel-badge'),
  sidepanel: mustFind(document, '#sidepanel'),
  sidepanelBackdrop: mustFind(document, '#sidepanel-backdrop'),
  settingsAnchor: mustFind(document, '#settings-anchor'),
  settingsButton: mustFind<HTMLButtonElement>(document, '#btn-settings'),
  settingsMenu: mustFind(document, '#settings-menu'),
  settingsClose: mustFind<HTMLButtonElement>(document, '#btn-settings-close'),
  langButton: mustFind<HTMLButtonElement>(document, '#btn-lang'),
  themeButtons: Array.from(
    document.querySelectorAll<HTMLButtonElement>('#theme-group [data-theme-option]'),
  ),
  soundButton: mustFind<HTMLButtonElement>(document, '#btn-sound'),
  confirmDeleteSettingButton: mustFind<HTMLButtonElement>(document, '#btn-setting-confirm-delete'),
  minSpeedInput: mustFind<HTMLInputElement>(document, '#input-min-speed'),
  minSpeedDec: mustFind<HTMLButtonElement>(document, '#btn-min-speed-dec'),
  minSpeedInc: mustFind<HTMLButtonElement>(document, '#btn-min-speed-inc'),
  maxSpeedInput: mustFind<HTMLInputElement>(document, '#input-max-speed'),
  maxSpeedDec: mustFind<HTMLButtonElement>(document, '#btn-max-speed-dec'),
  maxSpeedInc: mustFind<HTMLButtonElement>(document, '#btn-max-speed-inc'),
  historyPanel: mustFind<HTMLElement>(document, '#history-panel'),
  historyBackdrop: mustFind<HTMLElement>(document, '#history-backdrop'),
  historyButton: mustFind<HTMLButtonElement>(document, '#btn-history'),
  historyClose: mustFind<HTMLButtonElement>(document, '#btn-history-close'),
  showAutosavesButton: mustFind<HTMLButtonElement>(document, '#btn-show-autosaves'),
  historyNamedList: mustFind<HTMLUListElement>(document, '#history-named-list'),
  historyNamedCount: mustFind<HTMLElement>(document, '#history-named-count'),
  historyUnnamedList: mustFind<HTMLUListElement>(document, '#history-unnamed-list'),
  historyUnnamedCount: mustFind<HTMLElement>(document, '#history-unnamed-count'),
  saveButton: mustFind<HTMLButtonElement>(document, '#btn-save'),
  helpDialog: mustFind<HTMLDialogElement>(document, '#help-dialog'),
  helpTitle: mustFind(document, '#help-title'),
  helpBody: mustFind(document, '#help-body'),
  helpClose: mustFind<HTMLButtonElement>(document, '#btn-help-close'),
  helpBack: mustFind<HTMLButtonElement>(document, '#btn-help-back'),
  tu4Dialog: mustFind<HTMLDialogElement>(document, '#tu4-dialog'),
  tu4Output: mustFind<HTMLTextAreaElement>(document, '#tu4-output'),
  tu4Status: mustFind(document, '#tu4-status'),
  tu4Close: mustFind<HTMLButtonElement>(document, '#btn-tu4-close'),
  tu4Copy: mustFind<HTMLButtonElement>(document, '#btn-tu4-copy'),
  tu4Done: mustFind<HTMLButtonElement>(document, '#btn-tu4-done'),
  deleteDialog: mustFind<HTMLDialogElement>(document, '#delete-snapshot-dialog'),
  deleteSnapshotName: mustFind<HTMLElement>(document, '#delete-snapshot-name'),
  skipDeleteConfirm: mustFind<HTMLInputElement>(document, '#chk-skip-delete-confirm'),
  deleteDialogClose: mustFind<HTMLButtonElement>(document, '#btn-delete-dialog-close'),
  deleteDialogCancel: mustFind<HTMLButtonElement>(document, '#btn-cancel-delete'),
  deleteDialogConfirm: mustFind<HTMLButtonElement>(document, '#btn-confirm-delete-snapshot'),
};

dom.version.textContent = `v${TM_VERSION}`;

function themeIsDark(): boolean {
  return (
    settings.theme === 'dark' ||
    (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

function applyTheme(): void {
  html.dataset.theme =
    settings.theme === 'auto' ? (themeIsDark() ? 'dark' : 'light') : settings.theme;
  html.dataset.themeChoice = settings.theme;
  for (const button of dom.themeButtons) {
    const active = button.dataset.themeOption === settings.theme;
    button.setAttribute('aria-pressed', String(active));
  }
}

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'auto') applyTheme();
});

/* ——— side panel (notifications, metrics, hover hints) ———————————— */

const NARROW_VIEWPORT_PX = 900;

function isNarrowViewport(): boolean {
  return window.innerWidth < NARROW_VIEWPORT_PX;
}

let sidepanelOpen = settings.sidepanelOpen ?? !isNarrowViewport();
let historyOpen = settings.historyOpen ?? false;
let latestLogKind: LogKind | null = null;

function syncSidepanelBadge(): void {
  const showBadge = !sidepanelOpen && latestLogKind !== null;
  dom.sidepanelBadge.dataset.kind = showBadge ? (latestLogKind ?? '') : '';
}

function applyHistoryPanel(open: boolean, persist = false): void {
  historyOpen = open;
  if (open && isNarrowViewport() && sidepanelOpen) {
    applySidepanel(false, false);
  }
  dom.appShell.dataset.history = open ? 'open' : 'closed';
  dom.historyPanel.hidden = !open;
  dom.historyButton.setAttribute('aria-expanded', String(open));
  dom.historyBackdrop.hidden = !(open && isNarrowViewport());
  if (persist) updateSettings({ historyOpen: open });
  requestAnimationFrame(syncProgramOverflow);
}

function applySidepanel(open: boolean, persist = false): void {
  sidepanelOpen = open;
  if (open && isNarrowViewport() && historyOpen) {
    applyHistoryPanel(false, false);
  }
  dom.appShell.dataset.sidepanel = open ? 'open' : 'closed';
  dom.sidepanel.hidden = !open;
  dom.sidepanelButton.setAttribute('aria-expanded', String(open));
  dom.sidepanelBackdrop.hidden = !(open && isNarrowViewport());
  syncSidepanelBadge();
  if (persist) updateSettings({ sidepanelOpen: open });
  requestAnimationFrame(syncProgramOverflow);
}

applySidepanel(sidepanelOpen, false);
applyHistoryPanel(historyOpen, false);
window.addEventListener('resize', () => {
  dom.sidepanelBackdrop.hidden = !(sidepanelOpen && isNarrowViewport());
  dom.historyBackdrop.hidden = !(historyOpen && isNarrowViewport());
});

/* ——— sound —————————————————————————————————————————————————————— */

const sound = new StepSound(settings.sound);

/* ——— dynamic UI sync ————————————————————————————————————————————— */

let activeHintTarget: HTMLElement | null = null;

/** Keep the side-panel hint card in sync with the hovered/focused visible control. */
function syncHint(): void {
  const isDisabled = activeHintTarget instanceof HTMLButtonElement && activeHintTarget.disabled;
  if (activeHintTarget === null || isDisabled || activeHintTarget.offsetParent === null) {
    activeHintTarget = null;
    dom.hint.textContent = '';
    return;
  }
  dom.hint.textContent = activeHintTarget.dataset.hint ?? '';
}

/** Show the bottom scroll fade only when the listing actually overflows below. */
function syncProgramOverflow(): void {
  const view = dom.programView;
  const hasMoreBelow = view.scrollHeight - view.scrollTop - view.clientHeight > 4;
  dom.programStack.dataset.overflowBottom = String(hasMoreBelow);
}

function syncSoundControl(): void {
  const onState = sound.isEnabled;
  dom.soundButton.setAttribute('aria-checked', String(onState));
  dom.soundButton.dataset.on = String(onState);
}

function syncLangAria(): void {
  dom.langButton.setAttribute(
    'aria-label',
    i18n.t('settings.languageAria', { language: i18n.meta.nativeName }),
  );
}

function syncSpeedControls(): void {
  const minSpeed = controller.currentMinSpeed;
  const maxSpeed = controller.currentMaxSpeed;
  const speed = controller.currentSpeed;
  const formatted = formatSpeed(speed);
  const direction = speed < 0 ? 'reverse' : speed === 0 ? 'stopped' : 'forward';

  dom.speedControl.dataset.direction = direction;
  dom.speedControl.style.setProperty('--zero-ratio', String(zeroRatio(minSpeed, maxSpeed)));

  dom.speedInput.min = String(minSpeed);
  dom.speedInput.max = String(maxSpeed);
  dom.speedInput.step = String(SPEED_STEP);
  dom.speedInput.value = String(speed);
  dom.speedInput.setAttribute('aria-valuetext', formatted);
  dom.speedValue.textContent = formatted;

  dom.minSpeedInput.min = String(MIN_MIN_SPEED);
  dom.minSpeedInput.max = String(MAX_MIN_SPEED);
  if (document.activeElement !== dom.minSpeedInput) {
    dom.minSpeedInput.value = String(minSpeed);
  }
  setButtonDisabled(dom.minSpeedDec, minSpeed <= MIN_MIN_SPEED);
  setButtonDisabled(dom.minSpeedInc, minSpeed >= MAX_MIN_SPEED);

  dom.maxSpeedInput.min = String(MIN_MAX_SPEED);
  dom.maxSpeedInput.max = String(MAX_MAX_SPEED);
  if (document.activeElement !== dom.maxSpeedInput) {
    dom.maxSpeedInput.value = String(maxSpeed);
  }
  setButtonDisabled(dom.maxSpeedDec, maxSpeed <= MIN_MAX_SPEED);
  setButtonDisabled(dom.maxSpeedInc, maxSpeed >= MAX_MAX_SPEED);
}

/* ——— settings menu ——————————————————————————————————————————————— */

function isSettingsOpen(): boolean {
  return !dom.settingsMenu.hidden;
}

function openSettings(): void {
  if (isSettingsOpen()) return;
  dom.settingsMenu.hidden = false;
  dom.settingsButton.setAttribute('aria-expanded', 'true');
  syncSpeedControls();
}

function closeSettings(restoreFocus = false): void {
  if (!isSettingsOpen()) return;
  dom.settingsMenu.hidden = true;
  dom.settingsButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) dom.settingsButton.focus();
}

/* ——— help dialog ——————————————————————————————————————————————— */

function renderHelp(content: HelpContent): void {
  dom.helpTitle.textContent = content.title;
  dom.helpBack.textContent = content.back;

  const fragment = document.createDocumentFragment();
  for (const section of content.sections) {
    fragment.append(el('h3', {}, section.title));
    for (const block of section.blocks) {
      switch (block.kind) {
        case 'p':
          fragment.append(el('p', {}, block.text));
          break;
        case 'rich': {
          const p = el('p');
          for (const part of block.parts) {
            if (typeof part === 'string') {
              p.append(document.createTextNode(part));
            } else {
              p.append(
                el(
                  'a',
                  { href: part.href, target: '_blank', rel: 'noopener noreferrer' },
                  part.label,
                ),
              );
            }
          }
          fragment.append(p);
          break;
        }
        case 'list': {
          const list = el('ul');
          for (const item of block.items) list.append(el('li', {}, item));
          fragment.append(list);
          break;
        }
        case 'code': {
          const pre = el('pre', { class: 'help__code' });
          pre.textContent = block.lines.join('\n');
          fragment.append(pre);
          break;
        }
      }
    }
  }
  dom.helpBody.replaceChildren(fragment);
}

function openHelp(): void {
  closeSettings(false);
  if (dom.helpDialog.open) return;
  dom.helpDialog.showModal();
  // Focus the dialog itself instead of the close button: screen readers
  // announce the heading, and no accidental focus ring appears on "×".
  dom.helpDialog.focus({ preventScroll: true });
}

function closeHelp(): void {
  if (dom.helpDialog.open) dom.helpDialog.close();
}

/* ——— TU4 export dialog ——————————————————————————————————————————— */

let tu4StatusTimer: number | null = null;

function clearTu4Status(): void {
  if (tu4StatusTimer !== null) {
    window.clearTimeout(tu4StatusTimer);
    tu4StatusTimer = null;
  }
  dom.tu4Status.textContent = '';
}

function openTu4Dialog(converted: string): void {
  closeSettings(false);
  closeHelp();
  clearTu4Status();
  dom.tu4Output.value = converted;
  dom.tu4Output.scrollTop = 0;
  if (!dom.tu4Dialog.open) dom.tu4Dialog.showModal();
  dom.tu4Dialog.focus({ preventScroll: true });
}

function closeTu4Dialog(): void {
  clearTu4Status();
  if (dom.tu4Dialog.open) dom.tu4Dialog.close();
}

async function copyTu4Output(): Promise<void> {
  const text = dom.tu4Output.value;
  if (text === '') return;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    dom.tu4Output.focus();
    dom.tu4Output.select();
    const copied = document.execCommand('copy');
    dom.tu4Output.setSelectionRange(0, 0);
    if (!copied) return;
  }

  clearTu4Status();
  dom.tu4Status.textContent = i18n.t('tu4Dialog.copied');
  tu4StatusTimer = window.setTimeout(() => {
    tu4StatusTimer = null;
    dom.tu4Status.textContent = '';
  }, 2500);
}

/* ——— toolbar state ——————————————————————————————————————————————— */

function setButtonDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.disabled = disabled;
  button.setAttribute('aria-disabled', String(disabled));
}

function applyMode(mode: UIMode): void {
  dom.controls.dataset.mode = mode;
  document.body.dataset.mode = mode;
  dom.skipLink.href = mode === 'edit' ? '#input-program' : '#display-program';
  syncRunToggleLabel();
  syncHint();
  requestAnimationFrame(syncProgramOverflow);
}

/**
 * Keep every run-mode button enabled strictly when its action makes sense:
 * - `←` (Step back): enabled whenever at least 1 step was performed (including after halt/error).
 * - `→` (Step): enabled while the machine has not halted.
 * - `▶` / `■` (Run / Stop): enabled while auto-running, or when stepping in the slider's direction is valid.
 * - `Сначала` (Restart): enabled after at least 1 step or after halt/error.
 */
function syncRunState(state: RunControlState): void {
  setButtonDisabled(dom.stepBackButton, !state.canStepBack);
  setButtonDisabled(dom.stepButton, !state.canStepForward);
  setButtonDisabled(dom.runToggleButton, !state.canAutoRun);
  setButtonDisabled(dom.restartButton, !state.canRestart);
  document.body.dataset.running = String(state.isRunning);
  syncRunToggleLabel();
}

function syncRunToggleLabel(): void {
  const toggle = dom.runToggleButton;
  const running = controller.isAutoRunning;
  const label = i18n.t(running ? 'controls.stop' : 'controls.run');
  const hint = i18n.t(running ? 'hints.stop' : 'hints.run');
  toggle.dataset.state = running ? 'stop' : 'play';
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', hint);
  toggle.setAttribute('data-hint', hint);
  toggle.setAttribute('aria-pressed', String(running));
  syncHint();
}

/* ——— wiring ————————————————————————————————————————————————————— */

const controller = new AppController({
  i18n,
  initialSpeed: settings.speed,
  initialMinSpeed: settings.minSpeed,
  initialMaxSpeed: settings.maxSpeed,
  elements: {
    programInput: dom.programInput,
    tapeInput: dom.tapeInput,
    programView: dom.programView,
    tapeView: dom.tapeView,
    log: dom.log,
    stats: dom.stats,
    controls: dom.controls,
  },
  onModeChange: (mode) => {
    applyMode(mode);
  },
  onRunStateChange: syncRunState,
  onLogChange: (kind) => {
    latestLogKind = kind;
    if (kind === 'error' && !sidepanelOpen) {
      applySidepanel(true, false);
    } else {
      syncSidepanelBadge();
    }
  },
  onProgramChange: saveProgram,
  onTapeChange: saveTape,
  onTu4Converted: openTu4Dialog,
  onStepSound: () => sound.tick(),
});

/* ——— version control (snapshots, rename, restore, delete) ———————— */

const SVG_NS = 'http://www.w3.org/2000/svg';

function createSvgIcon(paths: readonly string[], size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

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

const snapshots = new SnapshotStore();
let showAutosaves = settings.showAutosaves ?? true;
let confirmSnapshotDelete = settings.confirmSnapshotDelete ?? true;
let activeSnapshotId: string | null = null;
let editingSnapshotId: string | null = null;
let pendingDeleteId: string | null = null;

function syncShowAutosavesControl(): void {
  dom.showAutosavesButton.setAttribute('aria-checked', String(showAutosaves));
}

function syncConfirmDeleteControl(): void {
  dom.confirmDeleteSettingButton.setAttribute('aria-checked', String(confirmSnapshotDelete));
}

function countProgramLines(program: string): number {
  const nonEmpty = program.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  return Math.max(nonEmpty, 1);
}

function closeDeleteDialog(): void {
  pendingDeleteId = null;
  if (dom.deleteDialog.open) dom.deleteDialog.close();
}

function performDeleteSnapshot(id: string): void {
  const removed = snapshots.remove(id);
  if (!removed) return;
  if (activeSnapshotId === id) activeSnapshotId = null;
  if (editingSnapshotId === id) editingSnapshotId = null;
  controller.notifySnapshotDeleted();
  renderHistory();
}

function requestDeleteSnapshot(snapshot: ProgramSnapshot): void {
  if (!confirmSnapshotDelete) {
    performDeleteSnapshot(snapshot.id);
    return;
  }
  pendingDeleteId = snapshot.id;
  dom.deleteSnapshotName.textContent = getSnapshotDisplayName(snapshot, i18n);
  dom.skipDeleteConfirm.checked = false;
  closeSettings(false);
  if (!dom.deleteDialog.open) dom.deleteDialog.showModal();
  dom.deleteDialog.focus({ preventScroll: true });
}

function restoreSnapshot(snapshot: ProgramSnapshot): void {
  const currentProgram = dom.programInput.value;
  const currentTape = dom.tapeInput.value;
  if (
    currentProgram.trim() !== '' &&
    (currentProgram !== snapshot.program || currentTape !== snapshot.tape)
  ) {
    snapshots.maybeAutosave(currentProgram, currentTape);
  }
  activeSnapshotId = snapshot.id;
  editingSnapshotId = null;
  controller.loadSnapshot(snapshot.program, snapshot.tape, getSnapshotDisplayName(snapshot, i18n));
  renderHistory();
  if (isNarrowViewport()) applyHistoryPanel(false, false);
}

function createManualSnapshot(): void {
  const program = dom.programInput.value;
  const tape = dom.tapeInput.value;
  if (program.trim() === '') {
    controller.notifySnapshotEmpty();
    return;
  }
  const created = snapshots.create('manual', program, tape);
  activeSnapshotId = created.id;
  controller.notifySnapshotSaved();
  renderHistory();
}

function renderSnapshotItem(snapshot: ProgramSnapshot): HTMLLIElement {
  const isNamed = snapshot.customName !== null;
  const isEditing = editingSnapshotId === snapshot.id;
  const displayName = getSnapshotDisplayName(snapshot, i18n);

  const li = el('li', {
    class: 'snapshot-item',
    'data-snapshot-id': snapshot.id,
    'data-kind': snapshot.kind,
    'data-named': String(isNamed),
    'data-active': String(activeSnapshotId === snapshot.id),
  });

  const node = el('span', { class: 'snapshot-item__node', 'aria-hidden': 'true' });
  const main = el('div', { class: 'snapshot-item__main' });

  if (isEditing) {
    const form = el('form', { class: 'snapshot-item__edit' });
    const input = el('input', {
      class: 'snapshot-item__input',
      type: 'text',
      placeholder: i18n.t('history.renamePlaceholder'),
      'aria-label': i18n.t('history.renamePlaceholder'),
    });
    input.value = snapshot.customName ?? '';

    const commitBtn = el(
      'button',
      {
        class: 'snapshot-action',
        type: 'submit',
        title: i18n.t('history.renameSave'),
        'aria-label': i18n.t('history.renameSave'),
      },
      createSvgIcon(ICON_CHECK),
    );

    const cancelBtn = el(
      'button',
      {
        class: 'snapshot-action',
        type: 'button',
        title: i18n.t('history.renameCancel'),
        'aria-label': i18n.t('history.renameCancel'),
      },
      createSvgIcon(ICON_CANCEL),
    );

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const trimmed = input.value.trim();
      if (trimmed !== '') snapshots.rename(snapshot.id, trimmed);
      editingSnapshotId = null;
      renderHistory();
    });
    cancelBtn.addEventListener('click', () => {
      editingSnapshotId = null;
      renderHistory();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        editingSnapshotId = null;
        renderHistory();
      }
    });

    form.append(input, commitBtn, cancelBtn);
    main.append(form);
    li.append(node, main);
    return li;
  }

  const loadBtn = el('button', {
    class: 'snapshot-item__load',
    type: 'button',
    title: i18n.t('history.restore'),
  });
  const titleSpan = el('span', { class: 'snapshot-item__title' }, displayName);
  const meta = el('span', { class: 'snapshot-item__meta' });
  const lineText = i18n.t('history.linesCount', { count: countProgramLines(snapshot.program) });
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
  loadBtn.addEventListener('click', () => restoreSnapshot(snapshot));

  const actions = el('div', { class: 'snapshot-item__actions' });
  const renameBtn = el(
    'button',
    {
      class: 'snapshot-action snapshot-action--rename',
      type: 'button',
      title: i18n.t('history.rename'),
      'aria-label': i18n.t('history.rename'),
    },
    createSvgIcon(ICON_RENAME),
  );
  renameBtn.addEventListener('click', () => {
    editingSnapshotId = snapshot.id;
    renderHistory();
    const editInput = dom.historyPanel.querySelector<HTMLInputElement>('.snapshot-item__input');
    if (editInput !== null) {
      editInput.focus();
      editInput.select();
    }
  });

  const deleteBtn = el(
    'button',
    {
      class: 'snapshot-action snapshot-action--delete',
      type: 'button',
      title: i18n.t('history.delete'),
      'aria-label': i18n.t('history.delete'),
    },
    createSvgIcon(ICON_DELETE),
  );
  deleteBtn.addEventListener('click', () => requestDeleteSnapshot(snapshot));

  actions.append(renameBtn, deleteBtn);
  main.append(loadBtn);
  li.append(node, main, actions);
  return li;
}

function renderHistory(): void {
  const named = snapshots.getNamed();
  const unnamed = snapshots.getUnnamed(showAutosaves);

  dom.historyNamedCount.textContent = String(named.length);
  dom.historyUnnamedCount.textContent = String(unnamed.length);

  dom.historyNamedList.replaceChildren(...named.map(renderSnapshotItem));
  dom.historyUnnamedList.replaceChildren(...unnamed.map(renderSnapshotItem));

  if (dom.deleteDialog.open && pendingDeleteId !== null) {
    const target = snapshots.getById(pendingDeleteId);
    if (target !== null) {
      dom.deleteSnapshotName.textContent = getSnapshotDisplayName(target, i18n);
    }
  }
}

window.setInterval(() => {
  if (controller.currentMode !== 'edit') return;
  const created = snapshots.maybeAutosave(dom.programInput.value, dom.tapeInput.value);
  if (created !== null) {
    activeSnapshotId = created.id;
    if (editingSnapshotId === null) renderHistory();
  }
}, AUTOSAVE_INTERVAL_MS);

// Declaratively bind all `data-i18n` / `data-i18n-attr` nodes, plus sync the
// dynamic controls whenever the active locale changes.
function syncDynamicI18n(): void {
  syncSoundControl();
  syncShowAutosavesControl();
  syncConfirmDeleteControl();
  syncLangAria();
  renderHelp(i18n.help);
  renderHistory();
  syncRunToggleLabel();
  syncSpeedControls();
  syncHint();
}

bindDomI18n(document, i18n);
syncDynamicI18n();
i18n.subscribe(syncDynamicI18n);

/* ——— events ————————————————————————————————————————————————————— */

const on = <K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void => target.addEventListener(type, handler as EventListener);

on(mustFind(document, '#btn-start'), 'click', () => {
  sound.unlock();
  controller.start();
});
on(dom.stepBackButton, 'click', () => {
  sound.unlock();
  controller.stepBack();
  syncRunToggleLabel();
});
on(dom.stepButton, 'click', () => {
  sound.unlock();
  controller.step();
  syncRunToggleLabel();
});
on(dom.runToggleButton, 'click', () => {
  sound.unlock();
  controller.toggleAutoRun();
  syncRunToggleLabel();
});
on(dom.restartButton, 'click', () => {
  controller.restart();
  syncRunToggleLabel();
});

on(dom.speedInput, 'pointerdown', () => controller.beginSpeedDrag());
window.addEventListener('pointerup', () => controller.endSpeedDrag());
window.addEventListener('pointercancel', () => controller.endSpeedDrag());
on(dom.speedInput, 'change', () => controller.endSpeedDrag());
on(dom.speedInput, 'input', () => {
  const nextSpeed = controller.setSpeed(Number(dom.speedInput.value));
  updateSettings({ speed: nextSpeed });
  syncSpeedControls();
});

on(mustFind(document, '#btn-unmark'), 'click', () => {
  controller.unmark();
  syncRunToggleLabel();
});
on(mustFind(document, '#btn-edit'), 'click', () => controller.backToEdit('program'));
on(mustFind(document, '#btn-edit-err'), 'click', () => controller.backToEdit('program'));
on(mustFind(document, '#btn-copy'), 'click', () => void controller.copyProgram());
on(dom.saveButton, 'click', () => createManualSnapshot());
on(mustFind(document, '#btn-totu4'), 'click', () => controller.toTu4());
on(mustFind(document, '#btn-help'), 'click', () => openHelp());
on(dom.helpBack, 'click', () => closeHelp());
on(dom.helpClose, 'click', () => closeHelp());
on(dom.helpDialog, 'click', (event) => {
  // A click on the backdrop (outside the inner card) closes the dialog.
  if (event.target === dom.helpDialog) closeHelp();
});
on(dom.helpDialog, 'close', () => {
  if (location.hash === '#help') {
    safeReplaceState(location.pathname + location.search);
  }
});
on(dom.tu4Close, 'click', () => closeTu4Dialog());
on(dom.tu4Done, 'click', () => closeTu4Dialog());
on(dom.tu4Copy, 'click', () => void copyTu4Output());
on(dom.tu4Dialog, 'click', (event) => {
  if (event.target === dom.tu4Dialog) closeTu4Dialog();
});
on(dom.tu4Dialog, 'close', () => clearTu4Status());

on(dom.historyButton, 'click', () => applyHistoryPanel(!historyOpen, true));
on(dom.historyClose, 'click', () => {
  applyHistoryPanel(false, true);
  dom.historyButton.focus();
});
on(dom.historyBackdrop, 'click', () => applyHistoryPanel(false, false));
on(dom.showAutosavesButton, 'click', () => {
  showAutosaves = !showAutosaves;
  updateSettings({ showAutosaves });
  syncShowAutosavesControl();
  renderHistory();
});

on(dom.deleteDialogClose, 'click', () => closeDeleteDialog());
on(dom.deleteDialogCancel, 'click', () => closeDeleteDialog());
on(dom.deleteDialog, 'click', (event) => {
  if (event.target === dom.deleteDialog) closeDeleteDialog();
});
on(dom.deleteDialog, 'close', () => {
  pendingDeleteId = null;
});
on(dom.deleteDialogConfirm, 'click', () => {
  if (dom.skipDeleteConfirm.checked) {
    confirmSnapshotDelete = false;
    updateSettings({ confirmSnapshotDelete: false });
    syncConfirmDeleteControl();
  }
  const id = pendingDeleteId;
  closeDeleteDialog();
  if (id !== null) performDeleteSnapshot(id);
});

on(dom.sidepanelButton, 'click', () => applySidepanel(!sidepanelOpen, true));
on(dom.sidepanelClose, 'click', () => {
  applySidepanel(false, true);
  dom.sidepanelButton.focus();
});
on(dom.sidepanelBackdrop, 'click', () => applySidepanel(false, false));

on(dom.settingsButton, 'click', () => {
  if (isSettingsOpen()) closeSettings(false);
  else openSettings();
});
on(dom.settingsClose, 'click', () => closeSettings(true));
document.addEventListener('pointerdown', (event) => {
  if (!isSettingsOpen()) return;
  const target = event.target;
  if (target instanceof Node && !dom.settingsAnchor.contains(target)) {
    closeSettings(false);
  }
});

on(dom.langButton, 'click', () => {
  const next = i18n.toggleLocale();
  updateSettings({ lang: next });
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.set('lang', next);
    safeReplaceState(url.pathname + url.search + url.hash);
  }
});

for (const button of dom.themeButtons) {
  on(button, 'click', () => {
    const choice = button.dataset.themeOption;
    if (choice !== 'auto' && choice !== 'light' && choice !== 'dark') return;
    const nextTheme: Theme = choice;
    updateSettings({ theme: nextTheme });
    applyTheme();
  });
}

on(dom.soundButton, 'click', () => {
  const next = !sound.isEnabled;
  sound.setEnabled(next);
  updateSettings({ sound: next });
  syncSoundControl();
  if (next) {
    sound.unlock();
    sound.tick();
  }
});

on(dom.confirmDeleteSettingButton, 'click', () => {
  confirmSnapshotDelete = !confirmSnapshotDelete;
  updateSettings({ confirmSnapshotDelete });
  syncConfirmDeleteControl();
});

function applyMinSpeedValue(rawValue: string, normalizeInput: boolean): void {
  const trimmed = rawValue.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || trimmed === '' || trimmed === '-') {
    if (!normalizeInput) return;
    const result = controller.setMinSpeed(DEFAULT_MIN_SPEED);
    updateSettings({ minSpeed: result.minSpeed, speed: result.speed });
    dom.minSpeedInput.value = String(result.minSpeed);
    syncSpeedControls();
    return;
  }

  if (!normalizeInput && (parsed < MIN_MIN_SPEED || parsed > MAX_MIN_SPEED)) return;

  const result = controller.setMinSpeed(clampMinSpeed(parsed));
  updateSettings({ minSpeed: result.minSpeed, speed: result.speed });
  if (normalizeInput) dom.minSpeedInput.value = String(result.minSpeed);
  syncSpeedControls();
}

function applyMaxSpeedValue(rawValue: string, normalizeInput: boolean): void {
  const trimmed = rawValue.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || trimmed === '') {
    if (!normalizeInput) return;
    const result = controller.setMaxSpeed(DEFAULT_MAX_SPEED);
    updateSettings({ maxSpeed: result.maxSpeed, speed: result.speed });
    dom.maxSpeedInput.value = String(result.maxSpeed);
    syncSpeedControls();
    return;
  }

  if (!normalizeInput && (parsed < MIN_MAX_SPEED || parsed > MAX_MAX_SPEED)) return;

  const result = controller.setMaxSpeed(clampMaxSpeed(parsed));
  updateSettings({ maxSpeed: result.maxSpeed, speed: result.speed });
  if (normalizeInput) dom.maxSpeedInput.value = String(result.maxSpeed);
  syncSpeedControls();
}

on(dom.minSpeedInput, 'input', () => applyMinSpeedValue(dom.minSpeedInput.value, false));
on(dom.minSpeedInput, 'change', () => applyMinSpeedValue(dom.minSpeedInput.value, true));
on(dom.minSpeedInput, 'blur', () => applyMinSpeedValue(dom.minSpeedInput.value, true));

on(dom.maxSpeedInput, 'input', () => applyMaxSpeedValue(dom.maxSpeedInput.value, false));
on(dom.maxSpeedInput, 'change', () => applyMaxSpeedValue(dom.maxSpeedInput.value, true));
on(dom.maxSpeedInput, 'blur', () => applyMaxSpeedValue(dom.maxSpeedInput.value, true));

function stepMinSpeed(delta: number): void {
  const result = controller.setMinSpeed(clampMinSpeed(controller.currentMinSpeed + delta));
  updateSettings({ minSpeed: result.minSpeed, speed: result.speed });
  dom.minSpeedInput.value = String(result.minSpeed);
  syncSpeedControls();
}

function stepMaxSpeed(delta: number): void {
  const result = controller.setMaxSpeed(clampMaxSpeed(controller.currentMaxSpeed + delta));
  updateSettings({ maxSpeed: result.maxSpeed, speed: result.speed });
  dom.maxSpeedInput.value = String(result.maxSpeed);
  syncSpeedControls();
}

function bindStepperButton(button: HTMLButtonElement, onStep: () => void): void {
  let delayId: number | null = null;
  let repeatId: number | null = null;
  let didRepeat = false;

  const stop = (): void => {
    if (delayId !== null) {
      window.clearTimeout(delayId);
      delayId = null;
    }
    if (repeatId !== null) {
      window.clearInterval(repeatId);
      repeatId = null;
    }
  };

  on(button, 'pointerdown', (event) => {
    if (event.button !== 0 || button.disabled) return;
    didRepeat = false;
    stop();
    delayId = window.setTimeout(() => {
      delayId = null;
      if (button.disabled) return;
      didRepeat = true;
      onStep();
      repeatId = window.setInterval(() => {
        if (button.disabled) {
          stop();
          return;
        }
        onStep();
      }, 65);
    }, 380);
  });

  on(button, 'pointerup', stop);
  on(button, 'pointercancel', stop);
  on(button, 'pointerleave', stop);
  on(button, 'blur', stop);

  on(button, 'click', () => {
    stop();
    if (didRepeat) {
      didRepeat = false;
      return;
    }
    if (!button.disabled) onStep();
  });
}

bindStepperButton(dom.minSpeedDec, () => stepMinSpeed(-1));
bindStepperButton(dom.minSpeedInc, () => stepMinSpeed(1));
bindStepperButton(dom.maxSpeedDec, () => stepMaxSpeed(-1));
bindStepperButton(dom.maxSpeedInc, () => stepMaxSpeed(1));

// Persist the draft as the user types (debounced).
const persistProgram = debounce((text: string) => saveProgram(text), 400);
const persistTape = debounce((text: string) => saveTape(text), 400);

on(dom.programInput, 'input', () => persistProgram(dom.programInput.value));
on(dom.tapeInput, 'input', () => persistTape(dom.tapeInput.value));
window.addEventListener('pagehide', () => {
  saveProgram(dom.programInput.value);
  saveTape(dom.tapeInput.value);
});

on(dom.tapeInput, 'keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sound.unlock();
    controller.start();
  }
});

// Clicking the tape field in error mode leaves error mode (matching v2.3).
on(dom.tapeInput, 'click', () => {
  if (controller.currentMode !== 'edit') {
    controller.backToEdit('tape');
  }
});

// Ctrl+Enter anywhere in the editor runs the program.
on(dom.programInput, 'keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sound.unlock();
    controller.start();
  }
});

// Clicks on the read-only panes behave like "Back to edit", unless the user
// just dragged a text selection to copy from the listing or tape.
on(dom.programView, 'click', () => {
  if (window.getSelection()?.toString()) return;
  controller.backToEdit('program');
});
on(dom.tapeView, 'click', () => {
  if (window.getSelection()?.toString()) return;
  controller.backToEdit('tape');
});

on(dom.programView, 'scroll', syncProgramOverflow);
window.addEventListener('resize', syncProgramOverflow);

on(document, 'keydown', (event) => {
  if (event.defaultPrevented) return;

  const target = event.target;
  const inEditable =
    (target instanceof HTMLInputElement && target.type !== 'range') ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);

  // Enter and Space are the activation keys of buttons and links: the global
  // shortcuts must not hijack them (e.g. pressing Enter on a focused button
  // must click that button, not start the machine).
  const inControl =
    target instanceof Element &&
    target.closest('button, a, [role="button"], select, summary') !== null;

  if (dom.tu4Dialog.open || dom.deleteDialog.open) return;

  if (event.key === 'F1' || (event.key === '?' && event.shiftKey && !inEditable)) {
    event.preventDefault();
    openHelp();
    return;
  }

  if (dom.helpDialog.open) return;

  if (isSettingsOpen()) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings(true);
    }
    return;
  }

  if (historyOpen && isNarrowViewport() && event.key === 'Escape') {
    event.preventDefault();
    applyHistoryPanel(false, false);
    return;
  }

  if (sidepanelOpen && isNarrowViewport() && event.key === 'Escape') {
    event.preventDefault();
    applySidepanel(false, false);
    return;
  }

  const hasModifier = event.ctrlKey || event.metaKey;

  if (
    hasModifier &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 's' &&
    controller.currentMode === 'edit'
  ) {
    event.preventDefault();
    createManualSnapshot();
    return;
  }

  if (event.key === 'Enter' && !inEditable && (hasModifier || !inControl)) {
    if (controller.currentMode !== 'edit' || hasModifier) {
      event.preventDefault();
      sound.unlock();
      controller.handleEnter(hasModifier);
      syncRunToggleLabel();
    }
    return;
  }
  if (
    event.key === ' ' &&
    !inEditable &&
    !inControl &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    sound.unlock();
    if (event.shiftKey) controller.handleShiftSpace();
    else controller.handleSpace();
    syncRunToggleLabel();
    return;
  }
  if (event.key === 'Escape' && (!inEditable || controller.currentMode === 'error')) {
    controller.handleEscape();
    syncRunToggleLabel();
  }
});

// Hint card in the side panel: show the hint of the hovered/focused toolbar control.
const hintTargets = Array.from(dom.controls.querySelectorAll<HTMLElement>('.btn, .speed-control'));
for (const control of hintTargets) {
  const show = (): void => {
    activeHintTarget = control;
    syncHint();
  };
  const hide = (): void => {
    if (activeHintTarget === control) activeHintTarget = null;
    syncHint();
  };
  control.addEventListener('mouseenter', show);
  control.addEventListener('focusin', show);
  control.addEventListener('mouseleave', hide);
  control.addEventListener('focusout', hide);
}

// Hydrate saved draft and initialize toolbar state.
controller.hydrate(saved.program, saved.tape);
syncRunState({
  isRunning: false,
  isAutoRunning: false,
  canStepForward: false,
  canStepBack: false,
  canAutoRun: false,
  canRestart: false,
  speed: controller.currentSpeed,
});

// Bookmarks landing on `#help` open the in-app help dialog.
if (location.hash === '#help') openHelp();
