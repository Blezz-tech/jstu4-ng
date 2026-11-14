// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../src/i18n';
import { StepSound } from '../src/ui/audio';
import { AppController, type AppElements, type UIMode } from '../src/ui/controller';

function setupDom(): AppElements {
  document.body.innerHTML = `
    <input id="input-tape" />
    <div id="display-tape"></div>
    <textarea id="input-program"></textarea>
    <div id="display-program" tabindex="0"></div>
    <div id="controls"></div>
    <p id="log"></p>
    <p id="stats"></p>
  `;
  return {
    tapeInput: document.querySelector<HTMLInputElement>('#input-tape')!,
    tapeView: document.querySelector<HTMLElement>('#display-tape')!,
    programInput: document.querySelector<HTMLTextAreaElement>('#input-program')!,
    programView: document.querySelector<HTMLElement>('#display-program')!,
    controls: document.querySelector<HTMLElement>('#controls')!,
    log: document.querySelector<HTMLElement>('#log')!,
    stats: document.querySelector<HTMLElement>('#stats')!,
  };
}

function makeController(
  elements: AppElements,
  overrides: {
    lang?: 'ru' | 'en';
    onModeChange?: (mode: UIMode) => void;
    onRunningChange?: (isRunning: boolean) => void;
    onProgramChange?: (text: string) => void;
    onStepSound?: () => void;
  } = {},
): AppController {
  return new AppController({
    messages: messages(overrides.lang ?? 'ru'),
    elements,
    onModeChange: overrides.onModeChange ?? (() => undefined),
    ...(overrides.onRunningChange ? { onRunningChange: overrides.onRunningChange } : {}),
    onProgramChange: overrides.onProgramChange ?? (() => undefined),
    onTapeChange: () => undefined,
    ...(overrides.onStepSound ? { onStepSound: overrides.onStepSound } : {}),
  });
}

describe('AppController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('keeps state 0 as 00 in toTu4 even when state 0 is not on the first line and preserves the log', () => {
    const el = setupDom();
    const saved: string[] = [];
    const controller = makeController(el, { onProgramChange: (t) => saved.push(t) });

    el.programInput.value = 'fin, ,#,fin\n0, ,>,fin';
    controller.toTu4();

    expect(el.programInput.value).toBe('01, ,#,01\n00, ,>,01');
    expect(saved).toEqual(['01, ,#,01\n00, ,>,01']);
    expect(el.log.textContent).toBe(messages('ru').log.convertedToTu4);
    expect(el.log.dataset.kind).toBe('info');
    expect(controller.currentMode).toBe('edit');
  });

  it('reports tooManyStates when toTu4 is called on a program with > 256 states', () => {
    const el = setupDom();
    const controller = makeController(el);

    const lines = [
      '0, ,>,s1',
      ...Array.from({ length: 256 }, (_, i) => `s${i + 1}, ,>,${i === 255 ? '0' : `s${i + 2}`}`),
    ];
    el.programInput.value = lines.join('\n');
    controller.toTu4();

    expect(el.log.textContent).toBe(messages('ru').error.tooManyStates);
    expect(el.log.dataset.kind).toBe('error');
  });

  it('does not leave duplicate .current highlights after unmark() followed by step()', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '0, ,>,1\n1, ,>,2\n2, ,>,3\n3, ,#,3';
    el.tapeInput.value = '';

    controller.start();
    controller.step(); // now at state 1
    expect(el.programView.querySelectorAll('.cmd.visited')).toHaveLength(1);
    expect(el.programView.querySelectorAll('.cmd.current')).toHaveLength(1);

    controller.unmark();
    expect(el.programView.querySelectorAll('.cmd.visited')).toHaveLength(0);
    expect(el.programView.querySelectorAll('.cmd.current')).toHaveLength(1);

    controller.step(); // moves to state 2; command 1 must lose .current and become .visited
    expect(el.programView.querySelectorAll('.cmd.current')).toHaveLength(1);
    expect(el.programView.querySelector('.cmd.current')?.textContent).toBe('2, ,>,3');
    expect(el.programView.querySelectorAll('.cmd.visited')).toHaveLength(1);
    expect(el.programView.querySelector('.cmd.visited')?.textContent).toBe('1, ,>,2');

    // Step to halt: final command becomes visited and can be cleared with unmark().
    controller.step(); // moves to state 3
    controller.step(); // halts
    expect(el.programView.querySelectorAll('.cmd.current')).toHaveLength(0);
    expect(el.programView.querySelectorAll('.cmd.visited').length).toBeGreaterThan(0);

    controller.unmark();
    expect(el.programView.querySelectorAll('.cmd.visited')).toHaveLength(0);
  });

  it('toggles auto-run on/off (pausing in place), respects speed changes, and stops on step/Escape', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '0, ,>,0';
    el.tapeInput.value = '';

    controller.start();
    expect(controller.isAutoRunning).toBe(false);
    expect(controller.currentSpeed).toBe(1);
    expect(controller.currentMaxSpeed).toBe(10);

    // Start auto-run at default 1× (200 ms/step).
    controller.toggleAutoRun();
    expect(controller.isAutoRunning).toBe(true);
    vi.advanceTimersByTime(600);
    expect(el.stats.textContent).toContain('Выполнено операций: 3');

    // Second toggleAutoRun() pauses (Stop) without resetting or leaving run mode.
    controller.toggleAutoRun();
    expect(controller.isAutoRunning).toBe(false);
    expect(controller.currentMode).toBe('run');
    expect(controller.isMachineRunning).toBe(true);
    vi.advanceTimersByTime(600);
    expect(el.stats.textContent).toContain('Выполнено операций: 3');

    // Resume at 0.5× (400 ms/step), then speed up dynamically to 10× (20 ms/step).
    controller.setSpeed(0.5);
    expect(controller.currentSpeed).toBe(0.5);
    controller.toggleAutoRun();
    vi.advanceTimersByTime(400);
    expect(el.stats.textContent).toContain('Выполнено операций: 4');

    controller.setSpeed(10);
    expect(controller.currentSpeed).toBe(10);
    vi.advanceTimersByTime(100);
    expect(el.stats.textContent).toContain('Выполнено операций: 9');

    // First Escape pauses auto-run without leaving run mode.
    controller.handleEscape();
    expect(controller.isAutoRunning).toBe(false);
    expect(controller.currentMode).toBe('run');

    // Lowering maxSpeed clamps current speed.
    const clamped = controller.setMaxSpeed(4);
    expect(clamped).toEqual({ maxSpeed: 4, speed: 4 });
    expect(controller.currentSpeed).toBe(4);

    // Restart auto-run, then step() must pause it and advance by 1.
    controller.toggleAutoRun();
    expect(controller.isAutoRunning).toBe(true);
    controller.step();
    expect(controller.isAutoRunning).toBe(false);
    expect(el.stats.textContent).toContain('Выполнено операций: 10');

    // Second Escape (now paused) returns to edit.
    controller.handleEscape();
    expect(controller.currentMode).toBe('edit');
  });

  it('updates language in place via setMessages() without losing input or active run', () => {
    const el = setupDom();
    const controller = makeController(el, { lang: 'ru' });

    el.programInput.value = '0, ,=,1\n1, ,#,1';
    el.tapeInput.value = '101';
    controller.start();
    controller.step(); // 1 step done, still running in state 1

    expect(el.stats.textContent).toContain('Команд в программе: 2');
    controller.setMessages(messages('en'));

    expect(controller.currentMode).toBe('run');
    expect(controller.isMachineRunning).toBe(true);
    expect(el.programInput.value).toBe('0, ,=,1\n1, ,#,1');
    expect(el.stats.textContent).toContain('Transitions: 2');
    expect(el.stats.textContent).toContain('Steps performed: 1');

    // Finish in English, then switch back to Russian — log message translates too.
    controller.step();
    expect(el.log.textContent).toBe(messages('en').log.finished);
    controller.setMessages(messages('ru'));
    expect(el.log.textContent).toBe(messages('ru').log.finished);
  });

  it('restores cursor offset in #input-program when returning from a compile error', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '0,1,>,1\nBAD';

    controller.start();
    expect(controller.currentMode).toBe('error');
    expect(el.programView.querySelector('mark.error')?.textContent).toBe('B');

    controller.handleEscape();
    expect(controller.currentMode).toBe('edit');
    expect(document.activeElement).toBe(el.programInput);
    expect(el.programInput.selectionStart).toBe(8);
    expect(el.programInput.selectionEnd).toBe(8);
  });

  it('marks the offending command with .error on OutOfTapeError instead of leaving it .current', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '0, ,<,0';
    el.tapeInput.value = '';

    controller.start();
    expect(el.programView.querySelectorAll('.cmd.current')).toHaveLength(1);

    expect(controller.step()).toBe(false);
    expect(el.programView.querySelectorAll('.cmd.current')).toHaveLength(0);
    expect(el.programView.querySelectorAll('.cmd.error')).toHaveLength(1);
    expect(el.log.dataset.kind).toBe('error');
  });

  it('renders syntax-highlighted commands on NonexistentInitialStateError', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '1, ,#,1 // no state 0';

    controller.start();
    expect(controller.currentMode).toBe('error');
    expect(el.programView.querySelectorAll('.cmd')).toHaveLength(1);
    expect(el.log.dataset.kind).toBe('error');
  });

  it('updates stats cellsUsed when moving right without writing and does not beep on start()', () => {
    const el = setupDom();
    const sounds = vi.fn();
    const controller = makeController(el, { lang: 'en', onStepSound: sounds });
    el.programInput.value = '0, ,>,0';
    el.tapeInput.value = '1';

    controller.start();
    expect(sounds).not.toHaveBeenCalled();
    expect(el.stats.textContent).toContain('Cells used: 2');

    controller.step();
    controller.step();
    expect(sounds).toHaveBeenCalledTimes(2);
    expect(el.stats.textContent).toContain('Cells used: 4');
  });

  it('moves focus out of #input-tape on compile error so Escape/Enter work immediately', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '???';
    el.tapeInput.value = '101';
    el.tapeInput.focus();
    expect(document.activeElement).toBe(el.tapeInput);

    controller.start();
    expect(controller.currentMode).toBe('error');
    expect(document.activeElement).toBe(el.programView);

    controller.handleEnter();
    expect(controller.currentMode).toBe('edit');
    expect(document.activeElement).toBe(el.programInput);
  });

  it('requires modifier for handleEnter in edit mode and flushes program/tape on start()', () => {
    const el = setupDom();
    const savedPrograms: string[] = [];
    const savedTapes: string[] = [];
    const controller = new AppController({
      messages: messages('en'),
      elements: el,
      onModeChange: () => undefined,
      onProgramChange: (p) => savedPrograms.push(p),
      onTapeChange: (t) => savedTapes.push(t),
    });
    el.programInput.value = '0, ,#,0';
    el.tapeInput.value = 'a\tb';

    controller.handleEnter(false);
    expect(controller.currentMode).toBe('edit');

    controller.handleEnter(true);
    expect(controller.currentMode).toBe('run');
    expect(savedPrograms).toEqual(['0, ,#,0']);
    expect(savedTapes).toEqual(['a b']);
  });

  it('does not shrink #display-tape cells when stepping left from the initial head cell', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '0, ,<,1\n1,0,#,1';
    el.tapeInput.value = '0';

    controller.start();
    expect(el.tapeView.querySelectorAll('.cell')).toHaveLength(2);

    controller.step(); // head moves left from pos 1 to pos 0
    expect(el.tapeView.querySelectorAll('.cell')).toHaveLength(2);
  });

  it('restores program scrollTop after focusing and placing the caret in backToEdit()', () => {
    const el = setupDom();
    const controller = makeController(el);
    el.programInput.value = '0,1,>,1\nBAD';
    el.programInput.scrollTop = 120;

    controller.start();
    expect(controller.currentMode).toBe('error');

    // Simulate a browser that resets scrollTop to 0 when focus() is called.
    const originalFocus = el.programInput.focus.bind(el.programInput);
    vi.spyOn(el.programInput, 'focus').mockImplementation((options?: FocusOptions) => {
      originalFocus(options);
      el.programInput.scrollTop = 0;
    });

    controller.backToEdit();
    expect(el.programInput.scrollTop).toBe(120);
  });

  it('reports isAutoRunning === false when onRunningChange(false) fires on auto-run halt', () => {
    const el = setupDom();
    const seenAutoDuringHalt: boolean[] = [];
    const controller = makeController(el, {
      onRunningChange: (isRunning) => {
        if (!isRunning) seenAutoDuringHalt.push(controller.isAutoRunning);
      },
    });
    el.programInput.value = '0, ,>,1\n1, ,#,1';
    el.tapeInput.value = '';

    controller.start();
    controller.toggleAutoRun();
    expect(controller.isAutoRunning).toBe(true);

    vi.advanceTimersByTime(500);
    expect(controller.isMachineRunning).toBe(false);
    expect(controller.isAutoRunning).toBe(false);
    expect(seenAutoDuringHalt).toEqual([false]);
  });

  it('StepSound.tick() swallows Web Audio errors without interrupting execution', () => {
    const original = window.AudioContext;
    class BrokenAudioContext {
      createOscillator(): never {
        throw new Error('audio device unavailable');
      }
    }
    vi.stubGlobal('AudioContext', BrokenAudioContext);
    try {
      const sound = new StepSound(true);
      expect(() => sound.tick()).not.toThrow();
    } finally {
      vi.stubGlobal('AudioContext', original);
    }
  });

  it('does not play step sound in high-speed rAF batch when the very first step throws', () => {
    const el = setupDom();
    const sounds = vi.fn();
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    try {
      const controller = makeController(el, { onStepSound: sounds });
      el.programInput.value = '0, ,<,0';
      el.tapeInput.value = '';
      controller.setMaxSpeed(50);
      controller.setSpeed(50);
      controller.start();

      // Speed > 10× schedules a requestAnimationFrame batch.
      controller.toggleAutoRun();
      expect(controller.isAutoRunning).toBe(true);

      const cb = rafCallbacks.pop();
      expect(cb).toBeDefined();
      cb?.(performance.now());

      expect(controller.isMachineRunning).toBe(false);
      expect(sounds).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
