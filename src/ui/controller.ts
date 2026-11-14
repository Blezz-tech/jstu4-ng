import type { Command } from '../core/machine';
import {
  AmbiguousCommandError,
  EmptyProgramError,
  MachineError,
  NoSuchCommandError,
  NonexistentInitialStateError,
  NonexistentTargetStateError,
  OutOfTapeError,
  ParseError,
} from '../core/errors';
import { MachineRun } from '../core/run';
import { toTu4 } from '../core/tu4';
import type { I18n } from '../i18n';
import { copyTextToClipboard } from './clipboard';
import { el } from './dom';
import { NotificationLog, type LogKind } from './notifications';
import {
  compileProgram,
  listProgram,
  renderProgram,
  renderProgramWithError,
  TapeRenderer,
  type CompiledProgram,
} from './render';
import {
  BASE_STEPS_PER_SECOND,
  clampMaxSpeed,
  clampMinSpeed,
  clampSpeed,
  DEFAULT_MAX_SPEED,
  DEFAULT_MIN_SPEED,
  DEFAULT_SPEED,
  stepIntervalMs,
} from './speed';

export type { LogKind };
export type UIMode = 'edit' | 'run' | 'error';

/** Everything the controller needs from the page, injected by main.ts. */
export interface AppElements {
  readonly programInput: HTMLTextAreaElement;
  readonly tapeInput: HTMLInputElement;
  readonly programView: HTMLElement;
  readonly tapeView: HTMLElement;
  readonly log: HTMLElement;
  readonly stats: HTMLElement;
  readonly controls: HTMLElement;
}

/** Snapshot of run-mode control availability emitted whenever execution state changes. */
export interface RunControlState {
  readonly isRunning: boolean;
  readonly isAutoRunning: boolean;
  readonly canStepForward: boolean;
  readonly canStepBack: boolean;
  readonly canAutoRun: boolean;
  readonly canRestart: boolean;
  readonly speed: number;
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
  /** Called whenever the machine halts or starts running again. */
  readonly onRunningChange?: (isRunning: boolean) => void;
  /** Called whenever run-mode button availability changes (step back/forward, run, restart). */
  readonly onRunStateChange?: (state: RunControlState) => void;
  /** Called whenever the internal notification log changes (ignored when `notifications` is injected). */
  readonly onLogChange?: (kind: LogKind | null) => void;
  /** Persist the program draft. */
  readonly onProgramChange: (text: string) => void;
  readonly onTapeChange: (text: string) => void;
  /** Called with converted TU4 source when "To TU4" succeeds (without mutating the editor). */
  readonly onTu4Converted?: (converted: string) => void;
  /** Optional per-step click. */
  readonly onStepSound?: () => void;
}

const RAF_THRESHOLD_MS = 20;
const MAX_BATCH_STEPS_PER_FRAME = 64;
const MAX_BATCH_MS_PER_FRAME = 6;

/**
 * The tape is a sequence of single-character cells, so tabs or pasted line
 * breaks are normalised to spaces (1-to-1 per character).
 */
export function coerceTape(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ');
}

function scrollElementIntoView(
  node: Element | null,
  options: ScrollIntoViewOptions = { block: 'nearest' },
): void {
  if (node !== null && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView(options);
  }
}

/**
 * Execution controller for the Turing machine emulator: owns compile/run/error
 * modes, stepping, high-speed frame batching, incremental tape rendering, and
 * O(1) program listing highlights.
 */
export class AppController {
  private readonly i18n: I18n;
  private readonly unsubscribeI18n: () => void;
  private readonly el: AppElements;
  private readonly options: ControllerOptions;
  private readonly notifications: NotificationLog;
  private readonly ownsNotifications: boolean;

  private mode: UIMode = 'edit';
  private run: MachineRun | null = null;
  private compiled: CompiledProgram | null = null;
  private readonly tapeRenderer = new TapeRenderer();
  private readonly commandIndex = new Map<Command, number>();
  private commandNodes: HTMLElement[] = [];
  private currentCommandNode: HTMLElement | null = null;
  private errorCommandNode: HTMLElement | null = null;
  private readonly visitCounts = new Map<number, number>();

  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRaf: number | null = null;
  private autoRunning = false;
  private autoGeneration = 0;
  private lastStepAt = 0;
  private stepDirection: 'forward' | 'reverse' = 'forward';
  private minSpeed: number;
  private maxSpeed: number;
  private speed: number;
  private draggingSpeed = false;
  private resumeAfterZeroDrag = false;

  private returnCursorOffset: number | null = null;
  private hasStats = false;
  private stats = { commandsCount: 0, initialDataLength: 0, maxDataLength: 0, operationsCount: 0 };

  constructor(options: ControllerOptions) {
    this.options = options;
    this.i18n = options.i18n;
    this.el = options.elements;
    if (options.notifications !== undefined) {
      this.notifications = options.notifications;
      this.ownsNotifications = false;
    } else {
      this.notifications = new NotificationLog({
        element: options.elements.log,
        i18n: options.i18n,
        ...(options.onLogChange !== undefined ? { onChange: options.onLogChange } : {}),
      });
      this.ownsNotifications = true;
    }
    this.minSpeed = clampMinSpeed(options.initialMinSpeed ?? DEFAULT_MIN_SPEED);
    this.maxSpeed = clampMaxSpeed(options.initialMaxSpeed ?? DEFAULT_MAX_SPEED);
    this.speed = clampSpeed(options.initialSpeed ?? DEFAULT_SPEED, this.minSpeed, this.maxSpeed);
    this.unsubscribeI18n = this.i18n.subscribe(() => this.refreshLocalized());
  }

  get currentMode(): UIMode {
    return this.mode;
  }

  get isAutoRunning(): boolean {
    return this.autoRunning;
  }

  get lastStepDirection(): 'forward' | 'reverse' {
    return this.stepDirection;
  }

  get currentSpeed(): number {
    return this.speed;
  }

  get currentMinSpeed(): number {
    return this.minSpeed;
  }

  get currentMaxSpeed(): number {
    return this.maxSpeed;
  }

  get isMachineRunning(): boolean {
    return this.mode === 'run' && this.run !== null && this.run.isRunning;
  }

  get canStepForward(): boolean {
    return this.mode === 'run' && this.run !== null && this.run.isRunning;
  }

  get canStepBack(): boolean {
    return this.mode === 'run' && this.run !== null && this.run.canStepBack;
  }

  get canRestart(): boolean {
    return (
      this.mode === 'run' && this.run !== null && (this.run.stepsCount > 0 || !this.run.isRunning)
    );
  }

  get canAutoRun(): boolean {
    if (this.mode !== 'run' || this.run === null) return false;
    if (this.isAutoRunning) return true;
    return this.canStepInDirection(this.speed);
  }

  /** Notify controller that the user started dragging the speed slider thumb. */
  beginSpeedDrag(): void {
    this.draggingSpeed = true;
    this.resumeAfterZeroDrag = this.isAutoRunning;
  }

  /** Notify controller that the user finished dragging the speed slider thumb. */
  endSpeedDrag(): void {
    this.draggingSpeed = false;
    this.resumeAfterZeroDrag = false;
  }

  /**
   * Change auto-run speed multiplier (`currentMinSpeed` .. `currentMaxSpeed`).
   * Moving to `0` stops automatic execution immediately; negative values run
   * the machine in reverse.
   */
  setSpeed(value: number): number {
    const next = clampSpeed(value, this.minSpeed, this.maxSpeed);
    if (next === this.speed) return next;
    this.speed = next;

    if (next === 0) {
      if (this.isAutoRunning) {
        if (this.draggingSpeed) this.resumeAfterZeroDrag = true;
        this.clearAutoHandles();
        this.options.onModeChange(this.mode);
      }
      this.notifyRunState();
      return next;
    }

    if (this.isAutoRunning) {
      if (!this.canStepInDirection(next)) {
        this.clearAutoHandles();
        if (next < 0 && this.run !== null && !this.run.canStepBack) {
          this.notifyStepBackBoundary(this.run);
        }
        this.options.onModeChange(this.mode);
      } else {
        this.clearAutoHandles();
        const remaining = Math.max(
          0,
          Math.round(stepIntervalMs(this.speed) - (performance.now() - this.lastStepAt)),
        );
        this.scheduleAutoTick(remaining);
      }
    } else if (this.draggingSpeed && this.resumeAfterZeroDrag) {
      if (this.canStepInDirection(next)) {
        this.lastStepAt = performance.now();
        this.scheduleAutoTick(0);
      } else if (next < 0 && this.run !== null && !this.run.canStepBack) {
        this.notifyStepBackBoundary(this.run);
      }
    }

    this.notifyRunState();
    return next;
  }

  /** Change the lower (negative) bound for the speed slider and clamp current speed if needed. */
  setMinSpeed(value: number): { readonly minSpeed: number; readonly speed: number } {
    this.minSpeed = clampMinSpeed(value);
    const clampedSpeed = clampSpeed(this.speed, this.minSpeed, this.maxSpeed);
    if (clampedSpeed !== this.speed) {
      this.setSpeed(clampedSpeed);
    }
    return { minSpeed: this.minSpeed, speed: this.speed };
  }

  /** Change the upper (positive) bound for the speed slider and clamp current speed if needed. */
  setMaxSpeed(value: number): { readonly maxSpeed: number; readonly speed: number } {
    this.maxSpeed = clampMaxSpeed(value);
    const clampedSpeed = clampSpeed(this.speed, this.minSpeed, this.maxSpeed);
    if (clampedSpeed !== this.speed) {
      this.setSpeed(clampedSpeed);
    }
    return { maxSpeed: this.maxSpeed, speed: this.speed };
  }

  /** Re-render controller-owned localized text when the active locale changes. */
  private refreshLocalized(): void {
    if (this.hasStats) this.renderStats();
    if (this.mode === 'run') this.updateTapeView(false);
  }

  /** Restore a draft on initial startup. */
  hydrate(program: string | null, tape: string | null): void {
    if (program !== null) this.el.programInput.value = program;
    if (tape !== null) this.el.tapeInput.value = tape;
    this.setMode('edit');
    this.notifications.show('info', (i) =>
      i.t(program !== null ? 'log.restoredDraft' : 'log.ready'),
    );
  }

  // ——— user actions ————————————————————————————————————————————————

  /** "Start": compile the program and begin a new run. */
  start(): void {
    const parsed = this.parseInput();
    if (parsed === null) return;

    const scrollTop = this.el.programInput.scrollTop;
    const tape = coerceTape(this.el.tapeInput.value);
    if (tape !== this.el.tapeInput.value) this.el.tapeInput.value = tape;

    this.stopAutoRun();
    this.compiled = parsed;
    this.run = new MachineRun(
      parsed.program,
      tape,
      this.options.maxHistory !== undefined ? { maxHistory: this.options.maxHistory } : {},
    );
    this.visitCounts.clear();
    this.returnCursorOffset = null;
    this.options.onProgramChange(this.el.programInput.value);
    this.options.onTapeChange(tape);

    this.el.programView.replaceChildren(renderProgram(parsed));
    this.indexCompiledCommands(parsed);
    this.mountTapeView();

    this.stats = {
      commandsCount: parsed.commands.length,
      initialDataLength: this.run.initialTape.length,
      maxDataLength: this.run.cellsUsed,
      operationsCount: 0,
    };
    this.hasStats = true;
    this.renderStats();

    this.setMode('run');
    this.el.programView.scrollTop = scrollTop;
    this.setStepDirection('forward');
    this.highlightCurrentCommand(this.run.nextCommand);
    this.notifications.clear();
    this.notifyRunState();
    // Move focus out of any previously active input (e.g. `#input-tape` after
    // pressing Enter) so Space/Enter/Esc hotkeys work immediately in run mode.
    this.el.programView.focus({ preventScroll: true });
  }

  /**
   * "Restart": reset the active run back to step 0 with the initial tape,
   * initial state, and cleared marks without leaving run mode.
   */
  restart(): void {
    if (this.mode !== 'run' || this.run === null || this.compiled === null) return;

    this.stopAutoRun();
    this.run.reset();
    for (const index of this.visitCounts.keys()) {
      this.commandNodes[index]?.classList.remove('visited');
    }
    this.visitCounts.clear();
    this.clearCurrentCommandHighlight();
    this.clearErrorCommandHighlight();

    this.stats.operationsCount = 0;
    this.stats.maxDataLength = this.run.cellsUsed;
    this.renderStats();
    this.updateTapeView(true);
    this.setStepDirection('forward');
    this.highlightCurrentCommand(this.run.nextCommand);
    this.notifications.show('info', (i) => i.t('log.restarted'));
    this.notifyRunState();
  }

  /**
   * "Step": pause auto-run (if active) and execute one command forward.
   * Returns whether the machine keeps running.
   */
  step(): boolean {
    this.stopAutoRun();
    return this.stepForwardOnce(true, true);
  }

  /**
   * "Step back": pause auto-run (if active) and undo the last executed command.
   * Returns whether further backward steps remain (i.e. not yet at step 0).
   */
  stepBack(): boolean {
    this.stopAutoRun();
    return this.stepBackOnce(true, true);
  }

  /**
   * "Run / Stop": toggle automatic execution in the current speed direction
   * (forward if speed > 0, backward if speed < 0; no-op when speed is 0).
   */
  toggleAutoRun(): void {
    if (this.isAutoRunning) {
      this.stopAutoRun();
      return;
    }
    if (this.mode !== 'run' || this.run === null || this.speed === 0) return;

    if (this.speed < 0 && !this.run.canStepBack) {
      this.notifyStepBackBoundary(this.run);
      this.notifyRunState();
      return;
    }
    if (this.speed > 0 && !this.run.isRunning) return;

    this.lastStepAt = performance.now();
    this.scheduleAutoTick();
  }

  /** Pause automatic execution without discarding the current run state. */
  stopAutoRun(): void {
    const wasRunning = this.isAutoRunning;
    this.clearAutoHandles();
    if (wasRunning) {
      this.options.onModeChange(this.mode);
      this.notifyRunState();
    }
  }

  /** "Back to edit": stop everything and return to the editable fields. */
  backToEdit(focus?: 'program' | 'tape'): void {
    const previousMode = this.mode;
    const scrollTop = this.el.programView.scrollTop;
    const cursorOffset = this.returnCursorOffset;

    this.resetRunObjects();
    this.setMode('edit');
    this.notifications.clear();
    this.notifyRunState();

    const target =
      focus ?? (previousMode === 'error' || cursorOffset !== null ? 'program' : 'tape');

    if (target === 'program') {
      this.el.programInput.focus({ preventScroll: true });
      if (cursorOffset !== null) {
        this.el.programInput.setSelectionRange(cursorOffset, cursorOffset);
      }
      this.el.programInput.scrollTop = scrollTop;
    } else {
      this.el.programInput.scrollTop = scrollTop;
      this.el.tapeInput.focus();
    }
  }

  /** "Unmark": pause auto-run (if active) and clear visited command marks. */
  unmark(): void {
    this.stopAutoRun();
    for (const index of this.visitCounts.keys()) {
      this.commandNodes[index]?.classList.remove('visited');
    }
    this.visitCounts.clear();
  }

  /** "Copy": copy the program to the clipboard. */
  async copyProgram(): Promise<void> {
    const copied = await copyTextToClipboard(this.el.programInput.value, this.el.programInput);
    if (copied) this.notifications.show('info', (i) => i.t('log.copied'));
  }

  /**
   * "To TU4": convert the current program to TU4 format without modifying
   * the editor content, and deliver the converted text via `onTu4Converted`.
   */
  toTu4(): string | null {
    const parsed = this.parseInput();
    if (parsed === null) return null;

    try {
      const converted = toTu4(parsed.program);
      this.notifications.show('info', (i) => i.t('log.convertedToTu4'));
      this.options.onTu4Converted?.(converted);
      return converted;
    } catch (error) {
      if (error instanceof RangeError) {
        this.notifications.show('error', (i) => i.t('error.tooManyStates'));
        return null;
      }
      throw error;
    }
  }

  /** Stop any active run and replace the editor content with the given program and tape. */
  loadDraft(program: string, tape: string): void {
    if (this.mode !== 'edit') {
      this.resetRunObjects();
      this.setMode('edit');
      this.notifyRunState();
    }
    this.el.programInput.value = program;
    this.el.tapeInput.value = tape;
    this.options.onProgramChange(program);
    this.options.onTapeChange(tape);
  }

  /** Keyboard: Enter behaviour depends on the current mode. */
  handleEnter(withModifier = false): void {
    switch (this.mode) {
      case 'edit':
        if (withModifier) this.start();
        break;
      case 'run':
        if (this.canAutoRun) this.toggleAutoRun();
        else if (!this.isMachineRunning && this.speed >= 0) this.backToEdit('tape');
        break;
      case 'error':
        this.backToEdit('program');
        break;
    }
  }

  handleSpace(): void {
    if (this.mode !== 'run') return;
    this.step();
  }

  handleShiftSpace(): void {
    if (this.mode !== 'run') return;
    this.stepBack();
  }

  handleEscape(): void {
    if (this.mode === 'edit') return;
    if (this.mode === 'run') {
      if (this.isAutoRunning) {
        this.stopAutoRun();
        return;
      }
      this.backToEdit('tape');
      return;
    }
    this.backToEdit('program');
  }

  dispose(): void {
    this.stopAutoRun();
    this.unsubscribeI18n();
    if (this.ownsNotifications) this.notifications.dispose();
  }

  // ——— internals ——————————————————————————————————————————————————

  private resetRunObjects(): void {
    this.stopAutoRun();
    this.run = null;
    this.compiled = null;
    this.commandIndex.clear();
    this.commandNodes = [];
    this.currentCommandNode = null;
    this.errorCommandNode = null;
    this.visitCounts.clear();
    this.tapeRenderer.clear();
    this.el.programView.replaceChildren();
    this.el.tapeView.replaceChildren();
    this.returnCursorOffset = null;
  }

  private indexCompiledCommands(compiled: CompiledProgram): void {
    this.commandIndex.clear();
    compiled.commands.forEach((command, index) => {
      this.commandIndex.set(command, index);
    });
    this.commandNodes = Array.from(this.el.programView.querySelectorAll<HTMLElement>('.cmd'));
    this.currentCommandNode = null;
    this.errorCommandNode = null;
  }

  private canStepInDirection(speed: number): boolean {
    if (this.run === null || speed === 0) return false;
    return speed > 0 ? this.run.isRunning : this.run.canStepBack;
  }

  private notifyRunState(): void {
    this.options.onRunningChange?.(this.isMachineRunning);
    this.options.onRunStateChange?.({
      isRunning: this.isMachineRunning,
      isAutoRunning: this.isAutoRunning,
      canStepForward: this.canStepForward,
      canStepBack: this.canStepBack,
      canAutoRun: this.canAutoRun,
      canRestart: this.canRestart,
      speed: this.speed,
    });
  }

  /**
   * Synchronize all run-mode DOM surfaces (stats, tape, current command highlight)
   * with the current `MachineRun` state. Called once per single step, or once per
   * animation frame at the end of a high-speed batch.
   */
  private flushRunView(direction: 'forward' | 'reverse', clearNotification = true): void {
    const run = this.run;
    if (run === null) return;
    this.stats.operationsCount = run.stepsCount;
    this.stats.maxDataLength = run.cellsUsed;
    this.renderStats();
    this.updateTapeView(true);
    this.setStepDirection(direction);
    this.highlightCurrentCommand(run.nextCommand);
    if (clearNotification) this.notifications.clear();
    this.notifyRunState();
  }

  private stepForwardOnce(playSound: boolean, render: boolean): boolean {
    const run = this.run;
    if (run === null || !run.isRunning) return false;

    const executed = run.nextCommand;
    try {
      run.step();
    } catch (error) {
      this.stats.operationsCount = run.stepsCount;
      this.stats.maxDataLength = run.cellsUsed;
      this.renderStats();
      this.updateTapeView(true);
      this.setStepDirection('forward');
      this.reportRuntimeError(error);
      return false;
    }

    if (executed !== undefined) {
      this.recordVisited(executed, 1);
      this.returnCursorOffset = executed.source.offset;
    }

    this.stats.operationsCount = run.stepsCount;
    this.stats.maxDataLength = run.cellsUsed;

    if (run.isRunning) {
      if (render) {
        this.flushRunView('forward');
      } else {
        this.stepDirection = 'forward';
      }
      if (playSound) this.options.onStepSound?.();
      return true;
    }

    this.renderStats();
    this.updateTapeView(true);
    this.setStepDirection('forward');
    this.highlightCurrentCommand(run.nextCommand);
    if (playSound) this.options.onStepSound?.();
    this.reportFinish(run);
    return false;
  }

  private notifyStepBackBoundary(run: MachineRun): void {
    const key = run.isAtStart ? 'log.reachedInitialState' : 'log.reachedHistoryLimit';
    this.notifications.show('info', (i) => i.t(key));
  }

  private stepBackOnce(playSound: boolean, render: boolean): boolean {
    const run = this.run;
    if (run === null) return false;

    if (!run.canStepBack) {
      this.clearAutoHandles();
      this.notifyStepBackBoundary(run);
      this.options.onModeChange(this.mode);
      this.notifyRunState();
      return false;
    }

    const undone = run.stepBack();
    if (undone === null) return false;

    this.recordVisited(undone, -1);
    this.clearErrorCommandHighlight();

    this.stats.operationsCount = run.stepsCount;
    this.stats.maxDataLength = run.cellsUsed;

    if (!run.canStepBack) {
      this.renderStats();
      this.updateTapeView(true);
      this.setStepDirection('reverse');
      this.highlightCurrentCommand(run.nextCommand);
      if (playSound) this.options.onStepSound?.();
      this.clearAutoHandles();
      this.notifyStepBackBoundary(run);
      this.options.onModeChange(this.mode);
      this.notifyRunState();
      return false;
    }

    if (render) {
      this.flushRunView('reverse');
    } else {
      this.stepDirection = 'reverse';
    }
    if (playSound) this.options.onStepSound?.();
    return true;
  }

  private parseInput(): CompiledProgram | null {
    try {
      return compileProgram(this.el.programInput.value, 0);
    } catch (error) {
      this.reportCompileError(error, this.el.programInput.value);
      return null;
    }
  }

  private reportCompileError(error: unknown, text: string): void {
    if (!(error instanceof MachineError)) throw error;

    const scrollTop = this.el.programInput.scrollTop;
    this.returnCursorOffset = null;
    this.setMode('error');
    this.notifications.clear();

    if (error instanceof ParseError) {
      this.returnCursorOffset = error.data.offset;
      this.el.programView.replaceChildren(renderProgramWithError(text, error.data.offset));
      const badText = error.data.text;
      this.notifications.show('error', (i) => i.t('error.parseError', { text: badText }));
    } else if (error instanceof EmptyProgramError) {
      this.el.programView.textContent = text;
      this.notifications.show('error', (i) => i.t('error.programIsEmpty'));
    } else if (error instanceof AmbiguousCommandError) {
      this.returnCursorOffset = error.data.command.source.offset;
      this.renderProgramWithMarks(text, [error.data.command, error.data.original], 'error');
      const q = String(error.data.command.q);
      const a = error.data.command.a;
      this.notifications.show('error', (i) => i.t('error.ambiguousCommand', { q, a }));
    } else if (error instanceof NonexistentTargetStateError) {
      this.returnCursorOffset = error.data.command.source.offset;
      this.renderProgramWithMarks(text, [error.data.command], 'error');
      const w = String(error.data.command.w);
      this.notifications.show('error', (i) => i.t('error.targetStateDoesNotExist', { w }));
    } else if (error instanceof NonexistentInitialStateError) {
      this.renderProgramWithMarks(text, [], 'error');
      const q = String(error.data.state);
      this.notifications.show('error', (i) => i.t('error.initialStateDoesNotExist', { q }));
    } else {
      throw error;
    }

    this.el.programView.scrollTop = scrollTop;
    scrollElementIntoView(this.el.programView.querySelector('mark.error, .cmd.error'));
    // Move focus out of `#input-tape` (e.g. if error was triggered by pressing
    // Enter in the tape input) so Enter/Escape immediately return to edit mode.
    this.el.programView.focus({ preventScroll: true });
  }

  /**
   * Render the program with some commands marked as erroneous.
   *
   * The program did not compile, so only the *parser* runs here: the
   * commands are enough to draw the syntax-highlighted listing without
   * repeating validation.
   */
  private renderProgramWithMarks(
    text: string,
    commands: readonly Command[],
    className: string,
  ): void {
    try {
      const listing = listProgram(text);
      this.el.programView.replaceChildren(renderProgram(listing));
      const nodes = Array.from(this.el.programView.querySelectorAll<HTMLElement>('.cmd'));
      const offsets = new Set(commands.map((command) => command.source.offset));
      listing.commands.forEach((command, index) => {
        if (offsets.has(command.source.offset)) nodes[index]?.classList.add(className);
      });
    } catch (parseFailure) {
      if (!(parseFailure instanceof ParseError)) throw parseFailure;
      this.el.programView.replaceChildren(renderProgramWithError(text, parseFailure.data.offset));
    }
  }

  private mountTapeView(): void {
    const run = this.run;
    if (run === null) return;
    const tapeLabel = this.i18n.t('a11y.tapeViewLabel');
    this.tapeRenderer.mount(this.el.tapeView, run.tapeText, run.headPosition, tapeLabel);
    scrollElementIntoView(this.tapeRenderer.currentCell, {
      block: 'nearest',
      inline: 'nearest',
    });
  }

  private updateTapeView(scrollToHead: boolean): void {
    const run = this.run;
    if (run === null) return;
    const tapeLabel = this.i18n.t('a11y.tapeViewLabel');
    this.tapeRenderer.update(run.tapeText, run.headPosition, tapeLabel);
    if (scrollToHead) {
      scrollElementIntoView(this.tapeRenderer.currentCell, {
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }

  /** Maintain O(1) execution counts per command so stepping backward restores `.visited` exactly. */
  private recordVisited(command: Command, delta: 1 | -1): void {
    const index = this.commandIndex.get(command);
    if (index === undefined) return;

    const prev = this.visitCounts.get(index) ?? 0;
    const next = Math.max(0, prev + delta);
    const node = this.commandNodes[index];

    if (next === 0) {
      this.visitCounts.delete(index);
      if (prev > 0) node?.classList.remove('visited');
    } else {
      this.visitCounts.set(index, next);
      if (prev === 0) node?.classList.add('visited');
    }
  }

  private setStepDirection(direction: 'forward' | 'reverse'): void {
    this.stepDirection = direction;
    this.el.programView.dataset.stepDir = direction;
  }

  private clearCurrentCommandHighlight(): void {
    if (this.currentCommandNode !== null) {
      this.currentCommandNode.classList.remove('current');
      this.currentCommandNode = null;
    }
  }

  private clearErrorCommandHighlight(): void {
    if (this.errorCommandNode !== null) {
      this.errorCommandNode.classList.remove('error');
      this.errorCommandNode = null;
    }
  }

  private highlightCurrentCommand(next: Command | undefined): void {
    this.clearCurrentCommandHighlight();
    if (next === undefined) return;

    const index = this.commandIndex.get(next);
    if (index !== undefined) {
      const current = this.commandNodes[index] ?? null;
      if (current !== null) {
        current.classList.add('current');
        this.currentCommandNode = current;
        scrollElementIntoView(current, { block: 'nearest' });
      }
      this.returnCursorOffset = next.source.offset;
    }
  }

  private reportRuntimeError(error: unknown): void {
    this.clearAutoHandles();
    if (error instanceof NoSuchCommandError) {
      this.clearCurrentCommandHighlight();
      const q = String(error.data.state);
      const a = error.data.symbol;
      this.notifications.show('error', (i) => i.t('error.noSuchCommand', { q, a }));
      this.options.onModeChange(this.mode);
      this.notifyRunState();
      return;
    }
    if (error instanceof OutOfTapeError) {
      // Mark the offending command as an error rather than leaving it green.
      this.clearCurrentCommandHighlight();
      this.clearErrorCommandHighlight();
      const offendingCommand = error.data.command;
      const index = offendingCommand !== null ? this.commandIndex.get(offendingCommand) : undefined;
      const node = index !== undefined ? (this.commandNodes[index] ?? null) : null;
      if (node !== null) {
        node.classList.add('error');
        this.errorCommandNode = node;
        scrollElementIntoView(node, { block: 'nearest' });
      }
      if (offendingCommand !== null) {
        this.returnCursorOffset = offendingCommand.source.offset;
      }
      this.notifications.show('error', (i) => i.t('error.headIsOutOfTape'));
      this.options.onModeChange(this.mode);
      this.notifyRunState();
      return;
    }
    throw error;
  }

  private reportFinish(run: MachineRun): void {
    this.clearAutoHandles();
    switch (run.checkNormality()) {
      case 'sourceAltered':
        this.notifications.show('warning', (i) => i.t('log.warningSourceAltered'));
        break;
      case 'misplaced':
        this.notifications.show('warning', (i) => i.t('log.warningMisposition'));
        break;
      case 'normal':
        this.notifications.show('info', (i) => i.t('log.finished'));
        break;
    }
    this.options.onModeChange(this.mode);
    this.notifyRunState();
  }

  private scheduleAutoTick(initialDelayMs?: number): void {
    if (this.speed === 0) return;

    this.autoRunning = true;
    const generation = ++this.autoGeneration;
    const interval = stepIntervalMs(this.speed);

    if (interval < RAF_THRESHOLD_MS) {
      // High-speed mode (|speed| > 10×): compute a rate-accurate, time-budgeted
      // batch per animation frame, flushing DOM updates only once at frame end.
      let lastFrameAt = performance.now();
      let stepBudget = 0;

      const frame = (now: number): void => {
        if (generation !== this.autoGeneration) return;
        this.autoRaf = null;
        if (this.speed === 0) {
          this.clearAutoHandles();
          this.options.onModeChange(this.mode);
          this.notifyRunState();
          return;
        }

        const elapsedMs = Math.max(0, Math.min(100, now - lastFrameAt));
        lastFrameAt = now;
        stepBudget += (elapsedMs * BASE_STEPS_PER_SECOND * Math.abs(this.speed)) / 1000;

        const targetSteps = Math.min(
          MAX_BATCH_STEPS_PER_FRAME,
          Math.max(1, Math.floor(stepBudget)),
        );
        const deadline = performance.now() + MAX_BATCH_MS_PER_FRAME;
        const opsBefore = this.stats.operationsCount;
        const direction = this.speed > 0 ? 'forward' : 'reverse';
        let stepped = 0;
        let keepGoing = true;

        while (
          keepGoing &&
          stepped < targetSteps &&
          (stepped === 0 || performance.now() < deadline)
        ) {
          keepGoing =
            direction === 'forward'
              ? this.stepForwardOnce(false, false)
              : this.stepBackOnce(false, false);
          stepped += 1;
        }
        stepBudget = Math.max(0, stepBudget - stepped);
        this.lastStepAt = performance.now();

        if (stepped > 0 && keepGoing && generation === this.autoGeneration) {
          this.flushRunView(direction);
        }
        if (this.stats.operationsCount !== opsBefore) this.options.onStepSound?.();

        if (!keepGoing || generation !== this.autoGeneration) {
          this.options.onModeChange(this.mode);
          return;
        }

        this.autoRaf = requestAnimationFrame(frame);
      };

      this.autoRaf = requestAnimationFrame(frame);
      this.options.onModeChange(this.mode);
      this.notifyRunState();
      return;
    }

    const tick = (): void => {
      if (generation !== this.autoGeneration) return;
      this.autoTimer = null;
      this.lastStepAt = performance.now();

      if (this.speed === 0) {
        this.clearAutoHandles();
        this.options.onModeChange(this.mode);
        this.notifyRunState();
        return;
      }

      const keepGoing =
        this.speed > 0 ? this.stepForwardOnce(true, true) : this.stepBackOnce(true, true);
      if (!keepGoing || generation !== this.autoGeneration) {
        this.options.onModeChange(this.mode);
        return;
      }

      this.autoTimer = setTimeout(tick, Math.round(stepIntervalMs(this.speed)));
    };

    const delay = initialDelayMs ?? Math.round(interval);
    this.autoTimer = setTimeout(tick, delay);
    this.options.onModeChange(this.mode);
    this.notifyRunState();
  }

  private clearAutoHandles(): void {
    this.autoRunning = false;
    this.autoGeneration += 1;
    if (this.autoTimer !== null) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
    if (this.autoRaf !== null) {
      cancelAnimationFrame(this.autoRaf);
      this.autoRaf = null;
    }
  }

  private renderStats(): void {
    const rows: ReadonlyArray<readonly [string, number]> = [
      [this.i18n.t('stats.commands'), this.stats.commandsCount],
      [this.i18n.t('stats.initialLength'), this.stats.initialDataLength],
      [this.i18n.t('stats.cellsUsed'), this.stats.maxDataLength],
      [this.i18n.t('stats.operations'), this.stats.operationsCount],
    ];
    const fragment = document.createDocumentFragment();
    rows.forEach(([label, value], index) => {
      if (index > 0) fragment.append(document.createTextNode('\n'));
      const row = el('div', { class: 'stat-row' });
      row.append(
        el('span', { class: 'stat-row__label' }, `${label}: `),
        el('strong', { class: 'stat-row__value' }, this.i18n.formatNumber(value)),
      );
      fragment.append(row);
    });
    this.el.stats.replaceChildren(fragment);
  }

  private setMode(mode: UIMode): void {
    this.mode = mode;
    this.el.controls.dataset.mode = mode;
    document.body.dataset.mode = mode;
    this.options.onModeChange(mode);
  }
}
