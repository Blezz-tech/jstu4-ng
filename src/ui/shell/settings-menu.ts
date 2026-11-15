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
export class SettingsMenu {
  private readonly doc: Document;
  private readonly dom: AppDom;
  private readonly i18n: I18n;
  private readonly controller: AppController;
  private readonly sound: StepSound;
  private readonly settings: SettingsStore;
  private readonly isConfirmDeleteEnabled: () => boolean;

  constructor(options: SettingsMenuOptions) {
    this.doc = options.doc;
    this.dom = options.dom;
    this.i18n = options.i18n;
    this.controller = options.controller;
    this.sound = options.sound;
    this.settings = options.settings;
    this.isConfirmDeleteEnabled = options.isConfirmDeleteEnabled;

    const { theme, onToggleConfirmDelete, signal } = options;

    listen(
      this.dom.settingsButton,
      'click',
      () => (this.isOpen ? this.close(false) : this.open()),
      signal,
    );
    listen(this.dom.settingsClose, 'click', () => this.close(true), signal);
    listen(
      this.doc,
      'pointerdown',
      (event) => {
        if (
          this.isOpen &&
          event.target instanceof Node &&
          !this.dom.settingsAnchor.contains(event.target)
        ) {
          this.close(false);
        }
      },
      signal,
    );

    listen(
      this.dom.langButton,
      'click',
      () => {
        const next = this.i18n.toggleLocale();
        this.settings.update({ lang: next });
        const url = new URL(location.href);
        if (url.searchParams.has('lang')) {
          url.searchParams.set('lang', next);
          safeReplaceState(url.pathname + url.search + url.hash);
        }
      },
      signal,
    );

    for (const button of this.dom.themeButtons) {
      listen(
        button,
        'click',
        () => {
          const choice = button.dataset.themeOption;
          if (choice !== 'auto' && choice !== 'light' && choice !== 'dark') return;
          this.settings.update({ theme: choice satisfies Theme });
          theme.apply();
        },
        signal,
      );
    }

    listen(
      this.dom.soundButton,
      'click',
      () => {
        const next = !this.sound.isEnabled;
        this.sound.setEnabled(next);
        this.settings.update({ sound: next });
        this.syncSoundControl();
        if (next) {
          this.sound.unlock();
          this.sound.tick();
        }
      },
      signal,
    );

    listen(this.dom.confirmDeleteSettingButton, 'click', onToggleConfirmDelete, signal);

    for (const kind of ['min', 'max'] as const) {
      const { input, dec, inc } = this.boundNodes(kind);
      listen(input, 'input', () => this.applySpeedBound(kind, input.value, false), signal);
      listen(input, 'change', () => this.applySpeedBound(kind, input.value, true), signal);
      listen(input, 'blur', () => this.applySpeedBound(kind, input.value, true), signal);
      bindStepperButton(dec, () => this.stepSpeedBound(kind, -1), signal);
      bindStepperButton(inc, () => this.stepSpeedBound(kind, 1), signal);
    }
  }

  get isOpen(): boolean {
    return !this.dom.settingsMenu.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.dom.settingsMenu.hidden = false;
    this.dom.settingsButton.setAttribute('aria-expanded', 'true');
    this.syncSpeedControls();
  }

  close(restoreFocus = false): void {
    if (!this.isOpen) return;
    this.dom.settingsMenu.hidden = true;
    this.dom.settingsButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.dom.settingsButton.focus();
  }

  syncSoundControl(): void {
    const onState = this.sound.isEnabled;
    this.dom.soundButton.setAttribute('aria-checked', String(onState));
    this.dom.soundButton.dataset.on = String(onState);
  }

  syncLangAria(): void {
    this.dom.langButton.setAttribute(
      'aria-label',
      this.i18n.t('settings.languageAria', { language: this.i18n.meta.nativeName }),
    );
  }

  syncConfirmDeleteControl(): void {
    this.dom.confirmDeleteSettingButton.setAttribute(
      'aria-checked',
      String(this.isConfirmDeleteEnabled()),
    );
  }

  syncSpeedControls(): void {
    const minSpeed = this.controller.currentMinSpeed;
    const maxSpeed = this.controller.currentMaxSpeed;
    const speed = this.controller.currentSpeed;
    const formatted = formatSpeed(speed);

    this.dom.speedControl.dataset.direction =
      speed < 0 ? 'reverse' : speed === 0 ? 'stopped' : 'forward';
    this.dom.speedControl.style.setProperty('--zero-ratio', String(zeroRatio(minSpeed, maxSpeed)));

    this.dom.speedInput.min = String(minSpeed);
    this.dom.speedInput.max = String(maxSpeed);
    this.dom.speedInput.step = String(SPEED_STEP);
    this.dom.speedInput.value = String(speed);
    this.dom.speedInput.setAttribute('aria-valuetext', formatted);
    this.dom.speedValue.textContent = formatted;

    for (const kind of ['min', 'max'] as const) {
      const { input, dec, inc } = this.boundNodes(kind);
      const limits = SPEED_BOUND_LIMITS[kind];
      const value = kind === 'min' ? minSpeed : maxSpeed;
      input.min = String(limits.min);
      input.max = String(limits.max);
      if (this.doc.activeElement !== input) input.value = String(value);
      setButtonDisabled(dec, value <= limits.min);
      setButtonDisabled(inc, value >= limits.max);
    }
  }

  private boundNodes(kind: SpeedBoundKind) {
    return kind === 'min'
      ? { input: this.dom.minSpeedInput, dec: this.dom.minSpeedDec, inc: this.dom.minSpeedInc }
      : { input: this.dom.maxSpeedInput, dec: this.dom.maxSpeedDec, inc: this.dom.maxSpeedInc };
  }

  private applySpeedBound(kind: SpeedBoundKind, rawValue: string, normalize: boolean): void {
    const limits = SPEED_BOUND_LIMITS[kind];
    const trimmed = rawValue.trim();
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || trimmed === '' || (kind === 'min' && trimmed === '-')) {
      if (normalize) this.commitSpeedBound(kind, limits.fallback, true);
      return;
    }
    if (!normalize && (parsed < limits.min || parsed > limits.max)) return;
    this.commitSpeedBound(kind, limits.clamp(parsed), normalize);
  }

  private stepSpeedBound(kind: SpeedBoundKind, delta: number): void {
    const current =
      kind === 'min' ? this.controller.currentMinSpeed : this.controller.currentMaxSpeed;
    this.commitSpeedBound(kind, SPEED_BOUND_LIMITS[kind].clamp(current + delta), true);
  }

  private commitSpeedBound(kind: SpeedBoundKind, nextBound: number, writeInput: boolean): void {
    const { input } = this.boundNodes(kind);
    let value: number;
    if (kind === 'min') {
      const result = this.controller.setMinSpeed(nextBound);
      this.settings.update({ minSpeed: result.minSpeed, speed: result.speed });
      value = result.minSpeed;
    } else {
      const result = this.controller.setMaxSpeed(nextBound);
      this.settings.update({ maxSpeed: result.maxSpeed, speed: result.speed });
      value = result.maxSpeed;
    }
    if (writeInput) input.value = String(value);
    this.syncSpeedControls();
  }
}
