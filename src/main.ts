import './styles/main.css';

import { TM_VERSION } from './core/version';
import { detectLang, messages, type Lang, type Messages } from './i18n';
import type { HelpContent } from './i18n/types';
import { StepSound } from './ui/audio';
import { AppController, type UIMode } from './ui/controller';
import { debounce, el, mustFind } from './ui/dom';
import {
  loadState,
  saveProgram,
  saveSettings,
  saveTape,
  type AppSettings,
  type Theme,
} from './ui/storage';

/* ——— settings, language & theme ———————————————————————————————————— */

const html = document.documentElement;
const saved = loadState();
let settings: AppSettings = saved.settings;

let lang: Lang = detectLang(
  location.search,
  settings.lang,
  navigator.languages ?? [navigator.language],
);

function updateSettings(patch: Partial<AppSettings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
}

/* ——— DOM references —————————————————————————————————————————————— */

const dom = {
  skipLink: mustFind<HTMLAnchorElement>(document, '.skip-link'),
  title: mustFind(document, '#app-title'),
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
  labelProgram: mustFind(document, '#label-program'),
  labelTape: mustFind(document, '#label-tape'),
  settingsAnchor: mustFind(document, '#settings-anchor'),
  settingsButton: mustFind<HTMLButtonElement>(document, '#btn-settings'),
  settingsMenu: mustFind(document, '#settings-menu'),
  settingsTitle: mustFind(document, '#settings-title'),
  settingsClose: mustFind<HTMLButtonElement>(document, '#btn-settings-close'),
  settingLangLabel: mustFind(document, '#label-setting-lang'),
  langButton: mustFind<HTMLButtonElement>(document, '#btn-lang'),
  langLabel: mustFind(document, '#lang-label'),
  settingThemeLabel: mustFind(document, '#label-setting-theme'),
  themeButtons: Array.from(
    document.querySelectorAll<HTMLButtonElement>('#theme-group [data-theme-option]'),
  ),
  settingSoundLabel: mustFind(document, '#label-setting-sound'),
  soundButton: mustFind<HTMLButtonElement>(document, '#btn-sound'),
  soundLabel: mustFind(document, '#sound-label'),
  helpDialog: mustFind<HTMLDialogElement>(document, '#help-dialog'),
  helpTitle: mustFind(document, '#help-title'),
  helpBody: mustFind(document, '#help-body'),
  helpClose: mustFind<HTMLButtonElement>(document, '#btn-help-close'),
  helpBack: mustFind<HTMLButtonElement>(document, '#btn-help-back'),
};

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

/* ——— sound —————————————————————————————————————————————————————— */

const sound = new StepSound(settings.sound);

/* ——— i18n bootstrap ————————————————————————————————————————————— */

let m: Messages = messages(lang);
let activeHintButton: HTMLButtonElement | null = null;

/** Keep the hint bar in sync with the hovered/focused visible button. */
function syncHint(): void {
  if (
    activeHintButton === null ||
    activeHintButton.disabled ||
    activeHintButton.offsetParent === null
  ) {
    activeHintButton = null;
    dom.hint.textContent = '';
    return;
  }
  dom.hint.textContent = activeHintButton.dataset.hint ?? '';
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
  dom.soundLabel.textContent = onState ? m.settings.on : m.settings.off;
}

/** Apply all localized strings to the static markup. */
function localize(): void {
  html.lang = lang;
  document.title = m.appTitle;
  dom.title.textContent = m.appTitle;
  dom.version.textContent = `v${TM_VERSION}`;
  dom.skipLink.textContent = m.a11y.skipToProgram;

  dom.labelTape.textContent = m.tape;
  dom.labelProgram.textContent = m.program;
  dom.tapeInput.placeholder = m.hints.editTape;
  dom.programInput.placeholder = m.hints.editProgram;

  dom.tapeInput.setAttribute('aria-label', m.a11y.tapeLabel);
  dom.programInput.setAttribute('aria-label', m.a11y.programLabel);
  dom.programView.setAttribute('aria-label', m.a11y.programViewLabel);
  dom.tapeView.setAttribute('aria-label', m.a11y.tapeViewLabel);
  dom.log.setAttribute('aria-label', m.a11y.logLabel);

  const byId = (id: string): HTMLElement => mustFind(document, id);
  const text = (id: string, value: string): void => {
    byId(id).querySelector('.btn__text')!.textContent = value;
  };
  const title = (id: string, value: string): void => {
    byId(id).setAttribute('title', value);
  };
  const hint = (id: string, value: string): void => {
    byId(id).setAttribute('data-hint', value);
  };

  text('#btn-start', m.controls.start);
  text('#btn-totu4', m.controls.toTu4);
  text('#btn-copy', m.controls.copy);
  text('#btn-step', m.controls.step);
  text('#btn-quick', m.controls.quick);
  text('#btn-unmark', m.controls.unmark);
  text('#btn-edit', m.controls.backToEdit);
  text('#btn-edit-err', m.controls.backToEdit);

  title('#btn-start', m.hints.start);
  title('#btn-totu4', m.hints.toTu4);
  title('#btn-copy', m.hints.copy);
  title('#btn-step', m.hints.step);
  title('#btn-quick', m.hints.quick);
  title('#btn-unmark', m.hints.unmark);
  title('#btn-edit', m.hints.backToEdit);
  title('#btn-edit-err', m.hints.backToEdit);
  title('#btn-help', m.controls.help);

  hint('#btn-start', m.hints.start);
  hint('#btn-totu4', m.hints.toTu4);
  hint('#btn-copy', m.hints.copy);
  hint('#btn-step', m.hints.step);
  hint('#btn-quick', m.hints.quick);
  hint('#btn-unmark', m.hints.unmark);
  hint('#btn-edit', m.hints.backToEdit);
  hint('#btn-edit-err', m.hints.backToEdit);

  dom.settingsButton.setAttribute('title', m.controls.settings);
  dom.settingsButton.setAttribute('aria-label', m.controls.settings);
  dom.settingsTitle.textContent = m.settings.title;
  dom.settingsClose.setAttribute('title', m.controls.close);
  dom.settingsClose.setAttribute('aria-label', m.controls.close);

  dom.settingLangLabel.textContent = m.settings.language;
  dom.langLabel.textContent = m.settings.languageName;
  dom.langButton.setAttribute('title', m.controls.language);
  dom.langButton.setAttribute('aria-label', `${m.controls.language}: ${m.settings.languageName}`);

  dom.settingThemeLabel.textContent = m.settings.theme;
  byId('#btn-theme-auto').textContent = m.settings.themeAuto;
  byId('#btn-theme-light').textContent = m.settings.themeLight;
  byId('#btn-theme-dark').textContent = m.settings.themeDark;

  dom.settingSoundLabel.textContent = m.settings.sound;
  syncSoundControl();

  mustFind(document, '#btn-help').setAttribute('aria-label', m.controls.help);
  dom.helpClose.setAttribute('aria-label', m.controls.close);
  dom.helpClose.setAttribute('title', m.controls.close);

  renderHelp(m.help);
  syncQuickLabel();
  syncHint();
}

/* ——— settings menu ——————————————————————————————————————————————— */

function isSettingsOpen(): boolean {
  return !dom.settingsMenu.hidden;
}

function openSettings(): void {
  if (isSettingsOpen()) return;
  dom.settingsMenu.hidden = false;
  dom.settingsButton.setAttribute('aria-expanded', 'true');
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

function applyMode(mode: UIMode): void {
  dom.controls.dataset.mode = mode;
  document.body.dataset.mode = mode;
  dom.skipLink.href = mode === 'edit' ? '#input-program' : '#display-program';
  syncQuickLabel();
  syncHint();
  requestAnimationFrame(syncProgramOverflow);
}

/**
 * Step and Quick only make sense while the machine is running. Once it halts
 * (finishes or hits a runtime error) the buttons stay visible — the mode is
 * still "run" — but are disabled and dimmed instead of silently doing nothing.
 */
function syncRunState(isRunning: boolean): void {
  const step = mustFind<HTMLButtonElement>(document, '#btn-step');
  const quick = mustFind<HTMLButtonElement>(document, '#btn-quick');
  step.disabled = !isRunning;
  quick.disabled = !isRunning;
  step.setAttribute('aria-disabled', String(!isRunning));
  quick.setAttribute('aria-disabled', String(!isRunning));
  document.body.dataset.running = String(isRunning);
  syncQuickLabel();
}

function syncQuickLabel(): void {
  const quick = mustFind<HTMLButtonElement>(document, '#btn-quick');
  const running = controller.isQuickRunning;
  const atMax = controller.isQuickAtMaxSpeed;
  const label = !running ? m.controls.quick : atMax ? m.controls.slow : m.controls.faster;
  const hint = !running ? m.hints.quick : atMax ? m.hints.slow : m.hints.faster;
  quick.querySelector('.btn__text')!.textContent = label;
  quick.setAttribute('title', hint);
  quick.setAttribute('data-hint', hint);
  quick.setAttribute('aria-pressed', String(running));
  syncHint();
}

/* ——— wiring ————————————————————————————————————————————————————— */

const controller = new AppController({
  messages: m,
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
  onRunningChange: syncRunState,
  onProgramChange: saveProgram,
  onTapeChange: saveTape,
  onStepSound: () => sound.tick(),
});

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
on(mustFind(document, '#btn-step'), 'click', () => {
  sound.unlock();
  controller.step();
  syncQuickLabel();
});
on(mustFind(document, '#btn-quick'), 'click', () => {
  sound.unlock();
  controller.quick();
  syncQuickLabel();
});
on(mustFind(document, '#btn-unmark'), 'click', () => {
  controller.unmark();
  syncQuickLabel();
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
    history.replaceState(null, '', location.pathname + location.search);
  }
});

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
  lang = lang === 'ru' ? 'en' : 'ru';
  updateSettings({ lang });
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.set('lang', lang);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  m = messages(lang);
  controller.setMessages(m);
  localize();
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
    target instanceof HTMLInputElement ||
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

  const hasModifier = event.ctrlKey || event.metaKey;

  if (event.key === 'Enter' && !inEditable && (hasModifier || !inControl)) {
    if (controller.currentMode !== 'edit' || hasModifier) {
      event.preventDefault();
      sound.unlock();
      controller.handleEnter(hasModifier);
      syncQuickLabel();
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
    controller.handleSpace();
    syncQuickLabel();
    return;
  }
  if (event.key === 'Escape' && (!inEditable || controller.currentMode === 'error')) {
    controller.handleEscape();
    syncQuickLabel();
  }
});

// Hint bar: show the hint of the hovered/focused button.
const hintTargets = Array.from(dom.controls.querySelectorAll<HTMLButtonElement>('.btn'));
for (const button of hintTargets) {
  const show = (): void => {
    activeHintButton = button;
    syncHint();
  };
  const hide = (): void => {
    if (activeHintButton === button) activeHintButton = null;
    syncHint();
  };
  button.addEventListener('mouseenter', show);
  button.addEventListener('focus', show);
  button.addEventListener('mouseleave', hide);
  button.addEventListener('blur', hide);
}

// Hydrate saved draft, localize static DOM, and initialize toolbar state.
controller.hydrate(saved.program, saved.tape);
localize();
syncRunState(false);

// Bookmarks landing on `#help` open the in-app help dialog.
if (location.hash === '#help') openHelp();
