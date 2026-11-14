/** Idle delay after the last step tick before suspending the `AudioContext`. */
export const AUDIO_IDLE_SUSPEND_MS = 2500;

/**
 * Optional click for each executed step, synthesised with Web Audio so the
 * app stays dependency-free and asset-free. The AudioContext is created
 * lazily on the first user gesture (autoplay policies), automatically
 * suspended while idle to release native audio buffers, and every failure is
 * swallowed: sound is a nice-to-have, never a reason for the machine to stop.
 */
export class StepSound {
  private context: AudioContext | null = null;
  private enabled: boolean;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleSuspendMs: number;

  constructor(enabled: boolean, idleSuspendMs = AUDIO_IDLE_SUSPEND_MS) {
    this.enabled = enabled;
    this.idleSuspendMs = idleSuspendMs;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.closeContext();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Call from a user gesture handler to unlock audio on mobile Safari. */
  unlock(): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (context === null) return;
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    this.scheduleIdleSuspend();
  }

  /** Short click at the current step. */
  tick(): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (context === null) return;

    try {
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;

      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.015, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.03);
      this.scheduleIdleSuspend();
    } catch {
      /* audio failure must never interrupt a machine step */
    }
  }

  /** Release timers and close any open `AudioContext`. */
  dispose(): void {
    this.closeContext();
  }

  private scheduleIdleSuspend(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.context?.state === 'running') {
        void this.context.suspend().catch(() => undefined);
      }
    }, this.idleSuspendMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private closeContext(): void {
    this.clearIdleTimer();
    if (this.context !== null) {
      void this.context.close().catch(() => undefined);
      this.context = null;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context !== null) return this.context;
    try {
      const Ctor = window.AudioContext;
      this.context = new Ctor();
      return this.context;
    } catch {
      return null;
    }
  }
}
