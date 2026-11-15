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

interface RunStats {
  commandsCount: number;
  initialDataLength: number;
  maxDataLength: number;
  operationsCount: number;
}

const STAT_LABEL_KEYS = [
  'stats.commands',
  'stats.initialLength',
  'stats.cellsUsed',
  'stats.operations',
] as const;

interface StatRowNodes {
  readonly row: HTMLElement;
  readonly label: HTMLElement;
  readonly value: HTMLElement;
  lastValue: number;
}

const RAF_THRESHOLD_MS = 20;
const MAX_BATCH_STEPS_PER_FRAME = 256;
const MAX_BATCH_MS_PER_FRAME = 6;

/** Normalise tabs and pasted line breaks to spaces (1-to-1 per tape cell). */
export function coerceTape(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ');
}

function scrollIntoView(
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
  private stats: RunStats | null = null;
  private statsNodes: StatRowNodes[] | null = null;

  constructor(options: ControllerOptions) {
    this.options = options;
    this.i18n = options.i18n;
    this.el = options.elements;
    this.ownsNotifications = options.notifications === undefined;
    this.notifications =
      options.notifications ??
      new NotificationLog({ element: options.elements.log, i18n: options.i18n });
    this.minSpeed = clampMinSpeed(options.initialMinSpeed ?? DEFAULT_MIN_SPEED);
    this.maxSpeed = clampMaxSpeed(options.initialMaxSpeed ?? DEFAULT_MAX_SPEED);
    this.speed = clampSpeed(options.initialSpeed ?? DEFAULT_SPEED, this.minSpeed, this.maxSpeed);
    this.unsubscribeI18n = this.i18n.subscribe(() => {
      if (this.stats !== null) this.renderStats(true);
      if (this.mode === 'run') this.renderTapeView(false);
    });
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
    return this.autoRunning || this.canStepInDirection(this.speed);
  }

  /** Notify controller that the user started dragging the speed slider thumb. */
  beginSpeedDrag(): void {
    this.draggingSpeed = true;
    this.resumeAfterZeroDrag = this.autoRunning;
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
      if (this.autoRunning) {
        if (this.draggingSpeed) this.resumeAfterZeroDrag = true;
        this.clearAutoHandles();
        this.options.onModeChange(this.mode);
      }
      this.notifyRunState();
      return next;
    }

    if (this.autoRunning) {
      this.clearAutoHandles();
      if (this.canStepInDirection(next)) {
        const remaining = Math.max(
          0,
          Math.round(stepIntervalMs(this.speed) - (performance.now() - this.lastStepAt)),
        );
        this.scheduleAutoTick(remaining);
      } else {
        if (next < 0 && this.run !== null && !this.run.canStepBack) {
          this.notifyStepBackBoundary(this.run);
        }
        this.options.onModeChange(this.mode);
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

  /** Change the lower (negative) speed bound and clamp current speed if needed. */
  setMinSpeed(value: number): { readonly minSpeed: number; readonly speed: number } {
    this.minSpeed = clampMinSpeed(value);
    this.clampSpeedToBounds();
    return { minSpeed: this.minSpeed, speed: this.speed };
  }

  /** Change the upper (positive) speed bound and clamp current speed if needed. */
  setMaxSpeed(value: number): { readonly maxSpeed: number; readonly speed: number } {
    this.maxSpeed = clampMaxSpeed(value);
    this.clampSpeedToBounds();
    return { maxSpeed: this.maxSpeed, speed: this.speed };
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
    this.renderTapeView(true);

    this.stats = {
      commandsCount: parsed.commands.length,
      initialDataLength: this.run.initialTape.length,
      maxDataLength: this.run.cellsUsed,
      operationsCount: 0,
    };
    this.renderStats();

    this.setMode('run');
    this.el.programView.scrollTop = scrollTop;
    this.setStepDirection('forward');
    this.markCommand('current', this.run.nextCommand, false);
    this.notifications.clear();
    this.notifyRunState();
    // Flush layout-dependent scroll calls after all DOM writes.
    this.tapeRenderer.scrollToHead();
    scrollIntoView(this.currentCommandNode);
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
    if (this.autoRunning) {
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
    if (!this.autoRunning) return;
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
    if (this.mode === 'edit') {
      if (withModifier) this.start();
    } else if (this.mode === 'run') {
      if (this.canAutoRun) this.toggleAutoRun();
      else if (!this.isMachineRunning && this.speed >= 0) this.backToEdit('tape');
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
      if (this.autoRunning) this.stopAutoRun();
      else this.backToEdit('tape');
      return;
    }
    this.backToEdit('program');
  }

  dispose(): void {
    this.stopAutoRun();
    this.unsubscribeI18n();
    this.tapeRenderer.clear();
    this.statsNodes = null;
    if (this.ownsNotifications) this.notifications.dispose();
  }

  // ——— internals ——————————————————————————————————————————————————

  private clampSpeedToBounds(): void {
    const clamped = clampSpeed(this.speed, this.minSpeed, this.maxSpeed);
    if (clamped !== this.speed) this.setSpeed(clamped);
  }

  private clearVisitedMarks(): void {
    for (const index of this.visitCounts.keys()) {
      this.commandNodes[index]?.classList.remove('visited');
    }
    this.visitCounts.clear();
  }

  private resetRunObjects(): void {
    this.stopAutoRun();
    this.run = null;
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
    compiled.commands.forEach((command, index) => this.commandIndex.set(command, index));
    this.commandNodes = Array.from(this.el.programView.querySelectorAll<HTMLElement>('.cmd'));
    this.currentCommandNode = null;
    this.errorCommandNode = null;
  }

  private canStepInDirection(speed: number): boolean {
    if (this.run === null || speed === 0) return false;
    return speed > 0 ? this.run.isRunning : this.run.canStepBack;
  }

  private notifyRunState(): void {
    this.options.onRunStateChange?.({
      isRunning: this.isMachineRunning,
      isAutoRunning: this.autoRunning,
      canStepForward: this.canStepForward,
      canStepBack: this.canStepBack,
      canAutoRun: this.canAutoRun,
      canRestart: this.canRestart,
      speed: this.speed,
    });
  }

  private haltAutoRun(): void {
    this.clearAutoHandles();
    this.options.onModeChange(this.mode);
    this.notifyRunState();
  }

  /** Synchronize stats, tape, step direction, and optional command highlight with `this.run`. */
  private syncRunView(direction: 'forward' | 'reverse', highlight = true): void {
    const run = this.run;
    if (run === null) return;
    // Batch all DOM writes first, then issue layout-reading scrollIntoView calls.
    if (this.stats !== null) {
      this.stats.operationsCount = run.stepsCount;
      this.stats.maxDataLength = run.cellsUsed;
      this.renderStats();
    }
    this.renderTapeView(false);
    this.setStepDirection(direction);
    if (highlight) this.markCommand('current', run.nextCommand, false);
    this.tapeRenderer.scrollToHead();
    if (highlight) scrollIntoView(this.currentCommandNode);
  }

  private flushRunView(direction: 'forward' | 'reverse'): void {
    this.syncRunView(direction);
    this.notifications.clear();
    this.notifyRunState();
  }

  private stepForwardOnce(playSound: boolean, render: boolean): boolean {
    const run = this.run;
    if (run === null || !run.isRunning) return false;

    const executed = run.nextCommand;
    try {
      run.step();
    } catch (error) {
      this.syncRunView('forward', false);
      this.reportRuntimeError(error);
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
      this.notifyStepBackBoundary(run);
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
      this.notifyStepBackBoundary(run);
      this.haltAutoRun();
      return false;
    }

    if (render) this.flushRunView('reverse');
    else this.stepDirection = 'reverse';
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
      this.notifications.show('error', (i) => i.t('error.parseError', { text: error.data.text }));
    } else if (error instanceof EmptyProgramError) {
      this.el.programView.textContent = text;
      this.notifications.show('error', (i) => i.t('error.programIsEmpty'));
    } else if (error instanceof AmbiguousCommandError) {
      this.returnCursorOffset = error.data.command.source.offset;
      this.renderProgramWithErrors(text, [error.data.command, error.data.original]);
      const { q, a } = error.data.command;
      this.notifications.show('error', (i) => i.t('error.ambiguousCommand', { q: String(q), a }));
    } else if (error instanceof NonexistentTargetStateError) {
      this.returnCursorOffset = error.data.command.source.offset;
      this.renderProgramWithErrors(text, [error.data.command]);
      const w = String(error.data.command.w);
      this.notifications.show('error', (i) => i.t('error.targetStateDoesNotExist', { w }));
    } else if (error instanceof NonexistentInitialStateError) {
      this.renderProgramWithErrors(text, []);
      const q = String(error.data.state);
      this.notifications.show('error', (i) => i.t('error.initialStateDoesNotExist', { q }));
    } else {
      throw error;
    }

    this.el.programView.scrollTop = scrollTop;
    scrollIntoView(this.el.programView.querySelector('mark.error, .cmd.error'));
    // Move focus out of `#input-tape` so Enter/Escape immediately return to edit mode.
    this.el.programView.focus({ preventScroll: true });
  }

  /** Render syntax-highlighted commands with offending commands marked `.error`. */
  private renderProgramWithErrors(text: string, commands: readonly Command[]): void {
    try {
      const listing = listProgram(text);
      this.el.programView.replaceChildren(renderProgram(listing));
      const nodes = Array.from(this.el.programView.querySelectorAll<HTMLElement>('.cmd'));
      const offsets = new Set(commands.map((command) => command.source.offset));
      listing.commands.forEach((command, index) => {
        if (offsets.has(command.source.offset)) nodes[index]?.classList.add('error');
      });
    } catch (parseFailure) {
      if (!(parseFailure instanceof ParseError)) throw parseFailure;
      this.el.programView.replaceChildren(renderProgramWithError(text, parseFailure.data.offset));
    }
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
    const prev = kind === 'current' ? this.currentCommandNode : this.errorCommandNode;

    let nextNode: HTMLElement | null = null;
    if (command !== null && command !== undefined) {
      const index = this.commandIndex.get(command);
      nextNode = index !== undefined ? (this.commandNodes[index] ?? null) : null;
      this.returnCursorOffset = command.source.offset;
    }

    if (prev !== nextNode) {
      prev?.classList.remove(kind);
      nextNode?.classList.add(kind);
      if (kind === 'current') this.currentCommandNode = nextNode;
      else this.errorCommandNode = nextNode;
    }

    if (scroll && nextNode !== null) scrollIntoView(nextNode);
  }

  private reportRuntimeError(error: unknown): void {
    this.markCommand('current', null);
    if (error instanceof NoSuchCommandError) {
      const q = String(error.data.state);
      const a = error.data.symbol;
      this.notifications.show('error', (i) => i.t('error.noSuchCommand', { q, a }));
      this.haltAutoRun();
      return;
    }
    if (error instanceof OutOfTapeError) {
      this.markCommand('error', error.data.command);
      this.notifications.show('error', (i) => i.t('error.headIsOutOfTape'));
      this.haltAutoRun();
      return;
    }
    throw error;
  }

  private reportFinish(run: MachineRun): void {
    const normality = run.checkNormality();
    const [kind, key] =
      normality === 'sourceAltered'
        ? (['warning', 'log.warningSourceAltered'] as const)
        : normality === 'misplaced'
          ? (['warning', 'log.warningMisposition'] as const)
          : (['info', 'log.finished'] as const);
    this.notifications.show(kind, (i) => i.t(key));
    this.haltAutoRun();
  }

  private stepInDirection(
    direction: 'forward' | 'reverse',
    playSound: boolean,
    render: boolean,
  ): boolean {
    return direction === 'forward'
      ? this.stepForwardOnce(playSound, render)
      : this.stepBackOnce(playSound, render);
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
          this.haltAutoRun();
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
        const opsBefore = this.run?.stepsCount ?? 0;
        const direction = this.speed > 0 ? 'forward' : 'reverse';
        let stepped = 0;
        let keepGoing = true;

        while (
          keepGoing &&
          stepped < targetSteps &&
          (stepped === 0 || performance.now() < deadline)
        ) {
          keepGoing = this.stepInDirection(direction, false, false);
          stepped += 1;
        }
        stepBudget = Math.max(0, stepBudget - stepped);
        this.lastStepAt = performance.now();

        if (stepped > 0 && keepGoing && generation === this.autoGeneration) {
          this.flushRunView(direction);
        }
        if ((this.run?.stepsCount ?? 0) !== opsBefore) this.options.onStepSound?.();

        if (!keepGoing || generation !== this.autoGeneration) {
          this.options.onModeChange(this.mode);
          return;
        }
        this.autoRaf = requestAnimationFrame(frame);
      };

      this.autoRaf = requestAnimationFrame(frame);
    } else {
      const tick = (): void => {
        if (generation !== this.autoGeneration) return;
        this.autoTimer = null;
        this.lastStepAt = performance.now();
        if (this.speed === 0) {
          this.haltAutoRun();
          return;
        }

        const direction = this.speed > 0 ? 'forward' : 'reverse';
        if (!this.stepInDirection(direction, true, true) || generation !== this.autoGeneration) {
          this.options.onModeChange(this.mode);
          return;
        }
        this.autoTimer = setTimeout(tick, Math.round(stepIntervalMs(this.speed)));
      };

      this.autoTimer = setTimeout(tick, initialDelayMs ?? Math.round(interval));
    }

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

  private renderStats(refreshLabels = false): void {
    if (this.stats === null) return;
    const values: readonly [number, number, number, number] = [
      this.stats.commandsCount,
      this.stats.initialDataLength,
      this.stats.maxDataLength,
      this.stats.operationsCount,
    ];

    if (this.statsNodes === null || !this.el.stats.contains(this.statsNodes[0]?.row ?? null)) {
      const fragment = document.createDocumentFragment();
      const nodes: StatRowNodes[] = [];
      STAT_LABEL_KEYS.forEach((key, index) => {
        if (index > 0) fragment.append(document.createTextNode('\n'));
        const val = values[index] ?? 0;
        const label = el('span', { class: 'stat-row__label' }, `${this.i18n.t(key)}: `);
        const value = el('strong', { class: 'stat-row__value' }, this.i18n.formatNumber(val));
        const row = el('div', { class: 'stat-row' }, label, value);
        fragment.append(row);
        nodes.push({ row, label, value, lastValue: val });
      });
      this.el.stats.replaceChildren(fragment);
      this.statsNodes = nodes;
      return;
    }

    for (let i = 0; i < this.statsNodes.length; i += 1) {
      const node = this.statsNodes[i];
      const key = STAT_LABEL_KEYS[i];
      const val = values[i];
      if (node === undefined || key === undefined || val === undefined) continue;
      if (refreshLabels) {
        node.label.textContent = `${this.i18n.t(key)}: `;
        node.lastValue = val;
        node.value.textContent = this.i18n.formatNumber(val);
      } else if (node.lastValue !== val) {
        node.lastValue = val;
        node.value.textContent = this.i18n.formatNumber(val);
      }
    }
  }

  private setMode(mode: UIMode): void {
    this.mode = mode;
    this.el.controls.dataset.mode = mode;
    document.body.dataset.mode = mode;
    this.options.onModeChange(mode);
  }
}
