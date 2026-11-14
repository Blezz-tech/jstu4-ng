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
import { convertTextToTu4 } from '../core/tu4';
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
  /** Called after every mode change so the shell can sync buttons/attributes. */
  readonly onModeChange: (mode: UIMode) => void;
  /** Persist the program draft (debounced by the caller). */
  readonly onProgramChange: (text: string) => void;
  readonly onTapeChange: (text: string) => void;
  /** Optional per-step click. */
  readonly onStepSound?: () => void;
}

const QUICK_INTERVALS_MS = [70, 30, 10, 0] as const;

/**
 * The tape is a sequence of single-character cells, so an accidental newline
 * (e.g. pasted from a text editor) would silently break the run. Tabs and line
 * breaks are normalised to spaces; the machine itself still reads `\s` only
 * as trailing padding. This mirrors the lenient tape handling of jstu4 v2.x.
 */
export function coerceTape(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/**
 * The whole application behaviour, framework-free: one class, explicit state,
 * DOM events in, DOM updates out.
 */
export class AppController {
  private readonly m: Messages;
  private readonly el: AppElements;
  private readonly options: ControllerOptions;

  private mode: UIMode = 'edit';
  private run: MachineRun | null = null;
  private compiled: CompiledProgram | null = null;
  private visited = new Set<number>();

  private quickTimer: ReturnType<typeof setTimeout> | null = null;
  private quickIndex = 0;
  private quickGeneration = 0;

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
    return this.quickTimer !== null;
  }

  get isMachineRunning(): boolean {
    return this.run?.isRunning ?? false;
  }

  /** Restore a draft without marking the app as "modified by the user". */
  hydrate(program: string | null, tape: string | null): void {
    if (program !== null) this.el.programInput.value = program;
    if (tape !== null) this.el.tapeInput.value = tape;
    this.setMode('edit');
    this.log(this.m.log.ready, 'info');
  }

  // ——— user actions ————————————————————————————————————————————————

  /** "Start": compile the program and begin a new run. */
  start(): void {
    const parsed = this.parseInput();
    if (parsed === null) return;

    const tape = coerceTape(this.el.tapeInput.value);
    if (tape !== this.el.tapeInput.value) this.el.tapeInput.value = tape;
    this.compiled = parsed;
    this.run = new MachineRun(parsed.program, tape);
    this.visited = new Set();

    this.el.programView.replaceChildren(renderProgram(parsed));
    this.renderTapeView();

    this.stats = {
      commandsCount: parsed.commands.length,
      initialDataLength: this.run.initialTape.length,
      maxDataLength: this.run.tapeText.length,
      operationsCount: 0,
    };
    this.renderStats();

    this.setMode('run');
    this.markCommand(this.run.nextCommand);
    this.log(null);
    this.options.onStepSound?.();
  }

  /** "Step": execute one command. Returns whether the machine keeps running. */
  step(): boolean {
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
    this.options.onStepSound?.();

    if (run.isRunning) {
      this.log(null);
      return true;
    }

    this.reportFinish(run);
    return false;
  }

  /** "Quick": toggle automatic execution; repeated presses speed it up. */
  quick(): void {
    if (!this.isMachineRunning) {
      // Nothing to run any more (finished or never started): behave like
      // "Start" instead of silently doing nothing, as the original did.
      if (this.mode === 'run') this.start();
      return;
    }
    if (this.quickTimer !== null) {
      // Already running quickly: accelerate.
      this.stopQuick();
      this.quickIndex = Math.min(this.quickIndex + 1, QUICK_INTERVALS_MS.length - 1);
    } else {
      if (!this.isMachineRunning) return;
      this.quickIndex = 0;
    }
    this.scheduleQuickTick();
  }

  /** "Back to edit": stop everything and return to the editable fields. */
  backToEdit(): void {
    this.stopQuick();
    this.run = null;
    this.compiled = null;
    this.setMode('edit');
    this.log(null);
    this.el.tapeInput.focus();
  }

  /** "Unmark": clear visited marks from previously executed commands. */
  unmark(): void {
    this.visited.clear();
    this.el.programView.querySelectorAll('.cmd.visited').forEach((node) => {
      node.classList.remove('visited');
    });
  }

  /**
   * "Copy" (or "Cut with Ctrl+X" outside the textarea): copy the program to
   * the clipboard. The Clipboard API needs a secure context; on `http://`
   * origins and old browsers the textarea selection + `execCommand` fallback
   * is used instead.
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
    this.log(this.m.log.copied, 'info');
  }

  /** "To TU4": convert the current program and replace the editor content. */
  toTu4(): void {
    const parsed = this.parseInput();
    if (parsed === null) return;

    try {
      const converted = convertTextToTu4(parsed.text);
      if (converted === null) return;
      this.el.programInput.value = converted;
      this.options.onProgramChange(converted);
      this.log(this.m.log.convertedToTu4, 'info');
      this.backToEdit();
    } catch (error) {
      if (error instanceof RangeError) {
        this.log(this.m.error.tooManyStates, 'error');
        return;
      }
      throw error;
    }
  }

  /** Keyboard: Enter behaviour depends on the current mode. */
  handleEnter(): void {
    switch (this.mode) {
      case 'edit':
        this.start();
        break;
      case 'run':
        if (this.quickTimer !== null) this.stopQuick();
        else if (this.isMachineRunning) this.quick();
        else this.backToEdit();
        break;
      case 'error':
        this.backToEdit();
        break;
    }
  }

  handleSpace(): void {
    if (this.mode !== 'run') return;
    this.stopQuick();
    this.step();
  }

  handleEscape(): void {
    if (this.mode === 'edit') return;
    this.backToEdit();
  }

  dispose(): void {
    this.stopQuick();
  }

  // ——— internals ——————————————————————————————————————————————————

  private parseInput(): CompiledProgram | null {
    try {
      return this.compile(this.el.programInput.value);
    } catch (error) {
      this.reportCompileError(error, this.el.programInput.value);
      return null;
    }
  }

  private compile(text: string): CompiledProgram {
    return compileProgram(text, 0);
  }

  private reportCompileError(error: unknown, text: string): void {
    if (!(error instanceof MachineError)) throw error;

    this.setMode('error');
    this.log(null);

    if (error instanceof ParseError) {
      this.el.programView.replaceChildren(renderProgramWithError(text, error.data.offset));
      this.log(this.m.error.parseError(error.data.text), 'error');
      return;
    }

    if (error instanceof EmptyProgramError) {
      this.el.programView.textContent = text;
      this.log(this.m.error.programIsEmpty, 'error');
      return;
    }

    if (error instanceof AmbiguousCommandError) {
      this.renderProgramWithMarks(text, [error.data.command, error.data.original], 'error');
      this.log(
        this.m.error.ambiguousCommand(String(error.data.command.q), error.data.command.a),
        'error',
      );
      return;
    }

    if (error instanceof NonexistentTargetStateError) {
      this.renderProgramWithMarks(text, [error.data.command], 'error');
      this.log(this.m.error.targetStateDoesNotExist(String(error.data.command.w)), 'error');
      return;
    }

    if (error instanceof NonexistentInitialStateError) {
      this.el.programView.textContent = text;
      this.log(this.m.error.initialStateDoesNotExist(String(error.data.state)), 'error');
      return;
    }

    throw error;
  }

  /**
   * Render the program with some commands marked as erroneous.
   *
   * The program did not compile, so only the *parser* runs here: the
   * commands before the failing one are enough to draw the listing, and
   * validation must not be repeated (it would throw again and lose the
   * marks).
   */
  private renderProgramWithMarks(
    text: string,
    commands: readonly Command[],
    className: string,
  ): void {
    try {
      const listing = listProgram(text);
      this.el.programView.replaceChildren(renderProgram(listing));
      // The failing commands come from a *different* parse, so identity
      // comparison cannot work: match them by their source offset.
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
  }

  private commandNode(index: number): HTMLElement | null {
    return this.el.programView.querySelector<HTMLElement>(`.cmd[data-command-id="${index}"]`);
  }

  private markCommand(next: Command | undefined): void {
    const compiled = this.compiled;
    if (compiled === null) return;

    if (next !== undefined) {
      const index = compiled.commands.indexOf(next);
      if (index >= 0) {
        this.visited.add(index);
        for (const id of this.visited) {
          const node = this.commandNode(id);
          if (node !== null && id !== index) {
            node.classList.remove('current');
            node.classList.add('visited');
          }
        }
        const current = this.commandNode(index);
        current?.classList.add('current');
        current?.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private reportRuntimeError(error: unknown): void {
    this.stopQuick();
    if (error instanceof NoSuchCommandError) {
      this.log(this.m.error.noSuchCommand(String(error.data.state), error.data.symbol), 'error');
      return;
    }
    if (error instanceof OutOfTapeError) {
      this.log(this.m.error.headIsOutOfTape, 'error');
      return;
    }
    throw error;
  }

  private reportFinish(run: MachineRun): void {
    switch (run.checkNormality()) {
      case 'sourceAltered':
        this.log(this.m.log.warningSourceAltered, 'warning');
        break;
      case 'misplaced':
        this.log(this.m.log.warningMisposition, 'warning');
        break;
      case 'normal':
        this.log(this.m.log.finished, 'info');
        break;
    }
  }

  private scheduleQuickTick(): void {
    const generation = ++this.quickGeneration;
    const interval = QUICK_INTERVALS_MS[this.quickIndex] ?? 0;

    const tick = (): void => {
      if (generation !== this.quickGeneration) return;

      if (!this.step()) {
        this.quickTimer = null;
        this.options.onModeChange(this.mode);
        return;
      }

      if (interval === 0) {
        // "As fast as possible": loop in a macrotask-free chain of
        // requestAnimationFrame callbacks, so the UI still repaints.
        this.quickTimer = setTimeout(() => {
          requestAnimationFrame(tick);
        }, 0);
      } else {
        this.quickTimer = setTimeout(tick, interval);
      }
    };

    this.quickTimer = setTimeout(tick, interval);
    this.options.onModeChange(this.mode);
  }

  private stopQuick(): void {
    this.quickGeneration += 1;
    if (this.quickTimer !== null) clearTimeout(this.quickTimer);
    this.quickTimer = null;
  }

  private renderStats(): void {
    this.el.stats.textContent = this.m.stats(this.stats);
  }

  private log(text: string | null, kind: LogKind = 'info'): void {
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
