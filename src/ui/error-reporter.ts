import {
  AmbiguousCommandError,
  EmptyProgramError,
  MachineError,
  NoSuchCommandError,
  NonexistentInitialStateError,
  NonexistentTargetStateError,
  OutOfTapeError,
  ParseError,
} from '../core/errors';
import type { Command } from '../core/machine';
import type { MachineRun } from '../core/run';
import type { NotificationLog } from './notifications';
import type { ProgramListing, ProgramRenderer } from './render';

export interface CompileErrorContext {
  readonly text: string;
  readonly listing: ProgramListing | null;
  readonly programView: HTMLElement;
  readonly programRenderer: ProgramRenderer;
  readonly notifications: NotificationLog;
}

function mountListingWithErrors(
  programView: HTMLElement,
  programRenderer: ProgramRenderer,
  listing: ProgramListing | null,
  commands: readonly Command[],
): void {
  if (listing === null) return;
  const errorIndices: number[] = [];
  if (commands.length > 0) {
    listing.commands.forEach((command, index) => {
      if (commands.includes(command)) errorIndices.push(index);
    });
  }
  programRenderer.mount(programView, listing, errorIndices);
}

/**
 * Render a compile-time `MachineError` into the read-only listing and publish
 * its localized message. Returns the editor cursor offset to restore on edit.
 */
export function displayCompileError(error: unknown, ctx: CompileErrorContext): number | null {
  if (!(error instanceof MachineError)) throw error;

  const { text, listing, programView, programRenderer, notifications } = ctx;
  notifications.clear();

  if (error instanceof ParseError) {
    programRenderer.mountParseError(programView, text, error.data.offset);
    notifications.show('error', (i) => i.t('error.parseError', { text: error.data.text }));
    return error.data.offset;
  }

  if (error instanceof EmptyProgramError) {
    programRenderer.clear();
    programView.textContent = text;
    notifications.show('error', (i) => i.t('error.programIsEmpty'));
    return null;
  }

  if (error instanceof AmbiguousCommandError) {
    mountListingWithErrors(programView, programRenderer, listing, [
      error.data.command,
      error.data.original,
    ]);
    const { q, a } = error.data.command;
    notifications.show('error', (i) => i.t('error.ambiguousCommand', { q: String(q), a }));
    return error.data.command.source.offset;
  }

  if (error instanceof NonexistentTargetStateError) {
    mountListingWithErrors(programView, programRenderer, listing, [error.data.command]);
    const w = String(error.data.command.w);
    notifications.show('error', (i) => i.t('error.targetStateDoesNotExist', { w }));
    return error.data.command.source.offset;
  }

  if (error instanceof NonexistentInitialStateError) {
    mountListingWithErrors(programView, programRenderer, listing, []);
    const q = String(error.data.state);
    notifications.show('error', (i) => i.t('error.initialStateDoesNotExist', { q }));
    return null;
  }

  throw error;
}

/** Publish a runtime `MachineError`, marking the offending command when applicable. */
export function displayRuntimeError(
  error: unknown,
  notifications: NotificationLog,
  markError: (command: Command | null) => void,
): void {
  if (error instanceof NoSuchCommandError) {
    const q = String(error.data.state);
    const a = error.data.symbol;
    notifications.show('error', (i) => i.t('error.noSuchCommand', { q, a }));
    return;
  }
  if (error instanceof OutOfTapeError) {
    markError(error.data.command);
    notifications.show('error', (i) => i.t('error.headIsOutOfTape'));
    return;
  }
  throw error;
}

/** Publish the final normality status after a halting command completes. */
export function displayRunFinish(run: MachineRun, notifications: NotificationLog): void {
  const normality = run.checkNormality();
  const [kind, key] =
    normality === 'sourceAltered'
      ? (['warning', 'log.warningSourceAltered'] as const)
      : normality === 'misplaced'
        ? (['warning', 'log.warningMisposition'] as const)
        : (['info', 'log.finished'] as const);
  notifications.show(kind, (i) => i.t(key));
}

/** Publish the appropriate boundary message when `stepBack` hits start or history cap. */
export function displayStepBackBoundary(run: MachineRun, notifications: NotificationLog): void {
  const key = run.isAtStart ? 'log.reachedInitialState' : 'log.reachedHistoryLimit';
  notifications.show('info', (i) => i.t(key));
}
