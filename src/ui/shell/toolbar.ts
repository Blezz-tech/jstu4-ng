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

export interface ToolbarView {
  applyMode(mode: UIMode): void;
  syncRunState(state: RunControlState): void;
  syncRunToggleLabel(): void;
  syncHint(): void;
  syncProgramOverflow(): void;
  scheduleProgramOverflow(): void;
}

/**
 * Wires the main control toolbar (edit/run/error mode actions, transport
 * controls, speed slider, hover/focus hints, and program-pane scroll fade).
 */
export function bindToolbar({
  doc,
  dom,
  i18n,
  controller,
  sound,
  settings,
  onSpeedChanged,
  signal,
}: ToolbarViewOptions): ToolbarView {
  let activeHintTarget: HTMLElement | null = null;
  let overflowRaf: number | null = null;

  /** Keep the side-panel hint card in sync with the hovered/focused visible control. */
  const syncHint = (): void => {
    const isDisabled = activeHintTarget instanceof HTMLButtonElement && activeHintTarget.disabled;
    if (activeHintTarget === null || isDisabled || activeHintTarget.offsetParent === null) {
      activeHintTarget = null;
      dom.hint.textContent = '';
      return;
    }
    dom.hint.textContent = activeHintTarget.dataset.hint ?? '';
  };

  /** Show the bottom scroll fade only when the listing actually overflows below. */
  const syncProgramOverflow = (): void => {
    const view = dom.programView;
    const hasMoreBelow = view.scrollHeight - view.scrollTop - view.clientHeight > 4;
    dom.programStack.dataset.overflowBottom = String(hasMoreBelow);
  };

  const scheduleProgramOverflow = (): void => {
    if (overflowRaf !== null) cancelAnimationFrame(overflowRaf);
    overflowRaf = requestAnimationFrame(() => {
      overflowRaf = null;
      syncProgramOverflow();
    });
  };

  const syncRunToggleLabel = (): void => {
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
  };

  listen(
    dom.startButton,
    'click',
    () => {
      sound.unlock();
      controller.start();
    },
    signal,
  );
  listen(
    dom.stepBackButton,
    'click',
    () => {
      sound.unlock();
      controller.stepBack();
    },
    signal,
  );
  listen(
    dom.stepButton,
    'click',
    () => {
      sound.unlock();
      controller.step();
    },
    signal,
  );
  listen(
    dom.runToggleButton,
    'click',
    () => {
      sound.unlock();
      controller.toggleAutoRun();
    },
    signal,
  );
  listen(dom.restartButton, 'click', () => controller.restart(), signal);

  listen(dom.speedInput, 'pointerdown', () => controller.beginSpeedDrag(), signal);
  listen(window, 'pointerup', () => controller.endSpeedDrag(), signal);
  listen(window, 'pointercancel', () => controller.endSpeedDrag(), signal);
  listen(dom.speedInput, 'change', () => controller.endSpeedDrag(), signal);
  listen(
    dom.speedInput,
    'input',
    () => {
      const nextSpeed = controller.setSpeed(Number(dom.speedInput.value));
      settings.update({ speed: nextSpeed });
      onSpeedChanged();
    },
    signal,
  );

  listen(dom.unmarkButton, 'click', () => controller.unmark(), signal);
  listen(dom.editButton, 'click', () => controller.backToEdit('program'), signal);
  listen(dom.editErrButton, 'click', () => controller.backToEdit('program'), signal);
  listen(dom.copyButton, 'click', () => void controller.copyProgram(), signal);
  listen(dom.toTu4Button, 'click', () => controller.toTu4(), signal);

  listen(dom.programView, 'scroll', syncProgramOverflow, signal);
  listen(window, 'resize', syncProgramOverflow, signal);

  // Hint card in the side panel: show the hint of the hovered/focused toolbar control.
  const hintTargets = Array.from(
    dom.controls.querySelectorAll<HTMLElement>('.btn, .speed-control'),
  );
  for (const control of hintTargets) {
    const show = (): void => {
      activeHintTarget = control;
      syncHint();
    };
    const hide = (): void => {
      if (activeHintTarget === control) activeHintTarget = null;
      syncHint();
    };
    listen(control, 'mouseenter', show, signal);
    listen(control, 'focusin', show, signal);
    listen(control, 'mouseleave', hide, signal);
    listen(control, 'focusout', hide, signal);
  }

  signal.addEventListener(
    'abort',
    () => {
      if (overflowRaf !== null) {
        cancelAnimationFrame(overflowRaf);
        overflowRaf = null;
      }
    },
    { once: true },
  );

  return {
    applyMode(mode) {
      dom.skipLink.href = mode === 'edit' ? '#input-program' : '#display-program';
      syncRunToggleLabel();
      scheduleProgramOverflow();
    },
    syncRunState(state) {
      setButtonDisabled(dom.stepBackButton, !state.canStepBack);
      setButtonDisabled(dom.stepButton, !state.canStepForward);
      setButtonDisabled(dom.runToggleButton, !state.canAutoRun);
      setButtonDisabled(dom.restartButton, !state.canRestart);
      doc.body.dataset.running = String(state.isRunning);
      syncRunToggleLabel();
    },
    syncRunToggleLabel,
    syncHint,
    syncProgramOverflow,
    scheduleProgramOverflow,
  };
}
