import './styles/main.css';

import { TM_VERSION } from './core/version';
import { detectLang, messages, type Lang, type Messages } from './i18n';
import { mustFind, debounce, el } from './ui/dom';
import { AppController, type UIMode } from './ui/controller';
import { StepSound } from './ui/audio';
import {
  loadState,
  saveLang,
  saveProgram,
  saveSound,
  saveTape,
  saveTheme,
  type Theme,
} from './ui/storage';
import type { HelpContent } from './i18n/types';

/* ——— language & theme ————————————————————————————————————————————— */

const html = document.documentElement;
const saved = loadState();

let lang: Lang = detectLang(
  location.search,
  saved.lang,
  navigator.languages ?? [navigator.language],
);

const themeCandidates: readonly Theme[] = ['auto', 'light', 'dark'];
let theme: Theme = saved.theme;

function themeIsDark(): boolean {
  return (
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

function applyTheme(): void {
  html.dataset.theme = theme === 'auto' ? (themeIsDark() ? 'dark' : 'light') : theme;
  html.dataset.themeChoice = theme;
  mustFind<HTMLButtonElement>(document, '#btn-theme').setAttribute(
    'aria-pressed',
    String(themeIsDark()),
  );
}

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (theme === 'auto') applyTheme();
});

/* ——— DOM references —————————————————————————————————————————————— */

const dom = {
  title: mustFind(document, '#app-title'),
  version: mustFind(document, '#app-version'),
  programInput: mustFind<HTMLTextAreaElement>(document, '#input-program'),
  tapeInput: mustFind<HTMLInputElement>(document, '#input-tape'),
  programView: mustFind(document, '#display-program'),
  tapeView: mustFind(document, '#display-tape'),
  log: mustFind(document, '#log'),
  stats: mustFind(document, '#stats'),
  controls: mustFind(document, '#controls'),
  hint: mustFind(document, '#hint'),
  labelProgram: mustFind(document, '#label-program'),
  labelTape: mustFind(document, '#label-tape'),
  helpDialog: mustFind<HTMLDialogElement>(document, '#help-dialog'),
  helpTitle: mustFind(document, '#help-title'),
  helpBody: mustFind(document, '#help-body'),
  helpBack: mustFind<HTMLButtonElement>(document, '#btn-help-back'),
  langLabel: mustFind(document, '#lang-label'),
};

/* ——— sound —————————————————————————————————————————————————————— */

const sound = new StepSound(saved.sound);

/* ——— i18n bootstrap ————————————————————————————————————————————— */

let m: Messages = messages(lang);
let controller: AppController | null = null;
let restoredDraft = false;

const placeholders = new WeakMap<HTMLInputElement | HTMLTextAreaElement, string>();

function setPlaceholder(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  placeholders.set(field, text);
  field.placeholder = text;
}

/** Apply all localized strings to the static markup. */
function localize(): void {
  html.lang = lang;
  document.title = m.appTitle;
  dom.title.textContent = m.appTitle;
  dom.version.textContent = `v${TM_VERSION}`;

  dom.labelTape.textContent = m.tape;
  dom.labelProgram.textContent = m.program;
  setPlaceholder(dom.tapeInput, m.hints.editTape);
  setPlaceholder(dom.programInput, m.hints.editProgram);

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
  hint('#btn-step', m.hints.step);
  hint('#btn-quick', m.hints.quick);
  hint('#btn-unmark', m.hints.unmark);
  hint('#btn-edit', m.hints.backToEdit);

  mustFind(document, '#btn-theme').setAttribute('title', m.controls.theme);
  mustFind(document, '#btn-theme').setAttribute('aria-label', m.controls.theme);
  mustFind(document, '#btn-sound').setAttribute('title', m.controls.theme);
  mustFind(document, '#btn-sound').setAttribute('aria-label', m.controls.theme);
  mustFind(document, '#btn-help').setAttribute('aria-label', m.controls.help);
  mustFind(document, '#btn-lang').setAttribute('title', m.controls.language);
  mustFind(document, '#btn-lang').setAttribute('aria-label', m.controls.language);
  dom.langLabel.textContent = lang === 'ru' ? 'EN' : 'RU';

  renderHelp(m.help);
  syncQuickLabel();
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
  syncQuickLabel();
}

function syncQuickLabel(): void {
  const quick = mustFind<HTMLButtonElement>(document, '#btn-quick');
  const running = controller?.isQuickRunning ?? false;
  quick.querySelector('.btn__text')!.textContent = running ? m.controls.slow : m.controls.quick;
  quick.setAttribute('aria-pressed', String(running));
}

/* ——— wiring ————————————————————————————————————————————————————— */

function buildController(): AppController {
  controller?.dispose();

  const next = new AppController({
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
      syncQuickLabel();
    },
    onProgramChange: saveProgram,
    onTapeChange: saveTape,
    onStepSound: () => sound.tick(),
  });

  next.hydrate(saved.program, saved.tape);
  restoredDraft = saved.program !== null;
  return next;
}

controller = buildController();

/* ——— events ————————————————————————————————————————————————————— */

const on = <K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void => target.addEventListener(type, handler as EventListener);

on(mustFind(document, '#btn-start'), 'click', () => controller?.start());
on(mustFind(document, '#btn-step'), 'click', () => {
  sound.unlock();
  controller?.step();
  syncQuickLabel();
});
on(mustFind(document, '#btn-quick'), 'click', () => {
  sound.unlock();
  controller?.quick();
  syncQuickLabel();
});
on(mustFind(document, '#btn-unmark'), 'click', () => controller?.unmark());
on(mustFind(document, '#btn-edit'), 'click', () => controller?.backToEdit());
on(mustFind(document, '#btn-edit-err'), 'click', () => controller?.backToEdit());
on(mustFind(document, '#btn-copy'), 'click', () => void controller?.copyProgram());
on(mustFind(document, '#btn-totu4'), 'click', () => controller?.toTu4());
on(mustFind(document, '#btn-help'), 'click', () => openHelp());
on(dom.helpBack, 'click', () => closeHelp());
on(mustFind(document, '#btn-help-close'), 'click', () => closeHelp());
on(dom.helpDialog, 'click', (event) => {
  // A click on the backdrop (outside the inner card) closes the dialog.
  if (event.target === dom.helpDialog) closeHelp();
});

on(mustFind(document, '#btn-lang'), 'click', () => {
  lang = lang === 'ru' ? 'en' : 'ru';
  saveLang(lang);
  m = messages(lang);
  localize();
  controller = buildController();
});

on(mustFind(document, '#btn-theme'), 'click', () => {
  const index = themeCandidates.indexOf(theme);
  theme = themeCandidates[(index + 1) % themeCandidates.length] ?? 'auto';
  saveTheme(theme);
  applyTheme();
});

on(mustFind(document, '#btn-sound'), 'click', () => {
  const next = !sound.isEnabled;
  sound.setEnabled(next);
  saveSound(next);
  const button = mustFind(document, '#btn-sound');
  button.setAttribute('aria-pressed', String(next));
  mustFind(document, '#btn-sound').dataset.on = String(next);
  if (next) sound.tick();
});

// Persist the draft as the user types (debounced), and keep the counter fresh.
const persistProgram = debounce((text: string) => saveProgram(text), 400);
const persistTape = debounce((text: string) => saveTape(text), 400);

on(dom.programInput, 'input', () => persistProgram(dom.programInput.value));
on(dom.tapeInput, 'input', () => persistTape(dom.tapeInput.value));

on(dom.tapeInput, 'keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sound.unlock();
    controller?.start();
  }
});

// Ctrl+Enter anywhere in the editor runs the program.
on(dom.programInput, 'keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sound.unlock();
    controller?.start();
  }
});

// Clicks on the read-only panes behave like "Back to edit".
on(dom.programView, 'click', () => controller?.backToEdit());
on(dom.tapeView, 'click', () => controller?.backToEdit());

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

  if (event.key === 'Enter' && !inEditable && !inControl) {
    event.preventDefault();
    controller?.handleEnter();
    syncQuickLabel();
    return;
  }
  if (event.key === ' ' && !inEditable && !inControl) {
    event.preventDefault();
    controller?.handleSpace();
    syncQuickLabel();
    return;
  }
  if (event.key === 'Escape' && !inEditable) {
    controller?.handleEscape();
    syncQuickLabel();
  }
});

// Hint bar: show the hint of the hovered/focused button.
const hintTargets = Array.from(dom.controls.querySelectorAll<HTMLButtonElement>('.btn[data-hint]'));
for (const button of hintTargets) {
  const show = (): void => {
    dom.hint.textContent = button.dataset.hint ?? '';
  };
  const hide = (): void => {
    dom.hint.textContent = '';
  };
  button.addEventListener('mouseenter', show);
  button.addEventListener('focus', show);
  button.addEventListener('mouseleave', hide);
  button.addEventListener('blur', hide);
}

// Reflect the sound preference in the markup on load.
mustFind(document, '#btn-sound').setAttribute('aria-pressed', String(sound.isEnabled));
mustFind(document, '#btn-sound').dataset.on = String(sound.isEnabled);

// Localize once the DOM is wired; the controller already restored the draft.
localize();
applyMode('edit');

// Legacy help links (`help-ru.html`, bookmarks) land on `#help`: open the
// in-app help instead of a separate page.
if (location.hash === '#help') openHelp();

// A restored draft is worth a quiet notice — but only after `localize()` has
// run, otherwise onModeChange would overwrite it with an empty log.
if (restoredDraft) {
  dom.log.textContent = m.log.restoredDraft;
  dom.log.dataset.kind = 'info';
}
