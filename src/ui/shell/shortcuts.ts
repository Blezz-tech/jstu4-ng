import type { StepSound } from '../audio';
import type { AppController } from '../controller';
import { listen, type AppDom } from './dom';
import { isNarrowViewport } from './sidepanels';

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
  readonly syncRunToggleLabel: () => void;
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

      if (options.isBlockingDialogOpen()) return;

      if (event.key === 'F1' || (event.key === '?' && event.shiftKey && !inEditable)) {
        event.preventDefault();
        options.openHelp();
        return;
      }

      if (options.isHelpOpen()) return;

      if (options.isSettingsOpen()) {
        if (event.key === 'Escape') {
          event.preventDefault();
          options.closeSettings(true);
        }
        return;
      }

      if (options.isHistoryOpen() && isNarrowViewport() && event.key === 'Escape') {
        event.preventDefault();
        options.closeHistoryDrawer();
        return;
      }

      if (options.isSidepanelOpen() && isNarrowViewport() && event.key === 'Escape') {
        event.preventDefault();
        options.closeSidepanelDrawer();
        return;
      }

      const hasModifier = event.ctrlKey || event.metaKey;

      if (
        hasModifier &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 's' &&
        controller.currentMode === 'edit'
      ) {
        event.preventDefault();
        options.saveSnapshot();
        return;
      }

      if (event.key === 'Enter' && !inEditable && (hasModifier || !inControl)) {
        if (controller.currentMode !== 'edit' || hasModifier) {
          event.preventDefault();
          sound.unlock();
          controller.handleEnter(hasModifier);
          options.syncRunToggleLabel();
        }
        return;
      }

      if (
        event.key === ' ' &&
        !inEditable &&
        !inControl &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        sound.unlock();
        if (event.shiftKey) controller.handleShiftSpace();
        else controller.handleSpace();
        options.syncRunToggleLabel();
        return;
      }

      if (event.key === 'Escape' && (!inEditable || controller.currentMode === 'error')) {
        controller.handleEscape();
        options.syncRunToggleLabel();
      }
    },
    signal,
  );
}
