import type { I18n } from '../../i18n';
import type { StepSound } from '../audio';
import type { AppController, RunControlState, UIMode } from '../controller';
import { listen, setButtonDisabled, type AppDom } from './dom';
import type { SettingsStore } from './settings-store';

export interface ToolbarViewOptions {
  readonly doc: Document;
  readonly dom: AppDom;
  readonly i18n: I18n;
  readonly controller: AppController;
  readonly sound: StepSound;
  readonly settings: SettingsStore;
  readonly onSpeedChanged: () => void;
  readonly signal: AbortSignal;
}

/**
 * Wires the main control toolbar (edit/run/error mode actions, transport
 * controls, speed slider, hover/focus hints, and program-pane scroll fade).
 */
export class ToolbarView {
  private readonly doc: Document;
  private readonly dom: AppDom;
  private readonly i18n: I18n;
  private readonly controller: AppController;
  private activeHintTarget: HTMLElement | null = null;
  private overflowRaf: number | null = null;

  constructor(options: ToolbarViewOptions) {
    this.doc = options.doc;
    this.dom = options.dom;
    this.i18n = options.i18n;
    this.controller = options.controller;

    const { controller, sound, settings, onSpeedChanged, signal } = options;

    listen(
      this.dom.startButton,
      'click',
      () => {
        sound.unlock();
        controller.start();
      },
      signal,
    );
    listen(
      this.dom.stepBackButton,
      'click',
      () => {
        sound.unlock();
        controller.stepBack();
        this.syncRunToggleLabel();
      },
      signal,
    );
    listen(
      this.dom.stepButton,
      'click',
      () => {
        sound.unlock();
        controller.step();
        this.syncRunToggleLabel();
      },
      signal,
    );
    listen(
      this.dom.runToggleButton,
      'click',
      () => {
        sound.unlock();
        controller.toggleAutoRun();
        this.syncRunToggleLabel();
      },
      signal,
    );
    listen(
      this.dom.restartButton,
      'click',
      () => {
        controller.restart();
        this.syncRunToggleLabel();
      },
      signal,
    );

    listen(this.dom.speedInput, 'pointerdown', () => controller.beginSpeedDrag(), signal);
    listen(window, 'pointerup', () => controller.endSpeedDrag(), signal);
    listen(window, 'pointercancel', () => controller.endSpeedDrag(), signal);
    listen(this.dom.speedInput, 'change', () => controller.endSpeedDrag(), signal);
    listen(
      this.dom.speedInput,
      'input',
      () => {
        const nextSpeed = controller.setSpeed(Number(this.dom.speedInput.value));
        settings.update({ speed: nextSpeed });
        onSpeedChanged();
      },
      signal,
    );

    listen(
      this.dom.unmarkButton,
      'click',
      () => {
        controller.unmark();
        this.syncRunToggleLabel();
      },
      signal,
    );
    listen(this.dom.editButton, 'click', () => controller.backToEdit('program'), signal);
    listen(this.dom.editErrButton, 'click', () => controller.backToEdit('program'), signal);
    listen(this.dom.copyButton, 'click', () => void controller.copyProgram(), signal);
    listen(this.dom.toTu4Button, 'click', () => controller.toTu4(), signal);

    listen(this.dom.programView, 'scroll', () => this.syncProgramOverflow(), signal);
    listen(window, 'resize', () => this.syncProgramOverflow(), signal);

    // Hint card in the side panel: show the hint of the hovered/focused toolbar control.
    const hintTargets = Array.from(
      this.dom.controls.querySelectorAll<HTMLElement>('.btn, .speed-control'),
    );
    for (const control of hintTargets) {
      const show = (): void => {
        this.activeHintTarget = control;
        this.syncHint();
      };
      const hide = (): void => {
        if (this.activeHintTarget === control) this.activeHintTarget = null;
        this.syncHint();
      };
      listen(control, 'mouseenter', show, signal);
      listen(control, 'focusin', show, signal);
      listen(control, 'mouseleave', hide, signal);
      listen(control, 'focusout', hide, signal);
    }

    signal.addEventListener(
      'abort',
      () => {
        if (this.overflowRaf !== null) {
          cancelAnimationFrame(this.overflowRaf);
          this.overflowRaf = null;
        }
      },
      { once: true },
    );
  }

  applyMode(mode: UIMode): void {
    this.dom.controls.dataset.mode = mode;
    this.doc.body.dataset.mode = mode;
    this.dom.skipLink.href = mode === 'edit' ? '#input-program' : '#display-program';
    this.syncRunToggleLabel();
    this.syncHint();
    this.scheduleProgramOverflow();
  }

  /**
   * Keep every run-mode button enabled strictly when its action makes sense:
   * - `←` (Step back): enabled whenever at least 1 step was performed (including after halt/error).
   * - `→` (Step): enabled while the machine has not halted.
   * - `▶` / `■` (Run / Stop): enabled while auto-running, or when stepping in the slider's direction is valid.
   * - `Сначала` (Restart): enabled after at least 1 step or after halt/error.
   */
  syncRunState(state: RunControlState): void {
    setButtonDisabled(this.dom.stepBackButton, !state.canStepBack);
    setButtonDisabled(this.dom.stepButton, !state.canStepForward);
    setButtonDisabled(this.dom.runToggleButton, !state.canAutoRun);
    setButtonDisabled(this.dom.restartButton, !state.canRestart);
    this.doc.body.dataset.running = String(state.isRunning);
    this.syncRunToggleLabel();
  }

  syncRunToggleLabel(): void {
    const toggle = this.dom.runToggleButton;
    const running = this.controller.isAutoRunning;
    const label = this.i18n.t(running ? 'controls.stop' : 'controls.run');
    const hint = this.i18n.t(running ? 'hints.stop' : 'hints.run');
    toggle.dataset.state = running ? 'stop' : 'play';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', hint);
    toggle.setAttribute('data-hint', hint);
    toggle.setAttribute('aria-pressed', String(running));
    this.syncHint();
  }

  /** Keep the side-panel hint card in sync with the hovered/focused visible control. */
  syncHint(): void {
    const isDisabled =
      this.activeHintTarget instanceof HTMLButtonElement && this.activeHintTarget.disabled;
    if (
      this.activeHintTarget === null ||
      isDisabled ||
      this.activeHintTarget.offsetParent === null
    ) {
      this.activeHintTarget = null;
      this.dom.hint.textContent = '';
      return;
    }
    this.dom.hint.textContent = this.activeHintTarget.dataset.hint ?? '';
  }

  /** Show the bottom scroll fade only when the listing actually overflows below. */
  syncProgramOverflow(): void {
    const view = this.dom.programView;
    const hasMoreBelow = view.scrollHeight - view.scrollTop - view.clientHeight > 4;
    this.dom.programStack.dataset.overflowBottom = String(hasMoreBelow);
  }

  scheduleProgramOverflow(): void {
    if (this.overflowRaf !== null) cancelAnimationFrame(this.overflowRaf);
    this.overflowRaf = requestAnimationFrame(() => {
      this.overflowRaf = null;
      this.syncProgramOverflow();
    });
  }
}
