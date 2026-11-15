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

/**
 * Owns bidirectional speed bounds (`[minSpeed, maxSpeed]`), slider drag state
 * (including seamless stop/resume when dragging across `0`), and live timer
 * rescheduling on `AutoRunner`.
 */
export class SpeedController {
  private minSpeed: number;
  private maxSpeed: number;
  private speed: number;
  private dragging = false;
  private resumeAfterZeroDrag = false;

  constructor(private readonly options: SpeedControllerOptions) {
    this.minSpeed = clampMinSpeed(options.initialMinSpeed ?? DEFAULT_MIN_SPEED);
    this.maxSpeed = clampMaxSpeed(options.initialMaxSpeed ?? DEFAULT_MAX_SPEED);
    this.speed = clampSpeed(options.initialSpeed ?? DEFAULT_SPEED, this.minSpeed, this.maxSpeed);
  }

  get current(): number {
    return this.speed;
  }

  get min(): number {
    return this.minSpeed;
  }

  get max(): number {
    return this.maxSpeed;
  }

  beginDrag(): void {
    this.dragging = true;
    this.resumeAfterZeroDrag = this.options.autoRunner.isRunning;
  }

  endDrag(): void {
    this.dragging = false;
    this.resumeAfterZeroDrag = false;
  }

  setSpeed(value: number): number {
    const next = clampSpeed(value, this.minSpeed, this.maxSpeed);
    if (next === this.speed) return next;
    this.speed = next;

    const { autoRunner, canStepInDirection, onReverseBoundary, onModeNotify, onRunStateNotify } =
      this.options;

    if (next === 0) {
      if (autoRunner.isRunning) {
        if (this.dragging) this.resumeAfterZeroDrag = true;
        autoRunner.cancel();
        onModeNotify();
      }
      onRunStateNotify();
      return next;
    }

    if (autoRunner.isRunning) {
      autoRunner.cancel();
      if (canStepInDirection(next)) {
        const remaining = Math.max(
          0,
          Math.round(stepIntervalMs(this.speed) - (performance.now() - autoRunner.lastStepTime)),
        );
        autoRunner.schedule(remaining);
      } else {
        if (next < 0) onReverseBoundary();
        onModeNotify();
      }
    } else if (this.dragging && this.resumeAfterZeroDrag) {
      if (canStepInDirection(next)) {
        autoRunner.markSteppedNow();
        autoRunner.schedule(0);
      } else if (next < 0) {
        onReverseBoundary();
      }
    }

    onRunStateNotify();
    return next;
  }

  setMin(value: number): { readonly minSpeed: number; readonly speed: number } {
    this.minSpeed = clampMinSpeed(value);
    this.clampToBounds();
    return { minSpeed: this.minSpeed, speed: this.speed };
  }

  setMax(value: number): { readonly maxSpeed: number; readonly speed: number } {
    this.maxSpeed = clampMaxSpeed(value);
    this.clampToBounds();
    return { maxSpeed: this.maxSpeed, speed: this.speed };
  }

  private clampToBounds(): void {
    const clamped = clampSpeed(this.speed, this.minSpeed, this.maxSpeed);
    if (clamped !== this.speed) this.setSpeed(clamped);
  }
}
