import { describe, expect, it } from 'vitest';
import {
  clampMaxSpeed,
  clampMinSpeed,
  clampSpeed,
  DEFAULT_MAX_SPEED,
  DEFAULT_MIN_SPEED,
  DEFAULT_SPEED,
  formatSpeed,
  MAX_MAX_SPEED,
  MAX_MIN_SPEED,
  MIN_MAX_SPEED,
  MIN_MIN_SPEED,
  stepIntervalMs,
  zeroRatio,
} from '../src/ui/speed';
import {
  createInitialSpeedState,
  transitionSpeed,
  type SpeedTransitionContext,
} from '../src/ui/speed-controller';

describe('speed helpers', () => {
  it('exposes defaults of -15..25 with initial speed 1', () => {
    expect(DEFAULT_MIN_SPEED).toBe(-15);
    expect(DEFAULT_MAX_SPEED).toBe(25);
    expect(DEFAULT_SPEED).toBe(1);
  });

  it('clamps min speed into [MIN_MIN_SPEED, MAX_MIN_SPEED] on 0.5 increments', () => {
    expect(clampMinSpeed(-15)).toBe(-15);
    expect(clampMinSpeed(0)).toBe(MAX_MIN_SPEED);
    expect(clampMinSpeed(10)).toBe(MAX_MIN_SPEED);
    expect(clampMinSpeed(-9999)).toBe(MIN_MIN_SPEED);
    expect(clampMinSpeed(Number.NaN)).toBe(DEFAULT_MIN_SPEED);
    expect(clampMinSpeed(-12.3)).toBe(-12.5);
  });

  it('clamps max speed into [MIN_MAX_SPEED, MAX_MAX_SPEED] on 0.5 increments', () => {
    expect(clampMaxSpeed(25)).toBe(25);
    expect(clampMaxSpeed(0)).toBe(MIN_MAX_SPEED);
    expect(clampMaxSpeed(-5)).toBe(MIN_MAX_SPEED);
    expect(clampMaxSpeed(9999)).toBe(MAX_MAX_SPEED);
    expect(clampMaxSpeed(Number.NaN)).toBe(DEFAULT_MAX_SPEED);
    expect(clampMaxSpeed(12.3)).toBe(12.5);
  });

  it('clamps execution speed into [minSpeed, maxSpeed] across negative, zero, and positive values', () => {
    expect(clampSpeed(1, -15, 25)).toBe(1);
    expect(clampSpeed(0, -15, 25)).toBe(0);
    expect(Object.is(clampSpeed(-0.1, -15, 25), 0)).toBe(true);
    expect(clampSpeed(-20, -15, 25)).toBe(-15);
    expect(clampSpeed(30, -15, 25)).toBe(25);
    expect(clampSpeed(-7.26, -15, 25)).toBe(-7.5);
    expect(clampSpeed(2.24, -15, 25)).toBe(2);
    expect(clampSpeed(2.26, -15, 25)).toBe(2.5);
    expect(clampSpeed(Number.NaN, -15, 25)).toBe(DEFAULT_SPEED);
  });

  it('computes step intervals by magnitude and returns Infinity at speed 0', () => {
    expect(stepIntervalMs(0)).toBe(Number.POSITIVE_INFINITY);
    expect(stepIntervalMs(0.5)).toBe(400);
    expect(stepIntervalMs(-0.5)).toBe(400);
    expect(stepIntervalMs(1)).toBe(200);
    expect(stepIntervalMs(-1)).toBe(200);
    expect(stepIntervalMs(2)).toBe(100);
    expect(stepIntervalMs(-10)).toBe(20);
  });

  it('computes the exact relative position of 0 along [minSpeed, maxSpeed]', () => {
    expect(zeroRatio(-15, 25)).toBeCloseTo(0.375);
    expect(zeroRatio(-10, 10)).toBeCloseTo(0.5);
    expect(zeroRatio(-5, 15)).toBeCloseTo(0.25);
  });

  it('formats positive, zero, and negative speed multipliers cleanly with × sign', () => {
    expect(formatSpeed(-15)).toBe('-15×');
    expect(formatSpeed(-0.5)).toBe('-0.5×');
    expect(formatSpeed(-0)).toBe('0×');
    expect(formatSpeed(0)).toBe('0×');
    expect(formatSpeed(0.5)).toBe('0.5×');
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(25)).toBe('25×');
  });
});

describe('speed state machine (transitionSpeed)', () => {
  const ctx = (overrides: Partial<SpeedTransitionContext> = {}): SpeedTransitionContext => ({
    isAutoRunning: false,
    elapsedSinceLastStepMs: 0,
    canStepInDirection: () => true,
    ...overrides,
  });

  it('stops at 0 while dragging across zero and seamlessly resumes on the opposite side', () => {
    let state = createInitialSpeedState(2, -15, 25);

    // Begin dragging while auto-running forward
    state = transitionSpeed(state, { type: 'beginDrag' }, ctx({ isAutoRunning: true })).state;
    expect(state.dragging).toBe(true);
    expect(state.resumeAfterZeroDrag).toBe(true);

    // Drag to 0 -> stops runner, preserves resumeAfterZeroDrag
    const atZero = transitionSpeed(
      state,
      { type: 'setSpeed', value: 0 },
      ctx({ isAutoRunning: true }),
    );
    expect(atZero.state.speed).toBe(0);
    expect(atZero.state.resumeAfterZeroDrag).toBe(true);
    expect(atZero.effect).toEqual({ kind: 'stop', reverseBoundary: false });
    expect(atZero.notifyRunState).toBe(true);

    // Continue dragging into reverse while auto-runner is now paused -> resumes immediately
    const inReverse = transitionSpeed(
      atZero.state,
      { type: 'setSpeed', value: -2 },
      ctx({ isAutoRunning: false, canStepInDirection: () => true }),
    );
    expect(inReverse.state.speed).toBe(-2);
    expect(inReverse.effect).toEqual({ kind: 'resumeNow' });

    // Releasing drag clears drag flags
    const ended = transitionSpeed(inReverse.state, { type: 'endDrag' }, ctx());
    expect(ended.state.dragging).toBe(false);
    expect(ended.state.resumeAfterZeroDrag).toBe(false);
    expect(ended.effect).toEqual({ kind: 'none' });
  });

  it('emits reverseBoundary when dragging across 0 into reverse without undo history', () => {
    let state = createInitialSpeedState(1, -15, 25);
    state = transitionSpeed(state, { type: 'beginDrag' }, ctx({ isAutoRunning: true })).state;
    state = transitionSpeed(
      state,
      { type: 'setSpeed', value: 0 },
      ctx({ isAutoRunning: true }),
    ).state;

    const blocked = transitionSpeed(
      state,
      { type: 'setSpeed', value: -1 },
      ctx({ isAutoRunning: false, canStepInDirection: (s) => s > 0 }),
    );
    expect(blocked.effect).toEqual({ kind: 'reverseBoundary' });
  });

  it('reschedules remaining interval on live speed changes and stops when direction cannot step', () => {
    const state = createInitialSpeedState(1, -15, 25);

    // Speed 2× has 100ms interval; 40ms already elapsed -> 60ms remaining
    const faster = transitionSpeed(
      state,
      { type: 'setSpeed', value: 2 },
      ctx({ isAutoRunning: true, elapsedSinceLastStepMs: 40 }),
    );
    expect(faster.effect).toEqual({ kind: 'reschedule', delayMs: 60 });

    // Switching directly into reverse when canStepBack=false stops and emits reverseBoundary
    const stoppedReverse = transitionSpeed(
      faster.state,
      { type: 'setSpeed', value: -2 },
      ctx({ isAutoRunning: true, canStepInDirection: (s) => s > 0 }),
    );
    expect(stoppedReverse.effect).toEqual({ kind: 'stop', reverseBoundary: true });
  });

  it('clamps active speed and triggers speed transition when min/max bounds shrink', () => {
    const state = createInitialSpeedState(20, -15, 25);

    // Shrinking maxSpeed below current speed clamps speed and reschedules live runner
    const shrunkMax = transitionSpeed(
      state,
      { type: 'setMax', value: 10 },
      ctx({ isAutoRunning: true, elapsedSinceLastStepMs: 5 }),
    );
    expect(shrunkMax.state.maxSpeed).toBe(10);
    expect(shrunkMax.state.speed).toBe(10);
    expect(shrunkMax.effect).toEqual({ kind: 'reschedule', delayMs: 15 });
    expect(shrunkMax.notifyRunState).toBe(true);

    // Shrinking minSpeed when current speed is already inside bounds is a silent state update
    const shrunkMin = transitionSpeed(shrunkMax.state, { type: 'setMin', value: -5 }, ctx());
    expect(shrunkMin.state.minSpeed).toBe(-5);
    expect(shrunkMin.state.speed).toBe(10);
    expect(shrunkMin.effect).toEqual({ kind: 'none' });
    expect(shrunkMin.notifyRunState).toBe(false);
  });
});
