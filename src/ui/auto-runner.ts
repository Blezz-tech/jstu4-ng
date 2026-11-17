import { BASE_STEPS_PER_SECOND, stepIntervalMs } from './speed';

const RAF_THRESHOLD_MS = 20;
const MAX_BATCH_STEPS_PER_FRAME = 256;
const MAX_BATCH_MS_PER_FRAME = 6;

export type StepDirection = 'forward' | 'reverse';

export interface AutoRunnerOptions {
  readonly getSpeed: () => number;
  readonly getOpsCount: () => number;
  readonly step: (direction: StepDirection, playSound: boolean, render: boolean) => boolean;
  readonly onBatchFlush: (direction: StepDirection) => void;
  readonly onSound: () => void;
  readonly onHalt: () => void;
  readonly onModeNotify: () => void;
  readonly onRunStateNotify: () => void;
}

export interface AutoRunner {
  readonly isRunning: boolean;
  readonly lastStepTime: number;
  markSteppedNow(): void;
  schedule(initialDelayMs?: number): void;
  cancel(): void;
}

/** Pure frame step-budget accumulator for high-speed `requestAnimationFrame` batching. */
export function computeFrameBatch(
  elapsedMs: number,
  speed: number,
  prevBudget: number,
): { readonly budget: number; readonly targetSteps: number } {
  const clampedElapsed = Math.max(0, Math.min(100, elapsedMs));
  const budget = prevBudget + (clampedElapsed * BASE_STEPS_PER_SECOND * Math.abs(speed)) / 1000;
  const targetSteps = Math.min(MAX_BATCH_STEPS_PER_FRAME, Math.max(1, Math.floor(budget)));
  return { budget, targetSteps };
}

/**
 * Generation-guarded auto-execution scheduler supporting both `setTimeout`
 * (low/normal speeds) and time-budgeted `requestAnimationFrame` frame batching
 * (`|speed| > 10×`, flushing DOM once per frame).
 */
export function createAutoRunner({
  getSpeed,
  getOpsCount,
  step,
  onBatchFlush,
  onSound,
  onHalt,
  onModeNotify,
  onRunStateNotify,
}: AutoRunnerOptions): AutoRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let raf: number | null = null;
  let running = false;
  let generation = 0;
  let lastStepAt = 0;

  return {
    get isRunning(): boolean {
      return running;
    },
    get lastStepTime(): number {
      return lastStepAt;
    },
    markSteppedNow() {
      lastStepAt = performance.now();
    },
    schedule(initialDelayMs) {
      const speed = getSpeed();
      if (speed === 0) return;

      running = true;
      const gen = ++generation;
      const interval = stepIntervalMs(speed);

      if (interval < RAF_THRESHOLD_MS) {
        let lastFrameAt = performance.now();
        let stepBudget = 0;

        const frame = (now: number): void => {
          if (gen !== generation) return;
          raf = null;
          const curSpeed = getSpeed();
          if (curSpeed === 0) {
            onHalt();
            return;
          }

          const batch = computeFrameBatch(now - lastFrameAt, curSpeed, stepBudget);
          lastFrameAt = now;
          stepBudget = batch.budget;

          const deadline = performance.now() + MAX_BATCH_MS_PER_FRAME;
          const opsBefore = getOpsCount();
          const direction: StepDirection = curSpeed > 0 ? 'forward' : 'reverse';
          let stepped = 0;
          let keepGoing = true;

          while (
            keepGoing &&
            stepped < batch.targetSteps &&
            (stepped === 0 || performance.now() < deadline)
          ) {
            keepGoing = step(direction, false, false);
            stepped += 1;
          }
          stepBudget = Math.max(0, stepBudget - stepped);
          lastStepAt = performance.now();

          if (stepped > 0 && keepGoing && gen === generation) {
            onBatchFlush(direction);
          }
          if (getOpsCount() !== opsBefore) onSound();

          if (!keepGoing || gen !== generation) {
            onModeNotify();
            return;
          }
          raf = requestAnimationFrame(frame);
        };

        raf = requestAnimationFrame(frame);
      } else {
        const tick = (): void => {
          if (gen !== generation) return;
          timer = null;
          lastStepAt = performance.now();
          const curSpeed = getSpeed();
          if (curSpeed === 0) {
            onHalt();
            return;
          }

          const direction: StepDirection = curSpeed > 0 ? 'forward' : 'reverse';
          if (!step(direction, true, true) || gen !== generation) {
            onModeNotify();
            return;
          }
          timer = setTimeout(tick, Math.round(stepIntervalMs(getSpeed())));
        };

        timer = setTimeout(tick, initialDelayMs ?? Math.round(interval));
      }

      onModeNotify();
      onRunStateNotify();
    },
    cancel() {
      running = false;
      generation += 1;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    },
  };
}
