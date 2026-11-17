import { describe, expect, it } from 'vitest';
import { resolveGlobalShortcut, type GlobalShortcutContext } from '../src/ui/shell/shortcuts';

function ctx(overrides: Partial<GlobalShortcutContext> = {}): GlobalShortcutContext {
  return {
    key: '',
    code: '',
    shiftKey: false,
    altKey: false,
    ctrlOrMeta: false,
    inEditable: false,
    inControl: false,
    isNarrowViewport: false,
    mode: 'edit',
    isBlockingDialogOpen: false,
    isHelpOpen: false,
    isSettingsOpen: false,
    isHistoryOpen: false,
    isSidepanelOpen: false,
    ...overrides,
  };
}

describe('resolveGlobalShortcut', () => {
  it('blocks every shortcut while a modal blocking dialog is open', () => {
    expect(resolveGlobalShortcut(ctx({ key: 'F1', isBlockingDialogOpen: true }))).toEqual({
      type: 'none',
    });
    expect(resolveGlobalShortcut(ctx({ key: 'Escape', isBlockingDialogOpen: true }))).toEqual({
      type: 'none',
    });
  });

  it('opens Help on F1 (even in editable fields) and on Shift+? only outside editables', () => {
    expect(resolveGlobalShortcut(ctx({ key: 'F1', inEditable: true }))).toEqual({
      type: 'openHelp',
    });
    expect(resolveGlobalShortcut(ctx({ key: '?', shiftKey: true, inEditable: false }))).toEqual({
      type: 'openHelp',
    });
    expect(resolveGlobalShortcut(ctx({ key: '?', shiftKey: true, inEditable: true }))).toEqual({
      type: 'none',
    });
  });

  it('suppresses non-help shortcuts when Help is open, and routes Escape to Settings / narrow drawers first', () => {
    expect(resolveGlobalShortcut(ctx({ key: ' ', mode: 'run', isHelpOpen: true }))).toEqual({
      type: 'none',
    });

    expect(resolveGlobalShortcut(ctx({ key: 'Escape', isSettingsOpen: true }))).toEqual({
      type: 'closeSettings',
    });
    expect(resolveGlobalShortcut(ctx({ key: ' ', mode: 'run', isSettingsOpen: true }))).toEqual({
      type: 'none',
    });

    expect(
      resolveGlobalShortcut(ctx({ key: 'Escape', isHistoryOpen: true, isNarrowViewport: true })),
    ).toEqual({ type: 'closeHistoryDrawer' });
    expect(
      resolveGlobalShortcut(ctx({ key: 'Escape', isSidepanelOpen: true, isNarrowViewport: true })),
    ).toEqual({ type: 'closeSidepanelDrawer' });
    // On wide desktop viewports drawers stay pinned and Escape falls through to controller.
    expect(
      resolveGlobalShortcut(ctx({ key: 'Escape', isHistoryOpen: true, isNarrowViewport: false })),
    ).toEqual({ type: 'escape' });
  });

  it('matches Ctrl/Cmd+S (including non-Latin KeyS) only in edit mode', () => {
    expect(resolveGlobalShortcut(ctx({ key: 's', ctrlOrMeta: true, mode: 'edit' }))).toEqual({
      type: 'saveSnapshot',
    });
    expect(
      resolveGlobalShortcut(ctx({ key: 'ы', code: 'KeyS', ctrlOrMeta: true, mode: 'edit' })),
    ).toEqual({ type: 'saveSnapshot' });
    expect(resolveGlobalShortcut(ctx({ key: 's', ctrlOrMeta: true, mode: 'run' }))).toEqual({
      type: 'none',
    });
    expect(
      resolveGlobalShortcut(ctx({ key: 's', ctrlOrMeta: true, shiftKey: true, mode: 'edit' })),
    ).toEqual({ type: 'none' });
  });

  it('resolves Enter, Space, Shift+Space, and Escape respecting editable fields and focused controls', () => {
    // Plain Enter in edit mode is ignored, Ctrl+Enter starts even from a focused button
    expect(resolveGlobalShortcut(ctx({ key: 'Enter', mode: 'edit' }))).toEqual({ type: 'none' });
    expect(
      resolveGlobalShortcut(ctx({ key: 'Enter', ctrlOrMeta: true, inControl: true, mode: 'edit' })),
    ).toEqual({ type: 'enter', withModifier: true });
    expect(resolveGlobalShortcut(ctx({ key: 'Enter', mode: 'run' }))).toEqual({
      type: 'enter',
      withModifier: false,
    });
    expect(resolveGlobalShortcut(ctx({ key: 'Enter', inControl: true, mode: 'run' }))).toEqual({
      type: 'none',
    });

    // Space / Shift+Space
    expect(resolveGlobalShortcut(ctx({ key: ' ', mode: 'run' }))).toEqual({ type: 'space' });
    expect(resolveGlobalShortcut(ctx({ key: ' ', shiftKey: true, mode: 'run' }))).toEqual({
      type: 'shiftSpace',
    });
    expect(resolveGlobalShortcut(ctx({ key: ' ', inControl: true, mode: 'run' }))).toEqual({
      type: 'none',
    });

    // Escape works outside editables, and also inside editables while in error mode
    expect(resolveGlobalShortcut(ctx({ key: 'Escape', inEditable: true, mode: 'edit' }))).toEqual({
      type: 'none',
    });
    expect(resolveGlobalShortcut(ctx({ key: 'Escape', inEditable: true, mode: 'error' }))).toEqual({
      type: 'escape',
    });
  });
});
