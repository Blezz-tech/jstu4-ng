import { assertNever } from '../../core/result';
import type { StepSound } from '../audio';
import type { AppController, UIMode } from '../controller';
import { listen, type AppDom } from './dom';
import { isNarrowViewport } from './sidepanels';

export interface GlobalShortcutContext {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlOrMeta: boolean;
  readonly inEditable: boolean;
  readonly inControl: boolean;
  readonly isNarrowViewport: boolean;
  readonly mode: UIMode;
  readonly isBlockingDialogOpen: boolean;
  readonly isHelpOpen: boolean;
  readonly isSettingsOpen: boolean;
  readonly isHistoryOpen: boolean;
  readonly isSidepanelOpen: boolean;
}

export type GlobalShortcutAction =
  | { readonly type: 'none' }
  | { readonly type: 'openHelp' }
  | { readonly type: 'closeSettings' }
  | { readonly type: 'closeHistoryDrawer' }
  | { readonly type: 'closeSidepanelDrawer' }
  | { readonly type: 'saveSnapshot' }
  | { readonly type: 'enter'; readonly withModifier: boolean }
  | { readonly type: 'space' }
  | { readonly type: 'shiftSpace' }
  | { readonly type: 'escape' };

const NO_ACTION: GlobalShortcutAction = { type: 'none' };

/**
 * Pure priority resolver for global keyboard shortcuts (`F1`, `?`, `Ctrl/Cmd+S`,
 * `Enter`, `Space`, `Shift+Space`, `Escape`, and drawer/menu dismiss keys).
 */
export function resolveGlobalShortcut(ctx: GlobalShortcutContext): GlobalShortcutAction {
  if (ctx.isBlockingDialogOpen) return NO_ACTION;

  if (ctx.key === 'F1' || (ctx.key === '?' && ctx.shiftKey && !ctx.inEditable)) {
    return { type: 'openHelp' };
  }

  if (ctx.isHelpOpen) return NO_ACTION;

  if (ctx.isSettingsOpen) {
    return ctx.key === 'Escape' ? { type: 'closeSettings' } : NO_ACTION;
  }

  if (ctx.isHistoryOpen && ctx.isNarrowViewport && ctx.key === 'Escape') {
    return { type: 'closeHistoryDrawer' };
  }

  if (ctx.isSidepanelOpen && ctx.isNarrowViewport && ctx.key === 'Escape') {
    return { type: 'closeSidepanelDrawer' };
  }

  if (
    ctx.ctrlOrMeta &&
    !ctx.altKey &&
    !ctx.shiftKey &&
    (ctx.key.toLowerCase() === 's' || ctx.code === 'KeyS') &&
    ctx.mode === 'edit'
  ) {
    return { type: 'saveSnapshot' };
  }

  if (ctx.key === 'Enter' && !ctx.inEditable && (ctx.ctrlOrMeta || !ctx.inControl)) {
    return ctx.mode !== 'edit' || ctx.ctrlOrMeta
      ? { type: 'enter', withModifier: ctx.ctrlOrMeta }
      : NO_ACTION;
  }

  if (ctx.key === ' ' && !ctx.inEditable && !ctx.inControl && !ctx.altKey && !ctx.ctrlOrMeta) {
    return ctx.shiftKey ? { type: 'shiftSpace' } : { type: 'space' };
  }

  if (ctx.key === 'Escape' && (!ctx.inEditable || ctx.mode === 'error')) {
    return { type: 'escape' };
  }

  return NO_ACTION;
}

export interface ShortcutsOptions {
  readonly doc: Document;
  readonly dom: AppDom;
  readonly controller: AppController;
  readonly sound: StepSound;
  readonly isHelpOpen: () => boolean;
  readonly isBlockingDialogOpen: () => boolean;
  readonly isSettingsOpen: () => boolean;
  readonly isHistoryOpen: () => boolean;
  readonly isSidepanelOpen: () => boolean;
  readonly openHelp: () => void;
  readonly closeSettings: (restoreFocus: boolean) => void;
  readonly closeHistoryDrawer: () => void;
  readonly closeSidepanelDrawer: () => void;
  readonly saveSnapshot: () => void;
  readonly signal: AbortSignal;
}

/**
 * Wires editor shortcuts, read-only pane click-to-edit interactions, and
 * global keyboard shortcuts (`F1`, `?`, `Ctrl/Cmd+S`, `Enter`, `Space`,
 * `Shift+Space`, `Escape`), all cleanly detachable via `AbortSignal`.
 */
export function bindShortcuts(options: ShortcutsOptions): void {
  const { doc, dom, controller, sound, signal } = options;

  listen(
    dom.tapeInput,
    'keydown',
    (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sound.unlock();
        controller.start();
      }
    },
    signal,
  );

  // Clicking the tape field in error mode leaves error mode (matching v2.3).
  listen(
    dom.tapeInput,
    'click',
    () => {
      if (controller.currentMode !== 'edit') {
        controller.backToEdit('tape');
      }
    },
    signal,
  );

  // Ctrl+Enter anywhere in the editor runs the program.
  listen(
    dom.programInput,
    'keydown',
    (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        sound.unlock();
        controller.start();
      }
    },
    signal,
  );

  // Clicks on the read-only panes behave like "Back to edit", unless the user
  // just dragged a text selection to copy from the listing or tape.
  listen(
    dom.programView,
    'click',
    () => {
      if (window.getSelection()?.toString()) return;
      controller.backToEdit('program');
    },
    signal,
  );
  listen(
    dom.tapeView,
    'click',
    () => {
      if (window.getSelection()?.toString()) return;
      controller.backToEdit('tape');
    },
    signal,
  );

  listen(
    doc,
    'keydown',
    (event) => {
      if (event.defaultPrevented) return;

      const target = event.target;
      const inEditable =
        (target instanceof HTMLInputElement && target.type !== 'range') ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      // Enter and Space are the activation keys of buttons and links: the global
      // shortcuts must not hijack them (e.g. pressing Enter on a focused button
      // must click that button, not start the machine).
      const inControl =
        target instanceof Element &&
        target.closest('button, a, [role="button"], select, summary') !== null;

      const action = resolveGlobalShortcut({
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlOrMeta: event.ctrlKey || event.metaKey,
        inEditable,
        inControl,
        isNarrowViewport: isNarrowViewport(),
        mode: controller.currentMode,
        isBlockingDialogOpen: options.isBlockingDialogOpen(),
        isHelpOpen: options.isHelpOpen(),
        isSettingsOpen: options.isSettingsOpen(),
        isHistoryOpen: options.isHistoryOpen(),
        isSidepanelOpen: options.isSidepanelOpen(),
      });

      switch (action.type) {
        case 'none':
          return;
        case 'openHelp':
          event.preventDefault();
          options.openHelp();
          return;
        case 'closeSettings':
          event.preventDefault();
          options.closeSettings(true);
          return;
        case 'closeHistoryDrawer':
          event.preventDefault();
          options.closeHistoryDrawer();
          return;
        case 'closeSidepanelDrawer':
          event.preventDefault();
          options.closeSidepanelDrawer();
          return;
        case 'saveSnapshot':
          event.preventDefault();
          options.saveSnapshot();
          return;
        case 'enter':
          event.preventDefault();
          sound.unlock();
          controller.handleEnter(action.withModifier);
          return;
        case 'space':
          event.preventDefault();
          sound.unlock();
          controller.handleSpace();
          return;
        case 'shiftSpace':
          event.preventDefault();
          sound.unlock();
          controller.handleShiftSpace();
          return;
        case 'escape':
          controller.handleEscape();
          return;
        default:
          assertNever(action);
      }
    },
    signal,
  );
}
