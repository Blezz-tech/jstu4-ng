import type { I18n } from '../../i18n';
import { el, svgIcon } from '../dom';
import { formatSnapshotTimestamp, getSnapshotDisplayName, type ProgramSnapshot } from '../history';

const ICON_RENAME = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z'];
const ICON_DELETE = [
  'M3 6h18',
  'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
  'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  'M10 11v6',
  'M14 11v6',
];
const ICON_CHECK = ['M20 6 9 17l-5-5'];
const ICON_CANCEL = ['M18 6 6 18', 'M6 6l12 12'];

/** Count non-blank lines in a program string in a single pass without allocations. */
export function countProgramLines(program: string): number {
  let count = 0;
  let hasContent = false;
  for (let i = 0; i < program.length; i += 1) {
    const code = program.charCodeAt(i);
    if (code === 10) {
      if (hasContent) count += 1;
      hasContent = false;
    } else if (code !== 13 && code !== 32 && code !== 9) {
      hasContent = true;
    }
  }
  if (hasContent) count += 1;
  return Math.max(count, 1);
}

function actionButton(
  className: string,
  label: string,
  iconPaths: readonly string[],
  type: 'button' | 'submit' = 'button',
): HTMLButtonElement {
  return el(
    'button',
    { class: className, type, title: label, 'aria-label': label },
    svgIcon(iconPaths),
  );
}

export interface SnapshotItemViewState {
  readonly isActive: boolean;
  readonly isEditing: boolean;
}

/** Build one `<li>` snapshot card for `#history-list` (view mode or inline rename form). */
export function renderSnapshotItem(
  snapshot: ProgramSnapshot,
  i18n: I18n,
  state: SnapshotItemViewState,
): HTMLLIElement {
  const isNamed = snapshot.customName !== null;
  const li = el('li', {
    class: 'snapshot-item',
    'data-snapshot-id': snapshot.id,
    'data-kind': snapshot.kind,
    'data-named': String(isNamed),
    'data-active': String(state.isActive),
  });
  const node = el('span', { class: 'snapshot-item__node', 'aria-hidden': 'true' });

  if (state.isEditing) {
    const placeholder = i18n.t('history.renamePlaceholder');
    const input = el('input', {
      class: 'snapshot-item__input',
      type: 'text',
      placeholder,
      'aria-label': placeholder,
    });
    input.value = snapshot.customName ?? '';
    const form = el(
      'form',
      { class: 'snapshot-item__edit' },
      input,
      actionButton('snapshot-action', i18n.t('history.renameSave'), ICON_CHECK, 'submit'),
      actionButton(
        'snapshot-action snapshot-action--cancel',
        i18n.t('history.renameCancel'),
        ICON_CANCEL,
      ),
    );
    li.append(node, el('div', { class: 'snapshot-item__main' }, form));
    return li;
  }

  const lineText = i18n.t('history.linesCount', {
    count: countProgramLines(snapshot.program),
  });
  const meta = el(
    'span',
    { class: 'snapshot-item__meta' },
    ...(isNamed
      ? [el('span', {}, formatSnapshotTimestamp(snapshot.createdAt)), el('span', {}, '·')]
      : []),
    el('span', {}, lineText),
  );
  const loadBtn = el(
    'button',
    { class: 'snapshot-item__load', type: 'button', title: i18n.t('history.restore') },
    el('span', { class: 'snapshot-item__title' }, getSnapshotDisplayName(snapshot, i18n)),
    meta,
  );
  const actions = el(
    'div',
    { class: 'snapshot-item__actions' },
    actionButton('snapshot-action snapshot-action--rename', i18n.t('history.rename'), ICON_RENAME),
    actionButton('snapshot-action snapshot-action--delete', i18n.t('history.delete'), ICON_DELETE),
  );

  li.append(node, el('div', { class: 'snapshot-item__main' }, loadBtn), actions);
  return li;
}
