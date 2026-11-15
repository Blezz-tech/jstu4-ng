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

/**
 * Generation-guarded auto-execution scheduler supporting both `setTimeout`
 * (low/normal speeds) and time-budgeted `requestAnimationFrame` frame batching
 * (`|speed| > 10×`, flushing DOM once per frame).
 */
export class AutoRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf: number | null = null;
  private running = false;
  private generation = 0;
  private lastStepAt = 0;

  constructor(private readonly options: AutoRunnerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  get lastStepTime(): number {
    return this.lastStepAt;
  }

  markSteppedNow(): void {
    this.lastStepAt = performance.now();
  }

  schedule(initialDelayMs?: number): void {
    const speed = this.options.getSpeed();
    if (speed === 0) return;

    this.running = true;
    const generation = ++this.generation;
    const interval = stepIntervalMs(speed);

    if (interval < RAF_THRESHOLD_MS) {
      let lastFrameAt = performance.now();
      let stepBudget = 0;

      const frame = (now: number): void => {
        if (generation !== this.generation) return;
        this.raf = null;
        const curSpeed = this.options.getSpeed();
        if (curSpeed === 0) {
          this.options.onHalt();
          return;
        }

        const elapsedMs = Math.max(0, Math.min(100, now - lastFrameAt));
        lastFrameAt = now;
        stepBudget += (elapsedMs * BASE_STEPS_PER_SECOND * Math.abs(curSpeed)) / 1000;

        const targetSteps = Math.min(
          MAX_BATCH_STEPS_PER_FRAME,
          Math.max(1, Math.floor(stepBudget)),
        );
        const deadline = performance.now() + MAX_BATCH_MS_PER_FRAME;
        const opsBefore = this.options.getOpsCount();
        const direction: StepDirection = curSpeed > 0 ? 'forward' : 'reverse';
        let stepped = 0;
        let keepGoing = true;

        while (
          keepGoing &&
          stepped < targetSteps &&
          (stepped === 0 || performance.now() < deadline)
        ) {
          keepGoing = this.options.step(direction, false, false);
          stepped += 1;
        }
        stepBudget = Math.max(0, stepBudget - stepped);
        this.lastStepAt = performance.now();

        if (stepped > 0 && keepGoing && generation === this.generation) {
          this.options.onBatchFlush(direction);
        }
        if (this.options.getOpsCount() !== opsBefore) this.options.onSound();

        if (!keepGoing || generation !== this.generation) {
          this.options.onModeNotify();
          return;
        }
        this.raf = requestAnimationFrame(frame);
      };

      this.raf = requestAnimationFrame(frame);
    } else {
      const tick = (): void => {
        if (generation !== this.generation) return;
        this.timer = null;
        this.lastStepAt = performance.now();
        const curSpeed = this.options.getSpeed();
        if (curSpeed === 0) {
          this.options.onHalt();
          return;
        }

        const direction: StepDirection = curSpeed > 0 ? 'forward' : 'reverse';
        if (!this.options.step(direction, true, true) || generation !== this.generation) {
          this.options.onModeNotify();
          return;
        }
        this.timer = setTimeout(tick, Math.round(stepIntervalMs(this.options.getSpeed())));
      };

      this.timer = setTimeout(tick, initialDelayMs ?? Math.round(interval));
    }

    this.options.onModeNotify();
    this.options.onRunStateNotify();
  }

  cancel(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }
}
