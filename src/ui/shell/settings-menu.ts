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

function bindStepperButton(
  button: HTMLButtonElement,
  onStep: () => void,
  signal: AbortSignal,
): void {
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
          if (button.disabled) {
            stop();
            return;
          }
          onStep();
        }, 65);
      }, 380);
    },
    signal,
  );

  listen(button, 'pointerup', stop, signal);
  listen(button, 'pointercancel', stop, signal);
  listen(button, 'pointerleave', stop, signal);
  listen(button, 'blur', stop, signal);

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
      () => {
        if (this.isOpen) this.close(false);
        else this.open();
      },
      signal,
    );
    listen(this.dom.settingsClose, 'click', () => this.close(true), signal);
    listen(
      this.doc,
      'pointerdown',
      (event) => {
        if (!this.isOpen) return;
        const target = event.target;
        if (target instanceof Node && !this.dom.settingsAnchor.contains(target)) {
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
          const nextTheme: Theme = choice;
          this.settings.update({ theme: nextTheme });
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

    listen(
      this.dom.minSpeedInput,
      'input',
      () => this.applyMinSpeedValue(this.dom.minSpeedInput.value, false),
      signal,
    );
    listen(
      this.dom.minSpeedInput,
      'change',
      () => this.applyMinSpeedValue(this.dom.minSpeedInput.value, true),
      signal,
    );
    listen(
      this.dom.minSpeedInput,
      'blur',
      () => this.applyMinSpeedValue(this.dom.minSpeedInput.value, true),
      signal,
    );

    listen(
      this.dom.maxSpeedInput,
      'input',
      () => this.applyMaxSpeedValue(this.dom.maxSpeedInput.value, false),
      signal,
    );
    listen(
      this.dom.maxSpeedInput,
      'change',
      () => this.applyMaxSpeedValue(this.dom.maxSpeedInput.value, true),
      signal,
    );
    listen(
      this.dom.maxSpeedInput,
      'blur',
      () => this.applyMaxSpeedValue(this.dom.maxSpeedInput.value, true),
      signal,
    );

    bindStepperButton(this.dom.minSpeedDec, () => this.stepMinSpeed(-1), signal);
    bindStepperButton(this.dom.minSpeedInc, () => this.stepMinSpeed(1), signal);
    bindStepperButton(this.dom.maxSpeedDec, () => this.stepMaxSpeed(-1), signal);
    bindStepperButton(this.dom.maxSpeedInc, () => this.stepMaxSpeed(1), signal);
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
    const direction = speed < 0 ? 'reverse' : speed === 0 ? 'stopped' : 'forward';

    this.dom.speedControl.dataset.direction = direction;
    this.dom.speedControl.style.setProperty('--zero-ratio', String(zeroRatio(minSpeed, maxSpeed)));

    this.dom.speedInput.min = String(minSpeed);
    this.dom.speedInput.max = String(maxSpeed);
    this.dom.speedInput.step = String(SPEED_STEP);
    this.dom.speedInput.value = String(speed);
    this.dom.speedInput.setAttribute('aria-valuetext', formatted);
    this.dom.speedValue.textContent = formatted;

    this.dom.minSpeedInput.min = String(MIN_MIN_SPEED);
    this.dom.minSpeedInput.max = String(MAX_MIN_SPEED);
    if (this.doc.activeElement !== this.dom.minSpeedInput) {
      this.dom.minSpeedInput.value = String(minSpeed);
    }
    setButtonDisabled(this.dom.minSpeedDec, minSpeed <= MIN_MIN_SPEED);
    setButtonDisabled(this.dom.minSpeedInc, minSpeed >= MAX_MIN_SPEED);

    this.dom.maxSpeedInput.min = String(MIN_MAX_SPEED);
    this.dom.maxSpeedInput.max = String(MAX_MAX_SPEED);
    if (this.doc.activeElement !== this.dom.maxSpeedInput) {
      this.dom.maxSpeedInput.value = String(maxSpeed);
    }
    setButtonDisabled(this.dom.maxSpeedDec, maxSpeed <= MIN_MAX_SPEED);
    setButtonDisabled(this.dom.maxSpeedInc, maxSpeed >= MAX_MAX_SPEED);
  }

  private applyMinSpeedValue(rawValue: string, normalizeInput: boolean): void {
    const trimmed = rawValue.trim();
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || trimmed === '' || trimmed === '-') {
      if (!normalizeInput) return;
      const result = this.controller.setMinSpeed(DEFAULT_MIN_SPEED);
      this.settings.update({ minSpeed: result.minSpeed, speed: result.speed });
      this.dom.minSpeedInput.value = String(result.minSpeed);
      this.syncSpeedControls();
      return;
    }

    if (!normalizeInput && (parsed < MIN_MIN_SPEED || parsed > MAX_MIN_SPEED)) return;

    const result = this.controller.setMinSpeed(clampMinSpeed(parsed));
    this.settings.update({ minSpeed: result.minSpeed, speed: result.speed });
    if (normalizeInput) this.dom.minSpeedInput.value = String(result.minSpeed);
    this.syncSpeedControls();
  }

  private applyMaxSpeedValue(rawValue: string, normalizeInput: boolean): void {
    const trimmed = rawValue.trim();
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || trimmed === '') {
      if (!normalizeInput) return;
      const result = this.controller.setMaxSpeed(DEFAULT_MAX_SPEED);
      this.settings.update({ maxSpeed: result.maxSpeed, speed: result.speed });
      this.dom.maxSpeedInput.value = String(result.maxSpeed);
      this.syncSpeedControls();
      return;
    }

    if (!normalizeInput && (parsed < MIN_MAX_SPEED || parsed > MAX_MAX_SPEED)) return;

    const result = this.controller.setMaxSpeed(clampMaxSpeed(parsed));
    this.settings.update({ maxSpeed: result.maxSpeed, speed: result.speed });
    if (normalizeInput) this.dom.maxSpeedInput.value = String(result.maxSpeed);
    this.syncSpeedControls();
  }

  private stepMinSpeed(delta: number): void {
    const result = this.controller.setMinSpeed(
      clampMinSpeed(this.controller.currentMinSpeed + delta),
    );
    this.settings.update({ minSpeed: result.minSpeed, speed: result.speed });
    this.dom.minSpeedInput.value = String(result.minSpeed);
    this.syncSpeedControls();
  }

  private stepMaxSpeed(delta: number): void {
    const result = this.controller.setMaxSpeed(
      clampMaxSpeed(this.controller.currentMaxSpeed + delta),
    );
    this.settings.update({ maxSpeed: result.maxSpeed, speed: result.speed });
    this.dom.maxSpeedInput.value = String(result.maxSpeed);
    this.syncSpeedControls();
  }
}
