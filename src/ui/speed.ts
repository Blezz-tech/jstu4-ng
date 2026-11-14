/** Execution speed configuration and pure helpers for auto-run mode. */

export const MIN_SPEED = 0.5;
export const SPEED_STEP = 0.5;
export const DEFAULT_SPEED = 1;

export const DEFAULT_MAX_SPEED = 10;
export const MIN_MAX_SPEED = 1;
export const MAX_MAX_SPEED = 1000;

/** Steps executed per second at normal (1×) speed (200 ms per step). */
export const BASE_STEPS_PER_SECOND = 5;

function roundToStep(value: number): number {
  return Math.round(value / SPEED_STEP) * SPEED_STEP;
}

/** Clamp a user-configured max speed multiplier into `[MIN_MAX_SPEED, MAX_MAX_SPEED]`. */
export function clampMaxSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SPEED;
  const clamped = Math.min(MAX_MAX_SPEED, Math.max(MIN_MAX_SPEED, value));
  return Math.max(MIN_MAX_SPEED, roundToStep(clamped));
}

/** Clamp an execution speed multiplier into `[MIN_SPEED, maxSpeed]`. */
export function clampSpeed(value: number, maxSpeed: number = DEFAULT_MAX_SPEED): number {
  const safeMax = clampMaxSpeed(maxSpeed);
  if (!Number.isFinite(value)) return Math.min(DEFAULT_SPEED, safeMax);
  const clamped = Math.min(safeMax, Math.max(MIN_SPEED, value));
  return Math.min(safeMax, Math.max(MIN_SPEED, roundToStep(clamped)));
}

/** Milliseconds between consecutive steps at a given speed multiplier. */
export function stepIntervalMs(speed: number): number {
  const safeSpeed = Math.max(MIN_SPEED, Number.isFinite(speed) ? speed : DEFAULT_SPEED);
  return 1000 / (BASE_STEPS_PER_SECOND * safeSpeed);
}

/** Human-readable multiplier label, e.g. `0.5×`, `1×`, `2.5×`, `10×`. */
export function formatSpeed(speed: number): string {
  const rounded = Number(speed.toFixed(1));
  return `${rounded}\u00d7`;
}
