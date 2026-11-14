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
import type { Messages } from '../i18n';
import {
  compileProgram,
  listProgram,
  renderProgram,
  renderProgramWithError,
  renderTape,
  type CompiledProgram,
} from './render';

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

export type LogKind = 'info' | 'warning' | 'error';

export interface ControllerOptions {
  readonly messages: Messages;
  readonly elements: AppElements;
  /** Called after every mode or quick-run state change so the shell can sync UI. */
  readonly onModeChange: (mode: UIMode) => void;
  /**
   * Called whenever the machine halts or starts running again, so the toolbar
   * can disable "Step"/"Quick" instead of leaving them looking usable.
   */
  readonly onRunningChange?: (isRunning: boolean) => void;
  /** Persist the program draft. */
  readonly onProgramChange: (text: string) => void;
  readonly onTapeChange: (text: string) => void;
  /** Optional per-step click. */
  readonly onStepSound?: () => void;
}

const QUICK_INTERVALS_MS = [70, 30, 10, 0] as const;
const MAX_BATCH_STEPS_PER_FRAME = 64;
const MAX_BATCH_MS_PER_FRAME = 6;

type LogDescriptor =
  | { readonly type: 'none' }
  | { readonly type: 'ready' }
  | { readonly type: 'restoredDraft' }
  | { readonly type: 'finished' }
  | { readonly type: 'sourceAltered' }
  | { readonly type: 'misplaced' }
  | { readonly type: 'convertedToTu4' }
  | { readonly type: 'copied' }
  | { readonly type: 'tooManyStates' }
  | { readonly type: 'parseError'; readonly text: string }
  | { readonly type: 'programIsEmpty' }
  | { readonly type: 'ambiguousCommand'; readonly q: string; readonly a: string }
  | { readonly type: 'targetStateDoesNotExist'; readonly w: string }
  | { readonly type: 'initialStateDoesNotExist'; readonly q: string }
  | { readonly type: 'headIsOutOfTape' }
  | { readonly type: 'noSuchCommand'; readonly q: string; readonly a: string };

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
 * The whole application behaviour, framework-free: one class, explicit state,
 * DOM events in, DOM updates out.
 */
export class AppController {
  private m: Messages;
  private readonly el: AppElements;
  private readonly options: ControllerOptions;

  private mode: UIMode = 'edit';
  private run: MachineRun | null = null;
  private compiled: CompiledProgram | null = null;

  private quickTimer: ReturnType<typeof setTimeout> | null = null;
  private quickRaf: number | null = null;
  private quickIndex = 0;
  private quickGeneration = 0;

  private returnCursorOffset: number | null = null;
  private lastLog: LogDescriptor = { type: 'none' };
  private hasStats = false;
  private stats = { commandsCount: 0, initialDataLength: 0, maxDataLength: 0, operationsCount: 0 };

  constructor(options: ControllerOptions) {
    this.options = options;
    this.m = options.messages;
    this.el = options.elements;
  }

  get currentMode(): UIMode {
    return this.mode;
  }

  get isQuickRunning(): boolean {
    return this.quickTimer !== null || this.quickRaf !== null;
  }

  get isQuickAtMaxSpeed(): boolean {
    return this.isQuickRunning && this.quickIndex >= QUICK_INTERVALS_MS.length - 1;
  }

  get isMachineRunning(): boolean {
    return this.run?.isRunning ?? false;
  }

  /** Switch UI language in place without dropping the draft or active run. */
  setMessages(messages: Messages): void {
    this.m = messages;
    this.renderLog();
    if (this.hasStats) this.renderStats();
    if (this.mode === 'run') this.renderTapeView();
  }

  /** Restore a draft on initial startup. */
  hydrate(program: string | null, tape: string | null): void {
    if (program !== null) this.el.programInput.value = program;
    if (tape !== null) this.el.tapeInput.value = tape;
    this.setMode('edit');
    this.setLog(program !== null ? { type: 'restoredDraft' } : { type: 'ready' });
  }

  // ——— user actions ————————————————————————————————————————————————

  /** "Start": compile the program and begin a new run. */
  start(): void {
    const parsed = this.parseInput();
    if (parsed === null) return;

    const scrollTop = this.el.programInput.scrollTop;
    const tape = coerceTape(this.el.tapeInput.value);
    if (tape !== this.el.tapeInput.value) this.el.tapeInput.value = tape;

    this.stopQuick();
    this.compiled = parsed;
    this.run = new MachineRun(parsed.program, tape);
    this.returnCursorOffset = null;
    this.options.onProgramChange(this.el.programInput.value);
    this.options.onTapeChange(tape);

    this.el.programView.replaceChildren(renderProgram(parsed));
    this.renderTapeView();

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
    this.markCommand(this.run.nextCommand);
    this.setLog({ type: 'none' });
    this.options.onRunningChange?.(this.run.isRunning);
    // Move focus out of any previously active input (e.g. `#input-tape` after
    // pressing Enter) so Space/Enter/Esc hotkeys work immediately in run mode.
    this.el.programView.focus({ preventScroll: true });
  }

  /**
   * "Step": leave quick mode (if active) and execute one command.
   * Returns whether the machine keeps running.
   */
  step(): boolean {
    this.stopQuick();
    return this.stepOnce(true);
  }

  /**
   * "Quick": start automatic execution; repeated clicks speed it up through
   * the speed tiers and wrap back to the initial speed at maximum.
   */
  quick(): void {
    if (!this.isMachineRunning) return;

    if (this.isQuickRunning) {
      this.stopQuick();
      this.quickIndex = (this.quickIndex + 1) % QUICK_INTERVALS_MS.length;
    } else {
      this.quickIndex = 0;
    }
    this.scheduleQuickTick();
  }

  /** "Back to edit": stop everything and return to the editable fields. */
  backToEdit(focus?: 'program' | 'tape'): void {
    const previousMode = this.mode;
    const scrollTop = this.el.programView.scrollTop;
    const cursorOffset = this.returnCursorOffset;

    this.stopQuick();
    this.run = null;
    this.compiled = null;
    this.returnCursorOffset = null;
    this.options.onRunningChange?.(false);
    this.setMode('edit');
    this.setLog({ type: 'none' });

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

  /** "Unmark": stop quick mode (if active) and clear visited command marks. */
  unmark(): void {
    this.stopQuick();
    this.el.programView.querySelectorAll('.cmd.visited').forEach((node) => {
      node.classList.remove('visited');
    });
  }

  /**
   * "Copy": copy the program to the clipboard. Falls back to textarea
   * selection + `execCommand` on non-secure origins or older browsers.
   */
  async copyProgram(): Promise<void> {
    const text = this.el.programInput.value;
    if (text === '') return;

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = this.el.programInput;
      input.focus();
      input.select();
      const copied = document.execCommand('copy');
      input.setSelectionRange(input.value.length, input.value.length);
      if (!copied) return;
    }
    this.setLog({ type: 'copied' });
  }

  /** "To TU4": convert the current program and replace the editor content. */
  toTu4(): void {
    const parsed = this.parseInput();
    if (parsed === null) return;

    try {
      const converted = toTu4(parsed.program);
      this.el.programInput.value = converted;
      this.options.onProgramChange(converted);
      this.setLog({ type: 'convertedToTu4' });
    } catch (error) {
      if (error instanceof RangeError) {
        this.setLog({ type: 'tooManyStates' });
        return;
      }
      throw error;
    }
  }

  /** Keyboard: Enter behaviour depends on the current mode. */
  handleEnter(withModifier = false): void {
    switch (this.mode) {
      case 'edit':
        if (withModifier) this.start();
        break;
      case 'run':
        if (this.isQuickRunning) this.stopQuick();
        else if (this.isMachineRunning) this.quick();
        else this.backToEdit('tape');
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

  handleEscape(): void {
    if (this.mode === 'edit') return;
    if (this.mode === 'run') {
      if (this.isQuickRunning) {
        this.stopQuick();
        return;
      }
      this.backToEdit('tape');
      return;
    }
    this.backToEdit('program');
  }

  dispose(): void {
    this.stopQuick();
  }

  // ——— internals ——————————————————————————————————————————————————

  private stepOnce(playSound: boolean): boolean {
    const run = this.run;
    if (run === null || !run.isRunning) return false;

    try {
      run.step();
    } catch (error) {
      this.renderTapeView();
      this.reportRuntimeError(error);
      return false;
    }

    this.stats.operationsCount += 1;
    this.stats.maxDataLength = Math.max(this.stats.maxDataLength, run.cellsUsed);
    this.renderStats();
    this.renderTapeView();
    this.markCommand(run.nextCommand);
    if (playSound) this.options.onStepSound?.();

    if (run.isRunning) {
      this.setLog({ type: 'none' });
      return true;
    }

    this.reportFinish(run);
    return false;
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
    this.setLog({ type: 'none' });

    if (error instanceof ParseError) {
      this.returnCursorOffset = error.data.offset;
      this.el.programView.replaceChildren(renderProgramWithError(text, error.data.offset));
      this.setLog({ type: 'parseError', text: error.data.text });
    } else if (error instanceof EmptyProgramError) {
      this.el.programView.textContent = text;
      this.setLog({ type: 'programIsEmpty' });
    } else if (error instanceof AmbiguousCommandError) {
      this.returnCursorOffset = error.data.command.source.offset;
      this.renderProgramWithMarks(text, [error.data.command, error.data.original], 'error');
      this.setLog({
        type: 'ambiguousCommand',
        q: String(error.data.command.q),
        a: error.data.command.a,
      });
    } else if (error instanceof NonexistentTargetStateError) {
      this.returnCursorOffset = error.data.command.source.offset;
      this.renderProgramWithMarks(text, [error.data.command], 'error');
      this.setLog({ type: 'targetStateDoesNotExist', w: String(error.data.command.w) });
    } else if (error instanceof NonexistentInitialStateError) {
      this.renderProgramWithMarks(text, [], 'error');
      this.setLog({ type: 'initialStateDoesNotExist', q: String(error.data.state) });
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
      const offsets = new Set(commands.map((command) => command.source.offset));
      listing.commands.forEach((command, index) => {
        if (offsets.has(command.source.offset)) this.commandNode(index)?.classList.add(className);
      });
    } catch (parseFailure) {
      if (!(parseFailure instanceof ParseError)) throw parseFailure;
      this.el.programView.replaceChildren(renderProgramWithError(text, parseFailure.data.offset));
    }
  }

  private renderTapeView(): void {
    const run = this.run;
    if (run === null) return;
    this.el.tapeView.replaceChildren(
      renderTape(run.tapeText, run.headPosition, this.m.a11y.tapeViewLabel),
    );
    this.el.tapeView.setAttribute('aria-label', this.m.a11y.tapeViewLabel);
    scrollElementIntoView(this.el.tapeView.querySelector('.cell.current'), {
      block: 'nearest',
      inline: 'nearest',
    });
  }

  private commandNode(index: number): HTMLElement | null {
    return this.el.programView.querySelector<HTMLElement>(`.cmd[data-command-id="${index}"]`);
  }

  private markCommand(next: Command | undefined): void {
    const compiled = this.compiled;
    if (compiled === null) return;

    // Transition the previously active command into the visited state before
    // highlighting the next one (mirrors original jstu4 `selectCommand`).
    this.el.programView.querySelectorAll('.cmd.current').forEach((node) => {
      node.classList.remove('current');
      node.classList.add('visited');
    });

    if (next === undefined) return;

    const index = compiled.commands.indexOf(next);
    if (index >= 0) {
      const current = this.commandNode(index);
      current?.classList.add('current');
      scrollElementIntoView(current, { block: 'nearest' });
      this.returnCursorOffset = next.source.offset;
    }
  }

  private reportRuntimeError(error: unknown): void {
    this.stopQuick();
    this.options.onRunningChange?.(false);
    if (error instanceof NoSuchCommandError) {
      this.setLog({
        type: 'noSuchCommand',
        q: String(error.data.state),
        a: error.data.symbol,
      });
      return;
    }
    if (error instanceof OutOfTapeError) {
      // Mark the offending command as an error rather than leaving it green.
      this.el.programView.querySelectorAll('.cmd.current').forEach((node) => {
        node.classList.remove('current');
        node.classList.add('error');
      });
      this.setLog({ type: 'headIsOutOfTape' });
      return;
    }
    throw error;
  }

  private reportFinish(run: MachineRun): void {
    this.stopQuick();
    this.options.onRunningChange?.(false);
    switch (run.checkNormality()) {
      case 'sourceAltered':
        this.setLog({ type: 'sourceAltered' });
        break;
      case 'misplaced':
        this.setLog({ type: 'misplaced' });
        break;
      case 'normal':
        this.setLog({ type: 'finished' });
        break;
    }
  }

  private scheduleQuickTick(): void {
    const generation = ++this.quickGeneration;
    const interval = QUICK_INTERVALS_MS[this.quickIndex] ?? 0;

    if (interval === 0) {
      // Fastest tier: run a time-budgeted batch per animation frame so execution
      // is genuinely faster than the 10 ms tier without freezing repaints or
      // piling up timers in background tabs.
      const frame = (): void => {
        if (generation !== this.quickGeneration) return;
        this.quickRaf = null;

        const deadline = performance.now() + MAX_BATCH_MS_PER_FRAME;
        const opsBefore = this.stats.operationsCount;
        let stepped = 0;
        let keepGoing = true;
        while (
          keepGoing &&
          stepped < MAX_BATCH_STEPS_PER_FRAME &&
          (stepped === 0 || performance.now() < deadline)
        ) {
          keepGoing = this.stepOnce(false);
          stepped += 1;
        }
        if (this.stats.operationsCount > opsBefore) this.options.onStepSound?.();

        if (!keepGoing || generation !== this.quickGeneration) {
          this.options.onModeChange(this.mode);
          return;
        }

        this.quickRaf = requestAnimationFrame(frame);
      };

      this.quickRaf = requestAnimationFrame(frame);
      this.options.onModeChange(this.mode);
      return;
    }

    const tick = (): void => {
      if (generation !== this.quickGeneration) return;
      this.quickTimer = null;

      if (!this.stepOnce(true) || generation !== this.quickGeneration) {
        this.options.onModeChange(this.mode);
        return;
      }

      this.quickTimer = setTimeout(tick, interval);
    };

    this.quickTimer = setTimeout(tick, interval);
    this.options.onModeChange(this.mode);
  }

  private stopQuick(): void {
    const wasRunning = this.isQuickRunning;
    this.quickGeneration += 1;
    if (this.quickTimer !== null) {
      clearTimeout(this.quickTimer);
      this.quickTimer = null;
    }
    if (this.quickRaf !== null) {
      cancelAnimationFrame(this.quickRaf);
      this.quickRaf = null;
    }
    if (wasRunning) {
      this.options.onModeChange(this.mode);
    }
  }

  private renderStats(): void {
    this.el.stats.textContent = this.m.stats(this.stats);
  }

  private setLog(descriptor: LogDescriptor): void {
    this.lastLog = descriptor;
    this.renderLog();
  }

  private renderLog(): void {
    const d = this.lastLog;
    let text: string | null = null;
    let kind: LogKind = 'info';

    switch (d.type) {
      case 'none':
        text = null;
        break;
      case 'ready':
        text = this.m.log.ready;
        kind = 'info';
        break;
      case 'restoredDraft':
        text = this.m.log.restoredDraft;
        kind = 'info';
        break;
      case 'finished':
        text = this.m.log.finished;
        kind = 'info';
        break;
      case 'sourceAltered':
        text = this.m.log.warningSourceAltered;
        kind = 'warning';
        break;
      case 'misplaced':
        text = this.m.log.warningMisposition;
        kind = 'warning';
        break;
      case 'convertedToTu4':
        text = this.m.log.convertedToTu4;
        kind = 'info';
        break;
      case 'copied':
        text = this.m.log.copied;
        kind = 'info';
        break;
      case 'tooManyStates':
        text = this.m.error.tooManyStates;
        kind = 'error';
        break;
      case 'parseError':
        text = this.m.error.parseError(d.text);
        kind = 'error';
        break;
      case 'programIsEmpty':
        text = this.m.error.programIsEmpty;
        kind = 'error';
        break;
      case 'ambiguousCommand':
        text = this.m.error.ambiguousCommand(d.q, d.a);
        kind = 'error';
        break;
      case 'targetStateDoesNotExist':
        text = this.m.error.targetStateDoesNotExist(d.w);
        kind = 'error';
        break;
      case 'initialStateDoesNotExist':
        text = this.m.error.initialStateDoesNotExist(d.q);
        kind = 'error';
        break;
      case 'headIsOutOfTape':
        text = this.m.error.headIsOutOfTape;
        kind = 'error';
        break;
      case 'noSuchCommand':
        text = this.m.error.noSuchCommand(d.q, d.a);
        kind = 'error';
        break;
    }

    this.el.log.textContent = text ?? '';
    this.el.log.dataset.kind = text === null ? '' : kind;
  }

  private setMode(mode: UIMode): void {
    this.mode = mode;
    this.el.controls.dataset.mode = mode;
    document.body.dataset.mode = mode;
    this.options.onModeChange(mode);
  }
}
