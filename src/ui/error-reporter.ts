import type { CompileError, RuntimeError } from '../core/errors';
import type { Command } from '../core/machine';
import { assertNever } from '../core/result';
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
 * Render a compile-time error into the read-only listing and publish its
 * localized message. Returns the editor cursor offset to restore on edit.
 */
export function displayCompileError(error: CompileError, ctx: CompileErrorContext): number | null {
  const { text, listing, programView, programRenderer, notifications } = ctx;
  notifications.clear();

  switch (error.kind) {
    case 'parseError':
      programRenderer.mountParseError(programView, text, error.offset);
      notifications.show('error', (i) => i.t('error.parseError', { text: error.text }));
      return error.offset;

    case 'emptyProgram':
      programRenderer.clear();
      programView.textContent = text;
      notifications.show('error', (i) => i.t('error.programIsEmpty'));
      return null;

    case 'ambiguousCommand': {
      mountListingWithErrors(programView, programRenderer, listing, [
        error.command,
        error.original,
      ]);
      const { q, a } = error.command;
      notifications.show('error', (i) => i.t('error.ambiguousCommand', { q: String(q), a }));
      return error.command.source.offset;
    }

    case 'nonexistentTargetState': {
      mountListingWithErrors(programView, programRenderer, listing, [error.command]);
      const w = String(error.command.w);
      notifications.show('error', (i) => i.t('error.targetStateDoesNotExist', { w }));
      return error.command.source.offset;
    }

    case 'nonexistentInitialState': {
      mountListingWithErrors(programView, programRenderer, listing, []);
      const q = String(error.state);
      notifications.show('error', (i) => i.t('error.initialStateDoesNotExist', { q }));
      return null;
    }

    default:
      return assertNever(error);
  }
}

/** Publish a runtime error, marking the offending command when applicable. */
export function displayRuntimeError(
  error: RuntimeError,
  notifications: NotificationLog,
  markError: (command: Command) => void,
): void {
  switch (error.kind) {
    case 'noSuchCommand': {
      const q = String(error.state);
      const a = error.symbol;
      notifications.show('error', (i) => i.t('error.noSuchCommand', { q, a }));
      return;
    }

    case 'outOfTape':
      markError(error.command);
      notifications.show('error', (i) => i.t('error.headIsOutOfTape'));
      return;

    default:
      assertNever(error);
  }
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
