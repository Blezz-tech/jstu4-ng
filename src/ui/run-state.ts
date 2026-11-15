export type UIMode = 'edit' | 'run' | 'error';

/** Snapshot of run-mode control availability emitted whenever execution state changes. */
export interface RunControlState {
  readonly isRunning: boolean;
  readonly isAutoRunning: boolean;
  readonly canStepForward: boolean;
  readonly canStepBack: boolean;
  readonly canAutoRun: boolean;
  readonly canRestart: boolean;
  readonly speed: number;
}

/** Read-only projection of an active `MachineRun` needed to derive UI control state. */
export interface RunSnapshot {
  readonly isRunning: boolean;
  readonly canStepBack: boolean;
  readonly stepsCount: number;
}

export type EnterAction = 'start' | 'toggleAutoRun' | 'backToTape' | 'backToProgram' | 'none';
export type EscapeAction = 'stopAutoRun' | 'backToTape' | 'backToProgram' | 'none';

/** Normalise tabs and pasted line breaks to spaces (1-to-1 per tape cell). */
export function coerceTape(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ');
}

/** Whether the run can advance by one step in the direction of `speed`. */
export function canStepInDirection(run: RunSnapshot | null, speed: number): boolean {
  if (run === null || speed === 0) return false;
  return speed > 0 ? run.isRunning : run.canStepBack;
}

/** Pure derivation of run-mode transport control flags from mode, run snapshot, auto-run, and speed. */
export function deriveRunControlState(
  mode: UIMode,
  run: RunSnapshot | null,
  isAutoRunning: boolean,
  speed: number,
): RunControlState {
  const inRun = mode === 'run' && run !== null;
  const isRunning = inRun && run.isRunning;
  const canStepBack = inRun && run.canStepBack;
  const canRestart = inRun && (run.stepsCount > 0 || !run.isRunning);
  const canAutoRun = inRun && (isAutoRunning || canStepInDirection(run, speed));
  return {
    isRunning,
    isAutoRunning,
    canStepForward: isRunning,
    canStepBack,
    canAutoRun,
    canRestart,
    speed,
  };
}

/** Pick which editor field should receive focus when returning to `edit` mode. */
export function resolveBackToEditTarget(
  previousMode: UIMode,
  returnCursorOffset: number | null,
  explicitFocus?: 'program' | 'tape',
): 'program' | 'tape' {
  return (
    explicitFocus ?? (previousMode === 'error' || returnCursorOffset !== null ? 'program' : 'tape')
  );
}

/** Pure keyboard intent resolution for `Enter` (with or without Ctrl/Meta modifier). */
export function resolveEnterAction(
  mode: UIMode,
  state: RunControlState,
  withModifier: boolean,
): EnterAction {
  if (mode === 'edit') return withModifier ? 'start' : 'none';
  if (mode === 'run') {
    if (state.canAutoRun) return 'toggleAutoRun';
    if (!state.isRunning && state.speed >= 0) return 'backToTape';
    return 'none';
  }
  return 'backToProgram';
}

/** Pure keyboard intent resolution for `Escape`. */
export function resolveEscapeAction(mode: UIMode, isAutoRunning: boolean): EscapeAction {
  if (mode === 'edit') return 'none';
  if (mode === 'run') return isAutoRunning ? 'stopAutoRun' : 'backToTape';
  return 'backToProgram';
}
