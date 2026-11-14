/**
 * Optional click for each executed step, synthesised with Web Audio so the
 * app stays dependency-free and asset-free. The AudioContext is created
 * lazily on the first user gesture (autoplay policies), and every failure is
 * swallowed: sound is a nice-to-have, never a reason for the machine to stop.
 */
export class StepSound {
  private context: AudioContext | null = null;
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) void this.context?.close().catch(() => undefined);
    if (!enabled) this.context = null;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Call from a user gesture handler to unlock audio on mobile Safari. */
  unlock(): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (context?.state === 'suspended') void context.resume().catch(() => undefined);
  }

  /** Short click at the current step. */
  tick(): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (context === null) return;

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
