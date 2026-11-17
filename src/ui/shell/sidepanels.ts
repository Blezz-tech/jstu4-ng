import type { LogKind } from '../notifications';
import { listen, type AppDom } from './dom';
import type { SettingsStore } from './settings-store';

export const NARROW_VIEWPORT_PX = 900;

export function isNarrowViewport(): boolean {
  return window.innerWidth < NARROW_VIEWPORT_PX;
}

export interface SidePanelsOptions {
  readonly dom: AppDom;
  readonly settings: SettingsStore;
  readonly onLayoutChange: () => void;
  readonly signal: AbortSignal;
}

export interface SidePanels {
  readonly isSidepanelOpen: boolean;
  readonly isHistoryOpen: boolean;
  setHistoryOpen(open: boolean, persist?: boolean): void;
  setSidepanelOpen(open: boolean, persist?: boolean): void;
  handleLogChange(kind: LogKind | null): void;
}

type DrawerKey = 'history' | 'sidepanel';

/**
 * Coordinates the left version-history panel and the right status side panel,
 * their mobile backdrops, mutual exclusion on narrow viewports, and the
 * collapsed notification badge.
 */
export function bindSidePanels({
  dom,
  settings,
  onLayoutChange,
  signal,
}: SidePanelsOptions): SidePanels {
  const initial = settings.get();
  const openState: Record<DrawerKey, boolean> = {
    sidepanel: initial.sidepanelOpen ?? !isNarrowViewport(),
    history: initial.historyOpen ?? false,
  };
  let latestLogKind: LogKind | null = null;

  const drawerNodes = (key: DrawerKey) =>
    key === 'history'
      ? {
          panel: dom.historyPanel,
          button: dom.historyButton,
          closeButton: dom.historyClose,
          backdrop: dom.historyBackdrop,
        }
      : {
          panel: dom.sidepanel,
          button: dom.sidepanelButton,
          closeButton: dom.sidepanelClose,
          backdrop: dom.sidepanelBackdrop,
        };

  const syncSidepanelBadge = (): void => {
    const showBadge = !openState.sidepanel && latestLogKind !== null;
    dom.sidepanelBadge.dataset.kind = showBadge ? (latestLogKind ?? '') : '';
  };

  const setDrawerOpen = (key: DrawerKey, open: boolean, persist: boolean): void => {
    const other: DrawerKey = key === 'history' ? 'sidepanel' : 'history';
    openState[key] = open;
    if (open && isNarrowViewport() && openState[other]) {
      setDrawerOpen(other, false, false);
    }

    const { panel, button, backdrop } = drawerNodes(key);
    dom.appShell.dataset[key] = open ? 'open' : 'closed';
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !(open && isNarrowViewport());
    if (key === 'sidepanel') syncSidepanelBadge();
    if (persist) {
      settings.update(key === 'history' ? { historyOpen: open } : { sidepanelOpen: open });
    }
    onLayoutChange();
  };

  setDrawerOpen('sidepanel', openState.sidepanel, false);
  setDrawerOpen('history', openState.history, false);

  listen(
    window,
    'resize',
    () => {
      const narrow = isNarrowViewport();
      if (narrow && openState.history && openState.sidepanel) {
        setDrawerOpen('history', false, false);
      }
      dom.sidepanelBackdrop.hidden = !(openState.sidepanel && narrow);
      dom.historyBackdrop.hidden = !(openState.history && narrow);
    },
    signal,
  );

  for (const key of ['history', 'sidepanel'] as const) {
    const { button, closeButton, backdrop } = drawerNodes(key);
    listen(button, 'click', () => setDrawerOpen(key, !openState[key], true), signal);
    listen(
      closeButton,
      'click',
      () => {
        setDrawerOpen(key, false, true);
        button.focus();
      },
      signal,
    );
    listen(backdrop, 'click', () => setDrawerOpen(key, false, false), signal);
  }

  return {
    get isSidepanelOpen(): boolean {
      return openState.sidepanel;
    },
    get isHistoryOpen(): boolean {
      return openState.history;
    },
    setHistoryOpen: (open, persist = false) => setDrawerOpen('history', open, persist),
    setSidepanelOpen: (open, persist = false) => setDrawerOpen('sidepanel', open, persist),
    handleLogChange(kind) {
      latestLogKind = kind;
      if (kind === 'error' && !openState.sidepanel) {
        setDrawerOpen('sidepanel', true, false);
      } else {
        syncSidepanelBadge();
      }
    },
  };
}
