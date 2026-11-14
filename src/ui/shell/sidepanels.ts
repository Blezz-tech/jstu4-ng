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

/**
 * Coordinates the left version-history panel and the right status side panel,
 * their mobile backdrops, mutual exclusion on narrow viewports, and the
 * collapsed notification badge.
 */
export class SidePanels {
  private readonly dom: AppDom;
  private readonly settings: SettingsStore;
  private readonly onLayoutChange: () => void;

  private sidepanelOpen: boolean;
  private historyOpen: boolean;
  private latestLogKind: LogKind | null = null;

  constructor(options: SidePanelsOptions) {
    this.dom = options.dom;
    this.settings = options.settings;
    this.onLayoutChange = options.onLayoutChange;

    const initial = this.settings.get();
    this.sidepanelOpen = initial.sidepanelOpen ?? !isNarrowViewport();
    this.historyOpen = initial.historyOpen ?? false;

    this.setSidepanelOpen(this.sidepanelOpen, false);
    this.setHistoryOpen(this.historyOpen, false);

    const { signal } = options;
    listen(
      window,
      'resize',
      () => {
        this.dom.sidepanelBackdrop.hidden = !(this.sidepanelOpen && isNarrowViewport());
        this.dom.historyBackdrop.hidden = !(this.historyOpen && isNarrowViewport());
      },
      signal,
    );

    listen(
      this.dom.historyButton,
      'click',
      () => this.setHistoryOpen(!this.historyOpen, true),
      signal,
    );
    listen(
      this.dom.historyClose,
      'click',
      () => {
        this.setHistoryOpen(false, true);
        this.dom.historyButton.focus();
      },
      signal,
    );
    listen(this.dom.historyBackdrop, 'click', () => this.setHistoryOpen(false, false), signal);

    listen(
      this.dom.sidepanelButton,
      'click',
      () => this.setSidepanelOpen(!this.sidepanelOpen, true),
      signal,
    );
    listen(
      this.dom.sidepanelClose,
      'click',
      () => {
        this.setSidepanelOpen(false, true);
        this.dom.sidepanelButton.focus();
      },
      signal,
    );
    listen(this.dom.sidepanelBackdrop, 'click', () => this.setSidepanelOpen(false, false), signal);
  }

  get isSidepanelOpen(): boolean {
    return this.sidepanelOpen;
  }

  get isHistoryOpen(): boolean {
    return this.historyOpen;
  }

  setHistoryOpen(open: boolean, persist = false): void {
    this.historyOpen = open;
    if (open && isNarrowViewport() && this.sidepanelOpen) {
      this.setSidepanelOpen(false, false);
    }
    this.dom.appShell.dataset.history = open ? 'open' : 'closed';
    this.dom.historyPanel.hidden = !open;
    this.dom.historyButton.setAttribute('aria-expanded', String(open));
    this.dom.historyBackdrop.hidden = !(open && isNarrowViewport());
    if (persist) this.settings.update({ historyOpen: open });
    this.onLayoutChange();
  }

  setSidepanelOpen(open: boolean, persist = false): void {
    this.sidepanelOpen = open;
    if (open && isNarrowViewport() && this.historyOpen) {
      this.setHistoryOpen(false, false);
    }
    this.dom.appShell.dataset.sidepanel = open ? 'open' : 'closed';
    this.dom.sidepanel.hidden = !open;
    this.dom.sidepanelButton.setAttribute('aria-expanded', String(open));
    this.dom.sidepanelBackdrop.hidden = !(open && isNarrowViewport());
    this.syncSidepanelBadge();
    if (persist) this.settings.update({ sidepanelOpen: open });
    this.onLayoutChange();
  }

  handleLogChange(kind: LogKind | null): void {
    this.latestLogKind = kind;
    if (kind === 'error' && !this.sidepanelOpen) {
      this.setSidepanelOpen(true, false);
    } else {
      this.syncSidepanelBadge();
    }
  }

  private syncSidepanelBadge(): void {
    const showBadge = !this.sidepanelOpen && this.latestLogKind !== null;
    this.dom.sidepanelBadge.dataset.kind = showBadge ? (this.latestLogKind ?? '') : '';
  }
}
