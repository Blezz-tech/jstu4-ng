import type { I18n } from './index';
import type { PlainMessageKey } from './types';

/**
 * Declaratively synchronize DOM nodes marked with `data-i18n` and
 * `data-i18n-attr` against a reactive `I18n` instance.
 *
 * - `data-i18n="controls.start"` sets `element.textContent` (never `innerHTML`).
 * - `data-i18n-attr="title:hints.start;data-hint:hints.start"` sets one or more
 *   semicolon-separated `attribute:key` pairs.
 * - Also keeps `<html lang dir>` and `document.title` synchronized.
 */
export function applyDomI18n(root: Document | Element, i18n: I18n): void {
  if (root instanceof Document) {
    root.documentElement.lang = i18n.locale;
    root.documentElement.dir = i18n.meta.dir;
    root.title = i18n.t('app.title');
  }

  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (key) node.textContent = i18n.t(key as PlainMessageKey);
  }

  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    const spec = node.dataset.i18nAttr;
    if (!spec) continue;
    for (const pair of spec.split(';')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(':');
      if (colon <= 0) continue;
      const attr = trimmed.slice(0, colon).trim();
      const key = trimmed.slice(colon + 1).trim();
      if (attr && key) node.setAttribute(attr, i18n.t(key as PlainMessageKey));
    }
  }
}

/** Apply translations immediately and re-apply on every locale change. */
export function bindDomI18n(root: Document | Element, i18n: I18n): () => void {
  applyDomI18n(root, i18n);
  return i18n.subscribe(() => applyDomI18n(root, i18n));
}
