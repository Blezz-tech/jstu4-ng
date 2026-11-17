import type { AutoRunner } from './auto-runner';
import {
  clampMaxSpeed,
  clampMinSpeed,
  clampSpeed,
  DEFAULT_MAX_SPEED,
  DEFAULT_MIN_SPEED,
  DEFAULT_SPEED,
  stepIntervalMs,
} from './speed';

export interface SpeedState {
  readonly minSpeed: number;
  readonly maxSpeed: number;
  readonly speed: number;
  readonly dragging: boolean;
  readonly resumeAfterZeroDrag: boolean;
}

export interface SpeedTransitionContext {
  readonly isAutoRunning: boolean;
  readonly elapsedSinceLastStepMs: number;
  readonly canStepInDirection: (speed: number) => boolean;
}

export type SpeedAction =
  | { readonly type: 'beginDrag' }
  | { readonly type: 'endDrag' }
  | { readonly type: 'setSpeed'; readonly value: number }
  | { readonly type: 'setMin'; readonly value: number }
  | { readonly type: 'setMax'; readonly value: number };

export type SpeedEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'stop'; readonly reverseBoundary: boolean }
  | { readonly kind: 'reschedule'; readonly delayMs: number }
  | { readonly kind: 'resumeNow' }
  | { readonly kind: 'reverseBoundary' };

export interface SpeedTransitionResult {
  readonly state: SpeedState;
  readonly effect: SpeedEffect;
  readonly notifyRunState: boolean;
}

/** Build the normalized initial state for the speed state machine. */
export function createInitialSpeedState(
  initialSpeed?: number,
  initialMinSpeed?: number,
  initialMaxSpeed?: number,
): SpeedState {
  const minSpeed = clampMinSpeed(initialMinSpeed ?? DEFAULT_MIN_SPEED);
  const maxSpeed = clampMaxSpeed(initialMaxSpeed ?? DEFAULT_MAX_SPEED);
  return {
    minSpeed,
    maxSpeed,
    speed: clampSpeed(initialSpeed ?? DEFAULT_SPEED, minSpeed, maxSpeed),
    dragging: false,
    resumeAfterZeroDrag: false,
  };
}

function transitionToSpeed(
  state: SpeedState,
  rawSpeed: number,
  ctx: SpeedTransitionContext,
): SpeedTransitionResult {
  const next = clampSpeed(rawSpeed, state.minSpeed, state.maxSpeed);
  if (next === state.speed) {
    return { state, effect: { kind: 'none' }, notifyRunState: false };
  }

  let nextState: SpeedState = { ...state, speed: next };

  if (next === 0) {
    if (ctx.isAutoRunning) {
      if (state.dragging) nextState = { ...nextState, resumeAfterZeroDrag: true };
      return {
        state: nextState,
        effect: { kind: 'stop', reverseBoundary: false },
        notifyRunState: true,
      };
    }
    return { state: nextState, effect: { kind: 'none' }, notifyRunState: true };
  }

  if (ctx.isAutoRunning) {
    if (ctx.canStepInDirection(next)) {
      const delayMs = Math.max(0, Math.round(stepIntervalMs(next) - ctx.elapsedSinceLastStepMs));
      return {
        state: nextState,
        effect: { kind: 'reschedule', delayMs },
        notifyRunState: true,
      };
    }
    return {
      state: nextState,
      effect: { kind: 'stop', reverseBoundary: next < 0 },
      notifyRunState: true,
    };
  }

  if (state.dragging && state.resumeAfterZeroDrag) {
    if (ctx.canStepInDirection(next)) {
      return { state: nextState, effect: { kind: 'resumeNow' }, notifyRunState: true };
    }
    if (next < 0) {
      return { state: nextState, effect: { kind: 'reverseBoundary' }, notifyRunState: true };
    }
  }

  return { state: nextState, effect: { kind: 'none' }, notifyRunState: true };
}

/**
 * Pure state-machine reducer for bidirectional speed bounds (`[minSpeed, maxSpeed]`),
 * slider drag across `0` (stop + seamless resume), and `AutoRunner` rescheduling effects.
 */
export function transitionSpeed(
  state: SpeedState,
  action: SpeedAction,
  ctx: SpeedTransitionContext,
): SpeedTransitionResult {
  switch (action.type) {
    case 'beginDrag':
      return {
        state: { ...state, dragging: true, resumeAfterZeroDrag: ctx.isAutoRunning },
        effect: { kind: 'none' },
        notifyRunState: false,
      };
    case 'endDrag':
      return {
        state: { ...state, dragging: false, resumeAfterZeroDrag: false },
        effect: { kind: 'none' },
        notifyRunState: false,
      };
    case 'setSpeed':
      return transitionToSpeed(state, action.value, ctx);
    case 'setMin': {
      const next: SpeedState = { ...state, minSpeed: clampMinSpeed(action.value) };
      const clamped = clampSpeed(next.speed, next.minSpeed, next.maxSpeed);
      return clamped !== next.speed
        ? transitionToSpeed(next, clamped, ctx)
        : { state: next, effect: { kind: 'none' }, notifyRunState: false };
    }
    case 'setMax': {
      const next: SpeedState = { ...state, maxSpeed: clampMaxSpeed(action.value) };
      const clamped = clampSpeed(next.speed, next.minSpeed, next.maxSpeed);
      return clamped !== next.speed
        ? transitionToSpeed(next, clamped, ctx)
        : { state: next, effect: { kind: 'none' }, notifyRunState: false };
    }
  }
}

export interface SpeedControllerOptions {
  readonly initialSpeed?: number | undefined;
  readonly initialMinSpeed?: number | undefined;
  readonly initialMaxSpeed?: number | undefined;
  readonly autoRunner: AutoRunner;
  readonly canStepInDirection: (speed: number) => boolean;
  readonly onReverseBoundary: () => void;
  readonly onModeNotify: () => void;
  readonly onRunStateNotify: () => void;
}

export interface SpeedController {
  readonly current: number;
  readonly min: number;
  readonly max: number;
  beginDrag(): void;
  endDrag(): void;
  setSpeed(value: number): number;
  setMin(value: number): { readonly minSpeed: number; readonly speed: number };
  setMax(value: number): { readonly maxSpeed: number; readonly speed: number };
}

/**
 * Thin imperative shell around `transitionSpeed`: keeps current `SpeedState`
 * and applies scheduling/notification effects to `AutoRunner`.
 */
export function createSpeedController({
  initialSpeed,
  initialMinSpeed,
  initialMaxSpeed,
  autoRunner,
  canStepInDirection,
  onReverseBoundary,
  onModeNotify,
  onRunStateNotify,
}: SpeedControllerOptions): SpeedController {
  let state = createInitialSpeedState(initialSpeed, initialMinSpeed, initialMaxSpeed);

  const dispatch = (action: SpeedAction): void => {
    const result = transitionSpeed(state, action, {
      isAutoRunning: autoRunner.isRunning,
      elapsedSinceLastStepMs: performance.now() - autoRunner.lastStepTime,
      canStepInDirection,
    });
    state = result.state;

    switch (result.effect.kind) {
      case 'stop':
        autoRunner.cancel();
        if (result.effect.reverseBoundary) onReverseBoundary();
        onModeNotify();
        break;
      case 'reschedule':
        autoRunner.cancel();
        autoRunner.schedule(result.effect.delayMs);
        break;
      case 'resumeNow':
        autoRunner.markSteppedNow();
        autoRunner.schedule(0);
        break;
      case 'reverseBoundary':
        onReverseBoundary();
        break;
      case 'none':
        break;
    }

    if (result.notifyRunState) onRunStateNotify();
  };

  return {
    get current(): number {
      return state.speed;
    },
    get min(): number {
      return state.minSpeed;
    },
    get max(): number {
      return state.maxSpeed;
    },
    beginDrag: () => dispatch({ type: 'beginDrag' }),
    endDrag: () => dispatch({ type: 'endDrag' }),
    setSpeed(value) {
      dispatch({ type: 'setSpeed', value });
      return state.speed;
    },
    setMin(value) {
      dispatch({ type: 'setMin', value });
      return { minSpeed: state.minSpeed, speed: state.speed };
    },
    setMax(value) {
      dispatch({ type: 'setMax', value });
      return { maxSpeed: state.maxSpeed, speed: state.speed };
    },
  };
}
