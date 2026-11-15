import type { CompileError } from '../core/errors';
import type { Command } from '../core/machine';
import { createProgram } from '../core/program';
import { MachineRun } from '../core/run';
import { toTu4 } from '../core/tu4';
import type { I18n } from '../i18n';
import { AutoRunner, type StepDirection } from './auto-runner';
import { copyTextToClipboard } from './clipboard';
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
import { SpeedController } from './speed-controller';
import { createStatsView, type StatsView } from './stats-view';

export type { LogKind };
export type UIMode = 'edit' | 'run' | 'error';

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

/** Normalise tabs and pasted line breaks to spaces (1-to-1 per tape cell). */
export function coerceTape(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ');
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
  private readonly statsView: StatsView;
  private readonly autoRunner: AutoRunner;
  private readonly speedCtrl: SpeedController;

  private mode: UIMode = 'edit';
  private run: MachineRun | null = null;
  private readonly tapeRenderer = new TapeRenderer();
  private readonly programRenderer = new ProgramRenderer();
  private readonly commandIndex = new Map<Command, number>();
  private readonly visitCounts = new Map<number, number>();
  private stepDirection: StepDirection = 'forward';
  private returnCursorOffset: number | null = null;

  constructor(options: ControllerOptions) {
    this.options = options;
    this.i18n = options.i18n;
    this.el = options.elements;
    this.ownsNotifications = options.notifications === undefined;
    this.notifications =
      options.notifications ??
      createNotificationLog({ element: options.elements.log, i18n: options.i18n });
    this.statsView = createStatsView(options.elements.stats, options.i18n);
    this.autoRunner = new AutoRunner({
      getSpeed: () => this.speedCtrl.current,
      getOpsCount: () => this.run?.stepsCount ?? 0,
      step: (dir, sound, render) => this.stepInDirection(dir, sound, render),
      onBatchFlush: (dir) => this.flushRunView(dir),
      onSound: () => this.options.onStepSound?.(),
      onHalt: () => this.haltAutoRun(),
      onModeNotify: () => this.options.onModeChange(this.mode),
      onRunStateNotify: () => this.notifyRunState(),
    });
    this.speedCtrl = new SpeedController({
      initialSpeed: options.initialSpeed,
      initialMinSpeed: options.initialMinSpeed,
      initialMaxSpeed: options.initialMaxSpeed,
      autoRunner: this.autoRunner,
      canStepInDirection: (s) => this.canStepInDirection(s),
      onReverseBoundary: () => {
        if (this.run !== null && !this.run.canStepBack) {
          displayStepBackBoundary(this.run, this.notifications);
        }
      },
      onModeNotify: () => this.options.onModeChange(this.mode),
      onRunStateNotify: () => this.notifyRunState(),
    });
    this.unsubscribeI18n = this.i18n.subscribe(() => {
      this.statsView.refreshLabels();
      if (this.mode === 'run') this.renderTapeView(false);
    });
  }

  get currentMode(): UIMode {
    return this.mode;
  }

  get isAutoRunning(): boolean {
    return this.autoRunner.isRunning;
  }

  get lastStepDirection(): StepDirection {
    return this.stepDirection;
  }

  get currentSpeed(): number {
    return this.speedCtrl.current;
  }

  get currentMinSpeed(): number {
    return this.speedCtrl.min;
  }

  get currentMaxSpeed(): number {
    return this.speedCtrl.max;
  }

  get isMachineRunning(): boolean {
    return this.mode === 'run' && this.run !== null && this.run.isRunning;
  }

  get canStepForward(): boolean {
    return this.isMachineRunning;
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
    return this.autoRunner.isRunning || this.canStepInDirection(this.speedCtrl.current);
  }

  /** Notify controller that the user started dragging the speed slider thumb. */
  beginSpeedDrag(): void {
    this.speedCtrl.beginDrag();
  }

  /** Notify controller that the user finished dragging the speed slider thumb. */
  endSpeedDrag(): void {
    this.speedCtrl.endDrag();
  }

  /**
   * Change auto-run speed multiplier (`currentMinSpeed` .. `currentMaxSpeed`).
   * Moving to `0` stops automatic execution immediately; negative values run
   * the machine in reverse.
   */
  setSpeed(value: number): number {
    return this.speedCtrl.setSpeed(value);
  }

  /** Change the lower (negative) speed bound and clamp current speed if needed. */
  setMinSpeed(value: number): { readonly minSpeed: number; readonly speed: number } {
    return this.speedCtrl.setMin(value);
  }

  /** Change the upper (positive) speed bound and clamp current speed if needed. */
  setMaxSpeed(value: number): { readonly maxSpeed: number; readonly speed: number } {
    return this.speedCtrl.setMax(value);
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
    this.speedCtrl.endDrag();
    this.run = new MachineRun(
      parsed.program,
      tape,
      this.options.maxHistory !== undefined ? { maxHistory: this.options.maxHistory } : {},
    );
    this.visitCounts.clear();
    this.returnCursorOffset = null;
    this.options.onProgramChange(this.el.programInput.value);
    this.options.onTapeChange(tape);

    this.programRenderer.mount(this.el.programView, parsed);
    this.indexCompiledCommands(parsed);
    this.renderTapeView(true);

    this.statsView.set({
      commandsCount: parsed.commands.length,
      initialDataLength: this.run.initialLength,
      maxDataLength: this.run.cellsUsed,
      operationsCount: 0,
    });

    this.setMode('run');
    this.programRenderer.syncScroll(scrollTop);
    this.setStepDirection('forward');
    this.markCommand('current', this.run.nextCommand, false);
    this.notifications.clear();
    this.notifyRunState();
    // Flush layout-dependent scroll calls after all DOM writes.
    this.tapeRenderer.scrollToHead();
    this.programRenderer.scrollToCurrent();
    // Move focus out of `#input-tape` (e.g. after pressing Enter) so Space/Enter/Esc work.
    this.el.programView.focus({ preventScroll: true });
  }

  /** Reset the active run back to step 0 without leaving run mode. */
  restart(): void {
    if (this.mode !== 'run' || this.run === null) return;

    this.stopAutoRun();
    this.run.reset();
    this.clearVisitedMarks();
    this.markCommand('current', null);
    this.markCommand('error', null);

    this.syncRunView('forward');
    this.notifications.show('info', (i) => i.t('log.restarted'));
    this.notifyRunState();
  }

  /** Pause auto-run (if active) and execute one command forward. */
  step(): boolean {
    this.stopAutoRun();
    return this.stepForwardOnce(true, true);
  }

  /** Pause auto-run (if active) and undo the last executed command. */
  stepBack(): boolean {
    this.stopAutoRun();
    return this.stepBackOnce(true, true);
  }

  /** Toggle automatic execution in the current speed direction (no-op when speed is 0). */
  toggleAutoRun(): void {
    if (this.autoRunner.isRunning) {
      this.stopAutoRun();
      return;
    }
    const speed = this.speedCtrl.current;
    if (this.mode !== 'run' || this.run === null || speed === 0) return;

    if (speed < 0 && !this.run.canStepBack) {
      displayStepBackBoundary(this.run, this.notifications);
      this.notifyRunState();
      return;
    }
    if (speed > 0 && !this.run.isRunning) return;

    this.autoRunner.markSteppedNow();
    this.autoRunner.schedule();
  }

  /** Pause automatic execution without discarding the current run state. */
  stopAutoRun(): void {
    if (!this.autoRunner.isRunning) return;
    this.haltAutoRun();
  }

  /** Stop everything and return to the editable fields. */
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

  /** Pause auto-run (if active) and clear visited command marks. */
  unmark(): void {
    this.stopAutoRun();
    this.clearVisitedMarks();
  }

  /** Copy the program source to the clipboard. */
  async copyProgram(): Promise<void> {
    if (await copyTextToClipboard(this.el.programInput.value, this.el.programInput)) {
      this.notifications.show('info', (i) => i.t('log.copied'));
    }
  }

  /** Convert the current program to TU4 format without modifying the editor. */
  toTu4(): string | null {
    const parsed = this.parseInput();
    if (parsed === null) return null;

    const converted = toTu4(parsed.program);
    if (!converted.ok) {
      this.notifications.show('error', (i) => i.t('error.tooManyStates'));
      return null;
    }

    this.notifications.show('info', (i) => i.t('log.convertedToTu4'));
    this.options.onTu4Converted?.(converted.value);
    return converted.value;
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
    if (this.mode === 'edit') {
      if (withModifier) this.start();
    } else if (this.mode === 'run') {
      if (this.canAutoRun) this.toggleAutoRun();
      else if (!this.isMachineRunning && this.speedCtrl.current >= 0) this.backToEdit('tape');
    } else {
      this.backToEdit('program');
    }
  }

  handleSpace(): void {
    if (this.mode === 'run') this.step();
  }

  handleShiftSpace(): void {
    if (this.mode === 'run') this.stepBack();
  }

  handleEscape(): void {
    if (this.mode === 'edit') return;
    if (this.mode === 'run') {
      if (this.autoRunner.isRunning) this.stopAutoRun();
      else this.backToEdit('tape');
      return;
    }
    this.backToEdit('program');
  }

  dispose(): void {
    this.stopAutoRun();
    this.unsubscribeI18n();
    this.tapeRenderer.clear();
    this.programRenderer.clear();
    this.statsView.dispose();
    if (this.ownsNotifications) this.notifications.dispose();
  }

  // ——— internals ——————————————————————————————————————————————————

  private clearVisitedMarks(): void {
    this.programRenderer.clearVisited();
    this.visitCounts.clear();
  }

  private resetRunObjects(): void {
    this.stopAutoRun();
    this.speedCtrl.endDrag();
    this.run = null;
    this.commandIndex.clear();
    this.visitCounts.clear();
    this.tapeRenderer.clear();
    this.programRenderer.clear();
    this.returnCursorOffset = null;
  }

  private indexCompiledCommands(compiled: CompiledProgram): void {
    this.commandIndex.clear();
    compiled.commands.forEach((command, index) => this.commandIndex.set(command, index));
  }

  private canStepInDirection(speed: number): boolean {
    if (this.run === null || speed === 0) return false;
    return speed > 0 ? this.run.isRunning : this.run.canStepBack;
  }

  private notifyRunState(): void {
    this.options.onRunStateChange?.({
      isRunning: this.isMachineRunning,
      isAutoRunning: this.autoRunner.isRunning,
      canStepForward: this.canStepForward,
      canStepBack: this.canStepBack,
      canAutoRun: this.canAutoRun,
      canRestart: this.canRestart,
      speed: this.speedCtrl.current,
    });
  }

  private haltAutoRun(): void {
    this.autoRunner.cancel();
    this.options.onModeChange(this.mode);
    this.notifyRunState();
  }

  /** Synchronize stats, tape, step direction, and optional command highlight with `this.run`. */
  private syncRunView(direction: StepDirection, highlight = true): void {
    const run = this.run;
    if (run === null) return;
    // Batch all DOM writes first, then issue layout-reading scroll calls.
    this.statsView.updateProgress(run.stepsCount, run.cellsUsed);
    this.renderTapeView(false);
    this.setStepDirection(direction);
    if (highlight) this.markCommand('current', run.nextCommand, false);
    this.tapeRenderer.scrollToHead();
    if (highlight) this.programRenderer.scrollToCurrent();
  }

  private flushRunView(direction: StepDirection): void {
    this.syncRunView(direction);
    this.notifications.clear();
    this.notifyRunState();
  }

  private stepForwardOnce(playSound: boolean, render: boolean): boolean {
    const run = this.run;
    if (run === null || !run.isRunning) return false;

    const executed = run.nextCommand;
    const outcome = run.step();
    if (!outcome.ok) {
      this.syncRunView('forward', false);
      this.markCommand('current', null);
      displayRuntimeError(outcome.error, this.notifications, (cmd) =>
        this.markCommand('error', cmd),
      );
      this.haltAutoRun();
      return false;
    }

    if (executed !== undefined) {
      this.recordVisited(executed, 1);
      this.returnCursorOffset = executed.source.offset;
    }

    if (run.isRunning) {
      if (render) this.flushRunView('forward');
      else this.stepDirection = 'forward';
      if (playSound) this.options.onStepSound?.();
      return true;
    }

    this.syncRunView('forward');
    if (playSound) this.options.onStepSound?.();
    displayRunFinish(run, this.notifications);
    this.haltAutoRun();
    return false;
  }

  private stepBackOnce(playSound: boolean, render: boolean): boolean {
    const run = this.run;
    if (run === null) return false;

    if (!run.canStepBack) {
      displayStepBackBoundary(run, this.notifications);
      this.haltAutoRun();
      return false;
    }

    const undone = run.stepBack();
    if (undone === null) return false;

    this.recordVisited(undone, -1);
    this.markCommand('error', null);

    if (!run.canStepBack) {
      this.syncRunView('reverse');
      if (playSound) this.options.onStepSound?.();
      displayStepBackBoundary(run, this.notifications);
      this.haltAutoRun();
      return false;
    }

    if (render) this.flushRunView('reverse');
    else this.stepDirection = 'reverse';
    if (playSound) this.options.onStepSound?.();
    return true;
  }

  private parseInput(): CompiledProgram | null {
    const text = this.el.programInput.value;
    const listed = listProgram(text);
    if (!listed.ok) {
      return this.reportCompileFailure(text, null, listed.error);
    }

    const created = createProgram(listed.value.commands, 0);
    if (!created.ok) {
      return this.reportCompileFailure(text, listed.value, created.error);
    }

    return { ...listed.value, program: created.value };
  }

  private reportCompileFailure(
    text: string,
    listing: ProgramListing | null,
    error: CompileError,
  ): null {
    const scrollTop = this.el.programInput.scrollTop;
    this.resetRunObjects();
    this.setMode('error');
    this.returnCursorOffset = displayCompileError(error, {
      text,
      listing,
      programView: this.el.programView,
      programRenderer: this.programRenderer,
      notifications: this.notifications,
    });
    this.notifyRunState();
    this.programRenderer.syncScroll(scrollTop);
    this.programRenderer.scrollToFirstError();
    // Move focus out of `#input-tape` so Enter/Escape immediately return to edit mode.
    this.el.programView.focus({ preventScroll: true });
    return null;
  }

  private renderTapeView(mount: boolean): void {
    const run = this.run;
    if (run === null) return;
    const label = this.i18n.t('a11y.tapeViewLabel');
    const dirty = run.consumeDirtyCells();
    if (mount) {
      this.tapeRenderer.mount(this.el.tapeView, run.tapeCells, run.headPosition, label);
    } else {
      this.tapeRenderer.update(run.tapeCells, run.headPosition, label, dirty);
    }
  }

  /** Maintain O(1) execution counts per command so stepping backward restores `.visited` exactly. */
  private recordVisited(command: Command, delta: 1 | -1): void {
    const index = this.commandIndex.get(command);
    if (index === undefined) return;

    const prev = this.visitCounts.get(index) ?? 0;
    const next = Math.max(0, prev + delta);

    if (next === 0) {
      this.visitCounts.delete(index);
      if (prev > 0) this.programRenderer.setVisited(index, false);
    } else {
      this.visitCounts.set(index, next);
      if (prev === 0) this.programRenderer.setVisited(index, true);
    }
  }

  private setStepDirection(direction: StepDirection): void {
    if (this.stepDirection === direction && this.el.programView.dataset.stepDir === direction) {
      return;
    }
    this.stepDirection = direction;
    this.el.programView.dataset.stepDir = direction;
  }

  private markCommand(
    kind: 'current' | 'error',
    command: Command | null | undefined,
    scroll = true,
  ): void {
    let index: number | null = null;
    if (command !== null && command !== undefined) {
      index = this.commandIndex.get(command) ?? null;
      this.returnCursorOffset = command.source.offset;
    }

    if (kind === 'current') {
      this.programRenderer.setCurrent(index, scroll);
    } else {
      this.programRenderer.setError(index, scroll);
    }
  }

  private stepInDirection(direction: StepDirection, playSound: boolean, render: boolean): boolean {
    return direction === 'forward'
      ? this.stepForwardOnce(playSound, render)
      : this.stepBackOnce(playSound, render);
  }

  private setMode(mode: UIMode): void {
    this.mode = mode;
    this.el.controls.dataset.mode = mode;
    document.body.dataset.mode = mode;
    this.options.onModeChange(mode);
  }
}
