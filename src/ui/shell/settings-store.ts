import { saveSettings, type AppSettings, type Theme } from '../storage';

export interface SettingsStore {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): AppSettings;
  subscribe(listener: (settings: AppSettings) => void): () => void;
}

export interface ThemeBindingOptions {
  readonly root: HTMLElement;
  readonly themeButtons: readonly HTMLButtonElement[];
  readonly store: SettingsStore;
}

export interface ThemeController {
  apply(): void;
  dispose(): void;
}

/** Resolve the effective visual theme (`light` | `dark`) from user choice and OS preference. */
export function resolveEffectiveTheme(choice: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (choice === 'auto') return prefersDark ? 'dark' : 'light';
  return choice;
}

/**
 * In-memory reactive store for persisted `AppSettings`.
 * Keeps mutations centralized and notifies subscribers when settings change.
 */
export function createSettingsStore(initial: AppSettings): SettingsStore {
  let current = initial;
  const listeners = new Set<(settings: AppSettings) => void>();

  return {
    get: () => current,
    update(patch) {
      current = { ...current, ...patch };
      saveSettings(current);
      for (const listener of listeners) listener(current);
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Synchronizes `data-theme`, `data-theme-option` buttons, and OS `prefers-color-scheme`
 * changes with the active `SettingsStore`.
 */
export function bindTheme({ root, themeButtons, store }: ThemeBindingOptions): ThemeController {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  const apply = (): void => {
    const theme = store.get().theme;
    root.dataset.theme = resolveEffectiveTheme(theme, mediaQuery.matches);
    root.dataset.themeChoice = theme;
    for (const button of themeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.themeOption === theme));
    }
  };

  const onSchemeChange = (): void => {
    if (store.get().theme === 'auto') apply();
  };

  mediaQuery.addEventListener('change', onSchemeChange);
  apply();

  return {
    apply,
    dispose() {
      mediaQuery.removeEventListener('change', onSchemeChange);
    },
  };
}
