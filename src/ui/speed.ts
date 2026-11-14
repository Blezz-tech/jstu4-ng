/** Bidirectional execution speed configuration and pure helpers for auto-run mode. */

export const SPEED_STEP = 0.5;
export const DEFAULT_SPEED = 1;

export const DEFAULT_MIN_SPEED = -15;
export const MIN_MIN_SPEED = -1000;
export const MAX_MIN_SPEED = -1;

export const DEFAULT_MAX_SPEED = 25;
export const MIN_MAX_SPEED = 1;
export const MAX_MAX_SPEED = 1000;

/** Steps executed per second at normal (1×) speed (200 ms per step). */
export const BASE_STEPS_PER_SECOND = 5;

function roundToStep(value: number): number {
  const rounded = Math.round(value / SPEED_STEP) * SPEED_STEP;
  return rounded === 0 ? 0 : rounded;
}

/** Clamp a user-configured minimum (reverse) speed multiplier into `[MIN_MIN_SPEED, MAX_MIN_SPEED]`. */
export function clampMinSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_SPEED;
  const clamped = Math.min(MAX_MIN_SPEED, Math.max(MIN_MIN_SPEED, value));
  return Math.min(MAX_MIN_SPEED, Math.max(MIN_MIN_SPEED, roundToStep(clamped)));
}

/** Clamp a user-configured maximum (forward) speed multiplier into `[MIN_MAX_SPEED, MAX_MAX_SPEED]`. */
export function clampMaxSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SPEED;
  const clamped = Math.min(MAX_MAX_SPEED, Math.max(MIN_MAX_SPEED, value));
  return Math.min(MAX_MAX_SPEED, Math.max(MIN_MAX_SPEED, roundToStep(clamped)));
}

/** Clamp an execution speed multiplier into `[minSpeed, maxSpeed]` (crossing `0`). */
export function clampSpeed(
  value: number,
  minSpeed: number = DEFAULT_MIN_SPEED,
  maxSpeed: number = DEFAULT_MAX_SPEED,
): number {
  const safeMin = clampMinSpeed(minSpeed);
  const safeMax = clampMaxSpeed(maxSpeed);
  if (!Number.isFinite(value)) return Math.min(safeMax, Math.max(safeMin, DEFAULT_SPEED));
  const clamped = Math.min(safeMax, Math.max(safeMin, value));
  return Math.min(safeMax, Math.max(safeMin, roundToStep(clamped)));
}

/** Milliseconds between consecutive steps at a given speed multiplier (`Infinity` at `0`). */
export function stepIntervalMs(speed: number): number {
  if (!Number.isFinite(speed)) return 1000 / (BASE_STEPS_PER_SECOND * DEFAULT_SPEED);
  const magnitude = Math.abs(speed);
  if (magnitude === 0) return Number.POSITIVE_INFINITY;
  return 1000 / (BASE_STEPS_PER_SECOND * Math.max(SPEED_STEP, magnitude));
}

/** Relative position `[0..1]` of the `0` mark along `[minSpeed, maxSpeed]`. */
export function zeroRatio(
  minSpeed: number = DEFAULT_MIN_SPEED,
  maxSpeed: number = DEFAULT_MAX_SPEED,
): number {
  const safeMin = clampMinSpeed(minSpeed);
  const safeMax = clampMaxSpeed(maxSpeed);
  return (0 - safeMin) / (safeMax - safeMin);
}

/** Human-readable multiplier label, e.g. `-15×`, `0×`, `0.5×`, `1×`, `25×`. */
export function formatSpeed(speed: number): string {
  const normalized = Number(speed.toFixed(1));
  const clean = normalized === 0 ? 0 : normalized;
  return `${clean}\u00d7`;
}
