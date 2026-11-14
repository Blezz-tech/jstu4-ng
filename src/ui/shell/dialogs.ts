import type { HelpContent, I18n } from '../../i18n';
import { copyTextToClipboard } from '../clipboard';
import { el } from '../dom';
import { listen, safeReplaceState, type AppDom } from './dom';

export interface HelpDialogOptions {
  readonly dom: AppDom;
  readonly onBeforeOpen: () => void;
  readonly signal: AbortSignal;
}

export class HelpDialog {
  private readonly dom: AppDom;
  private readonly onBeforeOpen: () => void;

  constructor(options: HelpDialogOptions) {
    this.dom = options.dom;
    this.onBeforeOpen = options.onBeforeOpen;
    const { signal } = options;

    listen(this.dom.helpButton, 'click', () => this.open(), signal);
    listen(this.dom.helpBack, 'click', () => this.close(), signal);
    listen(this.dom.helpClose, 'click', () => this.close(), signal);
    listen(
      this.dom.helpDialog,
      'click',
      (event) => {
        if (event.target === this.dom.helpDialog) this.close();
      },
      signal,
    );
    listen(
      this.dom.helpDialog,
      'close',
      () => {
        if (location.hash === '#help') {
          safeReplaceState(location.pathname + location.search);
        }
      },
      signal,
    );
  }

  get isOpen(): boolean {
    return this.dom.helpDialog.open;
  }

  render(content: HelpContent): void {
    this.dom.helpTitle.textContent = content.title;
    this.dom.helpBack.textContent = content.back;

    const fragment = document.createDocumentFragment();
    for (const section of content.sections) {
      fragment.append(el('h3', {}, section.title));
      for (const block of section.blocks) {
        switch (block.kind) {
          case 'p':
            fragment.append(el('p', {}, block.text));
            break;
          case 'rich': {
            const p = el('p');
            for (const part of block.parts) {
              if (typeof part === 'string') {
                p.append(document.createTextNode(part));
              } else {
                p.append(
                  el(
                    'a',
                    { href: part.href, target: '_blank', rel: 'noopener noreferrer' },
                    part.label,
                  ),
                );
              }
            }
            fragment.append(p);
            break;
          }
          case 'list': {
            const list = el('ul');
            for (const item of block.items) list.append(el('li', {}, item));
            fragment.append(list);
            break;
          }
          case 'code': {
            const pre = el('pre', { class: 'help__code' });
            pre.textContent = block.lines.join('\n');
            fragment.append(pre);
            break;
          }
        }
      }
    }
    this.dom.helpBody.replaceChildren(fragment);
  }

  open(): void {
    this.onBeforeOpen();
    if (this.dom.helpDialog.open) return;
    this.dom.helpDialog.showModal();
    // Focus the dialog itself instead of the close button: screen readers
    // announce the heading, and no accidental focus ring appears on "×".
    this.dom.helpDialog.focus({ preventScroll: true });
  }

  close(): void {
    if (this.dom.helpDialog.open) this.dom.helpDialog.close();
  }
}

export interface Tu4DialogOptions {
  readonly dom: AppDom;
  readonly i18n: I18n;
  readonly onBeforeOpen: () => void;
  readonly signal: AbortSignal;
}

export class Tu4Dialog {
  private readonly dom: AppDom;
  private readonly i18n: I18n;
  private readonly onBeforeOpen: () => void;
  private statusTimer: number | null = null;

  constructor(options: Tu4DialogOptions) {
    this.dom = options.dom;
    this.i18n = options.i18n;
    this.onBeforeOpen = options.onBeforeOpen;
    const { signal } = options;

    listen(this.dom.tu4Close, 'click', () => this.close(), signal);
    listen(this.dom.tu4Done, 'click', () => this.close(), signal);
    listen(this.dom.tu4Copy, 'click', () => void this.copy(), signal);
    listen(
      this.dom.tu4Dialog,
      'click',
      (event) => {
        if (event.target === this.dom.tu4Dialog) this.close();
      },
      signal,
    );
    listen(this.dom.tu4Dialog, 'close', () => this.clearStatus(), signal);
  }

  get isOpen(): boolean {
    return this.dom.tu4Dialog.open;
  }

  open(converted: string): void {
    this.onBeforeOpen();
    this.clearStatus();
    this.dom.tu4Output.value = converted;
    this.dom.tu4Output.scrollTop = 0;
    if (!this.dom.tu4Dialog.open) this.dom.tu4Dialog.showModal();
    this.dom.tu4Dialog.focus({ preventScroll: true });
  }

  close(): void {
    this.clearStatus();
    if (this.dom.tu4Dialog.open) this.dom.tu4Dialog.close();
  }

  dispose(): void {
    this.clearStatus();
  }

  private clearStatus(): void {
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.dom.tu4Status.textContent = '';
  }

  private async copy(): Promise<void> {
    const copied = await copyTextToClipboard(this.dom.tu4Output.value, this.dom.tu4Output);
    if (!copied) return;

    this.clearStatus();
    this.dom.tu4Status.textContent = this.i18n.t('tu4Dialog.copied');
    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = null;
      this.dom.tu4Status.textContent = '';
    }, 2500);
  }
}

export interface DeleteSnapshotDialogOptions {
  readonly dom: AppDom;
  readonly onBeforeOpen: () => void;
  readonly onConfirm: (id: string, skipFutureConfirm: boolean) => void;
  readonly signal: AbortSignal;
}

export class DeleteSnapshotDialog {
  private readonly dom: AppDom;
  private readonly onBeforeOpen: () => void;
  private readonly onConfirm: (id: string, skipFutureConfirm: boolean) => void;
  private pendingId: string | null = null;

  constructor(options: DeleteSnapshotDialogOptions) {
    this.dom = options.dom;
    this.onBeforeOpen = options.onBeforeOpen;
    this.onConfirm = options.onConfirm;
    const { signal } = options;

    listen(this.dom.deleteDialogClose, 'click', () => this.close(), signal);
    listen(this.dom.deleteDialogCancel, 'click', () => this.close(), signal);
    listen(
      this.dom.deleteDialog,
      'click',
      (event) => {
        if (event.target === this.dom.deleteDialog) this.close();
      },
      signal,
    );
    listen(
      this.dom.deleteDialog,
      'close',
      () => {
        this.pendingId = null;
      },
      signal,
    );
    listen(
      this.dom.deleteDialogConfirm,
      'click',
      () => {
        const id = this.pendingId;
        const skipConfirm = this.dom.skipDeleteConfirm.checked;
        this.close();
        if (id !== null) this.onConfirm(id, skipConfirm);
      },
      signal,
    );
  }

  get isOpen(): boolean {
    return this.dom.deleteDialog.open;
  }

  get currentPendingId(): string | null {
    return this.pendingId;
  }

  open(id: string, displayName: string): void {
    this.pendingId = id;
    this.dom.deleteSnapshotName.textContent = displayName;
    this.dom.skipDeleteConfirm.checked = false;
    this.onBeforeOpen();
    if (!this.dom.deleteDialog.open) this.dom.deleteDialog.showModal();
    this.dom.deleteDialog.focus({ preventScroll: true });
  }

  syncName(displayName: string): void {
    this.dom.deleteSnapshotName.textContent = displayName;
  }

  close(): void {
    this.pendingId = null;
    if (this.dom.deleteDialog.open) this.dom.deleteDialog.close();
  }
}
