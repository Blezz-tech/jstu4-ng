import type { I18n } from '../i18n';

export type LogKind = 'info' | 'warning' | 'error';

export interface NotificationLogOptions {
  readonly element: HTMLElement;
  readonly i18n: I18n;
  readonly onChange?: (kind: LogKind | null) => void;
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
export class NotificationLog {
  private readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly onChange: ((kind: LogKind | null) => void) | undefined;
  private readonly unsubscribe: () => void;
  private current: ActiveNotification | null = null;

  constructor(options: NotificationLogOptions) {
    this.element = options.element;
    this.i18n = options.i18n;
    this.onChange = options.onChange;
    this.unsubscribe = this.i18n.subscribe(() => this.render());
  }

  get currentKind(): LogKind | null {
    return this.current?.kind ?? null;
  }

  /** Display a localized notification; re-renders automatically when locale changes. */
  show(kind: LogKind, format: (i18n: I18n) => string): void {
    this.current = { kind, format };
    this.render();
  }

  /** Clear the active notification (no-op when already cleared). */
  clear(): void {
    if (
      this.current === null &&
      this.element.textContent === '' &&
      (this.element.dataset.kind ?? '') === ''
    ) {
      return;
    }
    this.current = null;
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private render(): void {
    if (this.current === null) {
      this.element.textContent = '';
      this.element.dataset.kind = '';
      this.onChange?.(null);
      return;
    }

    const text = this.current.format(this.i18n);
    this.element.textContent = text;
    this.element.dataset.kind = this.current.kind;
    this.onChange?.(this.current.kind);
  }
}
