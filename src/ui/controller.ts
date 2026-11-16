import type { CompileError } from '../core/errors';
import { createProgram } from '../core/program';
import { MachineRun } from '../core/run';
import { toTu4 } from '../core/tu4';
import type { I18n } from '../i18n';
import { createAutoRunner, type StepDirection } from './auto-runner';
import { copyTextToClipboard } from './clipboard';
import { createCommandTracker } from './command-tracker';
import {
  displayCompileError,
  displayRunFinish,
  displayRuntimeError,
  displayStepBackBoundary,
} from './error-reporter';
import { createNotificationLog, type LogKind, type NotificationLog } from './notifications';
import {
  listProgram,
  ProgramRenderer,
  TapeRenderer,
  type CompiledProgram,
  type ProgramListing,
} from './render';
import {
  canStepInDirection,
  coerceTape,
  deriveRunControlState,
  resolveBackToEditTarget,
  resolveEnterAction,
  resolveEscapeAction,
  type RunControlState,
  type UIMode,
} from './run-state';
import { createSpeedController } from './speed-controller';
import { createStatsView } from './stats-view';

export { coerceTape, type LogKind, type RunControlState, type UIMode };

/** Everything the controller needs from the page, injected by app.ts. */
export interface AppElements {
  readonly programInput: HTMLTextAreaElement;
  readonly tapeInput: HTMLInputElement;
  readonly programView: HTMLElement;
  readonly tapeView: HTMLElement;
  readonly log: HTMLElement;
  readonly stats: HTMLElement;
  readonly controls: HTMLElement;
}

export interface ControllerOptions {
  readonly i18n: I18n;
  readonly elements: AppElements;
  /** Optional shared notification log; when omitted, an internal one is created for `elements.log`. */
  readonly notifications?: NotificationLog;
  /** Initial auto-run speed multiplier (defaults to 1×). */
  readonly initialSpeed?: number;
  /** Initial minimum (reverse) speed multiplier (defaults to -15×). */
  readonly initialMinSpeed?: number;
  /** Initial maximum (forward) speed multiplier (defaults to 25×). */
  readonly initialMaxSpeed?: number;
  /** Maximum reversible steps retained per run (defaults to `DEFAULT_MAX_HISTORY`). */
  readonly maxHistory?: number;
  /** Called after every mode or auto-run state change so the shell can sync UI. */
  readonly onModeChange: (mode: UIMode) => void;
  /** Called whenever run-mode button availability changes (step back/forward, run, restart). */
  readonly onRunStateChange?: (state: RunControlState) => void;
  /** Persist the program draft. */
  readonly onProgramChange: (text: string) => void;
  readonly onTapeChange: (text: string) => void;
  /** Called with converted TU4 source when "To TU4" succeeds (without mutating the editor). */
  readonly onTu4Converted?: (converted: string) => void;
  /** Optional per-step click. */
  readonly onStepSound?: () => void;
}

export interface AppController {
  readonly currentMode: UIMode;
  readonly isAutoRunning: boolean;
  readonly lastStepDirection: StepDirection;
  readonly currentSpeed: number;
  readonly currentMinSpeed: number;
  readonly currentMaxSpeed: number;
  readonly isMachineRunning: boolean;
  readonly canStepBack: boolean;
  readonly canRestart: boolean;
  readonly canAutoRun: boolean;
  beginSpeedDrag(): void;
  endSpeedDrag(): void;
  setSpeed(value: number): number;
  setMinSpeed(value: number): { readonly minSpeed: number; readonly speed: number };
  setMaxSpeed(value: number): { readonly maxSpeed: number; readonly speed: number };
  hydrate(program: string | null, tape: string | null): void;
  start(): void;
  restart(): void;
  step(): boolean;
  stepBack(): boolean;
  toggleAutoRun(): void;
  backToEdit(focus?: 'program' | 'tape'): void;
  unmark(): void;
  copyProgram(): Promise<void>;
  toTu4(): string | null;
  loadDraft(program: string, tape: string): void;
  handleEnter(withModifier?: boolean): void;
  handleSpace(): void;
  handleShiftSpace(): void;
  handleEscape(): void;
  dispose(): void;
}

/**
 * Execution controller for the Turing machine emulator: orchestrates compile/run/error
 * modes, stepping, speed transitions, incremental tape rendering, and O(1) program
 * listing highlights.
 */
export function createAppController(options: ControllerOptions): AppController {
  const { i18n, elements: el } = options;
  const ownsNotifications = options.notifications === undefined;
  const notifications = options.notifications ?? createNotificationLog({ element: el.log, i18n });
  const statsView = createStatsView(el.stats, i18n);
  const tapeRenderer = new TapeRenderer();
  const programRenderer = new ProgramRenderer();
  const commands = createCommandTracker(programRenderer);

  let mode: UIMode = 'edit';
  let run: MachineRun | null = null;
  let stepDirection: StepDirection = 'forward';

  const readRunState = (): RunControlState =>
    deriveRunControlState(mode, run, autoRunner.isRunning, speedCtrl.current);

  const notifyRunState = (): void => {
    options.onRunStateChange?.(readRunState());
  };

  const setMode = (nextMode: UIMode): void => {
    mode = nextMode;
    el.controls.dataset.mode = nextMode;
    document.body.dataset.mode = nextMode;
    options.onModeChange(nextMode);
  };

  const setStepDirection = (direction: StepDirection): void => {
    if (stepDirection === direction && el.programView.dataset.stepDir === direction) return;
    stepDirection = direction;
    el.programView.dataset.stepDir = direction;
  };

  const renderTapeView = (mount: boolean): void => {
    if (run === null) return;
    const label = i18n.t('a11y.tapeViewLabel');
    const dirty = run.consumeDirtyCells();
    if (mount) {
      tapeRenderer.mount(el.tapeView, run.tapeView, run.headPosition, label);
    } else {
      tapeRenderer.update(run.tapeView, run.headPosition, label, dirty);
    }
  };

  const haltAutoRun = (): void => {
    autoRunner.cancel();
    options.onModeChange(mode);
    notifyRunState();
  };

  const stopAutoRun = (): void => {
    if (autoRunner.isRunning) haltAutoRun();
  };

  const syncRunView = (direction: StepDirection, highlight = true): void => {
    if (run === null) return;
    // Batch all DOM writes first, then issue layout-reading scroll calls.
    statsView.updateProgress(run.stepsCount, run.cellsUsed);
    renderTapeView(false);
    setStepDirection(direction);
    if (highlight) commands.markCurrent(run.nextCommandIndex, false);
    tapeRenderer.scrollToHead();
    if (highlight) programRenderer.scrollToCurrent();
  };

  const flushRunView = (direction: StepDirection): void => {
    syncRunView(direction);
    notifications.clear();
    notifyRunState();
  };

  const stepForwardOnce = (playSound: boolean, render: boolean): boolean => {
    if (run === null || !run.isRunning) return false;

    const executedIdx = run.nextCommandIndex;
    const outcome = run.step();
    if (!outcome.ok) {
      syncRunView('forward', false);
      commands.markCurrent(-1);
      displayRuntimeError(outcome.error, notifications, (cmd) => commands.markError(cmd));
      haltAutoRun();
      return false;
    }

    if (executedIdx >= 0) {
      commands.recordVisited(executedIdx, 1);
      commands.recordCursor(executedIdx);
    }

    if (run.isRunning) {
      if (render) flushRunView('forward');
      else stepDirection = 'forward';
      if (playSound) options.onStepSound?.();
      return true;
    }

    syncRunView('forward');
    if (playSound) options.onStepSound?.();
    displayRunFinish(run, notifications);
    haltAutoRun();
    return false;
  };

  const stepBackOnce = (playSound: boolean, render: boolean): boolean => {
    if (run === null) return false;

    if (!run.canStepBack) {
      displayStepBackBoundary(run, notifications);
      haltAutoRun();
      return false;
    }

    const undoneIdx = run.stepBackIndex();
    if (undoneIdx < 0) return false;

    commands.recordVisited(undoneIdx, -1);
    commands.markError(null);

    if (!run.canStepBack) {
      syncRunView('reverse');
      if (playSound) options.onStepSound?.();
      displayStepBackBoundary(run, notifications);
      haltAutoRun();
      return false;
    }

    if (render) flushRunView('reverse');
    else stepDirection = 'reverse';
    if (playSound) options.onStepSound?.();
    return true;
  };

  const autoRunner = createAutoRunner({
    getSpeed: () => speedCtrl.current,
    getOpsCount: () => run?.stepsCount ?? 0,
    step: (dir, sound, render) =>
      dir === 'forward' ? stepForwardOnce(sound, render) : stepBackOnce(sound, render),
    onBatchFlush: flushRunView,
    onSound: () => options.onStepSound?.(),
    onHalt: haltAutoRun,
    onModeNotify: () => options.onModeChange(mode),
    onRunStateNotify: notifyRunState,
  });

  const speedCtrl = createSpeedController({
    initialSpeed: options.initialSpeed,
    initialMinSpeed: options.initialMinSpeed,
    initialMaxSpeed: options.initialMaxSpeed,
    autoRunner,
    canStepInDirection: (speed) => canStepInDirection(run, speed),
    onReverseBoundary: () => {
      if (run !== null && !run.canStepBack) displayStepBackBoundary(run, notifications);
    },
    onModeNotify: () => options.onModeChange(mode),
    onRunStateNotify: notifyRunState,
  });

  const unsubscribeI18n = i18n.subscribe(() => {
    statsView.refreshLabels();
    if (mode === 'run') renderTapeView(false);
  });

  const resetRunObjects = (): void => {
    stopAutoRun();
    speedCtrl.endDrag();
    run = null;
    commands.reset();
    tapeRenderer.clear();
    programRenderer.clear();
  };

  const reportCompileFailure = (
    text: string,
    listing: ProgramListing | null,
    error: CompileError,
  ): null => {
    const scrollTop = el.programInput.scrollTop;
    resetRunObjects();
    setMode('error');
    commands.setReturnCursorOffset(
      displayCompileError(error, {
        text,
        listing,
        programView: el.programView,
        programRenderer,
        notifications,
      }),
    );
    notifyRunState();
    programRenderer.syncScroll(scrollTop);
    programRenderer.scrollToFirstError();
    // Move focus out of `#input-tape` so Enter/Escape immediately return to edit mode.
    el.programView.focus({ preventScroll: true });
    return null;
  };

  const parseInput = (): CompiledProgram | null => {
    const text = el.programInput.value;
    const listed = listProgram(text);
    if (!listed.ok) return reportCompileFailure(text, null, listed.error);

    const created = createProgram(listed.value.commands, 0);
    if (!created.ok) return reportCompileFailure(text, listed.value, created.error);

    return { ...listed.value, program: created.value };
  };

  const start = (): void => {
    const parsed = parseInput();
    if (parsed === null) return;

    const scrollTop = el.programInput.scrollTop;
    const tape = coerceTape(el.tapeInput.value);
    if (tape !== el.tapeInput.value) el.tapeInput.value = tape;

    stopAutoRun();
    speedCtrl.endDrag();
    run = new MachineRun(
      parsed.program,
      tape,
      options.maxHistory !== undefined ? { maxHistory: options.maxHistory } : {},
    );
    commands.reset();
    options.onProgramChange(el.programInput.value);
    options.onTapeChange(tape);

    programRenderer.mount(el.programView, parsed);
    commands.index(parsed);
    renderTapeView(true);

    statsView.set({
      commandsCount: parsed.commands.length,
      initialDataLength: run.initialLength,
      maxDataLength: run.cellsUsed,
      operationsCount: 0,
    });

    setMode('run');
    programRenderer.syncScroll(scrollTop);
    setStepDirection('forward');
    commands.markCurrent(run.nextCommandIndex, false);
    notifications.clear();
    notifyRunState();
    // Flush layout-dependent scroll calls after all DOM writes.
    tapeRenderer.scrollToHead();
    programRenderer.scrollToCurrent();
    // Move focus out of `#input-tape` (e.g. after pressing Enter) so Space/Enter/Esc work.
    el.programView.focus({ preventScroll: true });
  };

  const toggleAutoRun = (): void => {
    if (autoRunner.isRunning) {
      stopAutoRun();
      return;
    }
    const speed = speedCtrl.current;
    if (mode !== 'run' || run === null || speed === 0) return;

    if (speed < 0 && !run.canStepBack) {
      displayStepBackBoundary(run, notifications);
      notifyRunState();
      return;
    }
    if (speed > 0 && !run.isRunning) return;

    autoRunner.markSteppedNow();
    autoRunner.schedule();
  };

  const backToEdit = (focus?: 'program' | 'tape'): void => {
    const previousMode = mode;
    const scrollTop = el.programView.scrollTop;
    const cursorOffset = commands.returnCursorOffset;

    resetRunObjects();
    setMode('edit');
    notifications.clear();
    notifyRunState();

    const target = resolveBackToEditTarget(previousMode, cursorOffset, focus);
    if (target === 'program') {
      el.programInput.focus({ preventScroll: true });
      if (cursorOffset !== null) {
        el.programInput.setSelectionRange(cursorOffset, cursorOffset);
      }
      el.programInput.scrollTop = scrollTop;
    } else {
      el.programInput.scrollTop = scrollTop;
      el.tapeInput.focus();
    }
  };

  const step = (): boolean => {
    stopAutoRun();
    return stepForwardOnce(true, true);
  };

  const stepBack = (): boolean => {
    stopAutoRun();
    return stepBackOnce(true, true);
  };

  return {
    get currentMode(): UIMode {
      return mode;
    },
    get isAutoRunning(): boolean {
      return autoRunner.isRunning;
    },
    get lastStepDirection(): StepDirection {
      return stepDirection;
    },
    get currentSpeed(): number {
      return speedCtrl.current;
    },
    get currentMinSpeed(): number {
      return speedCtrl.min;
    },
    get currentMaxSpeed(): number {
      return speedCtrl.max;
    },
    get isMachineRunning(): boolean {
      return readRunState().isRunning;
    },
    get canStepBack(): boolean {
      return readRunState().canStepBack;
    },
    get canRestart(): boolean {
      return readRunState().canRestart;
    },
    get canAutoRun(): boolean {
      return readRunState().canAutoRun;
    },
    beginSpeedDrag: () => speedCtrl.beginDrag(),
    endSpeedDrag: () => speedCtrl.endDrag(),
    setSpeed: (value) => speedCtrl.setSpeed(value),
    setMinSpeed: (value) => speedCtrl.setMin(value),
    setMaxSpeed: (value) => speedCtrl.setMax(value),
    hydrate(program, tape) {
      if (program !== null) el.programInput.value = program;
      if (tape !== null) el.tapeInput.value = tape;
      setMode('edit');
      notifications.show('info', (t) => t.t(program !== null ? 'log.restoredDraft' : 'log.ready'));
    },
    start,
    restart() {
      if (mode !== 'run' || run === null) return;
      stopAutoRun();
      run.reset();
      commands.clearVisited();
      commands.markCurrent(-1);
      commands.markError(null);
      syncRunView('forward');
      notifications.show('info', (t) => t.t('log.restarted'));
      notifyRunState();
    },
    step,
    stepBack,
    toggleAutoRun,
    backToEdit,
    unmark() {
      stopAutoRun();
      commands.clearVisited();
    },
    async copyProgram() {
      if (await copyTextToClipboard(el.programInput.value, el.programInput)) {
        notifications.show('info', (t) => t.t('log.copied'));
      }
    },
    toTu4() {
      const parsed = parseInput();
      if (parsed === null) return null;

      const converted = toTu4(parsed.program);
      if (!converted.ok) {
        notifications.show('error', (t) => t.t('error.tooManyStates'));
        return null;
      }

      notifications.show('info', (t) => t.t('log.convertedToTu4'));
      options.onTu4Converted?.(converted.value);
      return converted.value;
    },
    loadDraft(program, tape) {
      if (mode !== 'edit') {
        resetRunObjects();
        setMode('edit');
        notifyRunState();
      }
      el.programInput.value = program;
      el.tapeInput.value = tape;
      options.onProgramChange(program);
      options.onTapeChange(tape);
    },
    handleEnter(withModifier = false) {
      switch (resolveEnterAction(mode, readRunState(), withModifier)) {
        case 'start':
          start();
          break;
        case 'toggleAutoRun':
          toggleAutoRun();
          break;
        case 'backToTape':
          backToEdit('tape');
          break;
        case 'backToProgram':
          backToEdit('program');
          break;
        case 'none':
          break;
      }
    },
    handleSpace() {
      if (mode === 'run') step();
    },
    handleShiftSpace() {
      if (mode === 'run') stepBack();
    },
    handleEscape() {
      switch (resolveEscapeAction(mode, autoRunner.isRunning)) {
        case 'stopAutoRun':
          stopAutoRun();
          break;
        case 'backToTape':
          backToEdit('tape');
          break;
        case 'backToProgram':
          backToEdit('program');
          break;
        case 'none':
          break;
      }
    },
    dispose() {
      stopAutoRun();
      unsubscribeI18n();
      tapeRenderer.clear();
      programRenderer.clear();
      statsView.dispose();
      if (ownsNotifications) notifications.dispose();
    },
  };
}
