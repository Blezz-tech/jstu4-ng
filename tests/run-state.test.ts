import { describe, expect, it } from 'vitest';
import { computeFrameBatch } from '../src/ui/auto-runner';
import {
  canStepInDirection,
  coerceTape,
  deriveRunControlState,
  resolveBackToEditTarget,
  resolveEnterAction,
  resolveEscapeAction,
} from '../src/ui/run-state';

describe('pure run-state & frame-batch derivations', () => {
  it('coerceTape normalizes tabs and line breaks to single spaces', () => {
    expect(coerceTape('a\tb\nc\r\nd')).toBe('a b c  d');
  });

  it('canStepInDirection checks speed sign against running / undoable flags', () => {
    expect(canStepInDirection(null, 1)).toBe(false);
    expect(canStepInDirection({ isRunning: true, canStepBack: true, stepsCount: 1 }, 0)).toBe(
      false,
    );
    expect(canStepInDirection({ isRunning: true, canStepBack: false, stepsCount: 0 }, 2)).toBe(
      true,
    );
    expect(canStepInDirection({ isRunning: true, canStepBack: false, stepsCount: 0 }, -2)).toBe(
      false,
    );
    expect(canStepInDirection({ isRunning: false, canStepBack: true, stepsCount: 3 }, -2)).toBe(
      true,
    );
    expect(canStepInDirection({ isRunning: false, canStepBack: true, stepsCount: 3 }, 2)).toBe(
      false,
    );
  });

  it('deriveRunControlState produces exact flags across edit, running, halted, and reverse states', () => {
    expect(deriveRunControlState('edit', null, false, 1)).toEqual({
      isRunning: false,
      isAutoRunning: false,
      canStepForward: false,
      canStepBack: false,
      canAutoRun: false,
      canRestart: false,
      speed: 1,
    });

    // Fresh run at step 0 with reverse speed: cannot step back or restart or auto-run in reverse
    expect(
      deriveRunControlState(
        'run',
        { isRunning: true, canStepBack: false, stepsCount: 0 },
        false,
        -1,
      ),
    ).toEqual({
      isRunning: true,
      isAutoRunning: false,
      canStepForward: true,
      canStepBack: false,
      canAutoRun: false,
      canRestart: false,
      speed: -1,
    });

    // Halted after 5 steps with undo history and reverse speed: can step back, restart, and auto-run
    expect(
      deriveRunControlState(
        'run',
        { isRunning: false, canStepBack: true, stepsCount: 5 },
        false,
        -2,
      ),
    ).toEqual({
      isRunning: false,
      isAutoRunning: false,
      canStepForward: false,
      canStepBack: true,
      canAutoRun: true,
      canRestart: true,
      speed: -2,
    });
  });

  it('resolves Enter, Escape, and edit-return focus targets purely', () => {
    const runningForward = deriveRunControlState(
      'run',
      { isRunning: true, canStepBack: false, stepsCount: 0 },
      false,
      1,
    );
    const haltedForward = deriveRunControlState(
      'run',
      { isRunning: false, canStepBack: true, stepsCount: 2 },
      false,
      1,
    );
    const haltedZeroSpeed = deriveRunControlState(
      'run',
      { isRunning: false, canStepBack: true, stepsCount: 2 },
      false,
      0,
    );
    const haltedReverseBlocked = deriveRunControlState(
      'run',
      { isRunning: false, canStepBack: false, stepsCount: 0 },
      false,
      -1,
    );

    expect(resolveEnterAction('edit', runningForward, false)).toBe('none');
    expect(resolveEnterAction('edit', runningForward, true)).toBe('start');
    expect(resolveEnterAction('run', runningForward, false)).toBe('toggleAutoRun');
    expect(resolveEnterAction('run', haltedForward, false)).toBe('backToTape');
    expect(resolveEnterAction('run', haltedZeroSpeed, false)).toBe('backToTape');
    expect(resolveEnterAction('run', haltedReverseBlocked, false)).toBe('none');
    expect(resolveEnterAction('error', runningForward, false)).toBe('backToProgram');

    expect(resolveEscapeAction('edit', false)).toBe('none');
    expect(resolveEscapeAction('run', true)).toBe('stopAutoRun');
    expect(resolveEscapeAction('run', false)).toBe('backToTape');
    expect(resolveEscapeAction('error', false)).toBe('backToProgram');

    expect(resolveBackToEditTarget('run', null)).toBe('tape');
    expect(resolveBackToEditTarget('run', 12)).toBe('program');
    expect(resolveBackToEditTarget('error', null)).toBe('program');
    expect(resolveBackToEditTarget('error', 12, 'tape')).toBe('tape');
  });

  it('computeFrameBatch clamps elapsed time, accumulates budget, and caps per-frame batch size', () => {
    // 16ms at 20× speed (100 steps/s) -> 1.6 budget -> 1 target step
    const small = computeFrameBatch(16, 20, 0);
    expect(small.budget).toBeCloseTo(1.6);
    expect(small.targetSteps).toBe(1);

    // Huge tab-sleep elapsedMs (5000ms) is clamped to 100ms, and huge speed caps at 256 steps/frame
    const capped = computeFrameBatch(5000, 1000, 0);
    expect(capped.budget).toBe(500);
    expect(capped.targetSteps).toBe(256);

    // Negative speed uses magnitude
    const reverse = computeFrameBatch(20, -50, 0.5);
    expect(reverse.budget).toBeCloseTo(5.5);
    expect(reverse.targetSteps).toBe(5);
  });
});
