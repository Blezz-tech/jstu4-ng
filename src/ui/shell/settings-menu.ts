import type { I18n } from '../../i18n';
import type { StepSound } from '../audio';
import type { AppController } from '../controller';
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
} from '../speed';
import type { Theme } from '../storage';
import { listen, safeReplaceState, setButtonDisabled, type AppDom } from './dom';
import type { SettingsStore, ThemeController } from './settings-store';

export interface SettingsMenuOptions {
  readonly doc: Document;
  readonly dom: AppDom;
  readonly i18n: I18n;
  readonly controller: AppController;
  readonly sound: StepSound;
  readonly settings: SettingsStore;
  readonly theme: ThemeController;
  readonly onToggleConfirmDelete: () => void;
  readonly isConfirmDeleteEnabled: () => boolean;
  readonly signal: AbortSignal;
}

export interface SettingsMenu {
  readonly isOpen: boolean;
  close(restoreFocus?: boolean): void;
  syncSoundControl(): void;
  syncLangAria(): void;
  syncConfirmDeleteControl(): void;
  syncSpeedControls(): void;
}

type SpeedBoundKind = 'min' | 'max';

const SPEED_BOUND_LIMITS = {
  min: {
    min: MIN_MIN_SPEED,
    max: MAX_MIN_SPEED,
    fallback: DEFAULT_MIN_SPEED,
    clamp: clampMinSpeed,
  },
  max: {
    min: MIN_MAX_SPEED,
    max: MAX_MAX_SPEED,
    fallback: DEFAULT_MAX_SPEED,
    clamp: clampMaxSpeed,
  },
} as const;

function bindStepperButton(
  button: HTMLButtonElement,
  onStep: () => void,
  signal: AbortSignal,
): void {
  let delayId: number | null = null;
  let repeatId: number | null = null;
  let didRepeat = false;

  const stop = (): void => {
    if (delayId !== null) window.clearTimeout(delayId);
    if (repeatId !== null) window.clearInterval(repeatId);
    delayId = repeatId = null;
  };

  signal.addEventListener('abort', stop, { once: true });

  listen(
    button,
    'pointerdown',
    (event) => {
      if (event.button !== 0 || button.disabled) return;
      didRepeat = false;
      stop();
      delayId = window.setTimeout(() => {
        delayId = null;
        if (button.disabled) return;
        didRepeat = true;
        onStep();
        repeatId = window.setInterval(() => {
          if (button.disabled) stop();
          else onStep();
        }, 65);
      }, 380);
    },
    signal,
  );

  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'blur'] as const) {
    listen(button, type, stop, signal);
  }

  listen(
    button,
    'click',
    () => {
      stop();
      if (didRepeat) {
        didRepeat = false;
        return;
      }
      if (!button.disabled) onStep();
    },
    signal,
  );
}

/**
 * Controls the top-right settings popover: language toggle, theme selector,
 * sound toggle, delete confirmation switch, and min/max speed bounds.
 */
export function bindSettingsMenu({
  doc,
  dom,
  i18n,
  controller,
  sound,
  settings,
  theme,
  onToggleConfirmDelete,
  isConfirmDeleteEnabled,
  signal,
}: SettingsMenuOptions): SettingsMenu {
  const isOpen = (): boolean => !dom.settingsMenu.hidden;

  const boundNodes = (kind: SpeedBoundKind) =>
    kind === 'min'
      ? { input: dom.minSpeedInput, dec: dom.minSpeedDec, inc: dom.minSpeedInc }
      : { input: dom.maxSpeedInput, dec: dom.maxSpeedDec, inc: dom.maxSpeedInc };

  const syncSoundControl = (): void => {
    dom.soundButton.setAttribute('aria-checked', String(sound.isEnabled));
  };

  const syncLangAria = (): void => {
    dom.langButton.setAttribute(
      'aria-label',
      i18n.t('settings.languageAria', { language: i18n.meta.nativeName }),
    );
  };

  const syncConfirmDeleteControl = (): void => {
    dom.confirmDeleteSettingButton.setAttribute('aria-checked', String(isConfirmDeleteEnabled()));
  };

  const syncSpeedControls = (): void => {
    const minSpeed = controller.currentMinSpeed;
    const maxSpeed = controller.currentMaxSpeed;
    const speed = controller.currentSpeed;
    const formatted = formatSpeed(speed);

    dom.speedControl.dataset.direction =
      speed < 0 ? 'reverse' : speed === 0 ? 'stopped' : 'forward';
    dom.speedControl.style.setProperty('--zero-ratio', String(zeroRatio(minSpeed, maxSpeed)));

    dom.speedInput.min = String(minSpeed);
    dom.speedInput.max = String(maxSpeed);
    dom.speedInput.step = String(SPEED_STEP);
    dom.speedInput.value = String(speed);
    dom.speedInput.setAttribute('aria-valuetext', formatted);
    dom.speedValue.textContent = formatted;

    for (const kind of ['min', 'max'] as const) {
      const { input, dec, inc } = boundNodes(kind);
      const limits = SPEED_BOUND_LIMITS[kind];
      const value = kind === 'min' ? minSpeed : maxSpeed;
      input.min = String(limits.min);
      input.max = String(limits.max);
      if (doc.activeElement !== input) input.value = String(value);
      setButtonDisabled(dec, value <= limits.min);
      setButtonDisabled(inc, value >= limits.max);
    }
  };

  const commitSpeedBound = (kind: SpeedBoundKind, nextBound: number, writeInput: boolean): void => {
    const { input } = boundNodes(kind);
    let value: number;
    if (kind === 'min') {
      const result = controller.setMinSpeed(nextBound);
      settings.update({ minSpeed: result.minSpeed, speed: result.speed });
      value = result.minSpeed;
    } else {
      const result = controller.setMaxSpeed(nextBound);
      settings.update({ maxSpeed: result.maxSpeed, speed: result.speed });
      value = result.maxSpeed;
    }
    if (writeInput) input.value = String(value);
    syncSpeedControls();
  };

  const applySpeedBound = (kind: SpeedBoundKind, rawValue: string, normalize: boolean): void => {
    const limits = SPEED_BOUND_LIMITS[kind];
    const trimmed = rawValue.trim();
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || trimmed === '' || (kind === 'min' && trimmed === '-')) {
      if (normalize) commitSpeedBound(kind, limits.fallback, true);
      return;
    }
    if (!normalize && (parsed < limits.min || parsed > limits.max)) return;
    commitSpeedBound(kind, limits.clamp(parsed), normalize);
  };

  const stepSpeedBound = (kind: SpeedBoundKind, delta: number): void => {
    const current = kind === 'min' ? controller.currentMinSpeed : controller.currentMaxSpeed;
    commitSpeedBound(kind, SPEED_BOUND_LIMITS[kind].clamp(current + delta), true);
  };

  const open = (): void => {
    if (isOpen()) return;
    dom.settingsMenu.hidden = false;
    dom.settingsButton.setAttribute('aria-expanded', 'true');
    syncSpeedControls();
  };

  const close = (restoreFocus = false): void => {
    if (!isOpen()) return;
    dom.settingsMenu.hidden = true;
    dom.settingsButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) dom.settingsButton.focus();
  };

  listen(dom.settingsButton, 'click', () => (isOpen() ? close(false) : open()), signal);
  listen(dom.settingsClose, 'click', () => close(true), signal);
  listen(
    doc,
    'pointerdown',
    (event) => {
      if (isOpen() && event.target instanceof Node && !dom.settingsAnchor.contains(event.target)) {
        close(false);
      }
    },
    signal,
  );

  listen(
    dom.langButton,
    'click',
    () => {
      const next = i18n.toggleLocale();
      settings.update({ lang: next });
      const url = new URL(location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.set('lang', next);
        safeReplaceState(url.pathname + url.search + url.hash);
      }
    },
    signal,
  );

  for (const button of dom.themeButtons) {
    listen(
      button,
      'click',
      () => {
        const choice = button.dataset.themeOption;
        if (choice !== 'auto' && choice !== 'light' && choice !== 'dark') return;
        settings.update({ theme: choice satisfies Theme });
        theme.apply();
      },
      signal,
    );
  }

  listen(
    dom.soundButton,
    'click',
    () => {
      const next = !sound.isEnabled;
      sound.setEnabled(next);
      settings.update({ sound: next });
      syncSoundControl();
      if (next) {
        sound.unlock();
        sound.tick();
      }
    },
    signal,
  );

  listen(dom.confirmDeleteSettingButton, 'click', onToggleConfirmDelete, signal);

  for (const kind of ['min', 'max'] as const) {
    const { input, dec, inc } = boundNodes(kind);
    listen(input, 'input', () => applySpeedBound(kind, input.value, false), signal);
    listen(input, 'change', () => applySpeedBound(kind, input.value, true), signal);
    listen(input, 'blur', () => applySpeedBound(kind, input.value, true), signal);
    bindStepperButton(dec, () => stepSpeedBound(kind, -1), signal);
    bindStepperButton(inc, () => stepSpeedBound(kind, 1), signal);
  }

  return {
    get isOpen(): boolean {
      return isOpen();
    },
    close,
    syncSoundControl,
    syncLangAria,
    syncConfirmDeleteControl,
    syncSpeedControls,
  };
}
