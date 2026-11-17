import type { I18n } from '../i18n';

export type LogKind = 'info' | 'warning' | 'error';

export interface NotificationLogOptions {
  readonly element: HTMLElement;
  readonly i18n: I18n;
  readonly onChange?: (kind: LogKind | null) => void;
}

export interface NotificationLog {
  readonly currentKind: LogKind | null;
  /** Display a localized notification; re-renders automatically when locale changes. */
  show(kind: LogKind, format: (i18n: I18n) => string): void;
  /** Clear the active notification (no-op when already cleared). */
  clear(): void;
  dispose(): void;
}

interface ActiveNotification {
  readonly kind: LogKind;
  readonly format: (i18n: I18n) => string;
}

/**
 * Shared, locale-reactive status notification log rendered into `#log`.
 * Decouples execution (`AppController`) from other subsystems (such as version
 * control) so any part of the UI can publish localized messages cleanly.
 */
export function createNotificationLog({
  element,
  i18n,
  onChange,
}: NotificationLogOptions): NotificationLog {
  let current: ActiveNotification | null = null;

  const render = (): void => {
    if (current === null) {
      element.textContent = '';
      element.dataset.kind = '';
      onChange?.(null);
      return;
    }

    element.textContent = current.format(i18n);
    element.dataset.kind = current.kind;
    onChange?.(current.kind);
  };

  const unsubscribe = i18n.subscribe(render);

  return {
    get currentKind(): LogKind | null {
      return current?.kind ?? null;
    },
    show(kind, format) {
      current = { kind, format };
      render();
    },
    clear() {
      if (current === null && element.textContent === '' && (element.dataset.kind ?? '') === '') {
        return;
      }
      current = null;
      render();
    },
    dispose() {
      unsubscribe();
    },
  };
}
