import { saveSettings, type AppSettings } from '../storage';

export interface ThemeBindingOptions {
  readonly root: HTMLElement;
  readonly themeButtons: readonly HTMLButtonElement[];
  readonly store: SettingsStore;
}

/**
 * In-memory reactive store for persisted `AppSettings`.
 * Keeps mutations centralized and notifies subscribers when settings change.
 */
export class SettingsStore {
  private current: AppSettings;
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(initial: AppSettings) {
    this.current = initial;
  }

  get(): AppSettings {
    return this.current;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.current = { ...this.current, ...patch };
    saveSettings(this.current);
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  subscribe(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Synchronizes `data-theme`, `data-theme-option` buttons, and OS `prefers-color-scheme`
 * changes with the active `SettingsStore`.
 */
export class ThemeController {
  private readonly root: HTMLElement;
  private readonly themeButtons: readonly HTMLButtonElement[];
  private readonly store: SettingsStore;
  private readonly mediaQuery: MediaQueryList;
  private readonly onSchemeChange: () => void;

  constructor(options: ThemeBindingOptions) {
    this.root = options.root;
    this.themeButtons = options.themeButtons;
    this.store = options.store;
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.onSchemeChange = () => {
      if (this.store.get().theme === 'auto') this.apply();
    };
    this.mediaQuery.addEventListener('change', this.onSchemeChange);
    this.apply();
  }

  apply(): void {
    const theme = this.store.get().theme;
    const isDark = theme === 'dark' || (theme === 'auto' && this.mediaQuery.matches);
    this.root.dataset.theme = theme === 'auto' ? (isDark ? 'dark' : 'light') : theme;
    this.root.dataset.themeChoice = theme;
    for (const button of this.themeButtons) {
      const active = button.dataset.themeOption === theme;
      button.setAttribute('aria-pressed', String(active));
    }
  }

  dispose(): void {
    this.mediaQuery.removeEventListener('change', this.onSchemeChange);
  }
}
