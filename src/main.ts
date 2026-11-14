import './styles/main.css';

import { TM_VERSION } from './core/version';
import { bindDomI18n, createI18n, detectLang, type HelpContent } from './i18n';
import { StepSound } from './ui/audio';
import { AppController, type LogKind, type RunControlState, type UIMode } from './ui/controller';
import { debounce, el, mustFind } from './ui/dom';
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
  soundLabel: mustFind(document, '#sound-label'),
  minSpeedInput: mustFind<HTMLInputElement>(document, '#input-min-speed'),
  maxSpeedInput: mustFind<HTMLInputElement>(document, '#input-max-speed'),
  helpDialog: mustFind<HTMLDialogElement>(document, '#help-dialog'),
  helpTitle: mustFind(document, '#help-title'),
  helpBody: mustFind(document, '#help-body'),
  helpClose: mustFind<HTMLButtonElement>(document, '#btn-help-close'),
  helpBack: mustFind<HTMLButtonElement>(document, '#btn-help-back'),
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
let latestLogKind: LogKind | null = null;

function syncSidepanelBadge(): void {
  const showBadge = !sidepanelOpen && latestLogKind !== null;
  dom.sidepanelBadge.dataset.kind = showBadge ? (latestLogKind ?? '') : '';
}

function applySidepanel(open: boolean, persist = false): void {
  sidepanelOpen = open;
  dom.appShell.dataset.sidepanel = open ? 'open' : 'closed';
  dom.sidepanel.hidden = !open;
  dom.sidepanelButton.setAttribute('aria-expanded', String(open));
  dom.sidepanelBackdrop.hidden = !(open && isNarrowViewport());
  syncSidepanelBadge();
  if (persist) updateSettings({ sidepanelOpen: open });
  requestAnimationFrame(syncProgramOverflow);
}

applySidepanel(sidepanelOpen, false);
window.addEventListener('resize', () => {
  dom.sidepanelBackdrop.hidden = !(sidepanelOpen && isNarrowViewport());
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
  dom.soundLabel.textContent = i18n.t(onState ? 'settings.on' : 'settings.off');
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

  dom.maxSpeedInput.min = String(MIN_MAX_SPEED);
  dom.maxSpeedInput.max = String(MAX_MAX_SPEED);
  if (document.activeElement !== dom.maxSpeedInput) {
    dom.maxSpeedInput.value = String(maxSpeed);
  }
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
  onStepSound: () => sound.tick(),
});

// Declaratively bind all `data-i18n` / `data-i18n-attr` nodes, plus sync the
// dynamic controls whenever the active locale changes.
function syncDynamicI18n(): void {
  syncSoundControl();
  syncLangAria();
  renderHelp(i18n.help);
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

  if (sidepanelOpen && isNarrowViewport() && event.key === 'Escape') {
    event.preventDefault();
    applySidepanel(false, false);
    return;
  }

  const hasModifier = event.ctrlKey || event.metaKey;

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
