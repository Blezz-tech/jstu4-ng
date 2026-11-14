import type { HelpContent, I18n } from '../../i18n';
import { copyTextToClipboard } from '../clipboard';
import { el } from '../dom';
import { listen, safeReplaceState, type AppDom } from './dom';

function openModalDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  dialog.showModal();
  // Focus the dialog itself instead of the close button: screen readers
  // announce the heading, and no accidental focus ring appears on "×".
  dialog.focus({ preventScroll: true });
}

function closeModalDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
}

function bindModalDialog(
  dialog: HTMLDialogElement,
  closeButtons: readonly HTMLButtonElement[],
  signal: AbortSignal,
  onClose?: () => void,
): void {
  for (const button of closeButtons) {
    listen(button, 'click', () => closeModalDialog(dialog), signal);
  }
  listen(
    dialog,
    'click',
    (event) => {
      if (event.target === dialog) closeModalDialog(dialog);
    },
    signal,
  );
  if (onClose !== undefined) {
    listen(dialog, 'close', onClose, signal);
  }
}

export interface HelpDialogOptions {
  readonly dom: AppDom;
  readonly onBeforeOpen: () => void;
  readonly signal: AbortSignal;
}

export class HelpDialog {
  private readonly dom: AppDom;
  private readonly onBeforeOpen: () => void;
  private content: HelpContent | null = null;
  private renderedContent: HelpContent | null = null;

  constructor(options: HelpDialogOptions) {
    this.dom = options.dom;
    this.onBeforeOpen = options.onBeforeOpen;
    const { signal } = options;

    listen(this.dom.helpButton, 'click', () => this.open(), signal);
    bindModalDialog(this.dom.helpDialog, [this.dom.helpBack, this.dom.helpClose], signal, () => {
      // Release help body DOM nodes while the dialog is closed.
      this.dom.helpBody.replaceChildren();
      this.renderedContent = null;
      if (location.hash === '#help') {
        safeReplaceState(location.pathname + location.search);
      }
    });
  }

  get isOpen(): boolean {
    return this.dom.helpDialog.open;
  }

  /** Store localized help content; builds `#help-body` lazily only when open. */
  render(content: HelpContent): void {
    this.content = content;
    this.dom.helpTitle.textContent = content.title;
    this.dom.helpBack.textContent = content.back;
    if (this.isOpen) this.mountContent(content);
  }

  open(): void {
    this.onBeforeOpen();
    if (this.content !== null && this.renderedContent !== this.content) {
      this.mountContent(this.content);
    }
    openModalDialog(this.dom.helpDialog);
  }

  close(): void {
    closeModalDialog(this.dom.helpDialog);
  }

  private mountContent(content: HelpContent): void {
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
              p.append(
                typeof part === 'string'
                  ? document.createTextNode(part)
                  : el(
                      'a',
                      { href: part.href, target: '_blank', rel: 'noopener noreferrer' },
                      part.label,
                    ),
              );
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
          case 'code':
            fragment.append(el('pre', { class: 'help__code' }, block.lines.join('\n')));
            break;
        }
      }
    }
    this.dom.helpBody.replaceChildren(fragment);
    this.renderedContent = content;
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

    listen(this.dom.tu4Copy, 'click', () => void this.copy(), signal);
    bindModalDialog(this.dom.tu4Dialog, [this.dom.tu4Close, this.dom.tu4Done], signal, () =>
      this.clearStatus(),
    );
  }

  get isOpen(): boolean {
    return this.dom.tu4Dialog.open;
  }

  open(converted: string): void {
    this.onBeforeOpen();
    this.clearStatus();
    this.dom.tu4Output.value = converted;
    this.dom.tu4Output.scrollTop = 0;
    openModalDialog(this.dom.tu4Dialog);
  }

  close(): void {
    this.clearStatus();
    closeModalDialog(this.dom.tu4Dialog);
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

    bindModalDialog(
      this.dom.deleteDialog,
      [this.dom.deleteDialogClose, this.dom.deleteDialogCancel],
      signal,
      () => {
        this.pendingId = null;
      },
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
    openModalDialog(this.dom.deleteDialog);
  }

  syncName(displayName: string): void {
    this.dom.deleteSnapshotName.textContent = displayName;
  }

  close(): void {
    this.pendingId = null;
    closeModalDialog(this.dom.deleteDialog);
  }
}
