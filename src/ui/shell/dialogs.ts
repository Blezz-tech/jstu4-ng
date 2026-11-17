import type { HelpContent, I18n } from '../../i18n';
import { copyTextToClipboard } from '../clipboard';
import { el } from '../dom';
import { listen, safeReplaceState, type AppDom } from './dom';

interface ModalDialogController {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

/**
 * Wraps a native modal `<dialog>` so closing via Escape, buttons, backdrop,
 * or programmatic `close()` runs `onClose` synchronously as `dialog.open`
 * flips to `false`. HTML's native `close` event is queued asynchronously,
 * which otherwise races with immediate navigation/reload right after Escape.
 */
function createModalDialog(
  dialog: HTMLDialogElement,
  closeButtons: readonly HTMLButtonElement[],
  signal: AbortSignal,
  onClose?: () => void,
): ModalDialogController {
  let closeNotified = true;

  const notifyClose = (): void => {
    if (closeNotified) return;
    closeNotified = true;
    onClose?.();
  };

  const open = (): void => {
    if (dialog.open) return;
    closeNotified = false;
    dialog.showModal();
    // Focus the dialog itself instead of the close button: screen readers
    // announce the heading, and no accidental focus ring appears on "×".
    dialog.focus({ preventScroll: true });
  };

  const close = (): void => {
    if (!dialog.open) return;
    dialog.close();
    notifyClose();
  };

  for (const button of closeButtons) {
    listen(button, 'click', close, signal);
  }
  listen(
    dialog,
    'click',
    (event) => {
      if (event.target === dialog) close();
    },
    signal,
  );
  dialog.ownerDocument.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && dialog.open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
    { capture: true, signal },
  );
  if (onClose !== undefined) {
    listen(
      dialog,
      'cancel',
      (event) => {
        if (!event.defaultPrevented) notifyClose();
      },
      signal,
    );
    listen(
      dialog,
      'close',
      () => {
        if (!dialog.open) notifyClose();
      },
      signal,
    );
  }

  return {
    get isOpen(): boolean {
      return dialog.open;
    },
    open,
    close,
  };
}

function buildHelpContentFragment(content: HelpContent): DocumentFragment {
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
  return fragment;
}

export interface HelpDialogOptions {
  readonly dom: AppDom;
  readonly onBeforeOpen: () => void;
  readonly signal: AbortSignal;
}

export interface HelpDialog {
  readonly isOpen: boolean;
  /** Store localized help content; builds `#help-body` lazily only when open. */
  render(content: HelpContent): void;
  open(): void;
  close(): void;
}

export function createHelpDialog({ dom, onBeforeOpen, signal }: HelpDialogOptions): HelpDialog {
  let content: HelpContent | null = null;
  let renderedContent: HelpContent | null = null;

  const mountContent = (next: HelpContent): void => {
    dom.helpBody.replaceChildren(buildHelpContentFragment(next));
    renderedContent = next;
  };

  const modal = createModalDialog(dom.helpDialog, [dom.helpBack, dom.helpClose], signal, () => {
    // Release help body DOM nodes while the dialog is closed.
    dom.helpBody.replaceChildren();
    renderedContent = null;
    if (location.hash === '#help') {
      safeReplaceState(location.pathname + location.search);
    }
  });

  const open = (): void => {
    onBeforeOpen();
    if (content !== null && renderedContent !== content) {
      mountContent(content);
    }
    modal.open();
  };

  listen(dom.helpButton, 'click', open, signal);

  return {
    get isOpen(): boolean {
      return modal.isOpen;
    },
    render(next) {
      content = next;
      dom.helpTitle.textContent = next.title;
      dom.helpBack.textContent = next.back;
      if (modal.isOpen) mountContent(next);
    },
    open,
    close: () => modal.close(),
  };
}

export interface Tu4DialogOptions {
  readonly dom: AppDom;
  readonly i18n: I18n;
  readonly onBeforeOpen: () => void;
  readonly signal: AbortSignal;
}

export interface Tu4Dialog {
  readonly isOpen: boolean;
  open(converted: string): void;
  dispose(): void;
}

export function createTu4Dialog({ dom, i18n, onBeforeOpen, signal }: Tu4DialogOptions): Tu4Dialog {
  let statusTimer: number | null = null;

  const clearStatus = (): void => {
    if (statusTimer !== null) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
    dom.tu4Status.textContent = '';
  };

  const copy = async (): Promise<void> => {
    const copied = await copyTextToClipboard(dom.tu4Output.value, dom.tu4Output);
    if (!copied || !dom.tu4Dialog.open) return;

    clearStatus();
    dom.tu4Status.textContent = i18n.t('tu4Dialog.copied');
    statusTimer = window.setTimeout(() => {
      statusTimer = null;
      dom.tu4Status.textContent = '';
    }, 2500);
  };

  const modal = createModalDialog(dom.tu4Dialog, [dom.tu4Close, dom.tu4Done], signal, clearStatus);
  listen(dom.tu4Copy, 'click', () => void copy(), signal);

  return {
    get isOpen(): boolean {
      return modal.isOpen;
    },
    open(converted) {
      onBeforeOpen();
      clearStatus();
      dom.tu4Output.value = converted;
      dom.tu4Output.scrollTop = 0;
      modal.open();
    },
    dispose: clearStatus,
  };
}

export interface DeleteSnapshotDialogOptions {
  readonly dom: AppDom;
  readonly onBeforeOpen: () => void;
  readonly onConfirm: (id: string, skipFutureConfirm: boolean) => void;
  readonly signal: AbortSignal;
}

export interface DeleteSnapshotDialog {
  readonly isOpen: boolean;
  readonly currentPendingId: string | null;
  open(id: string, displayName: string): void;
  syncName(displayName: string): void;
  close(): void;
}

export function createDeleteSnapshotDialog({
  dom,
  onBeforeOpen,
  onConfirm,
  signal,
}: DeleteSnapshotDialogOptions): DeleteSnapshotDialog {
  let pendingId: string | null = null;

  const modal = createModalDialog(
    dom.deleteDialog,
    [dom.deleteDialogClose, dom.deleteDialogCancel],
    signal,
    () => {
      pendingId = null;
    },
  );

  const close = (): void => {
    pendingId = null;
    modal.close();
  };

  listen(
    dom.deleteDialogConfirm,
    'click',
    () => {
      const id = pendingId;
      const skipConfirm = dom.skipDeleteConfirm.checked;
      close();
      if (id !== null) onConfirm(id, skipConfirm);
    },
    signal,
  );

  return {
    get isOpen(): boolean {
      return modal.isOpen;
    },
    get currentPendingId(): string | null {
      return pendingId;
    },
    open(id, displayName) {
      pendingId = id;
      dom.deleteSnapshotName.textContent = displayName;
      dom.skipDeleteConfirm.checked = false;
      onBeforeOpen();
      modal.open();
    },
    syncName(displayName) {
      dom.deleteSnapshotName.textContent = displayName;
    },
    close,
  };
}
