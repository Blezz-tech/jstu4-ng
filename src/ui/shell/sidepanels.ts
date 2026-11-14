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

type DrawerKey = 'history' | 'sidepanel';

/**
 * Coordinates the left version-history panel and the right status side panel,
 * their mobile backdrops, mutual exclusion on narrow viewports, and the
 * collapsed notification badge.
 */
export class SidePanels {
  private readonly dom: AppDom;
  private readonly settings: SettingsStore;
  private readonly onLayoutChange: () => void;
  private readonly openState: Record<DrawerKey, boolean>;
  private latestLogKind: LogKind | null = null;

  constructor(options: SidePanelsOptions) {
    this.dom = options.dom;
    this.settings = options.settings;
    this.onLayoutChange = options.onLayoutChange;

    const initial = this.settings.get();
    this.openState = {
      sidepanel: initial.sidepanelOpen ?? !isNarrowViewport(),
      history: initial.historyOpen ?? false,
    };

    this.setDrawerOpen('sidepanel', this.openState.sidepanel, false);
    this.setDrawerOpen('history', this.openState.history, false);

    const { signal } = options;
    listen(
      window,
      'resize',
      () => {
        const narrow = isNarrowViewport();
        this.dom.sidepanelBackdrop.hidden = !(this.openState.sidepanel && narrow);
        this.dom.historyBackdrop.hidden = !(this.openState.history && narrow);
      },
      signal,
    );

    for (const key of ['history', 'sidepanel'] as const) {
      const { button, closeButton, backdrop } = this.drawerNodes(key);
      listen(button, 'click', () => this.setDrawerOpen(key, !this.openState[key], true), signal);
      listen(
        closeButton,
        'click',
        () => {
          this.setDrawerOpen(key, false, true);
          button.focus();
        },
        signal,
      );
      listen(backdrop, 'click', () => this.setDrawerOpen(key, false, false), signal);
    }
  }

  get isSidepanelOpen(): boolean {
    return this.openState.sidepanel;
  }

  get isHistoryOpen(): boolean {
    return this.openState.history;
  }

  setHistoryOpen(open: boolean, persist = false): void {
    this.setDrawerOpen('history', open, persist);
  }

  setSidepanelOpen(open: boolean, persist = false): void {
    this.setDrawerOpen('sidepanel', open, persist);
  }

  handleLogChange(kind: LogKind | null): void {
    this.latestLogKind = kind;
    if (kind === 'error' && !this.openState.sidepanel) {
      this.setDrawerOpen('sidepanel', true, false);
    } else {
      this.syncSidepanelBadge();
    }
  }

  private drawerNodes(key: DrawerKey) {
    return key === 'history'
      ? {
          panel: this.dom.historyPanel,
          button: this.dom.historyButton,
          closeButton: this.dom.historyClose,
          backdrop: this.dom.historyBackdrop,
        }
      : {
          panel: this.dom.sidepanel,
          button: this.dom.sidepanelButton,
          closeButton: this.dom.sidepanelClose,
          backdrop: this.dom.sidepanelBackdrop,
        };
  }

  private setDrawerOpen(key: DrawerKey, open: boolean, persist: boolean): void {
    const other: DrawerKey = key === 'history' ? 'sidepanel' : 'history';
    this.openState[key] = open;
    if (open && isNarrowViewport() && this.openState[other]) {
      this.setDrawerOpen(other, false, false);
    }

    const { panel, button, backdrop } = this.drawerNodes(key);
    this.dom.appShell.dataset[key] = open ? 'open' : 'closed';
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !(open && isNarrowViewport());
    if (key === 'sidepanel') this.syncSidepanelBadge();
    if (persist) {
      this.settings.update(key === 'history' ? { historyOpen: open } : { sidepanelOpen: open });
    }
    this.onLayoutChange();
  }

  private syncSidepanelBadge(): void {
    const showBadge = !this.openState.sidepanel && this.latestLogKind !== null;
    this.dom.sidepanelBadge.dataset.kind = showBadge ? (this.latestLogKind ?? '') : '';
  }
}
