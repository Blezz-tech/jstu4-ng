/** Idle delay after the last step tick before suspending the `AudioContext`. */
export const AUDIO_IDLE_SUSPEND_MS = 2500;

export interface StepSound {
  readonly isEnabled: boolean;
  setEnabled(enabled: boolean): void;
  /** Call from a user gesture handler to unlock audio on mobile Safari. */
  unlock(): void;
  /** Short click at the current step. */
  tick(): void;
  /** Release timers and close any open `AudioContext`. */
  dispose(): void;
}

/**
 * Optional click for each executed step, synthesised with Web Audio so the
 * app stays dependency-free and asset-free. The AudioContext is created
 * lazily on the first user gesture (autoplay policies), automatically
 * suspended while idle to release native audio buffers, and every failure is
 * swallowed: sound is a nice-to-have, never a reason for the machine to stop.
 */
export function createStepSound(
  initialEnabled: boolean,
  idleSuspendMs = AUDIO_IDLE_SUSPEND_MS,
): StepSound {
  let context: AudioContext | null = null;
  let enabled = initialEnabled;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdleSuspend = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (context?.state === 'running') {
        void context.suspend().catch(() => undefined);
      }
    }, idleSuspendMs);
  };

  const closeContext = (): void => {
    clearIdleTimer();
    if (context !== null) {
      void context.close().catch(() => undefined);
      context = null;
    }
  };

  const ensureContext = (): AudioContext | null => {
    if (context !== null) return context;
    try {
      const Ctor = window.AudioContext;
      context = new Ctor();
      return context;
    } catch {
      return null;
    }
  };

  return {
    get isEnabled(): boolean {
      return enabled;
    },
    setEnabled(next) {
      enabled = next;
      if (!next) closeContext();
    },
    unlock() {
      if (!enabled) return;
      const ctx = ensureContext();
      if (ctx === null) return;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      scheduleIdleSuspend();
    },
    tick() {
      if (!enabled) return;
      const ctx = ensureContext();
      if (ctx === null) return;

      try {
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const now = ctx.currentTime;

        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.015, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.03);
        scheduleIdleSuspend();
      } catch {
        /* audio failure must never interrupt a machine step */
      }
    },
    dispose: closeContext,
  };
}
